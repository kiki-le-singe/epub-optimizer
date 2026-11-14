import fs from "fs-extra";
import { acquireKernelWatchLock, clearRecoverableWatchRecord } from "./utils/watch-lock.js";
import path from "node:path";
import os from "node:os";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Stats } from "node:fs";
import type { Args } from "./types.js";
import { runOptimization } from "./optimization.js";
import { reportError, reportInfo } from "./utils/diagnostics.js";
import { assertDistinctPathSet } from "./utils/output-transaction.js";
import { resolvePngBackground } from "./utils/pipeline-options.js";
import {
  loadAuthorWorkflowConfig,
  type AuthorWorkflowConfig,
} from "./utils/author-workflow-config.js";
import { findPackageRoot } from "./utils/package-root.js";

/** Structurally compatible with AbortSignal, without requiring DOM or Node typings. */
export interface WatchSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
export interface WatchOptions {
  /** Stop accepting books; finish the current optimization before returning. */
  signal: WatchSignal;
  pollIntervalMs?: number;
}
export interface WatchReport {
  succeeded: number;
  failed: number;
  skipped: number;
}

function fingerprint(s: Stats): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}
async function ownedDirectory(directory: string, owner: Stats): Promise<void> {
  const current = await fs.lstat(directory);
  if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino)
    throw new Error(`Watch directory ownership changed: ${directory}`);
}
async function removeOwnedLock(file: string, owner: Stats): Promise<void> {
  const current = await fs.lstat(file);
  if (!current.isFile() || current.dev !== owner.dev || current.ino !== owner.ino)
    throw new Error("Refusing to remove a replaced watch lock.");
  await fs.unlink(file);
}
async function digest(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Expected a regular file.");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
function settingsDigest(args: Args, authorConfig?: AuthorWorkflowConfig): string {
  const ignored = new Set([
    "input",
    "i",
    "output",
    "o",
    "temp",
    "t",
    "batch",
    "watch",
    "outputDir",
    "output-dir",
    "reportJson",
    "report-json",
    "reportHtml",
    "report-html",
    "watchSettleMs",
    "watch-settle-ms",
    "clean",
    "profile",
    "_",
    "$0",
  ]);
  const settings = Object.fromEntries(
    Object.entries(args)
      .filter(([key]) => !ignored.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
  );
  const version = fs.readJsonSync(
    path.join(findPackageRoot(import.meta.url), "package.json")
  ).version;
  return createHash("sha256")
    .update(JSON.stringify({ version, settings, authorConfig }))
    .digest("hex")
    .slice(0, 16);
}

/** Polling also works on mounted Docker folders; no dependency on filesystem events. */
export async function runWatch(args: Args, options: WatchOptions): Promise<WatchReport> {
  resolvePngBackground(args);
  if (!args.watch || !args.outputDir || args.batch || args.doctor || args.inspect)
    throw new Error("Watch requires --watch and --output-dir, without batch or doctor mode.");
  if (args.reportJson || args.reportHtml)
    throw new Error("Watch writes per-book JSON and HTML reports automatically.");
  const interval = options.pollIntervalMs ?? 1000;
  const settle = args.watchSettleMs ?? 3000;
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    !Number.isSafeInteger(settle) ||
    settle < 1
  )
    throw new Error("Watch polling and settling intervals must be positive integers.");
  const input = path.resolve(args.watch),
    output = path.resolve(args.outputDir);
  const inputOwner = await fs.lstat(input);
  if (!inputOwner.isDirectory())
    throw new Error("Watch input must be a real directory, not a symbolic link.");
  assertDistinctPathSet([input, output]);
  await fs.ensureDir(output);
  const outputOwner = await fs.lstat(output);
  if (!outputOwner.isDirectory())
    throw new Error("Watch output must be a real directory, not a symbolic link.");
  // Exclusive lock prevents two watchers from publishing the same jobs concurrently.
  const authorConfig =
    args.authorWorkflow || args.preset === "author"
      ? await loadAuthorWorkflowConfig(args.authorConfig)
      : undefined;
  const settings = settingsDigest(args, authorConfig);
  const lockPath = path.join(output, ".epub-watch.lock");
  const kernel = await acquireKernelWatchLock(output);
  let lock;
  try {
    if (kernel) await clearRecoverableWatchRecord(lockPath, kernel.identity);
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    await kernel?.release();
    throw error;
  }
  const lockOwner = await lock.stat();
  const result: WatchReport = { succeeded: 0, failed: 0, skipped: 0 };
  const observations = new Map<
    string,
    { fingerprint: string; since: number; attempted: boolean }
  >();
  try {
    await lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        input,
        method: kernel ? "linux-flock-v1" : "exclusive-file-v1",
        guard: kernel?.identity,
      })
    );
    reportInfo(`Watching ${input}; output: ${output}. Stop with Ctrl+C.`);
    while (!options.signal.aborted) {
      await ownedDirectory(input, inputOwner);
      await ownedDirectory(output, outputOwner);
      const entries = (await fs.readdir(input, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      const present = new Set<string>();
      for (const entry of entries) {
        if (options.signal.aborted) break;
        if (!/\.epub$/i.test(entry.name)) continue;
        const source = path.join(input, entry.name);
        present.add(entry.name);
        let stats: Stats;
        try {
          stats = await fs.lstat(source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const identity = fingerprint(stats);
        const prior = observations.get(entry.name);
        if (!prior || prior.fingerprint !== identity) {
          observations.set(entry.name, {
            fingerprint: identity,
            since: performance.now(),
            attempted: false,
          });
          if (!stats.isFile()) reportError(`Ignoring non-regular watch input: ${entry.name}`);
          continue;
        }
        if (
          prior.attempted ||
          !stats.isFile() ||
          stats.size === 0 ||
          performance.now() - prior.since < settle
        )
          continue;
        prior.attempted = true;
        // Copy a stable, no-follow file descriptor into a private snapshot. Never extract the live drop file.
        const snapshotDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "epub-watch-"));
        const snapshotOwner = await fs.lstat(snapshotDirectory);
        const snapshot = path.join(snapshotDirectory, "input.epub");
        try {
          const handle = await open(
            source,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          );
          try {
            if (fingerprint(await handle.stat()) !== identity) {
              observations.delete(entry.name);
              continue;
            }
            await pipeline(
              handle.createReadStream({ autoClose: false }),
              fs.createWriteStream(snapshot, { flags: "wx", mode: 0o600 })
            );
            if (
              fingerprint(await handle.stat()) !== identity ||
              fingerprint(await fs.lstat(source)) !== identity
            ) {
              observations.delete(entry.name);
              continue;
            }
          } finally {
            await handle.close();
          }
          if (options.signal.aborted) break;
          const hash = await digest(snapshot);
          const nameHash = createHash("sha256").update(entry.name).digest("hex").slice(0, 16);
          const stem =
            path
              .basename(entry.name, path.extname(entry.name))
              .replace(/[^a-zA-Z0-9_-]/g, "_")
              .slice(0, 64) || "book";
          const job = path.join(output, `${stem}-${nameHash}-${hash}-${settings}`);
          await ownedDirectory(output, outputOwner);
          try {
            await fs.mkdir(job);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          const jobOwner = await fs.lstat(job);
          if (!jobOwner.isDirectory()) throw new Error("Refusing unsafe watch job directory.");
          const target = path.join(job, "optimized.epub"),
            marker = path.join(job, "completed.json");
          if (await fs.pathExists(marker)) {
            const m = await fs.lstat(marker);
            if (!m.isFile() || m.size > 65536) throw new Error("Unsafe watch completion record.");
            const saved = await fs.readJson(marker);
            if (
              saved.inputSha256 !== hash ||
              saved.settings !== settings ||
              saved.outputSha256 !== (await digest(target))
            )
              throw new Error(
                "Watch completion record or output no longer matches; preserve it and choose a fresh output directory."
              );
            result.skipped++;
            continue;
          }
          assertDistinctPathSet([
            ...entries
              .filter((item) => item.isFile() && /\.epub$/i.test(item.name))
              .map((item) => path.join(input, item.name)),
            snapshot,
            target,
            marker,
            path.join(job, "report.json"),
            path.join(job, "report.html"),
          ]);
          const authorConfigPath = authorConfig
            ? path.join(snapshotDirectory, "author-config.json")
            : undefined;
          if (authorConfigPath) await fs.writeJson(authorConfigPath, authorConfig);
          reportInfo(`Watch book: ${entry.name}`);
          await runOptimization({
            ...args,
            watch: undefined,
            authorConfig: authorConfigPath,
            outputDir: undefined,
            input: snapshot,
            output: target,
            temp: path.join(os.tmpdir(), `epub-watch-extract-${randomUUID()}`),
            reportJson: path.join(job, "report.json"),
            reportHtml: path.join(job, "report.html"),
          });
          await ownedDirectory(output, outputOwner);
          await ownedDirectory(job, jobOwner);
          await fs.writeFile(
            marker,
            JSON.stringify(
              { input: source, inputSha256: hash, settings, outputSha256: await digest(target) },
              null,
              2
            ),
            { flag: "wx", mode: 0o600 }
          );
          result.succeeded++;
          reportInfo(`Watch completed: ${entry.name} → ${target}`);
        } catch (error) {
          result.failed++;
          reportError(
            `Watch book failed: ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
          );
        } finally {
          await ownedDirectory(snapshotDirectory, snapshotOwner);
          await fs.remove(snapshotDirectory);
        }
      }
      for (const name of observations.keys()) if (!present.has(name)) observations.delete(name);
      if (!options.signal.aborted) {
        try {
          await delay(interval, undefined, { signal: options.signal as AbortSignal });
        } catch (error) {
          if (!options.signal.aborted) throw error;
        }
      }
    }
    reportInfo(
      `Watch stopped: ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} already completed.`
    );
    return result;
  } finally {
    try {
      await lock.close();
      await ownedDirectory(output, outputOwner);
      await removeOwnedLock(lockPath, lockOwner);
    } finally {
      await kernel?.release();
    }
  }
}
