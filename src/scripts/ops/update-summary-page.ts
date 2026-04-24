import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { getCoverLabel } from "../../utils/i18n.js";
import { getContentPath } from "../../utils/epub-utils.js";
import { getLang, getTempDir, isEntryPoint, type RunOpts } from "../utils.js";

export async function run(opts: RunOpts = {}): Promise<void> {
  const extractedDir = opts.tempDir ?? getTempDir();
  const coverLabel = getCoverLabel(opts.lang ?? getLang());

  const contentDir = await getContentPath(extractedDir);
  const summaryFile = path.join(contentDir, "chapter-2.xhtml");

  if (!fs.existsSync(summaryFile)) {
    console.log(`Summary file not found at ${summaryFile}, skipping summary update`);
    return;
  }

  console.log(`Updating summary page: ${summaryFile}`);

  const content = fs.readFileSync(summaryFile, "utf8");
  const $ = cheerio.load(content, { xmlMode: true });

  // Remove the 'Sommaire' self-reference
  $('a[href="chapter-2.xhtml"]').parent().remove();

  const existingCoverLink = $('a[href="cover.xhtml"]');
  if (existingCoverLink.length === 0) {
    const firstLink = $("p.p6").first();
    if (firstLink.length) {
      const coverParagraph = $('<p class="p6" style=""></p>');
      coverParagraph.append($(`<a href="cover.xhtml">${coverLabel}</a>`));
      firstLink.before(coverParagraph);
      console.log("Successfully added cover to summary page");
    } else {
      console.log("Warning: Could not find link paragraphs in summary page");
    }
  } else {
    console.log("Cover is already in the summary page");
  }

  fs.writeFileSync(summaryFile, $.xml());
  console.log("Summary page updated successfully");
}

if (isEntryPoint(import.meta.url)) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
