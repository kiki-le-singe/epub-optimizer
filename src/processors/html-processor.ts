import fs from "fs-extra";
import path from "node:path";
import { minify } from "html-minifier-terser";
import CleanCSS from "clean-css";
import * as cheerio from "cheerio";
import config from "../utils/config.js";

/**
 * Process HTML and CSS files in a directory recursively
 * Minifies HTML/XHTML and CSS files to reduce file size
 * @param dir Directory to process
 * @throws Error if processing fails
 */
async function processHTML(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory()) {
        await processHTML(fullPath);
      } else if (entry.endsWith(".xhtml") || entry.endsWith(".html")) {
        await minifyHTML(fullPath);
      } else if (entry.endsWith(".css")) {
        await minifyCSS(fullPath);
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to process HTML/CSS in ${dir}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Minify HTML/XHTML file using cheerio and html-minifier-terser
 * @param filePath Path to HTML/XHTML file
 * @throws Error if minification fails
 */
async function minifyHTML(filePath: string): Promise<void> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    // Use cheerio for DOM manipulation with appropriate XML mode for XHTML
    const isXHTML = filePath.endsWith(".xhtml");
    const $ = cheerio.load(content, { xmlMode: isXHTML });
    // Use .xml() for XHTML to preserve XML structure (self-closing tags, etc.)
    const domContent = isXHTML ? $.xml() : $.html();
    const minified = await minify(domContent, config.htmlOptions);
    await fs.writeFile(filePath, minified);
  } catch (error) {
    throw new Error(
      `Failed to minify HTML file ${path.basename(filePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Minify CSS file using CleanCSS
 * @param filePath Path to CSS file
 * @throws Error if minification fails
 */
async function minifyCSS(filePath: string): Promise<void> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const cssResult = new CleanCSS({ level: 2 }).minify(content);
    await fs.writeFile(filePath, cssResult.styles);
  } catch (error) {
    throw new Error(
      `Failed to minify CSS file ${path.basename(filePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export { processHTML, minifyHTML, minifyCSS };
