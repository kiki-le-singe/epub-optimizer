import fs from "fs-extra";
import * as cheerio from "cheerio";
import { getCoverLabel } from "../../utils/i18n.js";
import { getContentPath } from "../../utils/epub-utils.js";
import { getLang, getTempDir, isEntryPoint, type RunOpts } from "../utils.js";
import {
  createOwnerRelativeHref,
  DEFAULT_AUTHOR_WORKFLOW_CONFIG,
  hasAnyClass,
  referenceTargetsFile,
  resolveAuthorWorkflowHref,
} from "../../utils/author-workflow-config.js";

export async function run(opts: RunOpts = {}): Promise<void> {
  const extractedDir = opts.tempDir ?? getTempDir();
  const coverLabel = getCoverLabel(opts.lang ?? getLang());
  const authorConfig = opts.authorConfig ?? DEFAULT_AUTHOR_WORKFLOW_CONFIG;

  const contentDir = await getContentPath(extractedDir);
  const summaryFile = resolveAuthorWorkflowHref(
    contentDir,
    authorConfig.summaryHref,
    "author summary href"
  );
  const coverFile = resolveAuthorWorkflowHref(
    contentDir,
    authorConfig.coverHref,
    "author cover href"
  );

  if (!fs.existsSync(summaryFile)) {
    console.log(`Summary file not found at ${summaryFile}, skipping summary update`);
    return;
  }

  console.log(`Updating summary page: ${summaryFile}`);

  const content = fs.readFileSync(summaryFile, "utf8");
  const $ = cheerio.load(content, { xmlMode: true });

  // Remove the 'Sommaire' self-reference
  $("a[href]")
    .filter((_, element) =>
      referenceTargetsFile(extractedDir, summaryFile, $(element).attr("href"), summaryFile)
    )
    .parent()
    .remove();

  const existingCoverLink = $("a[href]").filter((_, element) =>
    referenceTargetsFile(extractedDir, summaryFile, $(element).attr("href"), coverFile)
  );
  if (existingCoverLink.length === 0) {
    const firstLink = $("p")
      .filter((_, element) =>
        hasAnyClass($(element).attr("class"), [authorConfig.summaryEntryClass])
      )
      .first();
    if (firstLink.length) {
      const coverParagraph = $(`<p class="${authorConfig.summaryEntryClass}" style=""></p>`);
      coverParagraph.append(
        $(`<a href="${createOwnerRelativeHref(summaryFile, coverFile)}">${coverLabel}</a>`)
      );
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
