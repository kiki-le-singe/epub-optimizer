import { reportError, reportInfo, reportWarning } from "../utils/diagnostics.js";
import fs from "fs-extra";
import path from "node:path";
import { optimize as svgoOptimize } from "svgo";
import { collectManifestResources } from "../utils/epub-utils.js";
import { forEachFileLimited } from "../utils/files.js";

const SVG_MEDIA_TYPES = new Set(["image/svg+xml"]);
const SVG_EXTENSIONS = new Set([".svg"]);

/**
 * Optimize SVG files in the EPUB images directory
 * @param epubDir Directory containing the extracted EPUB
 */
export async function optimizeSVGs(epubDir: string): Promise<void> {
  try {
    // Discover SVGs via the OPF manifest (any folder/case), not a hardcoded
    // `images/` folder — Sigil/EDRLab use capitalized `Images/`, etc.
    const svgFiles = await collectManifestResources(epubDir, {
      mediaTypes: SVG_MEDIA_TYPES,
      extensions: SVG_EXTENSIONS,
    });
    if (svgFiles.length === 0) {
      reportInfo("No SVG files found");
      return;
    }
    reportInfo(`Optimizing ${svgFiles.length} SVG files...`);
    await forEachFileLimited(svgFiles, async (svgFile) => {
      try {
        const original = await fs.readFile(svgFile, "utf8");
        const result = svgoOptimize(original, {
          multipass: true,
          plugins: [{ name: "preset-default", params: { overrides: { cleanupIds: false } } }],
        });
        if (result.data && result.data.length < original.length) {
          await fs.writeFile(svgFile, result.data);
          reportInfo(
            `Optimized ${path.basename(svgFile)}: ${original.length} → ${result.data.length} bytes`
          );
        } else {
          reportInfo(`No optimization for ${path.basename(svgFile)}`);
        }
      } catch (error) {
        reportWarning(
          `Failed to optimize ${path.basename(svgFile)}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  } catch (error) {
    reportError(
      `SVG optimization failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
