import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import config from "./utils/config.js";
import type { Args } from "./types.js";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Walk up from this file to find package.json — robust whether running from
// src/ (vitest) or dist/src/ (compiled).
function findPackageJson(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("package.json not found");
}
const packageJson = JSON.parse(fs.readFileSync(findPackageJson(), "utf8"));

/**
 * Parse command line arguments
 * @returns Promise<Args> Parsed CLI options
 */
async function parseArguments(): Promise<Args> {
  const parsed = await yargs(hideBin(process.argv))
    .usage(`${packageJson.description}\n\nUsage: pnpm build [options]`)
    .option("input", {
      alias: "i",
      describe: "Input EPUB file path",
      type: "string",
      default: config.inputEPUB,
    })
    .option("output", {
      alias: "o",
      describe: "Output EPUB file path",
      type: "string",
      default: config.outputEPUB,
    })
    .option("temp", {
      alias: "t",
      describe: "Temporary directory for processing",
      type: "string",
      default: config.tempDir,
    })
    .option("jpg-quality", {
      describe: "JPEG compression quality (0-100)",
      type: "number",
      default: config.jpegOptions.quality,
    })
    .option("png-quality", {
      describe: "PNG compression quality (0-1 scale, use decimal)",
      type: "number",
      default: config.pngOptions.quality,
    })
    .option("lang", {
      describe: "UI language for labels (e.g. fr, en)",
      type: "string",
      default: config.lang,
    })
    .option("clean", {
      describe: "Clean temporary files after processing",
      type: "boolean",
      default: false,
    })
    .example("pnpm build -i book.epub -o book-optimized.epub", "Basic optimization")
    .example("pnpm build:clean -i book.epub -o book-opt.epub", "Optimize and clean temp files")
    .example("pnpm build -i book.epub -o book-opt.epub --jpg-quality 85", "Higher JPEG quality")
    .example("pnpm build -i book.epub -o book-opt.epub --png-quality 0.9", "Higher PNG quality")
    .example(
      "pnpm build -i input.epub -o output.epub --jpg-quality 85 --png-quality 0.8",
      "Custom image settings"
    )
    .help()
    .alias("help", "h")
    .version(packageJson.version)
    .alias("version", "v")
    .strict()
    .parseAsync();

  // yargs exposes both kebab-case and camelCase keys at runtime; `Args`
  // reflects that. A single assertion is enough — no `unknown` bridge.
  return parsed as Args;
}

export { parseArguments };
