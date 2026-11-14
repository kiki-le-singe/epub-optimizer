import fs from "fs-extra";
import path from "node:path";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";

export interface KernelWatchLock {
  identity: string;
  release(): Promise<void>;
}

/** Linux flock is released by the kernel after process/container death, across PID namespaces. */
export async function acquireKernelWatchLock(output: string): Promise<KernelWatchLock | undefined> {
  if (process.platform !== "linux") return undefined;
  const guard = path.join(output, ".epub-watch.guard");
  let file;
  try {
    file = await open(guard, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    file = await open(guard, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  let retained = false;
  try {
    const owner = await file.stat();
    if (!owner.isFile() || owner.nlink !== 1) throw new Error("Refusing unsafe watch guard file");
    // fd 3 is a duplicate of our open file description. Linux keeps the lock
    // on our descriptor after the short-lived flock utility exits.
    // https://man7.org/linux/man-pages/man2/flock.2.html
    const result = spawnSync(
      "/usr/bin/flock",
      ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "3"],
      {
        stdio: ["ignore", "pipe", "pipe", file.fd],
        timeout: 5000,
      }
    );
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    if (result.error || result.status !== 0)
      throw new Error(
        result.status === 73
          ? "Another watcher holds the output guard"
          : "Cannot acquire the Linux watch guard"
      );
    const current = await fs.lstat(guard);
    if (
      !current.isFile() ||
      current.dev !== owner.dev ||
      current.ino !== owner.ino ||
      current.nlink !== 1
    )
      throw new Error("Watch guard identity changed");
    // Some shared mounts emulate process-scoped locks. Prove retention via an
    // independently opened descriptor before relying on it for crash recovery.
    const probe = await open(guard, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const check = await probe.stat();
      if (check.dev !== owner.dev || check.ino !== owner.ino)
        throw new Error("Watch guard identity changed");
      const competition = spawnSync(
        "/usr/bin/flock",
        ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "3"],
        { stdio: ["ignore", "pipe", "pipe", probe.fd], timeout: 5000 }
      );
      if (competition.error || ![0, 73].includes(competition.status ?? -1))
        throw new Error("Cannot verify retained watch guard");
      if (competition.status === 0) return undefined;
    } finally {
      await probe.close();
    }
    retained = true;
    return { identity: `${owner.dev}:${owner.ino}`, release: () => file.close() };
  } finally {
    if (!retained) await file.close();
  }
}

/** Only modern kernel-backed records can be recovered while holding the same guard. */
export async function clearRecoverableWatchRecord(
  lock: string,
  guardIdentity: string
): Promise<void> {
  let handle;
  try {
    handle = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const owner = await handle.stat();
    if (!owner.isFile() || owner.size > 65536 || owner.nlink !== 1)
      throw new Error("Unsafe watch lock record");
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw new Error("Oversized watch lock record");
    const record: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (
      !record ||
      typeof record !== "object" ||
      !("method" in record) ||
      record.method !== "linux-flock-v1" ||
      !("guard" in record) ||
      record.guard !== guardIdentity
    )
      throw new Error(
        "Legacy or unknown watch lock requires manual recovery after confirming inactivity"
      );
    const current = await fs.lstat(lock);
    if (!current.isFile() || current.dev !== owner.dev || current.ino !== owner.ino)
      throw new Error("Watch lock identity changed");
    await fs.unlink(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    await handle?.close();
  }
}
