// This script fixes the XML/XHTML files.
// It is used to fix the XML/XHTML files after the book is built.
// There were some issues like <br> tags that were not self-closed or invalid tags.

import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { getTempDir, isEntryPoint, type RunOpts } from "../utils.js";
import { normalizeVoidElements } from "../../utils/xhtml.js";

// Properly format self-closing tags in XML/XHTML files
export function fixXml(originalContent: string): string {
  // Self-close every HTML5 void element (link, meta, img, br, hr, input, …).
  // Remove invalid </br> markup without touching strings in attributes/scripts.
  let processedContent = normalizeVoidElements(originalContent, { removeInvalidBrClosings: true });

  // Ensure XML declaration is immediately followed by <html>
  processedContent = processedContent.replace(/(<\?xml[^>]+>)[\s\r\n]+<html/, "$1<html");

  // Use cheerio for DOM manipulation
  const $ = cheerio.load(processedContent, { xmlMode: true });

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

  // Text directly inside body and scripts are valid EPUB content. Repairing
  // XML structure must not delete them or change the scripted manifest flag.

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
