import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { minify } from "terser";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.join(__dirname, "..", "dist");
const srcDir = path.join(distDir, "src");
const entryPoint = path.join(distDir, "optimize-epub.js");

// Scripts to skip minification due to template literal variable name issues
const skipFiles: string[] = [];

/**
 * Minify a JavaScript file and save the result
 * @param filePath Path to JavaScript file
 */
async function minifyFile(filePath: string): Promise<boolean> {
  // Skip files in the skip list
  const fileName = path.basename(filePath);
  if (skipFiles.includes(fileName)) {
    console.log(`⏩ Skipping: ${path.relative(distDir, filePath)} (in skip list)`);
    return true;
  }

  try {
    console.log(`Minifying: ${path.relative(distDir, filePath)}`);
    const code = await readFile(filePath, "utf8");

    const result = await minify(code, {
      compress: {
        passes: 2,
        drop_console: false,
        drop_debugger: true,
      },
      mangle: true,
      module: true,
      sourceMap: false,
      toplevel: true,
      keep_classnames: true,
      keep_fnames: true,
      output: {
        comments: false,
      },
    });

    if (result.code) {
      await writeFile(filePath, result.code);
      console.log(`✓ Success: ${path.relative(distDir, filePath)}`);
      return true;
    } else {
      console.warn(`⚠ No output for: ${path.relative(distDir, filePath)}`);
      return false;
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`✗ Error minifying ${path.relative(distDir, filePath)}: ${error.message}`);
    } else {
      console.error(`✗ Error minifying ${path.relative(distDir, filePath)}:`, error);
    }
    return false;
  }
}

/**
 * Recursively process all .js files in a directory
 * @param dir Directory to process
 */
async function processDirectory(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await processDirectory(fullPath);
    } else if (entry.name.endsWith(".js")) {
      await minifyFile(fullPath);
    }
  }
}

// Main function
async function main() {
  console.log("Starting minification process...");

  // Minify the entry point first
  if (existsSync(entryPoint)) {
    await minifyFile(entryPoint);
  } else {
    console.warn(`Entry point not found: ${entryPoint}`);
  }

  // Minify src/ directory
  if (existsSync(srcDir)) {
    console.log("Processing src/ directory...");
    await processDirectory(srcDir);
  } else {
    console.warn(`Source directory not found: ${srcDir}`);
  }

  console.log("Minification complete!");
}

main().catch((error) => {
  console.error("Minification failed:", error);
  process.exit(1);
});
