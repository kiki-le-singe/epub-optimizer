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
import {
  assertDistinctInputOutput,
  assertSafeOutputTarget,
  assertSafeReportPath,
  commitCandidateOutput,
  createCandidateOutputPath,
  discardCandidateOutput,
} from "./utils/output-transaction.js";
import {
  completePipelineReport,
  createPipelineReport,
  printProfile,
  recordSkippedStep,
  runReportedStep,
  writePipelineReport,
} from "./utils/run-report.js";

export async function main(): Promise<void> {
  const args = await parseArguments();
  assertDistinctInputOutput(args.input, args.output);
  await assertSafeOutputTarget(args.output);
  if (args.reportJson) {
    assertSafeReportPath(args.reportJson, args.input, args.output);
  }
  const report = createPipelineReport({
    input: args.input,
    output: args.output,
    preset: args.preset,
    strict: args.strict,
  });
  let candidateOutput: string | undefined;
  let reportWriteError: unknown;

  try {
    candidateOutput = await createCandidateOutputPath(args.output);

    // Step 1: Extract + run every content processor. Skip packaging —
    // repair/author steps still need the temp dir, and the candidate archive
    // is created only once after every transformation is complete.
    console.log("\n=== Optimize EPUB ===");
    await optimizeEPUB(args, {
      skipPackaging: true,
      runStep: (name, operation) => runReportedStep(report, name, args.strict, operation),
      skipStep: (name, reason) => recordSkippedStep(report, name, reason),
    });

    // Step 2: Explicit XHTML repair passes. The author workflow implies repair,
    // while the generic optimizer remains conservative by default.
    if (args.repair) {
      console.log("\n=== XHTML Repair Passes ===");
      await runReportedStep(report, "Repair XHTML", args.strict, () =>
        runFixes({ tempDir: args.temp, strict: args.strict })
      );
    } else {
      recordSkippedStep(report, "Repair XHTML", "Enable with --repair or the author preset.");
    }

    // Step 3: Optional author workflow structure updates. These are tailored to
    // this project's Pages/manual-summary publishing flow.
    if (args.authorWorkflow) {
      console.log("\n=== Author Workflow Structure Updates ===");
      await runReportedStep(report, "Author workflow", args.strict, () =>
        runStructureUpdates({ tempDir: args.temp, lang: args.lang, strict: args.strict })
      );
    } else {
      recordSkippedStep(
        report,
        "Author workflow",
        "Enable with --author-workflow or --preset author."
      );
    }

    // Step 4: Build and validate a candidate. The requested output is not
    // touched until EPUBCheck has accepted the candidate.
    console.log("\n=== Create Candidate EPUB ===");
    await runReportedStep(report, "Create candidate EPUB", args.strict, () =>
      createEPUBFile({ tempDir: args.temp, output: candidateOutput })
    );

    console.log("\n=== Validate Candidate EPUB ===");
    await runReportedStep(report, "Validate candidate EPUB", args.strict, () =>
      validateEPUB({ output: candidateOutput, strict: args.strict })
    );

    console.log("\n=== Publish Validated EPUB ===");
    await runReportedStep(report, "Publish validated EPUB", args.strict, () =>
      commitCandidateOutput(candidateOutput as string, args.output)
    );
    candidateOutput = undefined;

    // Step 5: Cleanup only after the validated output is safely published.
    if (args.clean) {
      console.log("\n=== Cleanup ===");
      const removedTempDir = await runReportedStep(report, "Cleanup", args.strict, () =>
        removeTempDir(args.temp, {
          inputPath: args.input,
          outputPath: args.output,
        })
      );
      console.log(`Removed temporary directory: ${removedTempDir}`);
    } else {
      recordSkippedStep(report, "Cleanup", "Temporary files kept for inspection.");
    }

    if (await fs.pathExists(args.output)) {
      await reportFileSizeComparison(args.input, args.output);
      const [inputStats, outputStats] = await Promise.all([
        fs.stat(args.input),
        fs.stat(args.output),
      ]);
      const savedBytes = inputStats.size - outputStats.size;
      report.sizes = {
        inputBytes: inputStats.size,
        outputBytes: outputStats.size,
        savedBytes,
        reductionPercent: (savedBytes / inputStats.size) * 100,
      };
    }

    completePipelineReport(report);
    if (args.clean) {
      console.log("All done!\n");
    } else {
      console.log(
        `\nBuild completed successfully!\nNote: Temporary files have been kept in '${args.temp}'. Use --clean to remove them.\n`
      );
    }
  } catch (error) {
    await discardCandidateOutput(candidateOutput);
    completePipelineReport(report, error);
    console.error(error instanceof Error ? error.message : error);
    console.error(`Temporary files were kept in '${args.temp}' for inspection.`);
    throw error;
  } finally {
    if (args.reportJson) {
      try {
        await writePipelineReport(report, args.reportJson);
      } catch (reportError) {
        console.error(
          `Failed to write JSON report: ${reportError instanceof Error ? reportError.message : String(reportError)}`
        );
        reportWriteError = reportError;
      }
    }
    if (args.profile) {
      printProfile(report);
    }
  }

  if (reportWriteError !== undefined) {
    throw reportWriteError;
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
