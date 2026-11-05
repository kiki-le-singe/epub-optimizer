// This script removes empty style="" attributes from XHTML files.
// Empty style attributes add unnecessary bytes without providing any styling.

import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { getTempDir, isEntryPoint, type RunOpts } from "../utils.js";
import { normalizeNamedEntities } from "../../utils/xhtml.js";
import { collectRepairFiles } from "./xhtml-files.js";

/**
 * Remove all empty `style=""` attributes from an XHTML string.
 * Pure function — easy to unit test.
 */
export function removeEmptyStyles(content: string): { xml: string; removed: number } {
  const $ = cheerio.load(normalizeNamedEntities(content), { xml: { decodeEntities: false } });
  let removed = 0;
  $('[style=""]').each((_index, element) => {
    $(element).removeAttr("style");
    removed++;
  });
  return { xml: $.xml(), removed };
}

async function fixFile(file: string): Promise<number> {
  try {
    console.log(`Processing ${file}`);
    const content = await fs.readFile(file, "utf8");
    const { xml, removed } = removeEmptyStyles(content);

    if (removed > 0) {
      await fs.writeFile(file, xml);
      console.log(`Removed ${removed} empty style attribute(s) from ${path.basename(file)}`);
    }

    return removed;
  } catch (error) {
    console.error(`Error processing ${file}:`, error);
    return 0;
  }
}

export async function run(opts: RunOpts = {}): Promise<void> {
  const extractedDir = opts.tempDir ?? getTempDir();

  const files = await collectRepairFiles(extractedDir);

  let totalRemoved = 0;
  for (const file of files) {
    totalRemoved += await fixFile(file);
  }

  console.log(`Removed ${totalRemoved} empty style attributes from ${files.length} files.`);
}

if (isEntryPoint(import.meta.url)) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
