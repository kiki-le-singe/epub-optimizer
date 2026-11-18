import { assertDistinctInputOutput } from "./output-transaction.js";
import fs from "node:fs";
import path from "node:path";

const paths = new Set([
  "input",
  "output",
  "temp",
  "batch",
  "watch",
  "output-dir",
  "report-json",
  "report-html",
  "author-config",
]);
const strings = new Set([...paths, "preset", "lang", "png-background"]);
const numbers = new Set([
  "jpg-quality",
  "png-quality",
  "min-image-ssim",
  "max-image-dim",
  "image-concurrency",
  "validation-timeout",
  "watch-settle-ms",
  "jobs",
]);
const booleans = new Set([
  "fonts",
  "repair",
  "author-workflow",
  "convert-png",
  "convert-webp",
  "lazy-loading",
  "strict",
  "profile",
  "clean",
  "doctor",
]);

/** JSON only: no executable configuration, includes, environment interpolation or purge actions. */
export function readCliConfig(file: string): Record<string, unknown> {
  const handle = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size > 65536)
      throw new Error("Configuration must be a regular JSON file of at most 64 KiB.");
    const bytes = Buffer.alloc(65537);
    let count = 0;
    while (count < bytes.length) {
      const size = fs.readSync(handle, bytes, count, bytes.length - count, count);
      if (!size) break;
      count += size;
    }
    if (count > 65536) throw new Error("Configuration exceeds 64 KiB.");
    const value: unknown = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Configuration must be a JSON object.");
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!strings.has(key) && !numbers.has(key) && !booleans.has(key))
        throw new Error(`Unsupported configuration key: ${key}`);
      if (
        (strings.has(key) && (typeof item !== "string" || !item.trim())) ||
        (numbers.has(key) && (typeof item !== "number" || !Number.isFinite(item))) ||
        (booleans.has(key) && typeof item !== "boolean")
      )
        throw new Error(`Invalid configuration value: ${key}`);
      result[key] = paths.has(key)
        ? path.resolve(path.dirname(path.resolve(file)), item as string)
        : item;
    }
    return result;
  } finally {
    fs.closeSync(handle);
  }
}

/** A settings file is an input too: generated output must never replace it. */
export function protectCliConfig(
  file: string,
  targets: Array<string | undefined>,
  outputDirectory?: string
): void {
  for (const target of targets) if (target) assertDistinctInputOutput(file, target);
  if (outputDirectory && fs.existsSync(outputDirectory)) {
    const relative = path.relative(fs.realpathSync(outputDirectory), fs.realpathSync(file));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
      throw new Error("Keep --config outside the batch/watch output directory.");
  }
}
