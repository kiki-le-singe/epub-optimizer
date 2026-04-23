import fs from "fs-extra";
import path from "node:path";
import unzipper from "unzipper";
import yazl from "yazl";

/**
 * Extract EPUB file contents to a temporary directory
 * @param epubPath Path to EPUB file
 * @param extractDir Directory to extract contents to
 * @throws Error if extraction fails
 */
async function extractEPUB(epubPath: string, extractDir: string): Promise<void> {
  try {
    // Ensure extract directory exists and is empty
    await fs.remove(extractDir);
    await fs.mkdir(extractDir);

    // Extract EPUB contents
    await fs
      .createReadStream(epubPath)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();
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
