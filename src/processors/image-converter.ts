import fs from "fs-extra";
import path from "node:path";
import sharp from "sharp";
import * as glob from "glob";
import * as cheerio from "cheerio";
import { getOPFPath, getContentPath } from "../utils/epub-utils.js";

/**
 * Convert large PNG files to JPEG for better compression
 * Skips PNG files that use transparency
 * @param epubDir Directory containing the extracted EPUB
 * @param quality JPEG quality (0-100)
 * @throws Error if conversion fails
 */
async function convertPngToJpeg(epubDir: string, quality = 85): Promise<void> {
  try {
    console.log("Converting large PNG files to JPEG for better compression...");

    // Get content directory (OPS, OEBPS, or root)
    const contentDir = await getContentPath(epubDir);
    if (!(await fs.pathExists(contentDir))) {
      console.log("Content directory not found, skipping PNG to JPEG conversion");
      return;
    }

    // Check if images directory exists
    const imagesDir = path.join(contentDir, "images");
    if (!(await fs.pathExists(imagesDir))) {
      console.log("No images directory found, skipping PNG to JPEG conversion");
      return;
    }

    // Get all PNG files
    const pngFiles = glob.sync(path.join(imagesDir, "*.png"));
    if (pngFiles.length === 0) {
      console.log("No PNG files found");
      return;
    }

    console.log(`Found ${pngFiles.length} PNG files to analyze`);
    let convertedCount = 0;
    let totalSaved = 0;

    // Process each PNG file
    for (const pngFile of pngFiles) {
      try {
        // Get file size
        const stats = await fs.stat(pngFile);
        const originalSize = stats.size;

        // Skip small PNG files (likely icons, logos, etc.)
        if (originalSize < 200 * 1024) {
          // Skip files smaller than 200KB
          console.log(
            `Skipping small PNG: ${path.basename(pngFile)} (${formatBytes(originalSize)})`
          );
          continue;
        }

        // Check if the PNG has transparency
        const metadata = await sharp(pngFile).metadata();
        const hasAlpha = metadata.hasAlpha;

        if (hasAlpha) {
          console.log(`Skipping PNG with transparency: ${path.basename(pngFile)}`);
          continue;
        }

        // Define the JPEG output path
        const jpegFile = pngFile.replace(/\.png$/i, ".jpg");

        // Convert PNG to JPEG with high quality
        await sharp(pngFile).jpeg({ quality: quality, mozjpeg: true }).toFile(jpegFile);

        // Get the new file size
        const newStats = await fs.stat(jpegFile);
        const newSize = newStats.size;

        // Calculate savings
        const savedBytes = originalSize - newSize;
        const savedPercent = Math.round((savedBytes / originalSize) * 100);

        if (savedBytes > 0) {
          convertedCount++;
          totalSaved += savedBytes;

          console.log(
            `Converted ${path.basename(pngFile)}: ${formatBytes(originalSize)} → ${formatBytes(newSize)} (${savedPercent}% smaller)`
          );

          // Now update references in all XHTML files
          const xhtmlFiles = glob.sync(path.join(contentDir, "*.xhtml"));
          const pngBasename = path.basename(pngFile);
          const jpegBasename = path.basename(jpegFile);

          for (const xhtmlFile of xhtmlFiles) {
            const content = await fs.readFile(xhtmlFile, "utf8");

            // Skip if no references to this PNG
            if (!content.includes(pngBasename)) continue;

            // Replace references
            const $ = cheerio.load(content, { xmlMode: true });
            let changed = false;

            $(`img[src*="${pngBasename}"]`).each((_, elem) => {
              const src = $(elem).attr("src");
              if (src) {
                $(elem).attr("src", src.replace(pngBasename, jpegBasename));
                changed = true;
              }
            });

            if (changed) {
              // Use .xml() to preserve XML structure (self-closing tags, etc.)
              await fs.writeFile(xhtmlFile, $.xml());
              console.log(`Updated references in ${path.basename(xhtmlFile)}`);
            }
          }

          // Update OPF file
          try {
            const opfFile = await getOPFPath(epubDir);
            const opfContent = await fs.readFile(opfFile, "utf8");

            const pngPath = `images/${pngBasename}`;
            const jpegPath = `images/${jpegBasename}`;

            // Parse the OPF as XML so attribute order doesn't matter
            const $opf = cheerio.load(opfContent, { xmlMode: true });
            const items = $opf(`item[href="${pngPath}"][media-type="image/png"]`);

            if (items.length > 0) {
              items.attr("href", jpegPath);
              items.attr("media-type", "image/jpeg");
              await fs.writeFile(opfFile, $opf.xml());
              console.log(`Updated OPF file with new JPEG reference`);
            }

            // Remove the original PNG file since we've replaced all references
            await fs.remove(pngFile);
          } catch (opfError) {
            console.warn(
              `Failed to update OPF file: ${opfError instanceof Error ? opfError.message : String(opfError)}`
            );
            // Don't fail the whole process if OPF update fails
          }
        } else {
          // JPEG is larger, keep the PNG
          console.log(`Keeping PNG ${path.basename(pngFile)}: JPEG conversion would increase size`);
          await fs.remove(jpegFile); // Remove the temp JPEG file
        }
      } catch (error) {
        console.warn(
          `Skipping conversion for ${path.basename(pngFile)}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    if (convertedCount > 0) {
      console.log(
        `Converted ${convertedCount} PNG files to JPEG, saving ${formatBytes(totalSaved)}`
      );
    } else {
      console.log("No PNG files were converted to JPEG");
    }
  } catch (error) {
    throw new Error(
      `Failed to convert PNG to JPEG: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/**
 * Format bytes as human-readable file size
 */
function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

export { convertPngToJpeg };
