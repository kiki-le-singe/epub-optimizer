import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import config from "../utils/config.js";
import { parseArgs, isEntryPoint, type RunOpts } from "./utils.js";
import {
  parseEpubCheckJson,
  type EpubCheckReport,
  type EpubCheckTotals,
} from "../utils/epubcheck-report.js";

export interface ValidationOptions extends RunOpts {
  /** Receives this invocation's diagnostics on success, failure or timeout. */
  onReport?: (report: EpubCheckReport) => void;
}

/** Compatibility fallback when detailed JSON diagnostics are unavailable. */
export function parseEpubCheckMessages(output: string): EpubCheckTotals | undefined {
  const match = output.match(
    /Messages:\s*(\d+)\s+fatals?\s*\/\s*(\d+)\s+errors?\s*\/\s*(\d+)\s+warnings?\s*\/\s*(\d+)\s+infos?/i
  );
  if (!match) return undefined;
  return {
    fatals: Number(match[1]),
    errors: Number(match[2]),
    warnings: Number(match[3]),
    infos: Number(match[4]),
  };
}

function assertOwnedReportDirectory(directory: string, owner: { dev: number; ino: number }): void {
  const current = fs.lstatSync(directory);
  if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino)
    throw new Error("Refusing to use an EPUBCheck report directory whose ownership changed.");
}

/** Run the pinned Java validator; the requested EPUB is never changed here. */
export function run(opts: ValidationOptions = {}): void {
  let outputEpub = opts.output;
  if (!outputEpub) {
    const argv = parseArgs(false, true);
    outputEpub = (argv.output as string | undefined) ?? config.outputEPUB;
  }
  if (!outputEpub) throw new Error("No output EPUB file specified.");
  const timeoutMs = opts.timeoutMs ?? config.epubcheckTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("EPUBCheck timeout must be a positive integer no larger than 2147483647.");

  // A fresh private directory prevents stale reports and input/report collisions.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epubcheck-report-"));
  const owner = fs.lstatSync(directory);
  const reportPath = path.join(directory, "diagnostics.json");
  const report: EpubCheckReport = { source: "unavailable", exitCode: null, messages: [] };
  let failure: { error: unknown } | undefined;
  try {
    console.log(`Validating EPUB: ${outputEpub}`);
    const args = [
      "-jar",
      path.resolve(config.epubcheckPath),
      outputEpub,
      "--locale",
      "en",
      "--json",
      reportPath,
    ];
    if (opts.strict) args.push("--failonwarnings");
    const result = spawnSync("java", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    report.exitCode = result.status;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
        throw new Error(`EPUBCheck exceeded its ${timeoutMs} ms time limit.`, {
          cause: result.error,
        });
      throw new Error(`Failed to run EPUBCheck: ${result.error.message}`, { cause: result.error });
    }
    try {
      assertOwnedReportDirectory(directory, owner);
      const stats = fs.lstatSync(reportPath);
      if (!stats.isFile() || stats.size > 16 * 1024 * 1024)
        throw new Error("EPUBCheck JSON report must be a regular file no larger than 16 MiB.");
      Object.assign(report, parseEpubCheckJson(fs.readFileSync(reportPath, "utf8")), {
        source: "json",
      });
    } catch (error) {
      const reason =
        error instanceof SyntaxError
          ? "Malformed JSON."
          : error instanceof Error
            ? error.message
            : "Unsupported diagnostics.";
      report.diagnosticsError = `Could not read EPUBCheck JSON diagnostics; detailed validation messages are unavailable. ${reason}`;
      report.totals = parseEpubCheckMessages(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
      report.source = report.totals ? "text" : "unavailable";
      if (report.totals) console.log(report.diagnosticsError);
      else
        console.warn(
          "Could not read EPUBCheck message totals; validation diagnostics are incomplete."
        );
    }
    // JSON mode keeps native totals but redirects detailed messages to the file.
    for (const message of report.messages) {
      const locations = message.locations
        .map(
          (location) =>
            `${location.path}${location.line === undefined ? "" : `(${location.line}${location.column === undefined ? "" : `,${location.column}`})`}`
        )
        .join(", ");
      process.stderr.write(
        `${message.severity}(${message.code}): ${locations ? `${locations}: ` : ""}${message.message}\n`
      );
    }
    if (report.totals?.warnings)
      console.warn(`EPUBCheck reported ${report.totals.warnings} warning(s).`);
    if (result.status !== 0)
      throw new Error(`EPUB validation failed (exit ${result.status ?? "unknown"}).`);
    if (
      report.totals?.fatals ||
      report.totals?.errors ||
      report.messages.some(
        (message) => message.severity === "FATAL" || message.severity === "ERROR"
      )
    )
      throw new Error(
        "EPUB validation failed: EPUBCheck reported fatal/error diagnostics despite exit 0."
      );
    if (opts.strict && !report.totals)
      throw new Error(
        "Could not read EPUBCheck message totals; validation diagnostics are incomplete."
      );
    if (
      opts.strict &&
      (report.totals?.warnings || report.messages.some((message) => message.severity === "WARNING"))
    )
      throw new Error("EPUBCheck warnings are not allowed in strict mode.");
    console.log("EPUB validation passed.");
  } catch (error) {
    if (report.source === "unavailable")
      report.diagnosticsError ??= error instanceof Error ? error.message : String(error);
    failure = { error };
  } finally {
    try {
      assertOwnedReportDirectory(directory, owner);
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      failure ??= { error };
      console.warn(
        `Failed to clean EPUBCheck diagnostics: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    try {
      opts.onReport?.(report);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

if (isEntryPoint(import.meta.url)) {
  try {
    run();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
