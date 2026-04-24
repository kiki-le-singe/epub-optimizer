#!/usr/bin/env ts-node

import { getInputFileInfo, handleError, runCommand } from "./utils.js";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Get package.json information for version
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

// Check for help or version flags first
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
${packageJson.description}

Usage: pnpm build [options]

Options:
  -i, --input       Input EPUB file path                    [string] [default: "mybook.epub"]
  -o, --output      Output EPUB file path                   [string] [default: "mybook_opt.epub"]
  --jpg-quality     JPEG compression quality (0-100)        [number] [default: 70]
  --png-quality     PNG compression quality (0-1 scale)     [number] [default: 0.6]
  --clean           Clean temporary files after processing  [boolean] [default: false]
  -h, --help        Show this help message                  [boolean]
  -v, --version     Show version number                     [boolean]

Examples:
  pnpm build -i book.epub -o book-optimized.epub            Basic optimization
  pnpm build:clean -i book.epub -o book-opt.epub            Optimize and clean temp files
  pnpm build -i book.epub -o book-opt.epub --jpg-quality 85 Higher JPEG quality (less compression)
  pnpm build -i book.epub -o book-opt.epub --png-quality 0.9 Higher PNG quality (less compression)
  pnpm build -i input.epub -o output.epub --jpg-quality 85 --png-quality 0.8 Custom image settings
  `);
  process.exit(0);
}

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(packageJson.version);
  process.exit(0);
}

// Parse command options including clean flag
const argv = yargs(hideBin(process.argv))
  .option("clean", {
    type: "boolean",
    description: "Clean temporary files after build",
    default: false,
  })
  .help(false)
  .version(false).argv as { clean: boolean };

// Get input file info and args
const { args } = getInputFileInfo();

try {
  console.log(`Running optimize with arguments: ${args}`);
  runCommand(`ts-node optimize-epub.ts ${args}`);

  console.log("Running fix scripts");
  runCommand("ts-node scripts/fix/index.ts");

  console.log("Running structure update scripts");
  runCommand("ts-node scripts/ops/update-structure.ts");

  console.log(`Creating EPUB with arguments: ${args}`);
  runCommand(`ts-node scripts/create-epub.ts ${args}`);

  console.log(`Validating EPUB with arguments: ${args}`);
  runCommand(`ts-node scripts/validate-epub.ts ${args}`);

  if (argv.clean) {
    console.log("Cleaning up temporary files");
    runCommand(`rm -rf temp_epub`);
    console.log("All done!");
  } else {
    console.log("Build completed successfully!");
    console.log(
      'Note: Temporary files have been kept. Use "pnpm cleanup" or run with --clean flag to remove them.'
    );
  }
} catch (error) {
  handleError(error);
}
