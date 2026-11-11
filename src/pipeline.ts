#!/usr/bin/env node
import { reportError } from "./utils/diagnostics.js";
import { runBatch } from "./batch.js";
import { parseArguments } from "./cli.js";
import { runOptimization } from "./optimization.js";
import { isEntryPoint } from "./scripts/utils.js";

export async function main(): Promise<void> {
  const args = await parseArguments();
  if (args.batch) {
    const report = await runBatch(args);
    if (!report.success) process.exitCode = 1;
  } else await runOptimization(args);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    reportError(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
