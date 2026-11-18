import { reportError, reportInfo } from "../utils/diagnostics.js";
import fs from "fs-extra";
import path from "node:path";
import sharp, { type OutputInfo, type Sharp } from "sharp";
import pLimit from "p-limit";
import config from "../utils/config.js";
import { randomUUID } from "node:crypto";
import { DEFAULT_FILE_CONCURRENCY } from "../utils/files.js";
import { isAnimatedPng } from "../utils/png-animation.js";
import {
  DEFAULT_MIN_IMAGE_SSIM,
  imageSsim,
  type ImageQualityRecord,
} from "../utils/image-quality.js";

// Bound libvips so parallel encodes don't oversubscribe CPU threads or retain
// decoded-image memory. File-level parallelism is handled by p-limit below, so
// each sharp op runs single-threaded and the operation cache is disabled.
sharp.concurrency(1);
sharp.cache(false);

export interface ImageOpts {
  /** JPEG quality 0-100 */
  jpegQuality?: number;
  /** PNG quality 0-1 scale */
  pngQuality?: number;
  /** Max concurrent image encodes. Default 8 — libvips is thread-safe. */
  concurrency?: number;
  /** Max width/height in px; larger images are shrunk. Skip when unset. */
  maxDim?: number;
  /** Absolute paths that should be skipped (e.g. freshly converted elsewhere). */
  skip?: ReadonlySet<string>;
  /** Minimum SSIM for a lossy re-encode; 0 disables the guard. Default 0.85. */
  minSsim?: number;
  /** Root for record paths; defaults to the optimized directory. */
  root?: string;
  /** Receives the measured quality of each lossy re-encode. */
  onQuality?: (record: ImageQualityRecord) => void;
}

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|svg)$/i;

async function collectImages(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir);
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        out.push(...(await collectImages(fullPath)));
      } else if (IMAGE_EXT_RE.test(entry)) {
        out.push(fullPath);
      }
    })
  );
  return out;
}

/**
 * Optimize images in a directory recursively, in parallel.
 * Combines resize (if `maxDim` is set) and re-encode into a single sharp pass.
 * @param opts Quality overrides; falls back to config defaults.
 */
async function optimizeImages(dir: string, opts: ImageOpts = {}): Promise<void> {
  try {
    const files = await collectImages(dir);
    const skip = opts.skip;
    const targets = skip ? files.filter((f) => !skip.has(f)) : files;
    const limit = pLimit(opts.concurrency ?? DEFAULT_FILE_CONCURRENCY);
    await Promise.all(
      targets.map((file) => limit(() => compressImage(file, { root: dir, ...opts })))
    );
  } catch (error) {
    reportError(
      `Error processing directory ${dir}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Compress a single image using Sharp.
 * @param opts Quality overrides; falls back to config defaults.
 */
async function compressImage(imagePath: string, opts: ImageOpts = {}): Promise<void> {
  const filename = path.basename(imagePath);
  const jpegQuality = opts.jpegQuality ?? config.jpegOptions.quality;
  const pngQuality = opts.pngQuality ?? config.pngOptions.quality;
  let tempPath: string | undefined;

  try {
    const extension = path.extname(imagePath).toLowerCase();

    // Skip SVG files as they're already text/XML
    if (extension === ".svg") {
      return;
    }

    // Read the size cheaply first and skip tiny images without loading them.
    const originalSize = (await fs.stat(imagePath)).size;
    if (originalSize < 10 * 1024) {
      reportInfo(`⏩ Skipping small image: ${filename}`);
      return;
    }

    // Sharp's PNG decoder exposes only the default image of an APNG. Keep its
    // original bytes, including animation control, timing and disposal modes.
    if (extension === ".png" && (await isAnimatedPng(imagePath))) {
      reportInfo(`Keeping animated PNG unchanged: ${filename}`);
      return;
    }

    // Preserve every frame of multi-frame formats instead of collapsing to the
    // first one. `animated` is a harmless no-op for single-frame images.
    const isMultiFrame = extension === ".gif" || extension === ".webp" || extension === ".avif";
    // Read straight from the path (sharp streams it) instead of buffering the
    // whole compressed file in memory on top of the decoded raster.
    let processedImage = sharp(imagePath, isMultiFrame ? { animated: true } : undefined);
    const isJpeg = extension === ".jpg" || extension === ".jpeg";
    // JPEG encoding strips EXIF. Apply its orientation to the pixels first so
    // the displayed image stays unchanged, including mirrored orientations.
    if (isJpeg) processedImage = processedImage.autoOrient();

    // Resize step (merged from the old image-downscale pass). Sharp with
    // `fit: inside, withoutEnlargement: true` is a no-op for already-small
    // images, so we can apply it unconditionally — saves a separate pass.
    if (opts.maxDim && extension !== ".gif") {
      processedImage = processedImage.resize({
        width: opts.maxDim,
        height: opts.maxDim,
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    // Convert PNG quality from 0-1 scale to 0-100 scale for sharp
    const pngQualityValue = Math.round(pngQuality * 100);
    const resized = processedImage;

    // "high" is the fallback when the configured encode looks too different:
    // lossless PNG, and near-transparent quality for the lossy formats.
    const encode = (fidelity: "configured" | "high"): Sharp | undefined => {
      const high = fidelity === "high";
      const image = resized.clone();
      switch (extension) {
        case ".jpg":
        case ".jpeg":
          return image.jpeg({ quality: high ? 92 : jpegQuality, mozjpeg: true });
        case ".png":
          return high
            ? image.png({ compressionLevel: 9 })
            : image.png({ quality: pngQualityValue, compressionLevel: 9, palette: true });
        case ".webp":
          return image.webp({ quality: high ? 92 : jpegQuality, lossless: false });
        case ".gif":
          return high ? undefined : image.gif();
        case ".avif":
          return image.avif({ quality: high ? 80 : jpegQuality });
        default:
          return undefined;
      }
    };
    if (!encode("configured")) return;

    let resizeChecked = false;
    let wasResized = false;
    const changesDimensions = async (outputInfo: OutputInfo) => {
      if (!opts.maxDim || extension === ".gif") return false;
      if (!resizeChecked) {
        const metadata = await sharp(
          imagePath,
          isMultiFrame ? { animated: true } : undefined
        ).metadata();
        const dimensions = isJpeg
          ? metadata.autoOrient
          : { width: metadata.width, height: metadata.pageHeight ?? metadata.height };
        const outputHeight = outputInfo.pageHeight ?? outputInfo.height;
        wasResized = dimensions.width > outputInfo.width || dimensions.height > outputHeight;
        resizeChecked = true;
      }
      return wasResized;
    };
    const minSsim = opts.minSsim ?? DEFAULT_MIN_IMAGE_SSIM;
    const record = (ssim: number, outcome: ImageQualityRecord["outcome"]) =>
      opts.onQuality?.({
        path: path
          .relative(opts.root ?? path.dirname(imagePath), imagePath)
          .split(path.sep)
          .join("/"),
        operation: "recompress",
        ssim,
        outcome,
      });
    const reference = () => {
      const image = sharp(imagePath);
      return isJpeg ? image.autoOrient() : image;
    };

    let newSize = 0;
    let accepted = false;
    let rejectedSsim: number | undefined;
    for (const fidelity of ["configured", "high"] as const) {
      const encoder = encode(fidelity);
      if (!encoder) break;
      tempPath = `${imagePath}.${randomUUID()}.tmp`;
      const outputInfo = await encoder.toFile(tempPath);
      newSize = outputInfo.size;
      if (newSize >= originalSize && !(await changesDimensions(outputInfo))) {
        if (rejectedSsim !== undefined) record(rejectedSsim, "kept-original");
        reportInfo(`Keeping original ${filename}: recompression would not reduce size`);
        return;
      }
      if (minSsim === 0) {
        accepted = true;
        break;
      }
      const ssim = await imageSsim(reference, tempPath);
      if (ssim >= minSsim) {
        record(ssim, fidelity === "configured" ? "accepted" : "fallback");
        if (fidelity === "high")
          reportInfo(
            `Re-encoded ${filename} at higher quality: the configured settings fell below SSIM ${minSsim}`
          );
        accepted = true;
        break;
      }
      rejectedSsim = Math.max(rejectedSsim ?? 0, ssim);
      await fs.remove(tempPath);
      tempPath = undefined;
    }
    if (!accepted) {
      record(rejectedSsim ?? 0, "kept-original");
      reportInfo(
        `Keeping original ${filename}: recompression fell below SSIM ${minSsim} (${(rejectedSsim ?? 0).toFixed(3)})`
      );
      return;
    }
    await fs.rename(tempPath!, imagePath);
    tempPath = undefined;

    // Log optimization result
    const savings = (((originalSize - newSize) / originalSize) * 100).toFixed(1);

    if (newSize < originalSize) {
      reportInfo(`💾 Optimized ${filename}: ${savings}% smaller`);
    }
  } catch (error) {
    reportError(
      `⚠️ Error processing ${filename}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    if (tempPath) await fs.remove(tempPath);
  }
}

export { optimizeImages, compressImage };
