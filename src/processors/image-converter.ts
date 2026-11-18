import { reportInfo, reportWarning } from "../utils/diagnostics.js";
import fs from "fs-extra";
import path from "node:path";
import sharp from "sharp";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { getOPFPath, getContentPath } from "../utils/epub-utils.js";
import { DEFAULT_FILE_CONCURRENCY } from "../utils/files.js";
import { isAnimatedPng } from "../utils/png-animation.js";
import { resolvePngBackground } from "../utils/pipeline-options.js";
import {
  DEFAULT_MIN_IMAGE_SSIM,
  imageSsim,
  type ImageQualityRecord,
} from "../utils/image-quality.js";

/** Quality guard settings for PNG-to-JPEG conversion. */
export interface ConversionQuality {
  /** Minimum SSIM for a converted JPEG; 0 disables the guard. Default 0.85. */
  minSsim?: number;
  /** Receives the measured quality of each conversion that was kept or rejected. */
  onQuality?: (record: ImageQualityRecord) => void;
}

/** One image re-encoded next to its source, pending a safe reference rewrite. */
export interface Conversion {
  sourceFile: string;
  targetFile: string;
  sourceRel: string;
  targetRel: string;
  originalSize: number;
  newSize: number;
  ssim?: number;
  fallback?: boolean;
}

interface RewriteEdit {
  sourceRel: string;
  start: number;
  end: number;
  replacement: string;
}

interface RewriteStats {
  found: number;
  planned: number;
}

interface OpfUpdatePlan {
  opfFile: string;
  contentDir: string;
  updates: Map<string, string>;
}

const CONTENT_FILE_EXTENSIONS = new Set([".xhtml", ".html", ".css", ".svg"]);
const PNG_EXT_RE = /\.png$/i;

async function maybeConvertOne(
  sourceFile: string,
  contentDir: string,
  quality: number,
  maxDim?: number,
  background?: string,
  guard: { minSsim: number; reject: (sourceFile: string, ssim: number) => void } = {
    minSsim: 0,
    reject: () => {},
  }
): Promise<Conversion | null> {
  try {
    const originalSize = (await fs.stat(sourceFile)).size;
    if (originalSize < 200 * 1024) {
      reportInfo(`Skipping small PNG: ${path.basename(sourceFile)} (${formatBytes(originalSize)})`);
      return null;
    }

    if (await isAnimatedPng(sourceFile)) {
      reportInfo(`Keeping animated PNG unchanged: ${path.basename(sourceFile)}`);
      return null;
    }

    const metadata = await sharp(sourceFile).metadata();
    if (metadata.hasAlpha && background === undefined) {
      reportInfo(`Skipping PNG with transparency: ${path.basename(sourceFile)}`);
      return null;
    }

    const targetFile = sourceFile.replace(/\.png$/i, ".jpg");
    if (await fs.pathExists(targetFile)) {
      reportWarning(`Skipping ${path.basename(sourceFile)}: target JPEG already exists`);
      return null;
    }

    // Chain resize + encode into the single sharp pass — avoids a follow-up
    // downscale step on the freshly-written JPEG (which would otherwise be
    // skipped by optimizeImages and stay at its original dimensions).
    let pipeline = sharp(sourceFile);
    if (metadata.hasAlpha && background !== undefined) {
      reportInfo(
        `Flattening PNG onto ${background} before JPEG conversion: ${path.basename(sourceFile)}`
      );
      pipeline = pipeline.flatten({ background });
    }
    if (maxDim) {
      pipeline = pipeline.resize({
        width: maxDim,
        height: maxDim,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    await pipeline.clone().jpeg({ quality, mozjpeg: true }).toFile(targetFile);
    let newSize = (await fs.stat(targetFile)).size;

    if (newSize >= originalSize) {
      reportInfo(`Keeping PNG ${path.basename(sourceFile)}: JPEG conversion would increase size`);
      await fs.remove(targetFile);
      return null;
    }

    let ssim: number | undefined;
    let fallback = false;
    if (guard.minSsim > 0) {
      // Flattening onto the requested background is intended, so the reference includes it.
      const reference = () => {
        const image = sharp(sourceFile);
        return metadata.hasAlpha && background !== undefined
          ? image.flatten({ background })
          : image;
      };
      ssim = await imageSsim(reference, targetFile);
      if (ssim < guard.minSsim) {
        const rejected = ssim;
        await pipeline.clone().jpeg({ quality: 92, mozjpeg: true }).toFile(targetFile);
        newSize = (await fs.stat(targetFile)).size;
        ssim = newSize < originalSize ? await imageSsim(reference, targetFile) : rejected;
        if (newSize >= originalSize || ssim < guard.minSsim) {
          reportInfo(
            `Keeping PNG ${path.basename(sourceFile)}: JPEG conversion fell below SSIM ${guard.minSsim} (${Math.max(rejected, ssim).toFixed(3)})`
          );
          guard.reject(sourceFile, Math.max(rejected, ssim));
          await fs.remove(targetFile);
          return null;
        }
        fallback = true;
      }
    }

    reportInfo(
      `Converted ${path.basename(sourceFile)}: ${formatBytes(originalSize)} → ${formatBytes(
        newSize
      )} (${Math.round(((originalSize - newSize) / originalSize) * 100)}% smaller)`
    );
    return {
      sourceFile,
      targetFile,
      sourceRel: toContentRel(contentDir, sourceFile),
      targetRel: toContentRel(contentDir, targetFile),
      originalSize,
      newSize,
      ...(ssim === undefined ? {} : { ssim, fallback }),
    };
  } catch (error) {
    reportWarning(
      `Skipping conversion for ${path.basename(sourceFile)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

async function collectFiles(
  dir: string,
  shouldInclude: (filePath: string) => boolean
): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await collectFiles(fullPath, shouldInclude)));
      } else if (shouldInclude(fullPath)) {
        out.push(fullPath);
      }
    })
  );

  return out;
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function toContentRel(contentDir: string, filePath: string): string {
  return toPosixPath(path.relative(contentDir, filePath));
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function splitReference(rawReference: string): { pathPart: string; suffix: string } {
  const hashIndex = rawReference.indexOf("#");
  const queryIndex = rawReference.indexOf("?");
  const suffixIndex = [hashIndex, queryIndex]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (suffixIndex === undefined) {
    return { pathPart: rawReference, suffix: "" };
  }

  return {
    pathPart: rawReference.slice(0, suffixIndex),
    suffix: rawReference.slice(suffixIndex),
  };
}

function isExternalReference(pathPart: string): boolean {
  return (
    pathPart === "" ||
    pathPart.startsWith("#") ||
    pathPart.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(pathPart)
  );
}

function resolveReference(
  ownerFile: string,
  contentDir: string,
  rawReference: string
): { relPath: string; suffix: string } | null {
  const trimmedReference = rawReference.trim();
  const { pathPart, suffix } = splitReference(trimmedReference);
  if (isExternalReference(pathPart)) return null;

  const decodedPath = safeDecodeUri(pathPart).replace(/\\/g, "/");
  const targetPath = decodedPath.startsWith("/")
    ? path.resolve(contentDir, decodedPath.slice(1))
    : path.resolve(path.dirname(ownerFile), decodedPath);
  const relPath = path.relative(contentDir, targetPath);

  if (relPath === "" || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    return null;
  }

  return { relPath: toPosixPath(relPath), suffix };
}

function replacementReference(
  ownerFile: string,
  contentDir: string,
  targetRel: string,
  suffix: string
): string {
  const ownerRel = toContentRel(contentDir, ownerFile);
  const ownerDir = path.posix.dirname(ownerRel);
  const relativeReference = path.posix.relative(ownerDir === "." ? "" : ownerDir, targetRel);
  return encodeURI(relativeReference) + suffix;
}

function getStats(statsBySource: Map<string, RewriteStats>, sourceRel: string): RewriteStats {
  let stats = statsBySource.get(sourceRel);
  if (!stats) {
    stats = { found: 0, planned: 0 };
    statsBySource.set(sourceRel, stats);
  }
  return stats;
}

function getReferenceToken(captured: string): { rawReference: string; startOffset: number } | null {
  const leadingWhitespace = captured.match(/^\s*/)?.[0].length ?? 0;
  const trailingWhitespace = captured.match(/\s*$/)?.[0].length ?? 0;
  let startOffset = leadingWhitespace;
  let endOffset = captured.length - trailingWhitespace;

  const token = captured.slice(startOffset, endOffset);
  const quotePairs = [
    ["'", "'"],
    ['"', '"'],
    ["&apos;", "&apos;"],
    ["&#39;", "&#39;"],
    ["&#x27;", "&#x27;"],
    ["&quot;", "&quot;"],
    ["&#34;", "&#34;"],
    ["&#x22;", "&#x22;"],
  ] as const;

  for (const [open, close] of quotePairs) {
    if (
      token.length >= open.length + close.length &&
      token.slice(0, open.length).toLowerCase() === open.toLowerCase() &&
      token.slice(-close.length).toLowerCase() === close.toLowerCase()
    ) {
      startOffset += open.length;
      endOffset -= close.length;
      break;
    }
  }

  const rawReference = captured.slice(startOffset, endOffset);
  if (!rawReference) return null;
  return { rawReference, startOffset };
}

function addReferenceEdit(
  filePath: string,
  contentDir: string,
  rawReference: string,
  start: number,
  end: number,
  conversionsBySourceRel: Map<string, Conversion>,
  editsByFile: Map<string, RewriteEdit[]>,
  statsBySource: Map<string, RewriteStats>
): void {
  const resolved = resolveReference(filePath, contentDir, rawReference);
  if (!resolved) return;

  const conversion = conversionsBySourceRel.get(resolved.relPath);
  if (!conversion) return;

  const stats = getStats(statsBySource, conversion.sourceRel);
  stats.found++;

  const replacement = replacementReference(
    filePath,
    contentDir,
    conversion.targetRel,
    resolved.suffix
  );
  const edits = editsByFile.get(filePath) ?? [];
  edits.push({
    sourceRel: conversion.sourceRel,
    start,
    end,
    replacement,
  });
  editsByFile.set(filePath, edits);
  stats.planned++;
}

function scanSrcsetReferences(
  value: string,
  filePath: string,
  contentDir: string,
  valueOffset: number,
  conversionsBySourceRel: Map<string, Conversion>,
  editsByFile: Map<string, RewriteEdit[]>,
  statsBySource: Map<string, RewriteStats>
): void {
  let cursor = 0;

  while (cursor <= value.length) {
    const commaIndex = value.indexOf(",", cursor);
    const segmentEnd = commaIndex === -1 ? value.length : commaIndex;
    const segment = value.slice(cursor, segmentEnd);
    const leadingWhitespace = segment.match(/^\s*/)?.[0].length ?? 0;
    const rest = segment.slice(leadingWhitespace);
    const urlLength = rest.search(/\s/);
    const rawReference = rest.slice(0, urlLength === -1 ? rest.length : urlLength);

    if (rawReference) {
      const start = valueOffset + cursor + leadingWhitespace;
      addReferenceEdit(
        filePath,
        contentDir,
        rawReference,
        start,
        start + rawReference.length,
        conversionsBySourceRel,
        editsByFile,
        statsBySource
      );
    }

    if (commaIndex === -1) break;
    cursor = commaIndex + 1;
  }
}

function scanCssReferences(
  value: string,
  filePath: string,
  contentDir: string,
  valueOffset: number,
  conversionsBySourceRel: Map<string, Conversion>,
  editsByFile: Map<string, RewriteEdit[]>,
  statsBySource: Map<string, RewriteStats>
): void {
  const urlRegex = /url\(\s*(?:(["'])(.*?)\1|([^'")]*?))\s*\)/gis;
  let urlMatch: RegExpExecArray | null;

  while ((urlMatch = urlRegex.exec(value)) !== null) {
    const captured = urlMatch[2] ?? urlMatch[3] ?? "";
    const token = getReferenceToken(captured);
    if (!token) continue;

    const capturedStart = urlMatch[0].indexOf(captured);
    const start = valueOffset + urlMatch.index + capturedStart + token.startOffset;
    addReferenceEdit(
      filePath,
      contentDir,
      token.rawReference,
      start,
      start + token.rawReference.length,
      conversionsBySourceRel,
      editsByFile,
      statsBySource
    );
  }

  scanImageSetReferences(
    value,
    filePath,
    contentDir,
    valueOffset,
    conversionsBySourceRel,
    editsByFile,
    statsBySource
  );
}

function findFunctionEnd(value: string, bodyStart: number): number {
  let depth = 1;
  let index = bodyStart;

  while (index < value.length) {
    const char = value[index];

    if (char === '"' || char === "'") {
      index++;
      while (index < value.length) {
        if (value[index] === "\\") {
          index += 2;
          continue;
        }
        if (value[index] === char) break;
        index++;
      }
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0) return index;
    }

    index++;
  }

  return -1;
}

function scanImageSetReferences(
  value: string,
  filePath: string,
  contentDir: string,
  valueOffset: number,
  conversionsBySourceRel: Map<string, Conversion>,
  editsByFile: Map<string, RewriteEdit[]>,
  statsBySource: Map<string, RewriteStats>
): void {
  const imageSetStartRegex = /\b(?:-webkit-)?image-set\s*\(/gis;

  while (imageSetStartRegex.exec(value) !== null) {
    const bodyStart = imageSetStartRegex.lastIndex;
    const bodyEnd = findFunctionEnd(value, bodyStart);
    if (bodyEnd === -1) break;

    const imageSetBody = value.slice(bodyStart, bodyEnd);
    const quotedReferenceRegex = /(["'])(.*?)\1/gis;
    let quotedMatch: RegExpExecArray | null;

    while ((quotedMatch = quotedReferenceRegex.exec(imageSetBody)) !== null) {
      const beforeQuote = imageSetBody.slice(0, quotedMatch.index).trimEnd().toLowerCase();
      if (beforeQuote.endsWith("url(")) continue;

      const rawReference = quotedMatch[2];
      if (!rawReference) continue;

      const start =
        valueOffset + bodyStart + quotedMatch.index + quotedMatch[0].indexOf(rawReference);
      addReferenceEdit(
        filePath,
        contentDir,
        rawReference,
        start,
        start + rawReference.length,
        conversionsBySourceRel,
        editsByFile,
        statsBySource
      );
    }

    imageSetStartRegex.lastIndex = bodyEnd + 1;
  }
}

function scanMarkupReferences(
  content: string,
  filePath: string,
  contentDir: string,
  conversionsBySourceRel: Map<string, Conversion>,
  editsByFile: Map<string, RewriteEdit[]>,
  statsBySource: Map<string, RewriteStats>
): void {
  const attributeRegex = /\b(src|href|xlink:href|style|srcset)\s*=\s*(["'])(.*?)\2/gis;
  let attrMatch: RegExpExecArray | null;

  while ((attrMatch = attributeRegex.exec(content)) !== null) {
    const attrName = attrMatch[1]?.toLowerCase();
    const value = attrMatch[3];
    if (attrName === undefined || value === undefined) continue;
    const valueOffset = attrMatch.index + attrMatch[0].indexOf(value);

    if (attrName === "style") {
      scanCssReferences(
        value,
        filePath,
        contentDir,
        valueOffset,
        conversionsBySourceRel,
        editsByFile,
        statsBySource
      );
    } else if (attrName === "srcset") {
      scanSrcsetReferences(
        value,
        filePath,
        contentDir,
        valueOffset,
        conversionsBySourceRel,
        editsByFile,
        statsBySource
      );
    } else {
      addReferenceEdit(
        filePath,
        contentDir,
        value,
        valueOffset,
        valueOffset + value.length,
        conversionsBySourceRel,
        editsByFile,
        statsBySource
      );
    }
  }
}

async function buildRewritePlan(
  contentDir: string,
  conversions: Conversion[]
): Promise<{
  editsByFile: Map<string, RewriteEdit[]>;
  statsBySource: Map<string, RewriteStats>;
}> {
  const conversionsBySourceRel = new Map(
    conversions.map((conversion) => [conversion.sourceRel, conversion])
  );
  const editsByFile = new Map<string, RewriteEdit[]>();
  const statsBySource = new Map<string, RewriteStats>();
  const contentFiles = await collectFiles(contentDir, (filePath) =>
    CONTENT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  );
  const sourceExtensions = [
    ...new Set(conversions.map((conversion) => path.extname(conversion.sourceFile).toLowerCase())),
  ];

  await Promise.all(
    contentFiles.map(async (filePath) => {
      const content = await fs.readFile(filePath, "utf8");
      const lowered = content.toLowerCase();
      if (!sourceExtensions.some((extension) => lowered.includes(extension))) return;

      if (path.extname(filePath).toLowerCase() === ".css") {
        scanCssReferences(
          content,
          filePath,
          contentDir,
          0,
          conversionsBySourceRel,
          editsByFile,
          statsBySource
        );
      } else {
        scanMarkupReferences(
          content,
          filePath,
          contentDir,
          conversionsBySourceRel,
          editsByFile,
          statsBySource
        );
      }
    })
  );

  return { editsByFile, statsBySource };
}

async function buildOpfUpdatePlan(
  epubDir: string,
  contentDir: string,
  conversions: Conversion[]
): Promise<OpfUpdatePlan | null> {
  try {
    const opfFile = await getOPFPath(epubDir);
    const opfContent = await fs.readFile(opfFile, "utf8");
    const $opf = cheerio.load(opfContent, { xmlMode: true });
    const conversionBySourceRel = new Map(
      conversions.map((conversion) => [conversion.sourceRel, conversion])
    );
    const updates = new Map<string, string>();
    const opfDir = path.dirname(opfFile);

    $opf("item[href]").each((_, item) => {
      const href = $opf(item).attr("href");
      if (!href) return;

      const resolved = resolveReference(opfFile, contentDir, href);
      if (!resolved) return;

      const conversion = conversionBySourceRel.get(resolved.relPath);
      if (!conversion) return;

      const nextHref = encodeURI(toPosixPath(path.relative(opfDir, conversion.targetFile)));
      updates.set(conversion.sourceRel, nextHref);
    });

    return { opfFile, contentDir, updates };
  } catch (opfError) {
    reportWarning(
      `Failed to inspect OPF file: ${opfError instanceof Error ? opfError.message : String(opfError)}`
    );
    return null;
  }
}

async function applyCommittedEdits(
  editsByFile: Map<string, RewriteEdit[]>,
  committedSources: ReadonlySet<string>
): Promise<void> {
  await Promise.all(
    Array.from(editsByFile.entries()).map(async ([filePath, edits]) => {
      const committedEdits = edits
        .filter((edit) => committedSources.has(edit.sourceRel))
        .sort((a, b) => b.start - a.start);

      if (committedEdits.length === 0) return;

      let content = await fs.readFile(filePath, "utf8");
      for (const edit of committedEdits) {
        content = content.slice(0, edit.start) + edit.replacement + content.slice(edit.end);
      }
      await fs.writeFile(filePath, content);
      reportInfo(`Updated references in ${path.basename(filePath)}`);
    })
  );
}

async function applyOpfUpdates(
  opfPlan: OpfUpdatePlan,
  committedSources: ReadonlySet<string>,
  target: { mediaType: string; label: string }
): Promise<void> {
  if (committedSources.size === 0) return;

  const opfContent = await fs.readFile(opfPlan.opfFile, "utf8");
  const $opf = cheerio.load(opfContent, { xmlMode: true });
  let changed = 0;

  $opf("item[href]").each((_, item) => {
    const href = $opf(item).attr("href");
    if (!href) return;

    const resolved = resolveReference(opfPlan.opfFile, opfPlan.contentDir, href);
    if (!resolved) return;

    const updateHref = opfPlan.updates.get(resolved.relPath);

    if (updateHref && committedSources.has(resolved.relPath)) {
      $opf(item).attr("href", updateHref);
      $opf(item).attr("media-type", target.mediaType);
      changed++;
    }
  });

  if (changed > 0) {
    await fs.writeFile(opfPlan.opfFile, $opf.xml());
    reportInfo(`Updated OPF file with ${changed} new ${target.label} reference(s)`);
  }
}

/**
 * Replaces converted sources by their targets as one transaction per image.
 * Nothing is rewritten until an image is proven safe to commit: referenced in
 * supported content, every found reference planned, and its OPF manifest item
 * updatable. Otherwise its source is kept and its target removed.
 * @returns The conversions that were committed.
 */
export async function commitConversions(
  epubDir: string,
  contentDir: string,
  conversions: Conversion[],
  target: { mediaType: string; label: string; sourceLabel: string }
): Promise<Conversion[]> {
  const [{ editsByFile, statsBySource }, opfPlan] = await Promise.all([
    buildRewritePlan(contentDir, conversions),
    buildOpfUpdatePlan(epubDir, contentDir, conversions),
  ]);
  const committedSources = new Set<string>();
  const keeping = `Keeping ${target.sourceLabel}`;

  for (const conversion of conversions) {
    const stats = statsBySource.get(conversion.sourceRel) ?? { found: 0, planned: 0 };
    const hasOpfUpdate = opfPlan?.updates.has(conversion.sourceRel) ?? false;

    if (!hasOpfUpdate) {
      reportWarning(`${keeping} ${conversion.sourceRel}: no matching OPF manifest item found`);
    } else if (stats.found === 0) {
      reportWarning(`${keeping} ${conversion.sourceRel}: no supported content references found`);
    } else if (stats.found !== stats.planned) {
      reportWarning(
        `${keeping} ${conversion.sourceRel}: planned ${stats.planned} rewrite(s) for ${stats.found} reference(s)`
      );
    } else {
      committedSources.add(conversion.sourceRel);
    }
  }

  await applyCommittedEdits(editsByFile, committedSources);
  if (opfPlan) {
    await applyOpfUpdates(opfPlan, committedSources, target);
  }

  await Promise.all(
    conversions.map((conversion) =>
      committedSources.has(conversion.sourceRel)
        ? fs.remove(conversion.sourceFile)
        : fs.remove(conversion.targetFile)
    )
  );

  return conversions.filter((conversion) => committedSources.has(conversion.sourceRel));
}

/**
 * Convert large opaque PNGs, or explicitly flattened transparent PNGs, to JPEG.
 * Runs conversions in parallel, then updates XHTML and OPF references
 * in a single batched pass.
 * @param maxDim Optional max width/height in px — resize is chained into
 *   the same sharp pass so converted JPEGs don't need a follow-up downscale
 *   (optimizeImages skips them).
 * @returns Absolute paths of the newly-written JPEG files — callers pass
 *   this to optimizeImages as `skip` so the freshly-encoded JPEGs aren't
 *   re-encoded a second time.
 * @throws Error if conversion fails catastrophically (per-file errors are logged).
 */
async function convertPngToJpeg(
  epubDir: string,
  quality = 85,
  concurrency = DEFAULT_FILE_CONCURRENCY,
  maxDim?: number,
  background?: string,
  qualityGuard: ConversionQuality = {}
): Promise<Set<string>> {
  const pngBackground = resolvePngBackground({ pngBackground: background });
  const toRootRel = (file: string) => toPosixPath(path.relative(epubDir, file));
  const guard = {
    minSsim: qualityGuard.minSsim ?? DEFAULT_MIN_IMAGE_SSIM,
    reject: (sourceFile: string, ssim: number) =>
      qualityGuard.onQuality?.({
        path: toRootRel(sourceFile),
        operation: "png-to-jpeg",
        ssim,
        outcome: "kept-original",
      }),
  };
  try {
    reportInfo("Converting large PNG files to JPEG for better compression...");

    const contentDir = await getContentPath(epubDir);
    if (!(await fs.pathExists(contentDir))) {
      reportInfo("Content directory not found, skipping PNG to JPEG conversion");
      return new Set();
    }

    const pngFiles = await collectFiles(contentDir, (filePath) => PNG_EXT_RE.test(filePath));
    if (pngFiles.length === 0) {
      reportInfo("No PNG files found");
      return new Set();
    }

    reportInfo(`Found ${pngFiles.length} PNG files to analyze`);

    // Phase 1: convert in parallel — each task writes its own .jpg side-by-side.
    const limit = pLimit(concurrency);
    const results = await Promise.all(
      pngFiles.map((png) =>
        limit(() => maybeConvertOne(png, contentDir, quality, maxDim, pngBackground, guard))
      )
    );
    const conversions = results.filter((r): r is Conversion => r !== null);

    if (conversions.length === 0) {
      reportInfo("No PNG files were converted to JPEG");
      return new Set();
    }

    const committedConversions = await commitConversions(epubDir, contentDir, conversions, {
      mediaType: "image/jpeg",
      label: "JPEG",
      sourceLabel: "PNG",
    });
    for (const conversion of committedConversions)
      if (conversion.ssim !== undefined)
        qualityGuard.onQuality?.({
          path: toRootRel(conversion.sourceFile),
          operation: "png-to-jpeg",
          convertedTo: toRootRel(conversion.targetFile),
          ssim: conversion.ssim,
          outcome: conversion.fallback ? "fallback" : "accepted",
        });
    if (committedConversions.length === 0) {
      reportInfo("No PNG files were committed to JPEG conversion");
      return new Set();
    }

    const totalSaved = committedConversions.reduce(
      (sum, c) => sum + (c.originalSize - c.newSize),
      0
    );
    reportInfo(
      `Converted ${committedConversions.length} PNG files to JPEG, saving ${formatBytes(totalSaved)}`
    );
    return new Set(committedConversions.map((c) => c.targetFile));
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

export { convertPngToJpeg, collectFiles, toPosixPath, toContentRel, formatBytes };
