import fs from "node:fs";
import path from "node:path";
import config from "../utils/config.js";
import { parseArgs, getTempDir, isEntryPoint, type RunOpts } from "./utils.js";
import { compressEPUB } from "../processors/archive-processor.js";

export async function run(opts: RunOpts = {}): Promise<void> {
  const extractedDir = opts.tempDir ?? getTempDir();
  let outputEpub = opts.output;
  if (!outputEpub) {
    const argv = parseArgs(true, true);
    outputEpub = (argv.output as string | undefined) ?? config.outputEPUB;
  }
  const outputEpubPath = path.isAbsolute(outputEpub)
    ? outputEpub
    : path.join(process.cwd(), outputEpub);

  if (!fs.existsSync(extractedDir)) {
    throw new Error(`Directory ${extractedDir} does not exist.`);
  }

  console.log("Creating new EPUB...");
  await compressEPUB(outputEpubPath, extractedDir);
  console.log(`Created optimized EPUB: ${outputEpub}`);
}

if (isEntryPoint(import.meta.url)) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
