#!/usr/bin/env node
import { reportError } from "./utils/diagnostics.js";
import { runWatch } from "./watch.js";
import { runBatch } from "./batch.js";
import { parseArguments } from "./cli.js";
import { runOptimization } from "./optimization.js";
import { isEntryPoint } from "./scripts/utils.js";

export async function main(): Promise<void> {
  const args = await parseArguments();
  if (args.watch) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const report = await runWatch(args, { signal: controller.signal });
      if (report.failed) process.exitCode = 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } else if (args.batch) {
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
