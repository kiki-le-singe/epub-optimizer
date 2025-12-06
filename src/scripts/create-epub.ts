import fs from "node:fs";
import path from "node:path";
// import { fileURLToPath } from "node:url"; // Unused, remove
import config from "../utils/config.js";
import { parseArgs, handleError, getTempDir } from "./utils.js";
import { compressEPUB } from "../processors/archive-processor.js";

// Parse command line arguments
const argv = parseArgs(true, true);

// Get the output file path from arguments or default config
const outputEpub = argv.output || config.outputEPUB;

// Get temp directory from CLI args or config
const extractedDir = getTempDir();

// If output path is absolute, use it as-is; otherwise join with current directory
const outputEpubPath = path.isAbsolute(outputEpub)
  ? outputEpub
  : path.join(process.cwd(), outputEpub);

// Verify the directory exists
if (!fs.existsSync(extractedDir)) {
  console.error(`Error: Directory ${extractedDir} does not exist.`);
  console.error("Please run the optimization script first to extract the EPUB.");
  process.exit(1);
}

// Create a new EPUB file
console.log("Creating new EPUB...");

try {
  // Use the archive processor to create the EPUB with proper compression
  await compressEPUB(outputEpubPath, extractedDir);

  console.log(`Created optimized EPUB: ${outputEpub}`);
} catch (error) {
  handleError(error);
}
