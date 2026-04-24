// Sets the cover image as linear in the OPF file
// When linear="yes", the cover will be displayed in the reading order (on the first page)

import fs from "fs-extra";
import * as cheerio from "cheerio";
import { getOPFPath } from "../../utils/epub-utils.js";
import { getTempDir, isEntryPoint, type RunOpts } from "../utils.js";

/**
 * Mark the cover item in an OPF manifest's spine as `linear="yes"` so readers
 * render it first. Returns the updated XML and whether a change was made.
 * Pure function — no I/O.
 */
export function setCoverLinear(opfXml: string): { xml: string; updated: boolean } {
  const $ = cheerio.load(opfXml, { xmlMode: true });
  const coverRef = $('itemref[idref="cover"]');
  if (!coverRef.length) {
    return { xml: opfXml, updated: false };
  }
  coverRef.attr("linear", "yes");
  return { xml: $.xml(), updated: true };
}

export async function run(opts: RunOpts = {}): Promise<void> {
  const extractedDir = opts.tempDir ?? getTempDir();
  const opfFile = await getOPFPath(extractedDir);
  console.log(`Updating cover in OPF file: ${opfFile}`);

  const content = fs.readFileSync(opfFile, "utf8");
  const { xml, updated } = setCoverLinear(content);

  if (updated) {
    fs.writeFileSync(opfFile, xml);
    console.log('Successfully set cover to linear: <itemref idref="cover" linear="yes"/>');
  } else {
    console.log("Warning: No cover reference found in spine section of OPF file");
  }
}

if (isEntryPoint(import.meta.url)) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
