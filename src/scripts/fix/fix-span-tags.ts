// This script fixes the span tags in the XHTML files after the book is built.
// There were some issues like <span> tags that were not closed.

import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { getContentPath } from "../../utils/epub-utils.js";
import { getTempDir, isEntryPoint, type RunOpts } from "../utils.js";

async function fixFile(file: string) {
  try {
    console.log(`Processing ${file}`);
    const content = await fs.readFile(file, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });
    // Cheerio auto-closes tags on serialization
    await fs.writeFile(file, $.xml());
    console.log(`Fixed ${path.basename(file)}`);
  } catch (error) {
    console.error(`Error processing ${file}:`, error);
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

  for (const file of files) {
    await fixFile(file);
  }

  console.log("All XHTML files fixed.");
}

if (isEntryPoint(import.meta.url)) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
