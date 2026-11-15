import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
// @ts-expect-error Native Node TypeScript requires the source extension.
import { createFontFixture } from "./font-fixtures.ts";
// @ts-expect-error Native Node TypeScript requires the source extension.
import { createEpub } from "./e2e-epubcheck.ts";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await fs.mkdir(path.join(repo, ".cache"), { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-batch-benchmark-"));
const owner = await fs.lstat(root);
async function cleanupBenchmark() {
  const current = await fs.lstat(root);
  if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino)
    throw new Error("Benchmark directory ownership changed; preserving it");
  await fs.rm(root, { recursive: true, force: true });
}
try {
  await createFontFixture(path.join(root, "source"));
  await fs.mkdir(path.join(root, "input"));
  const input = path.join(root, "input/a.epub");
  await createEpub(input, path.join(root, "source"));
  for (const name of ["b.epub", "c.epub"]) await fs.copyFile(input, path.join(root, "input", name));
  const results: unknown[] = [];
  for (const jobs of [1, 2]) {
    const stats = path.join(root, `measure-${jobs}.json`);
    const code = `
      import fs from 'node:fs/promises';
      import {parseArguments} from ${JSON.stringify(pathToFileURL(path.join(repo, "dist/src/cli.js")).href)};
      import {runBatch} from ${JSON.stringify(pathToFileURL(path.join(repo, "dist/src/batch.js")).href)};
      process.argv=['node','bench','--batch',${JSON.stringify(path.join(root, "input"))},'--output-dir',${JSON.stringify(path.join(root, `out-${jobs}`))},'--jobs','${jobs}','--preset','lossless','--image-concurrency','1','--fonts','--clean','--strict','--profile'];
      const args=await parseArguments();
      let nodeRss=process.memoryUsage().rss;
      const sample=setInterval(()=>nodeRss=Math.max(nodeRss,process.memoryUsage().rss),20);
      const start=performance.now();
      const result=await runBatch(args);
      clearInterval(sample);
      await fs.writeFile(${JSON.stringify(stats)},JSON.stringify({jobs:${jobs},elapsedMs:performance.now()-start,nodeSampledPeakBytes:nodeRss,success:result.success,books:result.books.map(b=>({success:b.success,bytes:b.sizes?.outputBytes}))}));
      if(!result.success)process.exitCode=1;
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        EPUBCHECK_PATH: process.env.EPUBCHECK_PATH ?? path.join(repo, "epubcheck/epubcheck.jar"),
      },
    });
    await fs.writeFile(
      path.join(repo, `.cache/batch-benchmark-${jobs}.log`),
      run.stdout + run.stderr
    );
    if (run.status !== 0) throw new Error(`Benchmark ${jobs} failed; inspect .cache log`);
    results.push(JSON.parse(await fs.readFile(stats, "utf8")));
  }
  const record = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    inputBytes: (await fs.stat(input)).size,
    scope:
      "Three identical generated font EPUBs, lossless, strict, fonts enabled, image concurrency 1, one run per mode. Sampled RSS is Node only; separate Java memory not measured.",
    results,
  };
  await fs.writeFile(
    path.join(repo, ".cache/batch-benchmark.json"),
    JSON.stringify(record, null, 2) + "\n"
  );
  process.stdout.write(JSON.stringify(record, null, 2) + "\n");
} finally {
  await cleanupBenchmark();
}
