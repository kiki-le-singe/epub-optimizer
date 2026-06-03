#!/usr/bin/env node
import fs from "fs-extra";
import { parseArguments } from "./cli.js";
import { optimizeEPUB, reportFileSizeComparison } from "./index.js";
import { runFixes } from "./scripts/fix/index.js";
import { runStructureUpdates } from "./scripts/ops/update-structure.js";
import { run as createEPUBFile } from "./scripts/create-epub.js";
import { run as validateEPUB } from "./scripts/validate-epub.js";
import { isEntryPoint } from "./scripts/utils.js";
import { removeTempDir } from "./utils/temp-dir.js";

export async function main(): Promise<void> {
  const args = await parseArguments();

  // Step 1: Extract + run every content processor. Skip packaging —
  // the fix/structure steps still need the temp dir, and create-epub
  // zips once at the very end.
  console.log("\n=== Optimize EPUB ===");
  await optimizeEPUB(args, { skipPackaging: true });

  // Step 2: XHTML fix passes (span-tags, xml sanity, empty styles).
  console.log("\n=== General Fixes ===");
  await runFixes({ tempDir: args.temp });

  // Step 3: EPUB structure (cover linear, TOC, summary, chapter sections).
  console.log("\n=== EPUB Structure Updates ===");
  await runStructureUpdates({ tempDir: args.temp, lang: args.lang });

  // Step 4: Zip the final EPUB — single pass.
  console.log("\n=== Create EPUB ===");
  await createEPUBFile({ tempDir: args.temp, output: args.output });

  // Step 5: EPUBCheck validation (shells out to java — unavoidable).
  console.log("\n=== Validate EPUB ===");
  try {
    validateEPUB({ output: args.output });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Step 6: Cleanup if requested.
  if (args.clean) {
    console.log("\n=== Cleanup ===");
    const removedTempDir = await removeTempDir(args.temp, {
      inputPath: args.input,
      outputPath: args.output,
    });
    console.log(`Removed temporary directory: ${removedTempDir}`);
  }

  // Size report after everything is settled.
  if (await fs.pathExists(args.output)) {
    await reportFileSizeComparison(args.input, args.output);
  }

  if (args.clean) {
    console.log("All done!\n");
  } else {
    console.log(
      `\nBuild completed successfully!\nNote: Temporary files have been kept in '${args.temp}'. Use --clean to remove them.\n`
    );
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
