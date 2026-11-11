import { reportError, reportInfo, reportWarning } from "../utils/diagnostics.js";
import fs from "fs-extra";
import { extractEPUB } from "./archive-processor.js";
import { processHTML } from "./html-processor.js";
import { optimizeImages } from "./image-processor.js";
import type { Args } from "../types.js";
import { subsetFonts } from "./font-processor.js";
import { convertPngToJpeg } from "./image-converter.js";
import { minifyJavaScript } from "./js-processor.js";
import { optimizeSVGs } from "./svg-optimizer.js";
import { addLazyLoadingToImages } from "./lazy-img.js";
import { assertSafeTempDir } from "../utils/temp-dir.js";
import path from "node:path";
import { assertDistinctInputOutput, assertSafeOutputTarget } from "../utils/output-transaction.js";
import { detectEpubFeatures } from "../utils/epub-features.js";
import { assertNoInternalDtdSubsets } from "../utils/xml-dtd.js";

export interface ContentProcessingOptions {
  runStep?: <T>(name: string, operation: () => Promise<T> | T) => Promise<T>;
  skipStep?: (name: string, reason: string) => void;
  afterExtract?: (tempDir: string) => Promise<void> | void;
}

/**
 * Extract the EPUB and run its content processors without publishing an output.
 * The shared optimization pipeline validates and publishes the resulting candidate.
 * @param args Resolved optimization options.
 * @returns Metadata about the run.
 */
export async function processEpubContent(
  args: Args,
  options: ContentProcessingOptions = {}
): Promise<{ success: boolean; input: string; output: string }> {
  const resolvedArgs = args;
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
    reportInfo(`📦 Extracted ${resolvedArgs.input} to ${resolvedArgs.temp}`);

    // 1b. Detect special EPUB shapes early so we degrade gracefully instead of
    //     silently corrupting them: refuse DRM-encrypted books, leave obfuscated
    //     fonts untouched, and keep fixed-layout page images at their native size.
    await runStep("Analyze EPUB structure", async () => {
      await assertNoInternalDtdSubsets(resolvedArgs.temp);
      const features = await detectEpubFeatures(resolvedArgs.temp);
      if (features.encryptionKind === "drm") {
        throw new Error(
          "EPUB contains encrypted/DRM-protected resources (META-INF/encryption.xml). " +
            "Optimizing would corrupt the protected content, so the operation was refused."
        );
      }
      if (features.encryptionKind === "obfuscation") {
        reportWarning(
          "⚠️  Obfuscated embedded fonts detected (META-INF/encryption.xml); optimizing " +
            "everything else and leaving the fonts untouched."
        );
        resolvedArgs.fonts = false;
      }
      if (features.fixedLayout && resolvedArgs.maxImageDim > 0) {
        reportWarning(
          "⚠️  Fixed-layout (pre-paginated) EPUB detected; disabling image downscaling " +
            "to keep page images aligned with the declared viewport."
        );
        resolvedArgs.maxImageDim = 0;
      }
    });

    if (options.afterExtract) {
      await runStep("Analyze input content", () => options.afterExtract?.(resolvedArgs.temp));
    }

    // 2. Process HTML and CSS files
    await runStep("Optimize HTML/CSS", () => processHTML(resolvedArgs.temp));
    reportInfo("🔄 Optimized HTML/CSS files");

    // 3. Minify JavaScript
    await runStep("Minify JavaScript", () => minifyJavaScript(resolvedArgs.temp));
    reportInfo("🔄 Minified JavaScript files");

    // 4. Convert large opaque PNGs to JPEG. Resize is chained into the same
    //    sharp pass so converted JPEGs don't need a follow-up downscale — step
    //    5 skips them to avoid a double recompression.
    const maxImageDim = resolvedArgs.maxImageDim > 0 ? resolvedArgs.maxImageDim : undefined;
    let convertedJpegs = new Set<string>();
    if (resolvedArgs.convertPng && !resolvedArgs.lossless) {
      convertedJpegs = await runStep("Convert PNG to JPEG", () =>
        convertPngToJpeg(
          resolvedArgs.temp,
          resolvedArgs.jpgQuality,
          resolvedArgs.imageConcurrency,
          maxImageDim
        )
      );
      reportInfo("🖼️  Converted PNG to JPEG");
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
          concurrency: resolvedArgs.imageConcurrency,
        })
      );
      reportInfo("🖼️  Optimized image files");
    } else {
      skipStep("Optimize images", "Disabled by lossless preset.");
    }

    // 6. Optimize SVGs
    await runStep("Optimize SVG", () => optimizeSVGs(resolvedArgs.temp));
    reportInfo("🖼️  Optimized SVG files");

    // 7. Add lazy loading to images
    if (resolvedArgs.lazyLoading) {
      await runStep("Add lazy loading", () => addLazyLoadingToImages(resolvedArgs.temp));
      reportInfo("🖼️  Added lazy loading to images");
    } else {
      skipStep("Add lazy loading", "Disabled by preset/CLI option.");
    }

    // 8. Optional font subsetting. Disabled by default because the legacy
    // fontmin dependency tree is not suitable for the production install path.
    await runStep("Process fonts", () =>
      subsetFonts(resolvedArgs.temp, { enabled: resolvedArgs.fonts })
    );
    reportInfo("🔤 Font processing complete");

    return { success: true, input: resolvedArgs.input, output: resolvedArgs.output };
  } catch (error) {
    if (error instanceof Error) {
      reportError(`❌ Error: ${error.message}`);
    } else {
      reportError("❌ Unknown error", error);
    }

    throw error;
  }
}
