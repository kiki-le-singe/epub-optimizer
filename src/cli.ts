import { readCliConfig } from "./utils/cli-config.js";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import config from "./utils/config.js";
import type { Args } from "./types.js";
import fs from "fs-extra";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_FILE_CONCURRENCY } from "./utils/files.js";
import { applyPipelineOptions } from "./utils/pipeline-options.js";
import { findPackageRoot } from "./utils/package-root.js";

const packageJson = JSON.parse(
  fs.readFileSync(path.join(findPackageRoot(import.meta.url), "package.json"), "utf8")
);

/**
 * Parse command line arguments
 * @returns Promise<Args> Parsed CLI options
 */
async function parseArguments(): Promise<Args> {
  const parsed = await yargs(hideBin(process.argv))
    .config(
      "config",
      "Load explicit JSON configuration (CLI options take precedence)",
      readCliConfig
    )
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
    .option("batch", {
      describe: "Optimize regular EPUB files in this directory (non-recursive)",
      type: "string",
    })
    .option("jobs", {
      describe: "Concurrent batch books (1-4); each has its own image and Java memory use",
      type: "number",
      default: 1,
    })
    .option("storage", {
      describe: "Inspect watcher output storage without deleting files",
      type: "string",
    })
    .option("storage-plan", {
      describe: "Save a new read-only storage purge preview",
      type: "string",
    })
    .option("apply-storage-plan", {
      describe: "Apply a saved and reverified storage plan",
      type: "string",
    })
    .option("keep-revisions", {
      describe: "Successful revisions retained per original (minimum 1)",
      type: "number",
      default: 2,
    })
    .option("watch", {
      describe: "Continuously optimize stable EPUB files in this directory (non-recursive)",
      type: "string",
    })
    .option("watch-settle-ms", {
      describe: "Wait this long without file changes before processing a watched EPUB",
      type: "number",
      default: 3000,
    })
    .option("output-dir", {
      describe: "Destination directory for batch/watch outputs and per-book reports",
      type: "string",
    })
    .option("temp", {
      alias: "t",
      describe: "New temporary directory (must not already exist); unique by default",
      type: "string",
      default: () => `${config.tempDir}-${randomUUID()}`,
      defaultDescription: "unique temp_epub-<id> directory",
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
    .option("png-background", {
      describe:
        "Flatten eligible transparent PNGs onto an opaque #RRGGBB color before JPEG conversion",
      type: "string",
      requiresArg: true,
    })
    .option("lang", {
      describe: "UI language for labels (e.g. fr, en)",
      type: "string",
      default: config.lang,
    })
    .option("fonts", {
      describe: "Enable conservative HarfBuzz font subsetting (optional)",
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
    .option("validation-timeout", {
      describe: "Maximum EPUBCheck runtime in milliseconds",
      type: "number",
      default: config.epubcheckTimeoutMs,
    })
    .option("image-concurrency", {
      describe: "Concurrent image operations (1-64); lower values reduce memory use",
      type: "number",
      default: DEFAULT_FILE_CONCURRENCY,
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
    .option("report-html", {
      describe: "Write a standalone HTML optimization report",
      type: "string",
    })
    .option("doctor", {
      alias: "inspect",
      describe: "Inspect an EPUB without optimizing or writing an output EPUB",
      type: "boolean",
      default: false,
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
    .example("epub-optimizer --doctor -i input.epub", "Inspect without modifying the EPUB")
    .help()
    .alias("help", "h")
    .version(packageJson.version)
    .alias("version", "v")
    .strict()
    .check((argv) => {
      if (argv.config !== undefined && typeof argv.config !== "string")
        throw new Error("Choose a single --config file.");
      for (const key of ["storage", "storage-plan", "apply-storage-plan"] as const) {
        if (argv[key] !== undefined && !argv[key]?.trim())
          throw new Error(`--${key} requires a non-empty path.`);
      }
      const explicit = hideBin(process.argv);
      const configFile = typeof argv.config === "string" ? readCliConfig(argv.config) : {};
      const hasExplicitPaths =
        explicit.some(
          (value) => /^(--input|--output|--temp)(=|$)/.test(value) || /^-[iot]/.test(value)
        ) || ["input", "output", "temp"].some((key) => key in configFile);
      if (argv.storage || argv["apply-storage-plan"]) {
        if (
          hasExplicitPaths ||
          argv.config ||
          argv.watch ||
          argv.batch ||
          argv.doctor ||
          argv.inspect ||
          argv["output-dir"] ||
          argv["report-json"] ||
          argv["report-html"] ||
          (argv.storage && argv["apply-storage-plan"])
        )
          throw new Error(
            "Storage maintenance cannot be combined with optimization modes or reports."
          );
        if (argv["apply-storage-plan"] && argv["storage-plan"])
          throw new Error("Choose storage preview or apply, not both.");
      } else if (argv["storage-plan"]) throw new Error("--storage-plan requires --storage.");
      if (!Number.isSafeInteger(argv["keep-revisions"]) || argv["keep-revisions"] < 1)
        throw new Error("--keep-revisions must be an integer of at least 1.");
      if (!Number.isSafeInteger(argv.jobs) || argv.jobs < 1 || argv.jobs > 4)
        throw new Error("--jobs must be an integer between 1 and 4.");
      if (argv.jobs !== 1 && !argv.batch) throw new Error("--jobs requires --batch.");
      if (argv.watch && argv.batch) throw new Error("--watch cannot be combined with --batch.");
      if (!Number.isSafeInteger(argv["watch-settle-ms"]) || argv["watch-settle-ms"] < 1000)
        throw new Error("--watch-settle-ms must be an integer of at least 1000.");
      if (argv.watch && (argv["report-json"] || argv["report-html"]))
        throw new Error("Watch writes per-book JSON and HTML reports automatically.");
      if (argv.batch || argv.watch) {
        if (!argv["output-dir"]) throw new Error("--batch/--watch requires --output-dir.");
        if (argv.doctor || argv.inspect)
          throw new Error("--batch/--watch supports optimization only.");
        if (hasExplicitPaths) {
          throw new Error(
            "--batch/--watch cannot be combined with explicit --input, --output or --temp."
          );
        }
      } else if (argv["output-dir"]) throw new Error("--output-dir requires --batch or --watch.");
      if (argv["report-html"] && (argv.doctor || argv.inspect))
        throw new Error("--report-html is for optimization runs; use --report-json with --doctor.");
      if (
        !Number.isInteger(argv["image-concurrency"]) ||
        argv["image-concurrency"] < 1 ||
        argv["image-concurrency"] > 64
      ) {
        throw new Error("--image-concurrency must be an integer between 1 and 64.");
      }
      if (
        !Number.isSafeInteger(argv["validation-timeout"]) ||
        argv["validation-timeout"] <= 0 ||
        argv["validation-timeout"] > 2_147_483_647
      ) {
        throw new Error(
          "--validation-timeout must be a positive integer no larger than 2147483647."
        );
      }
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
