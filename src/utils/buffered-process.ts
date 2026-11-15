import { spawn } from "node:child_process";

export interface BufferedResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
/** Bounded async capture; timeout and output overflow kill the child before completion. */
export function runBufferedProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  maxBytes = 16 * 1024 * 1024
): Promise<BufferedResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let size = 0,
      error: Error | undefined;
    const stop = (message: string, code: string) => {
      error ??= Object.assign(new Error(message), { code });
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("Process timed out", "ETIMEDOUT"), timeoutMs);
    const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
      const available = Math.max(0, maxBytes - size);
      if (available) chunks.push(chunk.subarray(0, available));
      size += chunk.length;
      if (size > maxBytes) stop("Process output exceeded its buffer limit", "ENOBUFS");
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (failure) => {
      error ??= failure;
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        error,
      });
    });
  });
}
