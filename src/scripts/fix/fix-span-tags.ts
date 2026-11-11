import { reportError, reportInfo } from "../../utils/diagnostics.js";
// This script fixes the span tags in the XHTML files after the book is built.
// There were some issues like <span> tags that were not closed.

import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { getTempDir, isEntryPoint, type RunOpts } from "../utils.js";
import { normalizeNamedEntities } from "../../utils/xhtml.js";
import { collectRepairFiles } from "./xhtml-files.js";

async function fixFile(file: string) {
  try {
    reportInfo(`Processing ${file}`);
    const content = await fs.readFile(file, "utf8");
    const $ = cheerio.load(normalizeNamedEntities(content), { xml: { decodeEntities: false } });
    // Cheerio auto-closes tags on serialization
    await fs.writeFile(file, $.xml());
    reportInfo(`Fixed ${path.basename(file)}`);
  } catch (error) {
    reportError(`Error processing ${file}:`, error);
  }
}

export async function run(opts: RunOpts = {}): Promise<void> {
  const extractedDir = opts.tempDir ?? getTempDir();

  const files = await collectRepairFiles(extractedDir);

  for (const file of files) {
    await fixFile(file);
  }

  reportInfo("All XHTML files fixed.");
}

if (isEntryPoint(import.meta.url)) {
  run().catch((err) => {
    reportError(err);
    process.exit(1);
  });
}
