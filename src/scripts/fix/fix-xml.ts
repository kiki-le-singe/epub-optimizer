// This script fixes the XML/XHTML files.
// It is used to fix the XML/XHTML files after the book is built.
// There were some issues like <br> tags that were not self-closed or invalid tags.

import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { getTempDir, isEntryPoint, type RunOpts } from "../utils.js";

// Properly format self-closing tags in XML/XHTML files
export function fixXml(originalContent: string): string {
  // Remove all </br> tags (invalid in XHTML)
  let processedContent = originalContent.replace(/<\/br>/gi, "");
  // Convert all <br> to <br/> (self-closing)
  processedContent = processedContent.replace(/<br(?![a-zA-Z0-9/])/gi, "<br/");

  // Ensure XML declaration is immediately followed by <html>
  processedContent = processedContent.replace(/(<\?xml[^>]+>)[\s\r\n]+<html/, "$1<html");

  // Use cheerio for DOM manipulation
  const $ = cheerio.load(processedContent, { xmlMode: true });

  // Remove all <script> tags (not allowed in EPUB XHTML)
  $("script").remove();

  // Only keep <meta> tags that are direct children of <head>
  $("meta").each((_, el) => {
    const parent = $(el).parent();
    if (!parent.is("head")) {
      $(el).remove();
    }
  });

  // Remove any text nodes that are direct children of <html>
  $("html")
    .contents()
    .filter((_, node) => (node as { type?: string }).type === "text")
    .remove();

  // Remove any text nodes that are direct children of <body>
  $("body")
    .contents()
    .filter(
      (_, node) => (node as { type?: string }).type === "text" && $(node).text().trim().length > 0
    )
    .remove();

  // Serialize back to XML
  return $.xml();
}

import { getContentPath } from "../../utils/epub-utils.js";

export async function run(opts: RunOpts = {}): Promise<void> {
  const extractedDir = opts.tempDir ?? getTempDir();

  if (!fs.existsSync(extractedDir)) {
    throw new Error(`Directory ${extractedDir} does not exist.`);
  }

  const contentDir = await getContentPath(extractedDir);
  if (!fs.existsSync(contentDir)) {
    throw new Error(`Content directory ${contentDir} does not exist.`);
  }

  const xhtmlFiles = fs
    .readdirSync(contentDir)
    .filter((file) => file.endsWith(".xhtml"))
    .map((file) => path.join(contentDir, file));

  for (const file of xhtmlFiles) {
    try {
      console.log(`Processing ${file}`);
      const content = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, fixXml(content));
    } catch (error) {
      console.error(`Error processing ${file}:`, error);
    }
  }

  console.log("All files processed.");
}

if (isEntryPoint(import.meta.url)) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
