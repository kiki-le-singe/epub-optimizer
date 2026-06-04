import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import config from "./utils/config.js";
import type { Args } from "./types.js";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyPipelineOptions } from "./utils/pipeline-options.js";

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
    .usage(`${packageJson.description}\n\nUsage: epub-optimizer [options]`)
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
    .option("fonts", {
      describe: "Enable experimental font subsetting (requires installing fontmin separately)",
      type: "boolean",
      default: false,
    })
    .option("preset", {
      describe: "Optimization preset",
      choices: ["balanced", "lossless", "author"] as const,
      default: "balanced" as const,
    })
    .option("repair", {
      describe: "Apply potentially modifying XHTML repair passes",
      type: "boolean",
      default: false,
    })
    .option("author-workflow", {
      describe: "Enable this project's complete author workflow (includes --repair)",
      type: "boolean",
      default: false,
    })
    .option("author-config", {
      describe: "JSON overrides for the author workflow's summary, cover, and CSS class mapping",
      type: "string",
    })
    .option("convert-png", {
      describe: "Convert large opaque PNG files to JPEG when safe",
      type: "boolean",
    })
    .option("lazy-loading", {
      describe: 'Add loading="lazy" to XHTML images',
      type: "boolean",
    })
    .option("max-image-dim", {
      describe: "Maximum image width/height in pixels; 0 disables resizing",
      type: "number",
    })
    .option("strict", {
      describe: "Fail when a processing step emits warnings or errors",
      type: "boolean",
      default: false,
    })
    .option("profile", {
      describe: "Print execution time for each pipeline step",
      type: "boolean",
      default: false,
    })
    .option("report-json", {
      describe: "Write a structured pipeline report to this JSON file",
      type: "string",
    })
    .option("clean", {
      describe: "Clean temporary files after processing",
      type: "boolean",
      default: false,
    })
    .example("pnpm optimize -i book.epub -o book-optimized.epub", "Basic optimization")
    .example("pnpm optimize -i book.epub -o book-opt.epub --clean", "Optimize and clean temp files")
    .example("pnpm optimize -i book.epub -o book-opt.epub --jpg-quality 85", "Higher JPEG quality")
    .example("pnpm optimize -i book.epub -o book-opt.epub --png-quality 0.9", "Higher PNG quality")
    .example("pnpm optimize -i book.epub -o book-opt.epub --fonts", "Enable font subsetting")
    .example("pnpm optimize:lossless -i book.epub -o book-opt.epub", "Avoid lossy image changes")
    .example("pnpm optimize:repair -i book.epub -o book-opt.epub", "Apply XHTML repair passes")
    .example(
      "pnpm optimize:author -i book.epub -o book-opt.epub",
      "Use the project author's complete Pages/manual-summary workflow"
    )
    .example(
      "pnpm optimize:author -i book.epub -o book-opt.epub --author-config author-workflow.json",
      "Override the author workflow's summary, cover, and CSS class mapping"
    )
    .example(
      "epub-optimizer -i input.epub -o output.epub --jpg-quality 85 --png-quality 0.8",
      "Custom image settings"
    )
    .help()
    .alias("help", "h")
    .version(packageJson.version)
    .alias("version", "v")
    .strict()
    .check((argv) => {
      const jpgQuality = Number(argv["jpg-quality"]);
      const pngQuality = Number(argv["png-quality"]);
      const maxImageDim = argv["max-image-dim"];
      if (jpgQuality < 0 || jpgQuality > 100) {
        throw new Error("--jpg-quality must be between 0 and 100.");
      }
      if (pngQuality < 0 || pngQuality > 1) {
        throw new Error("--png-quality must be between 0 and 1.");
      }
      if (maxImageDim !== undefined && Number(maxImageDim) < 0) {
        throw new Error("--max-image-dim must be 0 or greater.");
      }
      if (argv["author-config"] && argv.preset !== "author" && argv["author-workflow"] !== true) {
        throw new Error("--author-config requires --preset author or --author-workflow.");
      }
      return true;
    })
    .parseAsync();

  // yargs exposes both kebab-case and camelCase keys at runtime; `Args`
  // reflects that. A single assertion is enough — no `unknown` bridge.
  return applyPipelineOptions(parsed as unknown as Args);
}

export { parseArguments };
