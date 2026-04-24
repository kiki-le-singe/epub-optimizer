import fs from "fs-extra";
import path from "node:path";
import sharp from "sharp";
import * as glob from "glob";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { getOPFPath, getContentPath } from "../utils/epub-utils.js";

interface Conversion {
  pngFile: string;
  jpegFile: string;
  pngBasename: string;
  jpegBasename: string;
  originalSize: number;
  newSize: number;
}

async function maybeConvertOne(pngFile: string, quality: number): Promise<Conversion | null> {
  try {
    const originalSize = (await fs.stat(pngFile)).size;
    if (originalSize < 200 * 1024) {
      console.log(`Skipping small PNG: ${path.basename(pngFile)} (${formatBytes(originalSize)})`);
      return null;
    }

    const metadata = await sharp(pngFile).metadata();
    if (metadata.hasAlpha) {
      console.log(`Skipping PNG with transparency: ${path.basename(pngFile)}`);
      return null;
    }

    const jpegFile = pngFile.replace(/\.png$/i, ".jpg");
    await sharp(pngFile).jpeg({ quality, mozjpeg: true }).toFile(jpegFile);
    const newSize = (await fs.stat(jpegFile)).size;

    if (newSize >= originalSize) {
      console.log(`Keeping PNG ${path.basename(pngFile)}: JPEG conversion would increase size`);
      await fs.remove(jpegFile);
      return null;
    }

    console.log(
      `Converted ${path.basename(pngFile)}: ${formatBytes(originalSize)} → ${formatBytes(
        newSize
      )} (${Math.round(((originalSize - newSize) / originalSize) * 100)}% smaller)`
    );
    return {
      pngFile,
      jpegFile,
      pngBasename: path.basename(pngFile),
      jpegBasename: path.basename(jpegFile),
      originalSize,
      newSize,
    };
  } catch (error) {
    console.warn(
      `Skipping conversion for ${path.basename(pngFile)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

async function rewriteXhtmlReferences(
  contentDir: string,
  conversions: Conversion[]
): Promise<void> {
  const xhtmlFiles = glob.sync(path.join(contentDir, "*.xhtml"));
  const byPng = new Map(conversions.map((c) => [c.pngBasename, c.jpegBasename]));

  await Promise.all(
    xhtmlFiles.map(async (xhtmlFile) => {
      const content = await fs.readFile(xhtmlFile, "utf8");
      if (!conversions.some((c) => content.includes(c.pngBasename))) return;

      const $ = cheerio.load(content, { xmlMode: true });
      let changed = false;
      $("img[src]").each((_, elem) => {
        const src = $(elem).attr("src");
        if (!src) return;
        for (const [pngBasename, jpegBasename] of byPng) {
          if (src.includes(pngBasename)) {
            $(elem).attr("src", src.replace(pngBasename, jpegBasename));
            changed = true;
            break;
          }
        }
      });
      if (changed) {
        await fs.writeFile(xhtmlFile, $.xml());
        console.log(`Updated references in ${path.basename(xhtmlFile)}`);
      }
    })
  );
}

async function rewriteOpfManifest(epubDir: string, conversions: Conversion[]): Promise<void> {
  try {
    const opfFile = await getOPFPath(epubDir);
    const opfContent = await fs.readFile(opfFile, "utf8");
    const $opf = cheerio.load(opfContent, { xmlMode: true });
    let changed = false;
    for (const c of conversions) {
      const items = $opf(`item[href="images/${c.pngBasename}"][media-type="image/png"]`);
      if (items.length > 0) {
        items.attr("href", `images/${c.jpegBasename}`);
        items.attr("media-type", "image/jpeg");
        changed = true;
      }
    }
    if (changed) {
      await fs.writeFile(opfFile, $opf.xml());
      console.log(`Updated OPF file with ${conversions.length} new JPEG reference(s)`);
    }
  } catch (opfError) {
    console.warn(
      `Failed to update OPF file: ${opfError instanceof Error ? opfError.message : String(opfError)}`
    );
  }
}

/**
 * Convert large opaque PNG files to JPEG for better compression.
 * Runs conversions in parallel, then updates XHTML and OPF references
 * in a single batched pass.
 * @returns Absolute paths of the newly-written JPEG files — callers pass
 *   this to optimizeImages as `skip` so the freshly-encoded JPEGs aren't
 *   re-encoded a second time.
 * @throws Error if conversion fails catastrophically (per-file errors are logged).
 */
async function convertPngToJpeg(
  epubDir: string,
  quality = 85,
  concurrency = 8
): Promise<Set<string>> {
  try {
    console.log("Converting large PNG files to JPEG for better compression...");

    const contentDir = await getContentPath(epubDir);
    if (!(await fs.pathExists(contentDir))) {
      console.log("Content directory not found, skipping PNG to JPEG conversion");
      return new Set();
    }

    const imagesDir = path.join(contentDir, "images");
    if (!(await fs.pathExists(imagesDir))) {
      console.log("No images directory found, skipping PNG to JPEG conversion");
      return new Set();
    }

    const pngFiles = glob.sync(path.join(imagesDir, "*.png"));
    if (pngFiles.length === 0) {
      console.log("No PNG files found");
      return new Set();
    }

    console.log(`Found ${pngFiles.length} PNG files to analyze`);

    // Phase 1: convert in parallel — each task writes its own .jpg side-by-side.
    const limit = pLimit(concurrency);
    const results = await Promise.all(
      pngFiles.map((png) => limit(() => maybeConvertOne(png, quality)))
    );
    const conversions = results.filter((r): r is Conversion => r !== null);

    if (conversions.length === 0) {
      console.log("No PNG files were converted to JPEG");
      return new Set();
    }

    // Phase 2: rewrite XHTML + OPF references once, then drop the PNG originals.
    await rewriteXhtmlReferences(contentDir, conversions);
    await rewriteOpfManifest(epubDir, conversions);
    await Promise.all(conversions.map((c) => fs.remove(c.pngFile)));

    const totalSaved = conversions.reduce((sum, c) => sum + (c.originalSize - c.newSize), 0);
    console.log(
      `Converted ${conversions.length} PNG files to JPEG, saving ${formatBytes(totalSaved)}`
    );
    return new Set(conversions.map((c) => c.jpegFile));
  } catch (error) {
    throw new Error(
      `Failed to convert PNG to JPEG: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

export { convertPngToJpeg };
