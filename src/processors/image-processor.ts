import fs from "fs-extra";
import path from "node:path";
import sharp from "sharp";
import pLimit from "p-limit";
import config from "../utils/config.js";

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
    const limit = pLimit(opts.concurrency ?? 8);
    await Promise.all(targets.map((file) => limit(() => compressImage(file, opts))));
  } catch (error) {
    console.error(
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

  try {
    const extension = path.extname(imagePath).toLowerCase();
    const imageBuffer = await fs.readFile(imagePath);

    // Skip if image is already small (less than 10KB)
    if (imageBuffer.length < 10 * 1024) {
      console.log(`⏩ Skipping small image: ${filename}`);
      return;
    }

    // Skip SVG files as they're already text/XML
    if (extension === ".svg") {
      return;
    }

    let processedImage = sharp(imageBuffer);

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

    // Configure compression based on file type
    switch (extension) {
      case ".jpg":
      case ".jpeg":
        processedImage = processedImage.jpeg({
          quality: jpegQuality, // Use jpegQuality from CLI args or config
          mozjpeg: true,
        });
        break;

      case ".png":
        processedImage = processedImage.png({
          quality: pngQualityValue,
          compressionLevel: 9,
          palette: true,
        });
        break;

      case ".webp":
        processedImage = processedImage.webp({
          quality: jpegQuality, // Use jpegQuality from CLI args or config
          lossless: false,
        });
        break;

      case ".gif":
        processedImage = processedImage.gif();
        break;

      case ".avif":
        processedImage = processedImage.avif({
          quality: jpegQuality, // Use jpegQuality from CLI args or config
        });
        break;

      default:
        // Unknown format, skip processing
        return;
    }

    // Write optimized image back to the same path
    const tempPath = `${imagePath}.tmp`;
    await processedImage.toFile(tempPath);
    await fs.rename(tempPath, imagePath);

    // Log optimization result
    const newSize = (await fs.stat(imagePath)).size;
    const savings = (((imageBuffer.length - newSize) / imageBuffer.length) * 100).toFixed(1);

    if (newSize < imageBuffer.length) {
      console.log(`💾 Optimized ${filename}: ${savings}% smaller`);
    }
  } catch (error) {
    console.error(
      `⚠️ Error processing ${filename}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export { optimizeImages, compressImage };
