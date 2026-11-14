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
