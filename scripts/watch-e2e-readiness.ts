import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Completion records precede summary publication; wait for the summary itself. */
export async function waitForWatchOverview(
  output: string,
  expected: readonly string[],
  options: { timeoutMs?: number; pollIntervalMs?: number; logs?: () => string } = {}
): Promise<void> {
  const file = path.join(output, "index.html");
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  for (;;) {
    let missing: readonly string[];
    try {
      const html = await fs.readFile(file, "utf8");
      missing = expected.filter((text) => !html.includes(text));
      if (!missing.length) return;
    } catch (error) {
      // Initial publication can still be pending. Real I/O failures must fail.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing = [...expected];
    }
    if (Date.now() >= deadline)
      throw new Error(
        `Watch summary timed out at ${file}; missing: ${missing.join(", ")}.\n${options.logs?.() ?? ""}`
      );
    await delay(Math.min(options.pollIntervalMs ?? 100, Math.max(0, deadline - Date.now())));
  }
}
