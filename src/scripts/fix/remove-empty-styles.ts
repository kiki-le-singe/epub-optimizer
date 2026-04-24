// This script removes empty style="" attributes from XHTML files.
// Empty style attributes add unnecessary bytes without providing any styling.

import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { getContentPath } from "../../utils/epub-utils.js";
import { getTempDir, isEntryPoint, type RunOpts } from "../utils.js";

/**
 * Remove all empty `style=""` attributes from an XHTML string.
 * Pure function — easy to unit test.
 */
export function removeEmptyStyles(content: string): { xml: string; removed: number } {
  const $ = cheerio.load(content, { xmlMode: true });
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

  if (!(await fs.pathExists(extractedDir))) {
    throw new Error(`Directory ${extractedDir} does not exist.`);
  }

  const contentDir = await getContentPath(extractedDir);
  if (!(await fs.pathExists(contentDir))) {
    throw new Error(`Content directory ${contentDir} does not exist.`);
  }

  const files = (await fs.readdir(contentDir))
    .filter((file) => file.endsWith(".xhtml"))
    .map((file) => path.join(contentDir, file));

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
