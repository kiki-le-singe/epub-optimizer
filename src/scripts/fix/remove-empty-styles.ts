// This script removes empty style="" attributes from XHTML files.
// Empty style attributes add unnecessary bytes without providing any styling.

import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { getContentPath } from "../../utils/epub-utils.js";
import { getTempDir } from "../utils.js";

// Get temp directory from CLI args or config
const extractedDir = getTempDir();

async function main() {
  // Verify the directories exist
  if (!(await fs.pathExists(extractedDir))) {
    console.error(`Error: Directory ${extractedDir} does not exist.`);
    console.error("Please run the optimization script first to extract the EPUB.");
    process.exit(1);
  }

  const contentDir = await getContentPath(extractedDir);
  if (!(await fs.pathExists(contentDir))) {
    console.error(`Error: Content directory ${contentDir} does not exist.`);
    console.error("Please make sure the extracted EPUB has a content directory (OPS or OEBPS).");
    process.exit(1);
  }

  // Get all chapter XHTML files
  const files = (await fs.readdir(contentDir))
    .filter((file) => file.endsWith(".xhtml"))
    .map((file) => path.join(contentDir, file));

  let totalRemoved = 0;

  for (const file of files) {
    const removed = await fixFile(file);
    totalRemoved += removed;
  }

  console.log(`Removed ${totalRemoved} empty style attributes from ${files.length} files.`);
}

async function fixFile(file: string): Promise<number> {
  try {
    console.log(`Processing ${file}`);
    const content = await fs.readFile(file, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });

    // Find all elements with style="" attribute
    let removedCount = 0;
    $('[style=""]').each((_index, element) => {
      $(element).removeAttr("style");
      removedCount++;
    });

    if (removedCount > 0) {
      const fixed = $.xml();
      await fs.writeFile(file, fixed);
      console.log(`Removed ${removedCount} empty style attribute(s) from ${path.basename(file)}`);
    }

    return removedCount;
  } catch (error) {
    console.error(`Error processing ${file}:`, error);
    return 0;
  }
}

// Use void operator to explicitly mark the promise as intentionally not awaited
void main();
