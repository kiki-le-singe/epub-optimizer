import { reportInfo } from "./diagnostics.js";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import unzipper from "unzipper";
import { detectEpubFeatures } from "./epub-features.js";
import { findInternalDtdSubsets } from "./xml-dtd.js";
import * as cheerio from "cheerio";
import { extractEPUB } from "../processors/archive-processor.js";
import { collectEpubContentMetrics, type EpubContentMetrics } from "./epub-integrity.js";
import { getContentPath, getOPFPath, getTOCFiles, parseOPF } from "./epub-utils.js";
import { resolvePathInside } from "./path-safety.js";

export interface DoctorImage {
  href: string;
  mediaType: string;
  bytes: number;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  exists: boolean;
}

export interface DoctorRisk {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

interface DoctorReportBase {
  input: string;
  archiveBytes: number;
  optimization: { blocked: boolean; blockers: DoctorRisk[] };
  risks: DoctorRisk[];
}

export interface BlockedDoctorReport extends DoctorReportBase {
  analysisComplete: false;
}

export interface EpubDoctorReport extends DoctorReportBase {
  analysisComplete: true;
  opf: {
    path: string;
    version?: string;
    manifestItems: number;
    spineItems: number;
    contentDirectory: string;
  };
  navigation: {
    hasEpub3Nav: boolean;
    hasNcx: boolean;
    entries: number;
  };
  references: {
    internal: number;
    missing: number;
    missingTargets: string[];
  };
  images: {
    count: number;
    totalBytes: number;
    compressedBytes: number | null;
    archivePercent: number | null;
    byMediaType: Record<string, { count: number; bytes: number }>;
    largest: DoctorImage[];
    duplicateBasenames: Array<{ basename: string; hrefs: string[] }>;
    largeRasterImages: DoctorImage[];
    opaquePngCandidates: DoctorImage[];
  };
  content: EpubContentMetrics;
  risks: DoctorRisk[];
}

export type DoctorReport = EpubDoctorReport | BlockedDoctorReport;

interface ManifestImageItem {
  href: string;
  mediaType: string;
  filePath?: string;
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function basenameFromHref(href: string): string {
  const pathPart = href.split(/[?#]/, 1)[0] ?? "";
  try {
    return path.posix.basename(decodeURI(pathPart));
  } catch {
    return path.posix.basename(pathPart);
  }
}

function addRisk(risks: DoctorRisk[], level: DoctorRisk["level"], code: string, message: string) {
  risks.push({ level, code, message });
}

async function readImageDetails(item: ManifestImageItem): Promise<DoctorImage> {
  if (!item.filePath || !(await fs.pathExists(item.filePath))) {
    return {
      href: item.href,
      mediaType: item.mediaType,
      bytes: 0,
      exists: false,
    };
  }

  const stats = await fs.stat(item.filePath);
  const image: DoctorImage = {
    href: item.href,
    mediaType: item.mediaType,
    bytes: stats.size,
    exists: true,
  };

  if (item.mediaType !== "image/svg+xml") {
    try {
      const metadata = await sharp(item.filePath).metadata();
      image.width = metadata.width;
      image.height = metadata.height;
      image.hasAlpha = metadata.hasAlpha;
    } catch {
      // Keep the byte-level report even when image metadata cannot be decoded.
    }
  }

  return image;
}

async function collectManifestImages(
  epubDir: string,
  opfPath: string,
  $opf: cheerio.CheerioAPI,
  archiveEntries?: ReadonlyMap<string, number>
): Promise<{ images: DoctorImage[]; compressedBytes?: number }> {
  const opfDir = path.dirname(opfPath);
  const items: ManifestImageItem[] = [];

  for (const element of $opf("manifest item").toArray()) {
    const item = $opf(element);
    const mediaType = item.attr("media-type") ?? "";
    const href = item.attr("href") ?? "";
    if (!href || !mediaType.startsWith("image/")) continue;

    try {
      items.push({
        href,
        mediaType,
        filePath: resolvePathInside(epubDir, opfDir, href, "image manifest href"),
      });
    } catch {
      items.push({ href, mediaType });
    }
  }

  const images = await Promise.all(items.map((item) => readImageDetails(item)));
  const imagePaths = new Set(
    items.flatMap((item, index) =>
      item.filePath && images[index]?.exists
        ? [toPosixPath(path.relative(epubDir, item.filePath))]
        : []
    )
  );
  const sizes = archiveEntries ? [...imagePaths].map((file) => archiveEntries.get(file)) : [];
  const compressedBytes =
    archiveEntries && sizes.every((size) => size !== undefined)
      ? sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0)
      : undefined;
  return { images, compressedBytes };
}

function summarizeImages(
  images: DoctorImage[],
  archiveBytes: number,
  compressedBytes?: number
): EpubDoctorReport["images"] {
  const byMediaType: Record<string, { count: number; bytes: number }> = {};
  const basenameGroups = new Map<string, string[]>();
  const totalBytes = images.reduce((sum, image) => sum + image.bytes, 0);

  for (const image of images) {
    const typeSummary = byMediaType[image.mediaType] ?? { count: 0, bytes: 0 };
    typeSummary.count++;
    typeSummary.bytes += image.bytes;
    byMediaType[image.mediaType] = typeSummary;

    const basename = basenameFromHref(image.href);
    basenameGroups.set(basename, [...(basenameGroups.get(basename) ?? []), image.href]);
  }

  return {
    count: images.length,
    totalBytes,
    compressedBytes: compressedBytes ?? null,
    archivePercent:
      compressedBytes !== undefined && archiveBytes > 0 && compressedBytes <= archiveBytes
        ? (compressedBytes / archiveBytes) * 100
        : null,
    byMediaType,
    largest: [...images].sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    duplicateBasenames: Array.from(basenameGroups.entries())
      .filter(([, hrefs]) => hrefs.length > 1)
      .map(([basename, hrefs]) => ({ basename, hrefs })),
    largeRasterImages: images.filter(
      (image) =>
        image.mediaType !== "image/svg+xml" &&
        ((image.width ?? 0) > 1600 || (image.height ?? 0) > 1600)
    ),
    opaquePngCandidates: images.filter(
      (image) =>
        image.mediaType === "image/png" && image.bytes >= 200 * 1024 && image.hasAlpha === false
    ),
  };
}

function buildRisks(report: Omit<EpubDoctorReport, "risks">): DoctorRisk[] {
  const risks: DoctorRisk[] = [];

  if (report.references.missing > 0) {
    addRisk(
      risks,
      "warning",
      "missing-references",
      `${report.references.missing} internal reference(s) are missing.`
    );
  }
  if (!report.navigation.hasEpub3Nav) {
    addRisk(risks, "warning", "missing-epub3-nav", "No EPUB3 navigation document was found.");
  }
  if (!report.navigation.hasNcx) {
    addRisk(
      risks,
      "info",
      "missing-ncx",
      "No legacy NCX navigation file was found; this is acceptable for EPUB3-only books."
    );
  }
  if (report.images.archivePercent !== null && report.images.archivePercent >= 60) {
    addRisk(
      risks,
      "info",
      "image-heavy",
      `Manifest images account for ${report.images.archivePercent.toFixed(1)}% of the archive.`
    );
  }
  if (report.images.largeRasterImages.length > 0) {
    addRisk(
      risks,
      "info",
      "large-raster-images",
      `${report.images.largeRasterImages.length} raster image(s) exceed 1600 px on at least one axis.`
    );
  }
  if (report.images.opaquePngCandidates.length > 0) {
    addRisk(
      risks,
      "info",
      "png-conversion-candidates",
      `${report.images.opaquePngCandidates.length} large opaque PNG image(s) may benefit from JPEG conversion.`
    );
  }
  if (report.images.duplicateBasenames.length > 0) {
    addRisk(
      risks,
      "info",
      "duplicate-image-basenames",
      `${report.images.duplicateBasenames.length} image basename(s) appear in multiple directories.`
    );
  }

  return risks;
}

export async function inspectExtractedEpub(
  epubDir: string,
  options: {
    input: string;
    archiveBytes: number;
    archiveEntries?: ReadonlyMap<string, number>;
  }
): Promise<DoctorReport> {
  const internalDtdFiles = await findInternalDtdSubsets(epubDir);
  const blockers: DoctorRisk[] = [];
  if (internalDtdFiles.length > 0) {
    blockers.push({
      level: "error",
      code: "internal-dtd",
      message: `Internal DTD subsets prevent optimization: ${internalDtdFiles.map((file) => JSON.stringify(file)).join(", ")}. Replace internal declarations with literal text or numeric references before retrying.`,
    });
  } else {
    // Never parse an OPF or other XML while its DTD semantics are unsupported.
    const features = await detectEpubFeatures(epubDir);
    if (features.encryptionKind === "drm") {
      blockers.push({
        level: "error",
        code: "drm",
        message:
          "Encrypted/DRM-protected resources prevent optimization (META-INF/encryption.xml).",
      });
    }
  }
  if (blockers.length > 0) {
    return {
      input: options.input,
      archiveBytes: options.archiveBytes,
      analysisComplete: false,
      optimization: { blocked: true, blockers },
      risks: blockers,
    };
  }
  const opfPath = await getOPFPath(epubDir);
  const $opf = await parseOPF(opfPath);
  const contentPath = await getContentPath(epubDir);
  const tocFiles = await getTOCFiles(epubDir);
  const content = await collectEpubContentMetrics(epubDir);
  const manifestImages = await collectManifestImages(
    epubDir,
    opfPath,
    $opf,
    options.archiveEntries
  );
  const images = summarizeImages(
    manifestImages.images,
    options.archiveBytes,
    manifestImages.compressedBytes
  );
  const reportWithoutRisks = {
    analysisComplete: true as const,
    optimization: { blocked: false, blockers: [] },
    input: options.input,
    archiveBytes: options.archiveBytes,
    opf: {
      path: toPosixPath(path.relative(epubDir, opfPath)),
      version: $opf("package").first().attr("version"),
      manifestItems: content.manifestItems,
      spineItems: content.spineItems,
      contentDirectory: toPosixPath(path.relative(epubDir, contentPath)) || ".",
    },
    navigation: {
      hasEpub3Nav: tocFiles.epub3Nav !== undefined,
      hasNcx: tocFiles.epub2Ncx !== undefined,
      entries: content.navigationEntries,
    },
    references: {
      internal: content.internalReferences,
      missing: content.missingReferences,
      missingTargets: content.missingReferenceTargets,
    },
    images,
    content,
  };

  return {
    ...reportWithoutRisks,
    risks: buildRisks(reportWithoutRisks),
  };
}

export function printDoctorReport(report: DoctorReport): void {
  reportInfo("\n=== EPUB Doctor ===");
  reportInfo(`Input: ${report.input}`);
  reportInfo(`Archive: ${formatBytes(report.archiveBytes)}`);
  if (!report.analysisComplete) {
    reportInfo("Optimization is blocked:");
    for (const blocker of report.optimization.blockers) reportInfo(`- ${blocker.message}`);
    reportInfo("Detailed content metrics are unavailable for this unsupported EPUB.\n");
    return;
  }
  reportInfo(
    `OPF: ${report.opf.path} (${report.opf.version ? `EPUB ${report.opf.version}` : "version unknown"}), manifest ${report.opf.manifestItems}, spine ${report.opf.spineItems}`
  );
  reportInfo(
    `Navigation: EPUB3 nav ${report.navigation.hasEpub3Nav ? "yes" : "no"}, NCX ${report.navigation.hasNcx ? "yes" : "no"}, entries ${report.navigation.entries}`
  );
  reportInfo(
    `Internal refs: ${report.references.internal} checked, ${report.references.missing} missing`
  );
  const compressedShare =
    report.images.archivePercent === null
      ? "compressed archive share unavailable"
      : `${report.images.archivePercent.toFixed(1)}% of compressed archive`;
  reportInfo(
    `Images: ${report.images.count} manifest item(s), ${formatBytes(report.images.totalBytes)} uncompressed (${compressedShare})`
  );

  if (report.images.largest.length > 0) {
    reportInfo("Largest images:");
    for (const image of report.images.largest) {
      const dimensions = image.width && image.height ? `, ${image.width}x${image.height}` : "";
      reportInfo(`- ${image.href}: ${formatBytes(image.bytes)}${dimensions}`);
    }
  }

  if (report.references.missingTargets.length > 0) {
    reportInfo("Missing references:");
    for (const reference of report.references.missingTargets.slice(0, 10)) {
      reportInfo(`- ${reference}`);
    }
    if (report.references.missingTargets.length > 10) {
      reportInfo(`- ... ${report.references.missingTargets.length - 10} more`);
    }
  }

  reportInfo("Optimization risks:");
  if (report.risks.length === 0) {
    reportInfo("- No obvious optimization risks found.");
  } else {
    for (const risk of report.risks) {
      reportInfo(`- [${risk.level}] ${risk.message}`);
    }
  }
  reportInfo("");
}

export async function runDoctor(options: {
  input: string;
  reportJson?: string;
}): Promise<DoctorReport> {
  if (!(await fs.pathExists(options.input))) {
    throw new Error(`Input file not found: ${options.input}`);
  }
  if (!(await fs.stat(options.input)).isFile()) {
    throw new Error(`Input path must point to a regular file: ${options.input}`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "epub-optimizer-doctor-"));
  try {
    const extractedDir = path.join(tempDir, "content");
    await extractEPUB(options.input, extractedDir);
    const archive = await unzipper.Open.file(options.input);
    const archiveEntries = new Map(
      archive.files
        .filter((entry) => entry.type !== "Directory")
        .map((entry) => [
          toPosixPath(
            path.relative(extractedDir, path.resolve(extractedDir, entry.path.replace(/\\/g, "/")))
          ),
          entry.compressedSize,
        ])
    );
    const report = await inspectExtractedEpub(extractedDir, {
      archiveEntries,
      input: options.input,
      archiveBytes: (await fs.stat(options.input)).size,
    });
    printDoctorReport(report);

    if (options.reportJson) {
      const absolutePath = path.resolve(options.reportJson);
      await fs.ensureDir(path.dirname(absolutePath));
      await fs.writeJson(absolutePath, report, { spaces: 2 });
      reportInfo(`Wrote JSON report: ${absolutePath}`);
    }

    return report;
  } finally {
    await fs.remove(tempDir);
  }
}
