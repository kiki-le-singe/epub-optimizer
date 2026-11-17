import fs from "fs-extra";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
// @ts-expect-error Native Node TypeScript requires the source extension.
import { waitForWatchOverview } from "./watch-e2e-readiness.ts";

/** Generated books only; exercise the actual long-lived CLI and native validator. */
export async function assertWatchWorkflow(
  runDir: string,
  inputEpub: string,
  pipelinePath: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const input = path.join(runDir, "watch-input"),
    output = path.join(runDir, "watch-output");
  await fs.ensureDir(input);
  for (const flags of [
    ["--batch", input],
    ["--input", inputEpub],
    ["--output", "unused.epub"],
    ["--temp", "unused-temp"],
    ["--doctor"],
    ["--report-json", "unused.json"],
    ["--watch-settle-ms", "999"],
  ]) {
    const invalid = spawnSync(
      process.execPath,
      [pipelinePath, "--watch", input, "--output-dir", output, ...flags],
      { env, encoding: "utf8", timeout: 5000 }
    );
    if (invalid.status !== 1 || (await fs.pathExists(output)))
      throw new Error(`Watch accepted incompatible CLI flags: ${flags.join(" ")}`);
  }
  const original = await fs.readFile(inputEpub);
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const launch = () => {
    const child = spawn(
      process.execPath,
      [
        pipelinePath,
        "--watch",
        input,
        "--output-dir",
        output,
        "--watch-settle-ms",
        "1000",
        "--preset",
        "lossless",
        "--strict",
        "--clean",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let log = "";
    child.stdout.on("data", (data) => {
      log = (log + String(data)).slice(-1024 * 1024);
    });
    child.stderr.on("data", (data) => {
      log = (log + String(data)).slice(-1024 * 1024);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    return { child, exited, log: () => log };
  };
  const waitFor = async (condition: () => Promise<boolean>, log: () => string) => {
    const deadline = Date.now() + 60_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`Watch E2E timed out.\n${log()}`);
      await delay(100);
    }
  };
  const jobs = async () =>
    (await fs.pathExists(output))
      ? (await fs.readdir(output)).filter((name) => !name.startsWith("."))
      : [];
  const completed = async () => {
    const names = await jobs();
    return (
      await Promise.all(
        names.map(async (name) =>
          (await fs.pathExists(path.join(output, name, "completed.json"))) ? name : undefined
        )
      )
    ).filter((name): name is string => !!name);
  };
  await fs.writeFile(path.join(input, "broken.epub"), "invalid ZIP");
  await fs.writeFile(path.join(input, "book.epub.part"), original);
  const first = launch();
  try {
    await waitFor(async () => first.log().includes("Watch book failed: broken.epub"), first.log);
    if ((await completed()).length) throw new Error("Watch processed a partial filename.");
    await fs.rename(path.join(input, "book.epub.part"), path.join(input, "book.epub"));
    await waitFor(async () => (await completed()).length === 1, first.log);
    const name = (await completed())[0];
    if (!name) throw new Error("Missing completed watch job.");
    const job = path.join(output, name);
    const report = await fs.readJson(path.join(job, "report.json"));
    if (
      !report.success ||
      !report.content?.integrity?.valid ||
      report.validation?.totals?.warnings !== 0
    )
      throw new Error("Watched book failed its integrity or native validation checks.");
    if (!(await fs.pathExists(path.join(job, "report.html"))))
      throw new Error("Watch HTML report missing.");
    if (await fs.pathExists(report.tempDir))
      throw new Error("Watch --clean left extraction files.");
    if (hash(await fs.readFile(path.join(input, "book.epub"))) !== hash(original))
      throw new Error("Watch changed its original.");
    await waitForWatchOverview(output, ["book.epub", "broken.epub", "optimized.epub"], {
      timeoutMs: 60_000,
      logs: first.log,
    });
    first.child.kill("SIGTERM");
    if ((await first.exited) !== 1)
      throw new Error("Watch did not report its failed book on graceful exit.");
    await fs.remove(path.join(input, "broken.epub"));
    const before = await fs.stat(path.join(job, "optimized.epub"));
    const second = launch();
    try {
      await waitFor(async () => second.log().includes("Watching "), second.log);
      // Wait through the settling interval and the durable skip observation.
      await delay(2200);
      second.child.kill("SIGINT");
      if ((await second.exited) !== 0 || !second.log().includes("1 already completed"))
        throw new Error(`Watch restart did not reuse its completion record.\n${second.log()}`);
      if ((await fs.stat(path.join(job, "optimized.epub"))).mtimeMs !== before.mtimeMs)
        throw new Error("Watch restart rewrote a completed book.");
    } finally {
      if (second.child.exitCode === null) {
        second.child.kill("SIGKILL");
        await second.exited;
      }
    }
    if (await fs.pathExists(path.join(output, ".epub-watch.lock")))
      throw new Error("Graceful watch stop left a lock.");
  } finally {
    if (first.child.exitCode === null) {
      first.child.kill("SIGKILL");
      await first.exited;
    }
  }
  // Exercise saved storage previews through the built CLI using generated revisions.
  const originalJob = (await completed())[0];
  if (!originalJob) throw new Error("Missing storage fixture job");
  const olderJob = originalJob.slice(0, -16) + "d".repeat(16);
  const olderDir = path.join(output, olderJob);
  await fs.copy(path.join(output, originalJob), olderDir);
  const marker = await fs.readJson(path.join(olderDir, "completed.json"));
  marker.settings = "d".repeat(16);
  await fs.writeJson(path.join(olderDir, "completed.json"), marker);
  await fs.utimes(path.join(olderDir, "completed.json"), 1, 1);
  const planFile = path.join(runDir, "storage-plan.json");
  const invoke = (flags: string[]) =>
    spawnSync(process.execPath, [pipelinePath, ...flags], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
  const preview = invoke([
    "--storage",
    output,
    "--storage-plan",
    planFile,
    "--keep-revisions",
    "1",
  ]);
  if (preview.status !== 0) throw new Error(`Storage preview failed: ${preview.stderr}`);
  const plan = JSON.parse(preview.stdout);
  if (
    plan.candidates.length !== 1 ||
    plan.candidates[0].job !== olderJob ||
    !(await fs.pathExists(olderDir))
  )
    throw new Error("Storage preview failed to preserve data or choose the older revision");
  const applied = invoke(["--apply-storage-plan", planFile]);
  if (
    applied.status !== 0 ||
    (await fs.pathExists(olderDir)) ||
    !(await fs.pathExists(path.join(output, originalJob, "optimized.epub")))
  )
    throw new Error(`Storage purge failed or removed the current revision: ${applied.stderr}`);
  if (hash(await fs.readFile(path.join(input, "book.epub"))) !== hash(original))
    throw new Error("Storage purge changed an original");
  console.log(
    "Watch E2E passed: partial filenames, failure recovery, native validation, reports, restart deduplication and graceful signals."
  );
}
