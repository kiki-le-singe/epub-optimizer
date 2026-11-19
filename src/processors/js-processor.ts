import { reportInfo, reportWarning } from "../utils/diagnostics.js";
import fs from "fs-extra";
import path from "node:path";
import { minify as terserMinify } from "terser";
import { collectFiles, forEachFileLimited, hasExtension } from "../utils/files.js";

const JS_EXTENSIONS = new Set([".js"]);

/**
 * Minify JavaScript files in the EPUB
 * @param dir Directory containing JS files
 * @throws Error if minification fails
 */
async function minifyJavaScript(dir: string): Promise<void> {
  try {
    reportInfo("Minifying JavaScript files...");

    const jsFiles = await collectFiles(dir, (filePath) => hasExtension(filePath, JS_EXTENSIONS));

    if (jsFiles.length === 0) {
      reportInfo("No JavaScript files found");
      return;
    }

    reportInfo(`Found ${jsFiles.length} JavaScript files to minify`);

    await forEachFileLimited(jsFiles, async (jsFile) => {
      try {
        // Read original file
        const content = await fs.readFile(jsFile, "utf8");
        const originalSize = Buffer.from(content).length;

        // Skip empty files
        if (content.trim() === "") {
          reportInfo(`Skipping empty file: ${path.basename(jsFile)}`);
          return;
        }

        // Minify with Terser
        const result = await terserMinify(content, {
          compress: true,
          mangle: true,
          output: {
            // Keep license notices (/*! … */, @license, @preserve), as CSS and
            // inline scripts already do; other comments are removed.
            comments: "some",
          },
        });

        if (!result.code) {
          reportInfo(`Skipping ${path.basename(jsFile)}: No output from minifier`);
          return;
        }
        const newSize = Buffer.from(result.code).length;
        // Already compact code can grow, for example by a statement terminator.
        if (newSize >= originalSize) {
          reportInfo(`Keeping ${path.basename(jsFile)}: minification would not reduce size`);
          return;
        }
        await fs.writeFile(jsFile, result.code);
        const reduction = Math.round(((originalSize - newSize) / originalSize) * 100);
        reportInfo(
          `Minified ${path.basename(jsFile)}: ${originalSize} bytes → ${newSize} bytes (${reduction}% smaller)`
        );
      } catch (error) {
        reportWarning(
          `Skipping ${path.basename(jsFile)}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  } catch (error) {
    throw new Error(
      `Failed to minify JavaScript: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

export { minifyJavaScript };
