import { spawnSync } from "node:child_process";
import path from "node:path";
import config from "../utils/config.js";
import { parseArgs, isEntryPoint, type RunOpts } from "./utils.js";

/**
 * Run EPUBCheck against a given EPUB file.
 * We shell out to java here — EPUBCheck is a JAR, so no in-process option exists.
 * @throws Error if validation fails (non-zero exit from epubcheck)
 */
export function run(opts: RunOpts = {}): void {
  let outputEpub = opts.output;
  if (!outputEpub) {
    const argv = parseArgs(false, true);
    outputEpub = (argv.output as string | undefined) ?? config.outputEPUB;
  }
  if (!outputEpub) {
    throw new Error("No output EPUB file specified.");
  }

  const epubcheckPath = path.resolve(config.epubcheckPath);
  console.log(`Validating EPUB: ${outputEpub}`);

  const result = spawnSync("java", ["-jar", epubcheckPath, outputEpub], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`EPUB validation failed (exit ${result.status ?? "unknown"}).`);
  }
  console.log("EPUB validation passed.");
}

if (isEntryPoint(import.meta.url)) {
  try {
    run();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
