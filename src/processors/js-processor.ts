import fs from "fs-extra";
import path from "node:path";
import * as glob from "glob";
import { minify as terserMinify } from "terser";

/**
 * Minify JavaScript files in the EPUB
 * @param dir Directory containing JS files
 * @throws Error if minification fails
 */
async function minifyJavaScript(dir: string): Promise<void> {
  try {
    console.log("Minifying JavaScript files...");

    // Get all JS files recursively
    const jsFiles = glob.sync(path.join(dir, "**", "*.js"));

    if (jsFiles.length === 0) {
      console.log("No JavaScript files found");
      return;
    }

    console.log(`Found ${jsFiles.length} JavaScript files to minify`);

    for (const jsFile of jsFiles) {
      try {
        // Read original file
        const content = await fs.readFile(jsFile, "utf8");
        const originalSize = Buffer.from(content).length;

        // Skip empty files
        if (content.trim() === "") {
          console.log(`Skipping empty file: ${path.basename(jsFile)}`);
          continue;
        }

        // Minify with Terser
        const result = await terserMinify(content, {
          compress: true,
          mangle: true,
          output: {
            comments: false,
          },
        });

        if (result.code) {
          // Write minified file
          await fs.writeFile(jsFile, result.code);
          const newSize = Buffer.from(result.code).length;
          const reduction = Math.round(((originalSize - newSize) / originalSize) * 100);

          console.log(
            `Minified ${path.basename(jsFile)}: ${originalSize} bytes → ${newSize} bytes (${reduction}% smaller)`
          );
        } else {
          console.log(`Skipping ${path.basename(jsFile)}: No output from minifier`);
        }
      } catch (error) {
        console.warn(
          `Skipping ${path.basename(jsFile)}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to minify JavaScript: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

export { minifyJavaScript };
