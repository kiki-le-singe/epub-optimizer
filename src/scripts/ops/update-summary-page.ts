import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { getCoverLabel } from "../../utils/i18n.js";
import { getContentPath } from "../../utils/epub-utils.js";
import { getTempDir } from "../utils.js";

// Get the localized cover label
const COVER_LABEL = getCoverLabel();

// Define file paths
const extractedDir = getTempDir();
const contentDir = await getContentPath(extractedDir);
const summaryFile = path.join(contentDir, "chapter-2.xhtml");

// Check if file exists
if (!fs.existsSync(summaryFile)) {
  console.error(`Error: Summary file not found at ${summaryFile}`);
  process.exit(1);
}

try {
  console.log(`Updating summary page: ${summaryFile}`);

  // Read and parse summary file
  const content = fs.readFileSync(summaryFile, "utf8");
  const $ = cheerio.load(content, { xmlMode: true });

  // Remove the 'Sommaire' link (self-reference)
  $('a[href="chapter-2.xhtml"]').parent().remove();

  // Check if cover is already in the summary page
  const coverLink = $('a[href="cover.xhtml"]');

  if (coverLink.length === 0) {
    // Get the first link paragraph
    const firstLink = $("p.p6").first();

    if (firstLink.length) {
      // Create new paragraph with cover link
      const coverParagraph = $('<p class="p6" style=""></p>');
      const anchorElement = $(`<a href="cover.xhtml">${COVER_LABEL}</a>`);
      coverParagraph.append(anchorElement);

      // Insert before the first link
      firstLink.before(coverParagraph);

      console.log("Successfully added cover to summary page");
    } else {
      console.log("Warning: Could not find link paragraphs in summary page");
    }
  } else {
    console.log("Cover is already in the summary page");
  }

  // Save the updated summary page
  fs.writeFileSync(summaryFile, $.xml());
  console.log("Summary page updated successfully");
} catch (error: unknown) {
  // Properly handle unknown error type
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`Error updating summary page: ${errorMessage}`);
}
