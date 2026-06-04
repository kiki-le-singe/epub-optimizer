import fs from "fs-extra";
import path from "node:path";
import unzipper from "unzipper";
import type { File as ZipFileEntry } from "unzipper";
import yazl from "yazl";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import config from "../utils/config.js";

export interface ArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
}

function isZipSymlink(externalFileAttributes: number): boolean {
  const unixMode = externalFileAttributes >>> 16;
  return (unixMode & 0o170000) === 0o120000;
}

function validateArchiveMetadata(files: ZipFileEntry[], limits: ArchiveLimits): void {
  if (files.length > limits.maxEntries) {
    throw new Error(`Archive contains ${files.length} entries; limit is ${limits.maxEntries}.`);
  }

  let declaredTotal = 0;
  for (const entry of files) {
    if (isZipSymlink(entry.externalFileAttributes)) {
      throw new Error(`Archive entry ${entry.path} is a symbolic link.`);
    }
    if (entry.type === "Directory") continue;
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      throw new Error(
        `Archive entry ${entry.path} is ${entry.uncompressedSize} bytes; per-file limit is ${limits.maxEntryBytes}.`
      );
    }

    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > limits.maxTotalBytes) {
      throw new Error(`Archive expands beyond the ${limits.maxTotalBytes} byte total limit.`);
    }

    const ratio =
      entry.compressedSize === 0
        ? entry.uncompressedSize === 0
          ? 1
          : Number.POSITIVE_INFINITY
        : entry.uncompressedSize / entry.compressedSize;
    if (ratio > limits.maxCompressionRatio) {
      throw new Error(
        `Archive entry ${entry.path} has suspicious compression ratio ${ratio.toFixed(0)}:1.`
      );
    }
  }
}

/**
 * Extract EPUB file contents to a temporary directory.
 * Validates each entry against zip-slip: any entry whose resolved target
 * escapes `extractDir` aborts the extraction.
 * @throws Error if extraction fails or an entry tries to escape extractDir
 */
async function extractEPUB(
  epubPath: string,
  extractDir: string,
  limits: ArchiveLimits = config.archiveLimits
): Promise<void> {
  try {
    await fs.remove(extractDir);
    await fs.mkdir(extractDir);

    const absExtract = path.resolve(extractDir);
    const directory = await unzipper.Open.file(epubPath);
    validateArchiveMetadata(directory.files, limits);
    let extractedTotal = 0;

    for (const entry of directory.files) {
      const normalizedEntryPath = entry.path.replace(/\\/g, "/");
      if (
        !normalizedEntryPath ||
        normalizedEntryPath.startsWith("/") ||
        normalizedEntryPath.includes("\0") ||
        /^[a-z]:/i.test(normalizedEntryPath)
      ) {
        throw new Error(`Refusing unsafe archive entry: ${entry.path}`);
      }

      const target = path.resolve(absExtract, normalizedEntryPath);
      const rel = path.relative(absExtract, target);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Refusing entry outside extract dir: ${entry.path}`);
      }

      if (entry.type === "Directory") {
        await fs.ensureDir(target);
        continue;
      }

      await fs.ensureDir(path.dirname(target));
      let entryBytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          entryBytes += chunk.length;
          extractedTotal += chunk.length;

          if (entryBytes > limits.maxEntryBytes) {
            callback(new Error(`Archive entry ${entry.path} exceeded the per-file size limit.`));
            return;
          }
          if (extractedTotal > limits.maxTotalBytes) {
            callback(new Error("Archive exceeded the total extracted size limit."));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(entry.stream(), limiter, fs.createWriteStream(target));
    }
  } catch (error) {
    throw new Error(
      `Failed to extract EPUB: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/**
 * Helper function to recursively add directory contents to zip file
 * @param zipFile The yazl ZipFile instance
 * @param dirPath Full path to directory to add
 * @param zipPath Relative path within zip file
 * @param exclude Array of file/directory names to exclude
 */
async function addDirectoryRecursive(
  zipFile: yazl.ZipFile,
  dirPath: string,
  zipPath: string,
  exclude: string[] = []
): Promise<void> {
  const items = await fs.readdir(dirPath);

  for (const item of items) {
    if (exclude.includes(item)) continue;

    const fullPath = path.join(dirPath, item);
    const zipItemPath = zipPath ? `${zipPath}/${item}` : item;
    const stats = await fs.stat(fullPath);

    if (stats.isDirectory()) {
      await addDirectoryRecursive(zipFile, fullPath, zipItemPath, exclude);
    } else {
      // Add file with compression (equivalent to zip -r9)
      zipFile.addFile(fullPath, zipItemPath, {
        compress: true,
        compressionLevel: 9,
      });
    }
  }
}

/**
 * Recompress directory contents into an EPUB file (Apple Books compatible)
 * EPUB requires specific compression:
 * 1. mimetype file must be first, uncompressed, with no extra fields
 * 2. All other files should be compressed normally
 *
 * @param outputPath Path for output EPUB file
 * @param sourceDir Directory containing EPUB contents
 * @returns True if compression succeeded
 * @throws Error if compression fails
 */
async function compressEPUB(outputPath: string, sourceDir: string): Promise<boolean> {
  try {
    const absOutput = path.resolve(outputPath);
    const absSource = path.resolve(sourceDir);

    // Ensure mimetype exists and is correct
    const mimetypePath = path.join(absSource, "mimetype");
    await fs.writeFile(mimetypePath, "application/epub+zip");

    // Remove output if exists
    if (await fs.pathExists(absOutput)) await fs.unlink(absOutput);

    return new Promise((resolve, reject) => {
      const zipFile = new yazl.ZipFile();

      // Step 1: Add mimetype first, uncompressed, no extra fields
      zipFile.addFile(mimetypePath, "mimetype", {
        compress: false, // No compression (store only)
        forceZip64Format: false,
      });

      // Step 2: Add everything else, compressed, excluding mimetype
      addDirectoryRecursive(zipFile, absSource, "", ["mimetype"])
        .then(() => {
          // Write the zip file to disk
          zipFile.outputStream
            .pipe(fs.createWriteStream(absOutput))
            .on("close", () => resolve(true))
            .on("error", reject);

          zipFile.end();
        })
        .catch(reject);
    });
  } catch (error) {
    throw new Error(
      `Failed to compress EPUB: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

export { extractEPUB, compressEPUB };
