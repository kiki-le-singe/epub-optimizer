import fs from "fs-extra";
import * as cheerio from "cheerio";
import { getOPFPath } from "../../utils/epub-utils.js";
import { getTempDir, isEntryPoint, type RunOpts } from "../utils.js";

export async function run(opts: RunOpts = {}): Promise<void> {
  const extractedDir = opts.tempDir ?? getTempDir();
  const opfFile = await getOPFPath(extractedDir);

  console.log(`Adding properties="cover-image" to cover-image item in: ${opfFile}`);

  const content = fs.readFileSync(opfFile, "utf8");
  const $ = cheerio.load(content, { xmlMode: true });

  const coverImageItem = $('item[id="cover-image"]');
  if (coverImageItem.length) {
    coverImageItem.attr("properties", "cover-image");
    fs.writeFileSync(opfFile, $.xml());
    console.log('Added properties="cover-image" to cover image');
  } else {
    console.log("Warning: Could not find cover-image item in OPF");
  }
}

if (isEntryPoint(import.meta.url)) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
