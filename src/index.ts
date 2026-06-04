import fs from "fs-extra";
import { parseArguments } from "./cli.js";
import { extractEPUB, compressEPUB } from "./processors/archive-processor.js";
import { processHTML } from "./processors/html-processor.js";
import { optimizeImages } from "./processors/image-processor.js";
import type { Args } from "./types.js";
import { subsetFonts } from "./processors/font-processor.js";
import { convertPngToJpeg } from "./processors/image-converter.js";
import { minifyJavaScript } from "./processors/js-processor.js";
import { optimizeSVGs } from "./processors/svg-optimizer.js";
import { addLazyLoadingToImages } from "./processors/lazy-img.js";
import { assertSafeTempDir, removeTempDir } from "./utils/temp-dir.js";
import path from "node:path";
import { assertDistinctInputOutput, assertSafeOutputTarget } from "./utils/output-transaction.js";

interface OptimizeOptions {
  /** If true, skip the final zip + cleanup. The pipeline uses this so the
   *  fix/structure steps can still operate on the extracted directory and the
   *  final zip is done by create-epub in one go. */
  skipPackaging?: boolean;
  runStep?: <T>(name: string, operation: () => Promise<T> | T) => Promise<T>;
  skipStep?: (name: string, reason: string) => void;
  afterExtract?: (tempDir: string) => Promise<void> | void;
}

/**
 * Extract the EPUB, run all content processors on the temp directory, and
 * (unless `skipPackaging` is set) zip the result back to resolvedArgs.output.
 * @param args Parsed CLI args. If omitted, argv is parsed.
 * @returns Metadata about the run.
 */
async function optimizeEPUB(
  args?: Args,
  options: OptimizeOptions = {}
): Promise<{ success: boolean; input: string; output: string }> {
  const resolvedArgs: Args = args ?? ((await parseArguments()) as Args);
  const runStep =
    options.runStep ?? (async <T>(_name: string, operation: () => Promise<T> | T) => operation());
  const skipStep = options.skipStep ?? (() => {});

  try {
    // Validate inputs
    if (!(await fs.pathExists(resolvedArgs.input))) {
      throw new Error(`Input file not found: ${resolvedArgs.input}`);
    }
    if (!(await fs.stat(resolvedArgs.input)).isFile()) {
      throw new Error(`Input path must point to a regular file: ${resolvedArgs.input}`);
    }
    assertDistinctInputOutput(resolvedArgs.input, resolvedArgs.output);
    await assertSafeOutputTarget(resolvedArgs.output);
    resolvedArgs.temp = assertSafeTempDir(resolvedArgs.temp, {
      inputPath: resolvedArgs.input,
      outputPath: resolvedArgs.output,
    });

    // Create parent directory for output if it doesn't exist
    const outputDir = path.dirname(path.resolve(resolvedArgs.output));
    if (outputDir !== path.parse(outputDir).root) {
      await fs.ensureDir(outputDir);
    }

    // 1. Extract EPUB file
    await runStep("Extract EPUB", () => extractEPUB(resolvedArgs.input, resolvedArgs.temp));
    console.log(`📦 Extracted ${resolvedArgs.input} to ${resolvedArgs.temp}`);
    if (options.afterExtract) {
      await runStep("Analyze input content", () => options.afterExtract?.(resolvedArgs.temp));
    }

    // 2. Process HTML and CSS files
    await runStep("Optimize HTML/CSS", () => processHTML(resolvedArgs.temp));
    console.log("🔄 Optimized HTML/CSS files");

    // 3. Minify JavaScript
    await runStep("Minify JavaScript", () => minifyJavaScript(resolvedArgs.temp));
    console.log("🔄 Minified JavaScript files");

    // 4. Convert large opaque PNGs to JPEG. Resize is chained into the same
    //    sharp pass so converted JPEGs don't need a follow-up downscale — step
    //    5 skips them to avoid a double recompression.
    const maxImageDim = resolvedArgs.maxImageDim > 0 ? resolvedArgs.maxImageDim : undefined;
    let convertedJpegs = new Set<string>();
    if (resolvedArgs.convertPng && !resolvedArgs.lossless) {
      convertedJpegs = await runStep("Convert PNG to JPEG", () =>
        convertPngToJpeg(resolvedArgs.temp, resolvedArgs.jpgQuality, undefined, maxImageDim)
      );
      console.log("🖼️  Converted PNG to JPEG");
    } else {
      skipStep(
        "Convert PNG to JPEG",
        resolvedArgs.lossless ? "Disabled by lossless preset." : "Disabled by CLI option."
      );
    }

    // 5. Single-pass image optimization: resize + re-encode in one sharp
    //    pipeline (replaces the old downscale + optimize split).
    if (!resolvedArgs.lossless) {
      await runStep("Optimize images", () =>
        optimizeImages(resolvedArgs.temp, {
          jpegQuality: resolvedArgs.jpgQuality,
          pngQuality: resolvedArgs.pngQuality,
          maxDim: maxImageDim,
          skip: convertedJpegs,
        })
      );
      console.log("🖼️  Optimized image files");
    } else {
      skipStep("Optimize images", "Disabled by lossless preset.");
    }

    // 6. Optimize SVGs
    await runStep("Optimize SVG", () => optimizeSVGs(resolvedArgs.temp));
    console.log("🖼️  Optimized SVG files");

    // 7. Add lazy loading to images
    if (resolvedArgs.lazyLoading) {
      await runStep("Add lazy loading", () => addLazyLoadingToImages(resolvedArgs.temp));
      console.log("🖼️  Added lazy loading to images");
    } else {
      skipStep("Add lazy loading", "Disabled by preset/CLI option.");
    }

    // 8. Optional font subsetting. Disabled by default because the legacy
    // fontmin dependency tree is not suitable for the production install path.
    await runStep("Process fonts", () =>
      subsetFonts(resolvedArgs.temp, { enabled: resolvedArgs.fonts })
    );
    console.log("🔤 Font processing complete");

    if (!options.skipPackaging) {
      // 9. Recompress as EPUB
      await runStep("Create EPUB", () => compressEPUB(resolvedArgs.output, resolvedArgs.temp));
      console.log(`✅ Created optimized EPUB: ${resolvedArgs.output}`);

      // 10. Clean up temporary files if needed
      if (resolvedArgs.clean) {
        const removedTempDir = await removeTempDir(resolvedArgs.temp, {
          inputPath: resolvedArgs.input,
          outputPath: resolvedArgs.output,
        });
        console.log(`🧹 Removed temporary directory: ${removedTempDir}`);
      } else {
        console.log(`📁 Kept temporary directory: ${resolvedArgs.temp} for inspection`);
      }

      await reportFileSizeComparison(resolvedArgs.input, resolvedArgs.output);
    }

    return { success: true, input: resolvedArgs.input, output: resolvedArgs.output };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`❌ Error: ${error.message}`);
    } else {
      console.error("❌ Unknown error", error);
    }

    throw error;
  }
}

/**
 * Compare and report original vs optimized file sizes
 * @param originalPath Path to original file
 * @param optimizedPath Path to optimized file
 */
async function reportFileSizeComparison(
  originalPath: string,
  optimizedPath: string
): Promise<void> {
  try {
    const originalSize = (await fs.stat(originalPath)).size;
    const optimizedSize = (await fs.stat(optimizedPath)).size;
    const reduction = ((originalSize - optimizedSize) / originalSize) * 100;
    const bytesSaved = originalSize - optimizedSize;

    console.log(`
📊 File Size Comparison:
   Original: ${formatFileSize(originalSize)}
   Optimized: ${formatFileSize(optimizedSize)}
   Reduction: ${reduction.toFixed(2)}% (${formatFileSize(bytesSaved)} saved)
    `);
  } catch {
    console.error("⚠️ Could not generate file size comparison");
  }
}

/**
 * Format file size in human readable format
 * @param bytes File size in bytes
 * @returns Formatted file size
 */
function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

export { formatFileSize, reportFileSizeComparison, optimizeEPUB };
