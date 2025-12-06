// This script fixes the span tags in the XHTML files after the book is built.
// There were some issues like <span> tags that were not closed.

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

  for (const file of files) {
    await fixFile(file);
  }

  console.log("All XHTML files fixed.");
}

async function fixFile(file: string) {
  try {
    console.log(`Processing ${file}`);
    const content = await fs.readFile(file, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });
    // Cheerio auto-closes tags on serialization
    const fixed = $.xml();
    await fs.writeFile(file, fixed);
    console.log(`Fixed ${path.basename(file)}`);
  } catch (error) {
    console.error(`Error processing ${file}:`, error);
  }
}

// Use void operator to explicitly mark the promise as intentionally not awaited
void main();
