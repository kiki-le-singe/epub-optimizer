import fs from "fs-extra";
import path from "node:path";
import sharp from "sharp";
import pLimit from "p-limit";
import { reportInfo, reportWarning } from "../utils/diagnostics.js";
import { getContentPath, getOPFPath, parseOPF } from "../utils/epub-utils.js";
import { DEFAULT_FILE_CONCURRENCY } from "../utils/files.js";
import { DEFAULT_MIN_IMAGE_SSIM, imageSsim } from "../utils/image-quality.js";
import type { ImageQualityRecord } from "../utils/image-quality-record.js";
import { resolvePathInside } from "../utils/path-safety.js";
import { isAnimatedPng } from "../utils/png-animation.js";
import {
  collectFiles,
  commitConversions,
  formatBytes,
  toContentRel,
  toPosixPath,
  type Conversion,
} from "./image-converter.js";

export interface WebpConversionOptions {
  /** Lossy WebP quality, 0-100. */
  quality?: number;
  concurrency?: number;
  /** Max width/height in px, chained into the same encode. */
  maxDim?: number;
  /** Minimum SSIM for a converted image; 0 disables the guard. Default 0.85. */
  minSsim?: number;
  onQuality?: (record: ImageQualityRecord) => void;
}

const SOURCE_RE = /\.(png|jpe?g)$/i;
const MIN_SOURCE_BYTES = 10 * 1024;

/** Cover images stay in their original format: stores and library views often require it. */
async function coverImages(epubDir: string, opfPath: string): Promise<Set<string>> {
  const $opf = await parseOPF(opfPath);
  const opfDir = path.dirname(opfPath);
  const coverId = $opf('metadata meta[name="cover"]').attr("content");
  const covers = new Set<string>();
  for (const element of $opf("manifest item").toArray()) {
    const item = $opf(element);
    const href = item.attr("href");
    const isCover =
      (item.attr("properties") ?? "").split(/\s+/).includes("cover-image") ||
      (coverId !== undefined && item.attr("id") === coverId);
    if (!href || !isCover) continue;
    try {
      covers.add(resolvePathInside(epubDir, opfDir, href, "cover image href"));
    } catch {
      // An unsafe href never matches a file collected inside the content directory.
    }
  }
  return covers;
}

async function convertOne(
  sourceFile: string,
  targetFile: string,
  contentDir: string,
  options: Required<Pick<WebpConversionOptions, "quality" | "minSsim">> & { maxDim?: number },
  reject: (sourceFile: string, ssim: number) => void
): Promise<Conversion | null> {
  const name = path.basename(sourceFile);
  try {
    const originalSize = (await fs.stat(sourceFile)).size;
    if (originalSize < MIN_SOURCE_BYTES) return null;
    const isPng = /\.png$/i.test(sourceFile);
    if (isPng && (await isAnimatedPng(sourceFile))) {
      reportInfo(`Keeping animated PNG unchanged: ${name}`);
      return null;
    }

    // JPEG orientation lives in EXIF, which the WebP encode drops: apply it to the pixels.
    const reference = () => (isPng ? sharp(sourceFile) : sharp(sourceFile).autoOrient());
    const resized = () =>
      options.maxDim
        ? reference().resize({
            width: options.maxDim,
            height: options.maxDim,
            fit: "inside",
            withoutEnlargement: true,
          })
        : reference();
    // The fallback is pixel-exact for PNG and near-transparent for JPEG.
    const attempts = [
      { quality: options.quality },
      isPng ? { lossless: true } : { quality: 92 },
    ] as const;
    let rejected: number | undefined;

    for (const [index, attempt] of attempts.entries()) {
      await resized().webp(attempt).toFile(targetFile);
      const newSize = (await fs.stat(targetFile)).size;
      if (newSize >= originalSize) break;
      const ssim = options.minSsim > 0 ? await imageSsim(reference, targetFile) : undefined;
      if (ssim === undefined || ssim >= options.minSsim) {
        reportInfo(
          `Converted ${name} to WebP: ${formatBytes(originalSize)} → ${formatBytes(newSize)}`
        );
        return {
          sourceFile,
          targetFile,
          sourceRel: toContentRel(contentDir, sourceFile),
          targetRel: toContentRel(contentDir, targetFile),
          originalSize,
          newSize,
          ...(ssim === undefined ? {} : { ssim, fallback: index > 0 }),
        };
      }
      rejected = Math.max(rejected ?? 0, ssim);
    }

    await fs.remove(targetFile);
    if (rejected === undefined) {
      reportInfo(`Keeping ${name}: WebP conversion would not reduce size`);
    } else {
      reportInfo(
        `Keeping ${name}: WebP conversion fell below SSIM ${options.minSsim} (${rejected.toFixed(3)})`
      );
      reject(sourceFile, rejected);
    }
    return null;
  } catch (error) {
    await fs.remove(targetFile).catch(() => {});
    reportWarning(
      `Skipping WebP conversion for ${name}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Convert PNG and JPEG images to WebP when that is smaller, then update their
 * references and OPF manifest items as one transaction per image.
 *
 * WebP is a core media type only since EPUB 3.3, so EPUB 2 packages are left
 * unchanged. Cover images and animated PNGs keep their format.
 *
 * @returns Absolute paths of the new WebP files, to skip in later image steps.
 */
export async function convertToWebp(
  epubDir: string,
  options: WebpConversionOptions = {}
): Promise<Set<string>> {
  try {
    const opfPath = await getOPFPath(epubDir);
    const version = (await parseOPF(opfPath))("package").first().attr("version") ?? "";
    if (!version.trim().startsWith("3")) {
      reportInfo(
        `Skipping WebP conversion: WebP requires EPUB 3 (package version ${version || "unknown"})`
      );
      return new Set();
    }
    const contentDir = await getContentPath(epubDir);
    if (!(await fs.pathExists(contentDir))) return new Set();

    const covers = await coverImages(epubDir, opfPath);
    const sources = (await collectFiles(contentDir, (file) => SOURCE_RE.test(file)))
      .filter((file) => !covers.has(file))
      .sort();
    const targetOf = (file: string) => file.replace(SOURCE_RE, ".webp");
    const targetCounts = new Map<string, number>();
    for (const file of sources) {
      const key = targetOf(file).toLowerCase();
      targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
    }

    const toRootRel = (file: string) => toPosixPath(path.relative(epubDir, file));
    const settings = {
      quality: options.quality ?? 80,
      minSsim: options.minSsim ?? DEFAULT_MIN_IMAGE_SSIM,
      maxDim: options.maxDim,
    };
    const reject = (sourceFile: string, ssim: number) =>
      options.onQuality?.({
        path: toRootRel(sourceFile),
        operation: "to-webp",
        ssim,
        outcome: "kept-original",
      });
    const limit = pLimit(options.concurrency ?? DEFAULT_FILE_CONCURRENCY);
    const results = await Promise.all(
      sources.map((sourceFile) =>
        limit(async () => {
          const targetFile = targetOf(sourceFile);
          // Two sources sharing a target name, or an existing file, would overwrite a resource.
          if (
            targetCounts.get(targetFile.toLowerCase()) !== 1 ||
            (await fs.pathExists(targetFile))
          ) {
            reportInfo(
              `Keeping ${path.basename(sourceFile)}: ${path.basename(targetFile)} is already taken`
            );
            return null;
          }
          return convertOne(sourceFile, targetFile, contentDir, settings, reject);
        })
      )
    );
    const conversions = results.filter((result): result is Conversion => result !== null);
    if (conversions.length === 0) {
      reportInfo("No images were converted to WebP");
      return new Set();
    }

    const committed = await commitConversions(epubDir, contentDir, conversions, {
      mediaType: "image/webp",
      label: "WebP",
      sourceLabel: "image",
    });
    for (const conversion of committed)
      if (conversion.ssim !== undefined)
        options.onQuality?.({
          path: toRootRel(conversion.sourceFile),
          operation: "to-webp",
          convertedTo: toRootRel(conversion.targetFile),
          ssim: conversion.ssim,
          outcome: conversion.fallback ? "fallback" : "accepted",
        });
    const saved = committed.reduce((sum, c) => sum + (c.originalSize - c.newSize), 0);
    reportInfo(`Converted ${committed.length} image(s) to WebP, saving ${formatBytes(saved)}`);
    return new Set(committed.map((conversion) => conversion.targetFile));
  } catch (error) {
    throw new Error(
      `Failed to convert images to WebP: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}
