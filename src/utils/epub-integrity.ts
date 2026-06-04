import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { getOPFPath, getTOCFiles, parseOPF } from "./epub-utils.js";
import { resolvePathInside } from "./path-safety.js";

export interface EpubContentMetrics {
  manifestItems: number;
  spineItems: number;
  contentDocuments: number;
  images: number;
  navigationEntries: number;
  internalReferences: number;
  missingReferences: number;
  missingReferenceTargets: string[];
}

export interface IntegrityCheck {
  name: "manifestItems" | "spineItems" | "contentDocuments" | "images" | "navigationEntries";
  before: number;
  after: number;
  passed: boolean;
}

export interface EpubIntegrityComparison {
  valid: boolean;
  checks: IntegrityCheck[];
  newMissingReferences: string[];
  issues: string[];
}

interface ManifestItem {
  id: string;
  mediaType: string;
  filePath?: string;
}

const SCANNED_MEDIA_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
  "text/css",
  "image/svg+xml",
  "application/x-dtbncx+xml",
]);

function isExternalReference(reference: string): boolean {
  return (
    reference === "" ||
    reference.startsWith("#") ||
    reference.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(reference)
  );
}

function normalizeReference(reference: string): string {
  let normalized = reference.trim().replace(/&amp;/gi, "&");
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
      normalized.length >= open.length + close.length &&
      normalized.slice(0, open.length).toLowerCase() === open.toLowerCase() &&
      normalized.slice(-close.length).toLowerCase() === close.toLowerCase()
    ) {
      normalized = normalized.slice(open.length, -close.length);
      break;
    }
  }

  return normalized;
}

function collectMarkupReferences(content: string): string[] {
  const references: string[] = [];
  const attributeRegex = /\b(?:src|href|xlink:href|poster)\s*=\s*(["'])(.*?)\1/gis;
  const srcsetRegex = /\bsrcset\s*=\s*(["'])(.*?)\1/gis;
  let match: RegExpExecArray | null;

  while ((match = attributeRegex.exec(content)) !== null) {
    references.push(match[2]);
  }

  while ((match = srcsetRegex.exec(content)) !== null) {
    for (const candidate of match[2].split(",")) {
      const reference = candidate.trim().split(/\s+/, 1)[0];
      if (reference) references.push(reference);
    }
  }

  return references;
}

function collectCssReferences(content: string): string[] {
  const references: string[] = [];
  const urlRegex = /url\(\s*(?:(["'])(.*?)\1|([^'")\s]+))\s*\)/gis;
  const importRegex = /@import\s+(?:url\(\s*)?(["'])(.*?)\1\s*\)?/gis;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(content)) !== null) {
    references.push(match[2] ?? match[3]);
  }
  while ((match = importRegex.exec(content)) !== null) {
    references.push(match[2]);
  }

  return references;
}

async function collectNavigationEntries(epubDir: string): Promise<number> {
  const tocFiles = await getTOCFiles(epubDir);
  let entries = 0;

  if (tocFiles.epub3Nav) {
    const content = await fs.readFile(tocFiles.epub3Nav, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });
    entries += $("nav a[href]").length;
  }

  if (tocFiles.epub2Ncx) {
    const content = await fs.readFile(tocFiles.epub2Ncx, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });
    entries += $("navMap navPoint").length;
  }

  return entries;
}

export async function collectEpubContentMetrics(epubDir: string): Promise<EpubContentMetrics> {
  const opfPath = await getOPFPath(epubDir);
  const opfDir = path.dirname(opfPath);
  const $opf = await parseOPF(opfPath);
  const manifest = new Map<string, ManifestItem>();
  const missingReferences = new Set<string>();
  let internalReferences = 0;

  for (const element of $opf("manifest item").toArray()) {
    const item = $opf(element);
    const id = item.attr("id") ?? "";
    const href = item.attr("href") ?? "";
    const mediaType = item.attr("media-type") ?? "";
    const manifestItem: ManifestItem = { id, mediaType };

    if (href) {
      internalReferences++;
      try {
        manifestItem.filePath = resolvePathInside(epubDir, opfDir, href, "manifest href");
        if (!(await fs.pathExists(manifestItem.filePath))) {
          missingReferences.add(`${path.relative(epubDir, opfPath)} -> ${href}`);
        }
      } catch {
        missingReferences.add(`${path.relative(epubDir, opfPath)} -> ${href} (unsafe)`);
      }
    }

    manifest.set(id, manifestItem);
  }

  const spineElements = $opf("spine itemref").toArray();
  for (const element of spineElements) {
    const idref = $opf(element).attr("idref") ?? "";
    const item = manifest.get(idref);
    if (!item?.filePath || !(await fs.pathExists(item.filePath))) {
      missingReferences.add(
        `${path.relative(epubDir, opfPath)} spine -> ${idref || "(missing idref)"}`
      );
    }
  }

  for (const item of manifest.values()) {
    if (!item.filePath || !SCANNED_MEDIA_TYPES.has(item.mediaType)) continue;
    if (!(await fs.pathExists(item.filePath))) continue;

    const content = await fs.readFile(item.filePath, "utf8");
    const references = [...collectMarkupReferences(content), ...collectCssReferences(content)];

    for (const rawReference of references) {
      const reference = normalizeReference(rawReference);
      if (isExternalReference(reference)) continue;

      internalReferences++;
      try {
        const target = resolvePathInside(
          epubDir,
          path.dirname(item.filePath),
          reference,
          "content reference"
        );
        if (!(await fs.pathExists(target))) {
          missingReferences.add(`${path.relative(epubDir, item.filePath)} -> ${reference}`);
        }
      } catch {
        missingReferences.add(`${path.relative(epubDir, item.filePath)} -> ${reference} (unsafe)`);
      }
    }
  }

  const manifestItems = Array.from(manifest.values());
  const missingReferenceTargets = Array.from(missingReferences).sort();

  return {
    manifestItems: manifestItems.length,
    spineItems: spineElements.length,
    contentDocuments: manifestItems.filter(
      ({ mediaType }) => mediaType === "application/xhtml+xml" || mediaType === "text/html"
    ).length,
    images: manifestItems.filter(({ mediaType }) => mediaType.startsWith("image/")).length,
    navigationEntries: await collectNavigationEntries(epubDir),
    internalReferences,
    missingReferences: missingReferenceTargets.length,
    missingReferenceTargets,
  };
}

export function compareEpubContentMetrics(
  before: EpubContentMetrics,
  after: EpubContentMetrics
): EpubIntegrityComparison {
  const metricNames: IntegrityCheck["name"][] = [
    "manifestItems",
    "spineItems",
    "contentDocuments",
    "images",
    "navigationEntries",
  ];
  const checks = metricNames.map((name) => ({
    name,
    before: before[name],
    after: after[name],
    passed: after[name] >= before[name],
  }));
  const previousMissing = new Set(before.missingReferenceTargets);
  const newMissingReferences = after.missingReferenceTargets.filter(
    (reference) => !previousMissing.has(reference)
  );
  const issues = checks
    .filter(({ passed }) => !passed)
    .map(
      ({ name, before: previous, after: current }) =>
        `${name} decreased from ${previous} to ${current}.`
    );

  for (const reference of newMissingReferences) {
    issues.push(`New missing internal reference: ${reference}`);
  }

  return {
    valid: issues.length === 0,
    checks,
    newMissingReferences,
    issues,
  };
}

export function assertEpubContentIntegrity(comparison: EpubIntegrityComparison): void {
  if (!comparison.valid) {
    throw new Error(`Content integrity validation failed:\n- ${comparison.issues.join("\n- ")}`);
  }
}
