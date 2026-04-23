import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";

/**
 * Dynamically reads the OPF file path from META-INF/container.xml
 * This follows the EPUB specification instead of hardcoding filenames
 * @param epubDir Path to the extracted EPUB directory
 * @returns Full path to the OPF file
 * @throws Error if container.xml is not found or OPF path cannot be determined
 */
export async function getOPFPath(epubDir: string): Promise<string> {
  const containerPath = path.join(epubDir, "META-INF", "container.xml");

  if (!(await fs.pathExists(containerPath))) {
    throw new Error(`Container file not found: ${containerPath}`);
  }

  try {
    const content = await fs.readFile(containerPath, "utf-8");
    const $ = cheerio.load(content, { xmlMode: true });

    const rootfile = $("rootfile").first();
    const fullPath = rootfile.attr("full-path");

    if (!fullPath) {
      throw new Error("No OPF path found in container.xml");
    }

    const opfPath = path.join(epubDir, fullPath);

    if (!(await fs.pathExists(opfPath))) {
      throw new Error(`OPF file not found: ${opfPath}`);
    }

    return opfPath;
  } catch (error) {
    throw new Error(`Failed to parse container.xml: ${error}`, { cause: error });
  }
}

/**
 * Determines the content directory used by the EPUB
 * Checks for standard directory conventions: OPS (modern) and OEBPS (legacy)
 * @param epubDir Path to the extracted EPUB directory
 * @returns The content directory name (e.g., "OPS", "OEBPS") or empty string if content is in root
 */
export async function getContentDir(epubDir: string): Promise<string> {
  // Standard EPUB content directory conventions
  const standardDirs = ["OPS", "OEBPS"];

  // Check each standard directory
  for (const dir of standardDirs) {
    const dirPath = path.join(epubDir, dir);
    if (await fs.pathExists(dirPath)) {
      try {
        const stat = await fs.stat(dirPath);
        if (stat && stat.isDirectory()) {
          return dir;
        }
      } catch {
        // If stat fails, continue to next directory
        continue;
      }
    }
  }

  // Fallback: try to detect from OPF location
  try {
    const opfPath = await getOPFPath(epubDir);
    const opfDir = path.dirname(path.relative(epubDir, opfPath));

    // If OPF is in root, return empty string
    if (opfDir === "." || opfDir === "") {
      return "";
    }

    // Return the directory containing the OPF
    return opfDir;
  } catch {
    // If all else fails, assume content is in root
    return "";
  }
}

/**
 * Gets the full path to the content directory
 * @param epubDir Path to the extracted EPUB directory
 * @returns Full path to the content directory
 */
export async function getContentPath(epubDir: string): Promise<string> {
  const contentDir = await getContentDir(epubDir);
  return contentDir ? path.join(epubDir, contentDir) : epubDir;
}

/**
 * Safely parses an OPF file with error handling
 * @param opfPath Path to the OPF file
 * @returns Cheerio document object for the OPF file
 * @throws Error if OPF file cannot be read or parsed
 */
export async function parseOPF(opfPath: string): Promise<cheerio.CheerioAPI> {
  if (!(await fs.pathExists(opfPath))) {
    throw new Error(`OPF file not found: ${opfPath}`);
  }

  try {
    const content = await fs.readFile(opfPath, "utf-8");
    return cheerio.load(content, { xmlMode: true });
  } catch (error) {
    throw new Error(`Failed to parse OPF file ${opfPath}: ${error}`, { cause: error });
  }
}

/**
 * Interface for TOC file information
 */
export interface TOCFiles {
  /** EPUB3 navigation file (modern readers) */
  epub3Nav?: string;
  /** EPUB2 NCX file (legacy/Kindle readers) */
  epub2Ncx?: string;
}

/**
 * Dynamically discovers TOC files from the OPF manifest
 * Follows EPUB specification instead of hardcoding filenames
 * @param epubDir Path to the extracted EPUB directory
 * @returns Object containing paths to discovered TOC files
 * @throws Error if OPF file cannot be read or parsed
 */
export async function getTOCFiles(epubDir: string): Promise<TOCFiles> {
  try {
    const opfPath = await getOPFPath(epubDir);
    const $ = await parseOPF(opfPath);
    const contentDir = await getContentPath(epubDir);

    const tocFiles: TOCFiles = {};

    // Find EPUB3 navigation file (properties="nav")
    const navItem = $('item[properties*="nav"]').first();
    if (navItem.length) {
      const href = navItem.attr("href");
      if (href) {
        const navPath = path.join(contentDir, href);
        if (await fs.pathExists(navPath)) {
          tocFiles.epub3Nav = navPath;
        }
      }
    }

    // Find EPUB2 NCX file (media-type="application/x-dtbncx+xml")
    const ncxItem = $('item[media-type="application/x-dtbncx+xml"]').first();
    if (ncxItem.length) {
      const href = ncxItem.attr("href");
      if (href) {
        const ncxPath = path.join(contentDir, href);
        if (await fs.pathExists(ncxPath)) {
          tocFiles.epub2Ncx = ncxPath;
        }
      }
    }

    return tocFiles;
  } catch (error) {
    throw new Error(
      `Failed to discover TOC files: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/**
 * Gets the EPUB3 navigation file path from OPF manifest
 * @param epubDir Path to the extracted EPUB directory
 * @returns Full path to EPUB3 navigation file, or null if not found
 */
export async function getEPUB3NavPath(epubDir: string): Promise<string | null> {
  try {
    const tocFiles = await getTOCFiles(epubDir);
    return tocFiles.epub3Nav || null;
  } catch {
    return null;
  }
}

/**
 * Gets the EPUB2 NCX file path from OPF manifest
 * @param epubDir Path to the extracted EPUB directory
 * @returns Full path to EPUB2 NCX file, or null if not found
 */
export async function getEPUB2NCXPath(epubDir: string): Promise<string | null> {
  try {
    const tocFiles = await getTOCFiles(epubDir);
    return tocFiles.epub2Ncx || null;
  } catch {
    return null;
  }
}
