import { parseArguments } from "./cli.js";
import { runOptimization } from "./optimization.js";
import { processEpubContent, type ContentProcessingOptions } from "./processors/epub-processor.js";
import type { Args } from "./types.js";

export { runBatch, type BatchReport } from "./batch.js";
export { reportWarning, reportError } from "./utils/diagnostics.js";

export { formatFileSize, reportFileSizeComparison } from "./utils/file-size.js";

interface OptimizeOptions extends ContentProcessingOptions {
  /** Prepare extracted content only; never create or replace the output EPUB. */
  skipPackaging?: boolean;
}

/** Optimize, validate and publish through the same pipeline as the CLI. */
export async function optimizeEPUB(
  args?: Args,
  options: OptimizeOptions = {}
): Promise<{ success: boolean; input: string; output: string }> {
  // Keep the caller's options intact when feature detection adjusts processing.
  const resolvedArgs = { ...(args ?? (await parseArguments())) };
  if (resolvedArgs.batch) throw new Error("Use runBatch(args) for batch optimization.");
  if (options.skipPackaging) {
    return processEpubContent(resolvedArgs, options);
  }
  await runOptimization(resolvedArgs, options);
  return { success: true, input: resolvedArgs.input, output: resolvedArgs.output };
}
