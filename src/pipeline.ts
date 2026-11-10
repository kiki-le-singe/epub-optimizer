#!/usr/bin/env node
import { parseArguments } from "./cli.js";
import { runOptimization } from "./optimization.js";
import { isEntryPoint } from "./scripts/utils.js";

export async function main(): Promise<void> {
  await runOptimization(await parseArguments());
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
