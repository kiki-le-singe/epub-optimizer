import fs from "fs-extra";
import path from "node:path";
import sharp from "sharp";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { getOPFPath, getContentPath } from "../utils/epub-utils.js";

interface Conversion {
  pngFile: string;
  jpegFile: string;
  pngRel: string;
  jpegRel: string;
  originalSize: number;
  newSize: number;
}

interface RewriteEdit {
  pngRel: string;
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
  pngFile: string,
  contentDir: string,
  quality: number,
  maxDim?: number
): Promise<Conversion | null> {
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
    if (await fs.pathExists(jpegFile)) {
      console.warn(`Skipping ${path.basename(pngFile)}: target JPEG already exists`);
      return null;
    }

    // Chain resize + encode into the single sharp pass — avoids a follow-up
    // downscale step on the freshly-written JPEG (which would otherwise be
    // skipped by optimizeImages and stay at its original dimensions).
    let pipeline = sharp(pngFile);
    if (maxDim) {
      pipeline = pipeline.resize({
        width: maxDim,
        height: maxDim,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    await pipeline.jpeg({ quality, mozjpeg: true }).toFile(jpegFile);
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
      pngRel: toContentRel(contentDir, pngFile),
      jpegRel: toContentRel(contentDir, jpegFile),
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

  const posixRelPath = toPosixPath(relPath);
  if (!PNG_EXT_RE.test(posixRelPath)) return null;

  return { relPath: posixRelPath, suffix };
}

function replacementReference(
  ownerFile: string,
  contentDir: string,
  jpegRel: string,
  suffix: string
): string {
  const ownerRel = toContentRel(contentDir, ownerFile);
  const ownerDir = path.posix.dirname(ownerRel);
  const relativeReference = path.posix.relative(ownerDir === "." ? "" : ownerDir, jpegRel);
  return encodeURI(relativeReference) + suffix;
}

function getStats(statsByPng: Map<string, RewriteStats>, pngRel: string): RewriteStats {
  let stats = statsByPng.get(pngRel);
  if (!stats) {
    stats = { found: 0, planned: 0 };
    statsByPng.set(pngRel, stats);
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
  conversionsByPngRel: Map<string, Conversion>,
  editsByFile: Map<string, RewriteEdit[]>,
  statsByPng: Map<string, RewriteStats>
): void {
  const resolved = resolveReference(filePath, contentDir, rawReference);
  if (!resolved) return;

  const conversion = conversionsByPngRel.get(resolved.relPath);
  if (!conversion) return;

  const stats = getStats(statsByPng, conversion.pngRel);
  stats.found++;

  const replacement = replacementReference(
    filePath,
    contentDir,
    conversion.jpegRel,
    resolved.suffix
  );
  const edits = editsByFile.get(filePath) ?? [];
  edits.push({
    pngRel: conversion.pngRel,
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
  conversionsByPngRel: Map<string, Conversion>,
  editsByFile: Map<string, RewriteEdit[]>,
  statsByPng: Map<string, RewriteStats>
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
        conversionsByPngRel,
        editsByFile,
        statsByPng
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
  conversionsByPngRel: Map<string, Conversion>,
  editsByFile: Map<string, RewriteEdit[]>,
  statsByPng: Map<string, RewriteStats>
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
      conversionsByPngRel,
      editsByFile,
      statsByPng
    );
  }

  scanImageSetReferences(
    value,
    filePath,
    contentDir,
    valueOffset,
    conversionsByPngRel,
    editsByFile,
    statsByPng
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
  conversionsByPngRel: Map<string, Conversion>,
  editsByFile: Map<string, RewriteEdit[]>,
  statsByPng: Map<string, RewriteStats>
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
        conversionsByPngRel,
        editsByFile,
        statsByPng
      );
    }

    imageSetStartRegex.lastIndex = bodyEnd + 1;
  }
}

function scanMarkupReferences(
  content: string,
  filePath: string,
  contentDir: string,
  conversionsByPngRel: Map<string, Conversion>,
  editsByFile: Map<string, RewriteEdit[]>,
  statsByPng: Map<string, RewriteStats>
): void {
  const attributeRegex = /\b(src|href|xlink:href|style|srcset)\s*=\s*(["'])(.*?)\2/gis;
  let attrMatch: RegExpExecArray | null;

  while ((attrMatch = attributeRegex.exec(content)) !== null) {
    const attrName = attrMatch[1].toLowerCase();
    const value = attrMatch[3];
    const valueOffset = attrMatch.index + attrMatch[0].indexOf(value);

    if (attrName === "style") {
      scanCssReferences(
        value,
        filePath,
        contentDir,
        valueOffset,
        conversionsByPngRel,
        editsByFile,
        statsByPng
      );
    } else if (attrName === "srcset") {
      scanSrcsetReferences(
        value,
        filePath,
        contentDir,
        valueOffset,
        conversionsByPngRel,
        editsByFile,
        statsByPng
      );
    } else {
      addReferenceEdit(
        filePath,
        contentDir,
        value,
        valueOffset,
        valueOffset + value.length,
        conversionsByPngRel,
        editsByFile,
        statsByPng
      );
    }
  }
}

async function buildRewritePlan(
  contentDir: string,
  conversions: Conversion[]
): Promise<{
  editsByFile: Map<string, RewriteEdit[]>;
  statsByPng: Map<string, RewriteStats>;
}> {
  const conversionsByPngRel = new Map(
    conversions.map((conversion) => [conversion.pngRel, conversion])
  );
  const editsByFile = new Map<string, RewriteEdit[]>();
  const statsByPng = new Map<string, RewriteStats>();
  const contentFiles = await collectFiles(contentDir, (filePath) =>
    CONTENT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  );

  await Promise.all(
    contentFiles.map(async (filePath) => {
      const content = await fs.readFile(filePath, "utf8");
      if (!content.toLowerCase().includes(".png")) return;

      if (path.extname(filePath).toLowerCase() === ".css") {
        scanCssReferences(
          content,
          filePath,
          contentDir,
          0,
          conversionsByPngRel,
          editsByFile,
          statsByPng
        );
      } else {
        scanMarkupReferences(
          content,
          filePath,
          contentDir,
          conversionsByPngRel,
          editsByFile,
          statsByPng
        );
      }
    })
  );

  return { editsByFile, statsByPng };
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
    const conversionByPngRel = new Map(
      conversions.map((conversion) => [conversion.pngRel, conversion])
    );
    const updates = new Map<string, string>();
    const opfDir = path.dirname(opfFile);

    $opf("item[href]").each((_, item) => {
      const href = $opf(item).attr("href");
      if (!href) return;

      const resolved = resolveReference(opfFile, contentDir, href);
      if (!resolved) return;

      const conversion = conversionByPngRel.get(resolved.relPath);
      if (!conversion) return;

      const nextHref = encodeURI(toPosixPath(path.relative(opfDir, conversion.jpegFile)));
      updates.set(conversion.pngRel, nextHref);
    });

    return { opfFile, contentDir, updates };
  } catch (opfError) {
    console.warn(
      `Failed to inspect OPF file: ${opfError instanceof Error ? opfError.message : String(opfError)}`
    );
    return null;
  }
}

async function applyCommittedEdits(
  editsByFile: Map<string, RewriteEdit[]>,
  committedPngs: ReadonlySet<string>
): Promise<void> {
  await Promise.all(
    Array.from(editsByFile.entries()).map(async ([filePath, edits]) => {
      const committedEdits = edits
        .filter((edit) => committedPngs.has(edit.pngRel))
        .sort((a, b) => b.start - a.start);

      if (committedEdits.length === 0) return;

      let content = await fs.readFile(filePath, "utf8");
      for (const edit of committedEdits) {
        content = content.slice(0, edit.start) + edit.replacement + content.slice(edit.end);
      }
      await fs.writeFile(filePath, content);
      console.log(`Updated references in ${path.basename(filePath)}`);
    })
  );
}

async function applyOpfUpdates(
  opfPlan: OpfUpdatePlan,
  committedPngs: ReadonlySet<string>
): Promise<void> {
  if (committedPngs.size === 0) return;

  const opfContent = await fs.readFile(opfPlan.opfFile, "utf8");
  const $opf = cheerio.load(opfContent, { xmlMode: true });
  let changed = 0;

  $opf("item[href]").each((_, item) => {
    const href = $opf(item).attr("href");
    if (!href) return;

    const resolved = resolveReference(opfPlan.opfFile, opfPlan.contentDir, href);
    if (!resolved) return;

    const updateHref = opfPlan.updates.get(resolved.relPath);

    if (updateHref && committedPngs.has(resolved.relPath)) {
      $opf(item).attr("href", updateHref);
      $opf(item).attr("media-type", "image/jpeg");
      changed++;
    }
  });

  if (changed > 0) {
    await fs.writeFile(opfPlan.opfFile, $opf.xml());
    console.log(`Updated OPF file with ${changed} new JPEG reference(s)`);
  }
}

/**
 * Convert large opaque PNG files to JPEG for better compression.
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
  concurrency = 8,
  maxDim?: number
): Promise<Set<string>> {
  try {
    console.log("Converting large PNG files to JPEG for better compression...");

    const contentDir = await getContentPath(epubDir);
    if (!(await fs.pathExists(contentDir))) {
      console.log("Content directory not found, skipping PNG to JPEG conversion");
      return new Set();
    }

    const pngFiles = await collectFiles(contentDir, (filePath) => PNG_EXT_RE.test(filePath));
    if (pngFiles.length === 0) {
      console.log("No PNG files found");
      return new Set();
    }

    console.log(`Found ${pngFiles.length} PNG files to analyze`);

    // Phase 1: convert in parallel — each task writes its own .jpg side-by-side.
    const limit = pLimit(concurrency);
    const results = await Promise.all(
      pngFiles.map((png) => limit(() => maybeConvertOne(png, contentDir, quality, maxDim)))
    );
    const conversions = results.filter((r): r is Conversion => r !== null);

    if (conversions.length === 0) {
      console.log("No PNG files were converted to JPEG");
      return new Set();
    }

    // Phase 2: build a transaction plan. Nothing is rewritten until a PNG is
    // proven safe to commit: referenced in supported content, all found
    // references are planned, and the OPF manifest can be updated.
    const [{ editsByFile, statsByPng }, opfPlan] = await Promise.all([
      buildRewritePlan(contentDir, conversions),
      buildOpfUpdatePlan(epubDir, contentDir, conversions),
    ]);
    const committedPngs = new Set<string>();

    for (const conversion of conversions) {
      const stats = statsByPng.get(conversion.pngRel) ?? { found: 0, planned: 0 };
      const hasOpfUpdate = opfPlan?.updates.has(conversion.pngRel) ?? false;

      if (!hasOpfUpdate) {
        console.warn(`Keeping PNG ${conversion.pngRel}: no matching OPF manifest item found`);
      } else if (stats.found === 0) {
        console.warn(`Keeping PNG ${conversion.pngRel}: no supported content references found`);
      } else if (stats.found !== stats.planned) {
        console.warn(
          `Keeping PNG ${conversion.pngRel}: planned ${stats.planned} rewrite(s) for ${stats.found} reference(s)`
        );
      } else {
        committedPngs.add(conversion.pngRel);
      }
    }

    await applyCommittedEdits(editsByFile, committedPngs);
    if (opfPlan) {
      await applyOpfUpdates(opfPlan, committedPngs);
    }

    await Promise.all(
      conversions.map((conversion) =>
        committedPngs.has(conversion.pngRel)
          ? fs.remove(conversion.pngFile)
          : fs.remove(conversion.jpegFile)
      )
    );

    const committedConversions = conversions.filter((conversion) =>
      committedPngs.has(conversion.pngRel)
    );
    if (committedConversions.length === 0) {
      console.log("No PNG files were committed to JPEG conversion");
      return new Set();
    }

    const totalSaved = committedConversions.reduce(
      (sum, c) => sum + (c.originalSize - c.newSize),
      0
    );
    console.log(
      `Converted ${committedConversions.length} PNG files to JPEG, saving ${formatBytes(totalSaved)}`
    );
    return new Set(committedConversions.map((c) => c.jpegFile));
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
