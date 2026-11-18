import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  acquireKernelWatchLock,
  clearRecoverableWatchRecord,
  type KernelWatchLock,
} from "./watch-lock.js";
let root: string;
const locks: KernelWatchLock[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-watch-test-"));
});
afterEach(async () => {
  for (const lock of locks.splice(0)) await lock.release();
  await fs.remove(root);
});
it.skipIf(process.platform !== "linux")(
  "retains the kernel lock after the flock subprocess exits",
  async () => {
    const first = await acquireKernelWatchLock(root);
    expect(first).toBeDefined();
    if (!first) return;
    locks.push(first);
    await expect(acquireKernelWatchLock(root)).rejects.toThrow("holds the output guard");
    await first.release();
    locks.pop();
    const next = await acquireKernelWatchLock(root);
    expect(next).toBeDefined();
    if (next) locks.push(next);
  }
);
it("preserves legacy, malformed, symlink and foreign-guard records", async () => {
  const file = path.join(root, "lock");
  for (const contents of [
    '{"pid":123}',
    "invalid",
    '{"method":"linux-flock-v1","guard":"foreign"}',
  ]) {
    await fs.writeFile(file, contents);
    await expect(clearRecoverableWatchRecord(file, "owned")).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(contents);
  }
  const original = path.join(root, "original");
  await fs.writeFile(original, "keep");
  await fs.remove(file);
  await fs.symlink(original, file);
  await expect(clearRecoverableWatchRecord(file, "owned")).rejects.toThrow();
  expect(await fs.readFile(original, "utf8")).toBe("keep");
});
it("removes only a regular modern record for the acquired guard", async () => {
  const file = path.join(root, "lock");
  await fs.writeJson(file, { method: "linux-flock-v1", guard: "owned" });
  await clearRecoverableWatchRecord(file, "owned");
  expect(await fs.pathExists(file)).toBe(false);
  await clearRecoverableWatchRecord(file, "owned");
});
it("rejects oversized records and hard links", async () => {
  const file = path.join(root, "lock");
  await fs.writeFile(file, " ".repeat(65537));
  await expect(clearRecoverableWatchRecord(file, "owned")).rejects.toThrow();
  await fs.writeJson(file, { method: "linux-flock-v1", guard: "owned" });
  await fs.link(file, path.join(root, "other"));
  await expect(clearRecoverableWatchRecord(file, "owned")).rejects.toThrow("Unsafe");
});
it.skipIf(process.platform !== "linux")(
  "refuses a hard-linked or symlinked guard without keeping a lock or touching its target",
  async () => {
    const guard = path.join(root, ".epub-watch.guard");
    const other = path.join(root, "other");
    await fs.writeFile(guard, "");
    await fs.link(guard, other);
    await expect(acquireKernelWatchLock(root)).rejects.toThrow("Refusing unsafe watch guard file");

    await fs.remove(guard);
    await fs.writeFile(other, "keep");
    await fs.symlink(other, guard);
    await expect(acquireKernelWatchLock(root)).rejects.toThrow();
    expect(await fs.readFile(other, "utf8")).toBe("keep");
    expect((await fs.lstat(guard)).isSymbolicLink()).toBe(true);

    // Neither refusal may leave the guard locked: a clean guard is acquirable at once.
    await fs.remove(guard);
    const lock = await acquireKernelWatchLock(root);
    expect(lock).toBeDefined();
    if (lock) locks.push(lock);
  }
);
it.skipIf(process.platform !== "linux")(
  "identifies the guard file so only records written under it are recoverable",
  async () => {
    const lock = await acquireKernelWatchLock(root);
    expect(lock).toBeDefined();
    if (!lock) return;
    locks.push(lock);
    const guard = await fs.stat(path.join(root, ".epub-watch.guard"));
    expect(lock.identity).toBe(`${guard.dev}:${guard.ino}`);
    expect(guard.mode & 0o777).toBe(0o600);

    const record = path.join(root, "lock");
    await fs.writeJson(record, { method: "linux-flock-v1", guard: "0:0" });
    await expect(clearRecoverableWatchRecord(record, lock.identity)).rejects.toThrow("Legacy");
    await fs.writeJson(record, { method: "linux-flock-v1", guard: lock.identity });
    await clearRecoverableWatchRecord(record, lock.identity);
    expect(await fs.pathExists(record)).toBe(false);
  }
);
it.skipIf(process.platform === "linux")(
  "offers no kernel lock, and creates no guard file, outside Linux",
  async () => {
    expect(await acquireKernelWatchLock(root)).toBeUndefined();
    expect(await fs.readdir(root)).toEqual([]);
  }
);
