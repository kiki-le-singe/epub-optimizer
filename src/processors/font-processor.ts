import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import * as glob from "glob";
import { createRequire } from "node:module";
import { getContentPath } from "../utils/epub-utils.js";

// fontmin is a CommonJS module, so we need to use require
const require = createRequire(import.meta.url);

/**
 * Subset font files to include only characters used in the EPUB content
 * This significantly reduces font file sizes using fontmin
 * @param epubDir Directory containing the extracted EPUB
 * @throws Error if font subsetting fails
 */
async function subsetFonts(epubDir: string): Promise<void> {
  try {
    console.log("Subsetting fonts to reduce file size...");

    // Get content directory (OPS, OEBPS, or root)
    const contentDir = await getContentPath(epubDir);
    if (!(await fs.pathExists(contentDir))) {
      console.log("Content directory not found, skipping font subsetting");
      return;
    }

    // Check if fonts directory exists
    const fontsDir = path.join(contentDir, "fonts");
    if (!(await fs.pathExists(fontsDir))) {
      console.log("No fonts directory found, skipping font subsetting");
      return;
    }

    // Get all XHTML files
    const xhtmlFiles = glob.sync(path.join(contentDir, "*.xhtml"));
    if (xhtmlFiles.length === 0) {
      console.log("No XHTML files found, skipping font subsetting");
      return;
    }

    // Extract all text from XHTML files
    let allText = "";
    for (const file of xhtmlFiles) {
      const content = await fs.readFile(file, "utf8");
      const $ = cheerio.load(content, { xmlMode: true });
      allText += $("body").text();
    }

    // Create a set of unique characters
    const uniqueChars = new Set(allText);
    const uniqueCharsString = Array.from(uniqueChars).join("");
    console.log(`Found ${uniqueChars.size} unique characters in EPUB content`);

    // Get all font files
    const fontFiles = glob.sync(path.join(fontsDir, "*.{ttf,otf}"));
    if (fontFiles.length === 0) {
      console.log("No font files found");
      return;
    }

    console.log(`Found ${fontFiles.length} font files to process`);

    // Load fontmin as CommonJS module
    const Fontmin = require("fontmin");

    // Process each font file with fontmin
    for (const fontFile of fontFiles) {
      try {
        const originalSize = (await fs.stat(fontFile)).size;
        const fileName = path.basename(fontFile);
        const fileExt = path.extname(fontFile).toLowerCase();

        // Skip OTF files - fontmin's OTF support is unreliable
        if (fileExt === ".otf") {
          console.log(`Skipping OTF file (conversion not reliable): ${fileName}`);
          continue;
        }

        // Try to subset the font
        await new Promise<void>((resolve, reject) => {
          const fontmin = new Fontmin()
            .src(fontFile)
            .use(
              Fontmin.glyph({
                text: uniqueCharsString,
                hinting: false, // Remove hinting to reduce size further
              })
            )
            .dest(fontsDir);

          fontmin.run((err: Error | null, files: unknown) => {
            if (err) {
              reject(err);
            } else {
              // Check if files were generated
              if (Array.isArray(files) && files.length > 0) {
                resolve();
              } else {
                reject(new Error("No output files generated"));
              }
            }
          });
        });

        // Check if output exists and replace original
        const outputFiles = await fs.readdir(fontsDir);
        const subsetFile = outputFiles.find(
          (f) => f.includes(path.basename(fontFile, fileExt)) && f !== fileName
        );

        if (subsetFile) {
          const subsetPath = path.join(fontsDir, subsetFile);
          const newSize = (await fs.stat(subsetPath)).size;

          // Only replace if the subset is actually smaller
          if (newSize < originalSize) {
            await fs.remove(fontFile);
            await fs.rename(subsetPath, fontFile);

            const reduction = Math.round((1 - newSize / originalSize) * 100);
            console.log(
              `Subset font ${fileName}: ${formatBytes(originalSize)} → ${formatBytes(
                newSize
              )} (${reduction}% smaller)`
            );
          } else {
            // Subset is larger, keep original
            await fs.remove(subsetPath);
            console.log(`Kept original ${fileName} (subset was larger)`);
          }
        } else {
          console.log(`No subset created for ${fileName} (likely encrypted or unsupported format)`);
        }
      } catch (error) {
        console.warn(
          `Skipping font ${path.basename(fontFile)}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  } catch (error) {
    // Don't throw error, just warn - font subsetting is optional
    console.warn(
      `Font subsetting failed: ${error instanceof Error ? error.message : String(error)}`
    );
    console.warn("Continuing without font optimization...");
  }
}

/**
 * Format bytes as human-readable file size
 */
function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

export { subsetFonts };
