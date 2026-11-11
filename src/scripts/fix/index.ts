import { reportError, reportInfo } from "../../utils/diagnostics.js";
import { isEntryPoint, type RunOpts } from "../utils.js";
import { run as fixSpanTags } from "./fix-span-tags.js";
import { run as fixXml } from "./fix-xml.js";
import { run as removeEmptyStyles } from "./remove-empty-styles.js";

/**
 * Run all general XHTML fixes in sequence, in-process.
 */
export async function runFixes(opts: RunOpts = {}): Promise<void> {
  await fixSpanTags(opts);
  await fixXml(opts);
  await removeEmptyStyles(opts);
  reportInfo("All general fixes applied.");
}

if (isEntryPoint(import.meta.url)) {
  runFixes().catch((err) => {
    reportError(err);
    process.exit(1);
  });
}
