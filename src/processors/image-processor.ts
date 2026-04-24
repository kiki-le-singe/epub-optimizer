import fs from "fs-extra";
import path from "node:path";
import sharp from "sharp";
import config from "../utils/config.js";

export interface ImageOpts {
  /** JPEG quality 0-100 */
  jpegQuality?: number;
  /** PNG quality 0-1 scale */
  pngQuality?: number;
}

/**
 * Optimize images in a directory recursively.
 * @param opts Quality overrides; falls back to config defaults.
 */
async function optimizeImages(dir: string, opts: ImageOpts = {}): Promise<void> {
  try {
    const entries = await fs.readdir(dir);

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory()) {
        await optimizeImages(fullPath, opts);
      } else if (/\.(jpe?g|png|webp|gif|avif|svg)$/i.test(entry)) {
        await compressImage(fullPath, opts);
      }
    }
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
