import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import pLimit from "p-limit";

async function collectFiles(
  dir: string,
  shouldInclude: (filePath: string) => boolean
): Promise<string[]> {
  if (!(await fs.pathExists(dir))) {
    return [];
  }

  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await collectFiles(fullPath, shouldInclude)));
      } else if (shouldInclude(fullPath)) {
        out.push(fullPath);
      }
    })
  );

  return out;
}

function hasExtension(filePath: string, extensions: ReadonlySet<string>): boolean {
  return extensions.has(path.extname(filePath).toLowerCase());
}

/**
 * Default bound for CPU-bound per-file work (HTML/CSS/JS/SVG minification).
 * Keeps parallel processing from oversubscribing cores on small machines.
 */
export const DEFAULT_FILE_CONCURRENCY = Math.max(1, Math.min(8, os.cpus().length));

/**
 * Runs `worker` over `items` with bounded concurrency. Rejects on the first
 * worker rejection (fail-fast for callers that re-throw); workers that catch
 * their own errors keep it lenient.
 */
async function forEachFileLimited<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  concurrency: number = DEFAULT_FILE_CONCURRENCY
): Promise<void> {
  const limit = pLimit(concurrency);
  await Promise.all(items.map((item) => limit(() => worker(item))));
}

export { collectFiles, hasExtension, forEachFileLimited };
