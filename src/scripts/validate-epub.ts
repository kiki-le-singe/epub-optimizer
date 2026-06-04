import { spawnSync } from "node:child_process";
import path from "node:path";
import config from "../utils/config.js";
import { parseArgs, isEntryPoint, type RunOpts } from "./utils.js";

interface EpubCheckMessages {
  fatals: number;
  errors: number;
  warnings: number;
  infos: number;
}

export function parseEpubCheckMessages(output: string): EpubCheckMessages | undefined {
  const match = output.match(
    /Messages:\s*(\d+)\s+fatals?\s*\/\s*(\d+)\s+errors?\s*\/\s*(\d+)\s+warnings?\s*\/\s*(\d+)\s+infos?/i
  );
  if (!match) {
    return undefined;
  }
  return {
    fatals: Number(match[1]),
    errors: Number(match[2]),
    warnings: Number(match[3]),
    infos: Number(match[4]),
  };
}

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
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    throw new Error(`Failed to run EPUBCheck: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`EPUB validation failed (exit ${result.status ?? "unknown"}).`);
  }

  const messages = parseEpubCheckMessages(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (messages && messages.warnings > 0) {
    console.warn(`EPUBCheck reported ${messages.warnings} warning(s).`);
    if (opts.strict) {
      throw new Error(`EPUBCheck warnings are not allowed in strict mode.`);
    }
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
