#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Resolve paths relative to this file (dist/src/pipeline.js) so the CLI works
// whether invoked via `pnpm optimize` from the repo or `epub-optimizer` when
// installed globally via the `bin` field.
const here = path.dirname(fileURLToPath(import.meta.url));

function runScript(scriptPath: string, args: string[], label: string) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync("node", [scriptPath, ...args], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed.`);
    process.exit(result.status || 1);
  }
}

// Parse CLI args
const rawArgs = process.argv.slice(2);
const hasClean = rawArgs.includes("--clean");
const filteredArgs = rawArgs.filter((arg) => arg !== "--clean");

// Extract temp directory from arguments (defaults to "temp_epub")
let tempDir = "temp_epub";
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === "-t" || arg === "--temp") {
    // Next argument is the temp directory
    if (i + 1 < rawArgs.length) {
      tempDir = rawArgs[i + 1];
    }
  } else if (arg.startsWith("-t=") || arg.startsWith("--temp=")) {
    // Extract value after =
    tempDir = arg.split("=")[1];
  }
}

// Step 1: Optimize EPUB (main logic)
runScript(path.resolve(here, "..", "optimize-epub.js"), filteredArgs, "Optimize EPUB");

// Step 2: General Fixes
runScript(path.join(here, "scripts", "fix", "index.js"), filteredArgs, "General Fixes");

// Step 3: OPF Fixes
runScript(
  path.join(here, "scripts", "ops", "update-structure.js"),
  filteredArgs,
  "EPUB Structure Updates"
);

// Step 4: Create EPUB
runScript(path.join(here, "scripts", "create-epub.js"), filteredArgs, "Create EPUB");

// Step 5: Validate EPUB
runScript(path.join(here, "scripts", "validate-epub.js"), filteredArgs, "Validate EPUB");

// Step 6: Cleanup if --clean
if (hasClean) {
  console.log("\n=== Cleanup ===");
  const cleanupResult = spawnSync("rm", ["-rf", tempDir], { stdio: "inherit" });
  if (cleanupResult.status !== 0) {
    console.error("✗ Cleanup failed.");
    process.exit(cleanupResult.status || 1);
  }
  console.log("All done!\n");
} else {
  console.log(
    `\nBuild completed successfully!\nNote: Temporary files have been kept in '${tempDir}'. Use --clean to remove them.\n`
  );
}
