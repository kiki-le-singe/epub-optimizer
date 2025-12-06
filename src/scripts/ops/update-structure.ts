// This script updates the EPUB structure files.
// It is used to update various structure files after the book is built:
// - epb.opf (package file)
// - toc.xhtml (EPUB3 TOC for modern readers)
// - epb.ncx (EPUB2 TOC for older/Kindle readers)
// - chapter-2.xhtml (summary page with TOC)

import { runCommand, handleError } from "../utils.js";

// Get CLI arguments to forward to child scripts
const args = process.argv.slice(2).join(" ");

try {
  // TODO: is add_cover_image_property really needed?
  // runCommand(`node dist/src/scripts/opf/add-cover-image-property.js ${args}`);

  // update_cover_linear: Allow to set cover image as linear. It means that the cover image will be displayed
  // on the first page of the book.
  runCommand(`node dist/src/scripts/ops/update-cover-linear.js ${args}`);

  // update_toc_with_cover: Add the cover image to the table of contents in both toc.xhtml and epb.ncx
  runCommand(`node dist/src/scripts/ops/update-toc-with-cover.js ${args}`);

  // update_summary_page: Add the cover to the summary page and remove the self-reference
  runCommand(`node dist/src/scripts/ops/update-summary-page.js ${args}`);

  console.log("All structure updates completed.");
} catch (error) {
  handleError(error);
}
