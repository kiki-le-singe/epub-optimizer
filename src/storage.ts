import fs from "fs-extra";
import path from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { acquireKernelWatchLock, clearRecoverableWatchRecord } from "./utils/watch-lock.js";
import { refreshWatchSummary } from "./utils/watch-summary.js";

const JOB = /^[a-zA-Z0-9_-]+-[a-f0-9]{16}-([a-f0-9]{64})-[a-f0-9]{16}$/;
const FILES = new Set([
  "optimized.epub",
  "completed.json",
  "report.json",
  "report.html",
  "watch-status.json",
]);
export interface StorageRevision {
  job: string;
  input: string;
  completedMs: number;
  bytes: number;
  signature: string;
}
export interface StoragePlan {
  schema: 1;
  directory: string;
  identity: string;
  keepRevisions: number;
  createdAt: string;
  verifiedRevisionBytes: number;
  candidateBytes: number;
  candidates: StorageRevision[];
  retained: StorageRevision[];
  protected: Array<{ name: string; reason: string }>;
}
const identity = (s: Stats) => `${s.dev}:${s.ino}`;
const version = (s: Stats) => `${identity(s)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function assertOwner(directory: string, expected: string): Promise<void> {
  const current = await fs.lstat(directory);
  if (!current.isDirectory() || identity(current) !== expected)
    throw new Error("Storage directory identity changed");
}
async function hashFile(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new Error("Unsafe or hard-linked revision resource");
    const hash = createHash("sha256");
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    if (version(before) !== version(await handle.stat()))
      throw new Error("Revision changed during inspection");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
async function readJson(file: string, limit: number): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit)
      throw new Error("Unsafe or oversized storage record");
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const r = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!r.bytesRead) break;
      offset += r.bytesRead;
    }
    if (offset > limit || version(before) !== version(await handle.stat()))
      throw new Error("Storage record changed or exceeds limit");
    return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
  } finally {
    await handle.close();
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid storage record");
  return value as Record<string, unknown>;
}
function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
async function inspectRevision(root: string, job: string): Promise<StorageRevision> {
  const match = JOB.exec(job);
  if (!match) throw new Error("Not a recognized watcher revision");
  const directory = path.join(root, job),
    owner = await fs.lstat(directory);
  if (!owner.isDirectory()) throw new Error("Revision is not a real directory");
  const names = (await fs.readdir(directory)).sort();
  if (
    !names.includes("optimized.epub") ||
    !names.includes("completed.json") ||
    !names.includes("report.json") ||
    names.some((name) => !FILES.has(name))
  )
    throw new Error("Incomplete revision or unrecognized files preserved");
  const parts: string[] = [identity(owner)];
  let bytes = 0;
  for (const name of names) {
    const file = path.join(directory, name),
      stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Symlinks, directories and hard links are protected");
    bytes += stat.size;
    parts.push(`${name}:${version(stat)}`);
  }
  const completed = object(await readJson(path.join(directory, "completed.json"), 65536));
  const report = object(await readJson(path.join(directory, "report.json"), 1024 * 1024));
  if (
    typeof completed.input !== "string" ||
    !path.isAbsolute(completed.input) ||
    inside(path.resolve(completed.input), root) ||
    completed.inputSha256 !== match[1] ||
    completed.settings !== job.slice(-16) ||
    typeof completed.outputSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(completed.outputSha256)
  )
    throw new Error("Invalid completion ownership record");
  const validation = object(report.validation),
    totals = object(validation.totals);
  if (
    report.success !== true ||
    validation.exitCode !== 0 ||
    totals.errors !== 0 ||
    totals.fatals !== 0
  )
    throw new Error("Failed or unvalidated revision preserved");
  if ((await hashFile(path.join(directory, "optimized.epub"))) !== completed.outputSha256)
    throw new Error("Output checksum changed; preserving revision");
  await assertOwner(directory, identity(owner));
  const stamp = await fs.lstat(path.join(directory, "completed.json"));
  return {
    job,
    input: completed.input,
    completedMs: stamp.mtimeMs,
    bytes,
    signature: createHash("sha256")
      .update(parts.join("\n") + completed.outputSha256)
      .digest("hex"),
  };
}

/** Read-only inventory and plan. Unknown/failed jobs and originals are never purge candidates. */
export async function planStorage(directory: string, keepRevisions = 2): Promise<StoragePlan> {
  if (!Number.isSafeInteger(keepRevisions) || keepRevisions < 1)
    throw new Error("Keep at least one successful revision per original");
  directory = path.resolve(directory);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory())
    throw new Error("Storage root must be a real directory, not a symbolic link");
  const canonical = await fs.realpath(directory);
  const plan: StoragePlan = {
    schema: 1,
    directory: canonical,
    identity: identity(stat),
    keepRevisions,
    createdAt: new Date().toISOString(),
    verifiedRevisionBytes: 0,
    candidateBytes: 0,
    candidates: [],
    retained: [],
    protected: [],
  };
  const revisions: StorageRevision[] = [];
  for (const entry of (await fs.readdir(canonical, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (entry.name.startsWith(".epub-watch") || entry.name === "index.html") continue;
    if (!entry.isDirectory() || !JOB.test(entry.name)) {
      plan.protected.push({ name: entry.name, reason: "Unrecognized entry preserved" });
      continue;
    }
    try {
      const revision = await inspectRevision(canonical, entry.name);
      revisions.push(revision);
      plan.verifiedRevisionBytes += revision.bytes;
    } catch (error) {
      plan.protected.push({
        name: entry.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const groups = new Map<string, StorageRevision[]>();
  for (const revision of revisions) {
    const group = groups.get(revision.input) ?? [];
    group.push(revision);
    groups.set(revision.input, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => b.completedMs - a.completedMs || a.job.localeCompare(b.job));
    plan.retained.push(...group.slice(0, keepRevisions));
    plan.candidates.push(...group.slice(keepRevisions));
  }
  plan.candidates.sort((a, b) => a.job.localeCompare(b.job));
  plan.retained.sort((a, b) => a.job.localeCompare(b.job));
  plan.candidateBytes = plan.candidates.reduce((sum, item) => sum + item.bytes, 0);
  await assertOwner(canonical, plan.identity);
  return plan;
}

export async function saveStoragePlan(plan: StoragePlan, destination: string): Promise<void> {
  const relative = path.relative(plan.directory, path.resolve(destination));
  if (
    inside(path.resolve(destination), plan.directory) &&
    (relative.split(path.sep).some((part) => JOB.test(part)) ||
      relative.startsWith(".epub-watch") ||
      relative === "index.html")
  )
    throw new Error("Plan must not replace watcher resources");
  await fs.writeFile(destination, JSON.stringify(plan, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}

/** Applying requires a saved preview and a fresh plan identical under the watcher lock. */
export async function applyStoragePlan(
  file: string
): Promise<{ removed: string[]; fileBytes: number }> {
  const saved = object(await readJson(file, 8 * 1024 * 1024));
  if (
    saved.schema !== 1 ||
    typeof saved.directory !== "string" ||
    typeof saved.identity !== "string" ||
    typeof saved.keepRevisions !== "number" ||
    !Array.isArray(saved.candidates)
  )
    throw new Error("Invalid storage plan");
  const directory = saved.directory;
  await assertOwner(directory, saved.identity);
  const kernel = await acquireKernelWatchLock(directory),
    lockPath = path.join(directory, ".epub-watch.lock");
  let lock;
  try {
    if (kernel) await clearRecoverableWatchRecord(lockPath, kernel.identity);
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    await kernel?.release();
    throw error;
  }
  const owner = await lock.stat();
  const removed: string[] = [];
  try {
    await lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        operation: "storage-maintenance",
        method: kernel ? "linux-flock-v1" : "exclusive-file-v1",
        guard: kernel?.identity,
      })
    );
    const current = await planStorage(directory, saved.keepRevisions);
    if (
      current.identity !== saved.identity ||
      JSON.stringify(current.candidates) !== JSON.stringify(saved.candidates)
    )
      throw new Error("Storage changed since preview; generate a new plan");
    for (const item of current.candidates) {
      await assertOwner(directory, saved.identity);
      const verified = await inspectRevision(directory, item.job);
      if (verified.signature !== item.signature)
        throw new Error("Revision changed before deletion");
      const original = path.join(directory, item.job),
        quarantine = path.join(directory, `.epub-prune-${randomUUID()}`);
      const before = await fs.lstat(original);
      await fs.rename(original, quarantine);
      await assertOwner(quarantine, identity(before));
      // Validate every resource before removing any; never recursively traverse a job.
      const names = await fs.readdir(quarantine);
      try {
        for (const name of names) {
          const stat = await fs.lstat(path.join(quarantine, name));
          if (!FILES.has(name) || !stat.isFile() || stat.nlink !== 1)
            throw new Error("Changed quarantine resource preserved");
        }
      } catch (error) {
        // Restore only if the original name is still vacant.
        if (!(await fs.pathExists(original))) await fs.rename(quarantine, original);
        throw error;
      }
      for (const name of names) {
        if (!FILES.has(name)) throw new Error("Unexpected quarantine file preserved");
        await assertOwner(quarantine, identity(before));
        const target = path.join(quarantine, name),
          stat = await fs.lstat(target);
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error("Changed quarantine resource preserved");
        await fs.unlink(target);
      }
      await fs.rmdir(quarantine);
      removed.push(item.job);
    }
    await refreshWatchSummary(directory);
    return { removed, fileBytes: current.candidateBytes };
  } catch (error) {
    throw new Error(
      `Storage purge stopped after ${removed.length} complete revision(s) removed. Inspect any .epub-prune-* recovery directory. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  } finally {
    try {
      await lock.close();
      await assertOwner(directory, saved.identity);
      await removeOwnedLock(lockPath, identity(owner));
    } finally {
      await kernel?.release();
    }
  }
}
async function removeOwnedLock(file: string, expected: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || identity(stat) !== expected)
    throw new Error("Maintenance lock replaced; refusing cleanup");
  await fs.unlink(file);
}
