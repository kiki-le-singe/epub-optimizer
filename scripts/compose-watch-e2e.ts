import fs from "fs-extra";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export async function assertComposeWatch(
  runDir: string,
  image: string,
  repo: string
): Promise<void> {
  const input = path.join(runDir, "compose-watch-in"),
    output = path.join(runDir, "compose-watch-out");
  await fs.ensureDir(input);
  await fs.ensureDir(output);
  await fs.chmod(output, 0o777);
  const project = `epub-compose-watch-${randomUUID()}`;
  const env = {
    ...process.env,
    EPUB_OPTIMIZER_DOCKER_IMAGE: image,
    EPUB_WATCH_INBOX: input,
    EPUB_WATCH_OUTPUT: output,
  };
  const compose = (...args: string[]) => {
    const r = spawnSync(
      "docker",
      ["compose", "-p", project, "-f", path.join(repo, "compose.watch.yaml"), ...args],
      { env, encoding: "utf8", timeout: 180000 }
    );
    if (r.status !== 0) throw new Error(`Compose watch failed: ${args.join(" ")}\n${r.stderr}`);
    return r.stdout;
  };
  const waitFor = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 90000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Compose watch timed out:\n${compose("logs")}`);
      await delay(100);
    }
  };
  compose("up", "-d");
  try {
    await fs.copyFile(path.join(runDir, "input.epub"), path.join(input, "book.epub.part"));
    await fs.rename(path.join(input, "book.epub.part"), path.join(input, "book.epub"));
    let job = "";
    await waitFor(async () => {
      for (const name of await fs.readdir(output)) {
        if (await fs.pathExists(path.join(output, name, "completed.json"))) {
          job = path.join(output, name);
          return true;
        }
      }
      return false;
    });
    const report = await fs.readJson(path.join(job, "report.json"));
    if (
      !report.success ||
      !report.content?.integrity?.valid ||
      report.validation?.totals?.warnings !== 0
    )
      throw new Error("Compose watch validation failed");
    const overview = await fs.readFile(path.join(output, "index.html"), "utf8");
    if (!overview.includes("book.epub") || !overview.includes("optimized.epub"))
      throw new Error("Docker watcher summary missing book links");
    const before = (await fs.stat(path.join(job, "optimized.epub"))).mtimeMs;
    compose("restart");
    await delay(4500);
    if ((await fs.stat(path.join(job, "optimized.epub"))).mtimeMs !== before)
      throw new Error("Compose restart reprocessed a completed book");
    compose("down");
    if (await fs.pathExists(path.join(output, ".epub-watch.lock")))
      throw new Error("Compose shutdown left a lock");
    if (!(await fs.pathExists(path.join(input, "book.epub"))))
      throw new Error("Compose removed the source");
  } finally {
    compose("down", "--remove-orphans");
  }
  console.log(
    "Compose background watcher passed: drop folder, reports, restart deduplication and graceful shutdown."
  );
}
