import { reportError, reportInfo } from "./diagnostics.js";
import fs from "fs-extra";

/**
 * Compare and report original vs optimized file sizes
 * @param originalPath Path to original file
 * @param optimizedPath Path to optimized file
 */
async function reportFileSizeComparison(
  originalPath: string,
  optimizedPath: string
): Promise<void> {
  try {
    const originalSize = (await fs.stat(originalPath)).size;
    const optimizedSize = (await fs.stat(optimizedPath)).size;
    const reduction = ((originalSize - optimizedSize) / originalSize) * 100;
    const bytesSaved = originalSize - optimizedSize;

    reportInfo(`
📊 File Size Comparison:
   Original: ${formatFileSize(originalSize)}
   Optimized: ${formatFileSize(optimizedSize)}
   Reduction: ${reduction.toFixed(2)}% (${formatFileSize(bytesSaved)} saved)
    `);
  } catch {
    reportError("⚠️ Could not generate file size comparison");
  }
}

/**
 * Format file size in human readable format
 * @param bytes File size in bytes
 * @returns Formatted file size
 */
function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

export { formatFileSize, reportFileSizeComparison };
