import fs from "fs-extra";
import path from "node:path";
import * as glob from "glob";
import { getContentPath } from "../utils/epub-utils.js";

/**
 * Add loading="lazy" to all <img> tags in XHTML files
 * @param epubDir Directory containing the extracted EPUB
 */
export async function addLazyLoadingToImages(epubDir: string): Promise<void> {
  try {
    const contentDir = await getContentPath(epubDir);
    const xhtmlFiles = glob.sync(path.join(contentDir, "*.xhtml"));
    if (xhtmlFiles.length === 0) {
      console.log("No XHTML files found for lazy loading");
      return;
    }
    for (const file of xhtmlFiles) {
      try {
        let content = await fs.readFile(file, "utf8");
        let changed = false;

        // Use regex to add loading="lazy" to <img> tags without it
        // This preserves the exact XML structure unlike Cheerio which can corrupt self-closing tags
        content = content.replace(
          /<img\s+([^>]*?)(?:\s+loading="[^"]*")?(\s*\/?>)/gi,
          (match, attrs, closing) => {
            // Check if loading attribute already exists in the matched attributes
            if (/loading\s*=\s*["'][^"']*["']/i.test(match)) {
              return match; // Already has loading attribute
            }
            changed = true;
            // Add loading="lazy" before the closing tag
            return `<img ${attrs} loading="lazy"${closing}`;
          }
        );

        if (changed) {
          await fs.writeFile(file, content);
          console.log(`Added loading="lazy" to images in ${path.basename(file)}`);
        }
      } catch (error) {
        console.warn(
          `Failed to add lazy loading to ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } catch (error) {
    console.error(
      `Lazy loading image update failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
