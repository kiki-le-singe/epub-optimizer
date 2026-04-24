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

interface OptimizeOptions {
  /** If true, skip the final zip + cleanup. The pipeline uses this so the
   *  fix/structure steps can still operate on the extracted directory and the
   *  final zip is done by create-epub in one go. */
  skipPackaging?: boolean;
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

  try {
    // Validate inputs
    if (!(await fs.pathExists(resolvedArgs.input))) {
      throw new Error(`Input file not found: ${resolvedArgs.input}`);
    }

    // Create parent directory for output if it doesn't exist
    const outputDir = resolvedArgs.output.split("/").slice(0, -1).join("/");
    if (outputDir) {
      await fs.ensureDir(outputDir);
    }

    // 1. Extract EPUB file
    await extractEPUB(resolvedArgs.input, resolvedArgs.temp);
    console.log(`📦 Extracted ${resolvedArgs.input} to ${resolvedArgs.temp}`);

    // 2. Process HTML and CSS files
    await processHTML(resolvedArgs.temp);
    console.log("🔄 Optimized HTML/CSS files");

    // 3. Minify JavaScript
    await minifyJavaScript(resolvedArgs.temp);
    console.log("🔄 Minified JavaScript files");

    // 4. Convert large opaque PNGs to JPEG (returns the set of freshly-encoded
    //    JPEGs so step 5 can skip re-encoding them).
    const convertedJpegs = await convertPngToJpeg(resolvedArgs.temp, resolvedArgs.jpgQuality);
    console.log("🖼️  Converted PNG to JPEG");

    // 5. Single-pass image optimization: resize to max 1600px AND re-encode
    //    in one sharp pipeline (replaces the old downscale + optimize split).
    await optimizeImages(resolvedArgs.temp, {
      jpegQuality: resolvedArgs.jpgQuality,
      pngQuality: resolvedArgs.pngQuality,
      maxDim: 1600,
      skip: convertedJpegs,
    });
    console.log("🖼️  Optimized image files");

    // 6. Optimize SVGs
    await optimizeSVGs(resolvedArgs.temp);
    console.log("🖼️  Optimized SVG files");

    // 7. Add lazy loading to images
    await addLazyLoadingToImages(resolvedArgs.temp);
    console.log("🖼️  Added lazy loading to images");

    // 8. Subset fonts
    await subsetFonts(resolvedArgs.temp);
    console.log("🔤 Subset fonts");

    if (!options.skipPackaging) {
      // 9. Recompress as EPUB
      await compressEPUB(resolvedArgs.output, resolvedArgs.temp);
      console.log(`✅ Created optimized EPUB: ${resolvedArgs.output}`);

      // 10. Clean up temporary files if needed
      if (resolvedArgs.clean) {
        await fs.remove(resolvedArgs.temp);
        console.log(`🧹 Removed temporary directory: ${resolvedArgs.temp}`);
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

    // Only exit the process in a non-test environment
    if (process.env.NODE_ENV !== "test") {
      process.exit(1);
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
