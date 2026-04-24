import { isEntryPoint, type RunOpts } from "../utils.js";
import { run as updateCoverLinear } from "./update-cover-linear.js";
import { run as updateTocWithCover } from "./update-toc-with-cover.js";
import { run as updateSummaryPage } from "./update-summary-page.js";
import { run as addChapterSectionsToToc } from "./add-chapter-sections-to-toc.js";

/**
 * Apply all EPUB structure updates in sequence, in-process.
 */
export async function runStructureUpdates(opts: RunOpts = {}): Promise<void> {
  await updateCoverLinear(opts);
  await updateTocWithCover(opts);
  await updateSummaryPage(opts);
  await addChapterSectionsToToc(opts);
  console.log("All structure updates completed.");
}

if (isEntryPoint(import.meta.url)) {
  runStructureUpdates().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
