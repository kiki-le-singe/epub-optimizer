import { fork } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import type { FontSubsetResult } from "./font-engine.js";
import { MAX_FONT_BYTES } from "./font-limits.js";

const exec = promisify(execFile);

/** RSS is sampled, not an OS-enforced hard limit; V8 heap has its own cap. */
async function residentBytes(pid: number): Promise<number> {
  if (process.platform === "linux") {
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    if (!match) throw new Error("Cannot read font worker RSS");
    return Number(match[1]) * 1024;
  }
  const { stdout } = await exec("/bin/ps", ["-o", "rss=", "-p", String(pid)], {
    timeout: 1000,
    maxBuffer: 1024,
  });
  const value = Number(stdout.trim());
  if (!value || !Number.isFinite(value)) throw new Error("Cannot read font worker RSS");
  return value * 1024;
}

interface WorkerLimits {
  timeoutMs?: number;
  rssBytes?: number;
  workerUrl?: URL;
}

export async function runFontWorker(
  font: Buffer,
  characters: string,
  limits: WorkerLimits = {}
): Promise<FontSubsetResult> {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Font worker resource monitoring is unavailable on this platform");
  const url =
    limits.workerUrl ??
    new URL(
      import.meta.url.endsWith(".ts") ? "./font-worker.ts" : "./font-worker.js",
      import.meta.url
    );
  return new Promise((resolve, reject) => {
    const child = fork(url, [], {
      execArgv: ["--experimental-strip-types", "--max-old-space-size=128"],
      env: { NODE_ENV: "production" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    });
    let result: FontSubsetResult | undefined;
    let failure: Error | undefined;
    let active = true;
    let checking = false;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(
      () => stop(new Error("Font worker timed out")),
      limits.timeoutMs ?? 10_000
    );
    const monitor = setInterval(() => {
      if (checking || !active || !child.pid) return;
      checking = true;
      void residentBytes(child.pid)
        .then((rss) => {
          if (active && rss > (limits.rssBytes ?? 256 * 1024 * 1024))
            stop(new Error("Font worker exceeded the sampled 256 MiB RSS budget"));
        })
        .catch(() => {
          if (active && !result) stop(new Error("Font worker memory monitoring failed"));
        })
        .finally(() => {
          checking = false;
        });
    }, 100);
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || result)
        return stop(new Error("Invalid font worker response"));
      const value = message as { data?: unknown; reason?: unknown; error?: unknown };
      if (typeof value.error === "string") return stop(new Error(value.error.slice(0, 240)));
      if (Buffer.isBuffer(value.data) && value.data.length && value.data.length <= MAX_FONT_BYTES)
        result = { data: value.data };
      else if (typeof value.reason === "string") result = { reason: value.reason.slice(0, 240) };
      else stop(new Error("Invalid font worker response"));
    });
    const finish = (error?: Error) => {
      if (!active) return;
      active = false;
      clearTimeout(timeout);
      clearInterval(monitor);
      if (error || failure || !result)
        reject(error ?? failure ?? new Error("Font worker exited without a result"));
      else resolve(result);
    };
    child.once("error", finish);
    child.once("exit", (code) =>
      finish(code === 0 ? undefined : (failure ?? new Error("Font worker failed")))
    );
    child.send({ font, characters }, (error) => {
      if (error && active) stop(error);
    });
  });
}
