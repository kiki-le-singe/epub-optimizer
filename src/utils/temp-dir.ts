import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

export const TEMP_DIR_MARKER = ".epub-optimizer-temp.json";

function canonicalPath(filePath: string): string {
  const suffix: string[] = [];
  let current = path.resolve(filePath);
  while (!fs.existsSync(current)) {
    suffix.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...suffix);
}

interface TempDirSafetyOptions {
  inputPath?: string;
  outputPath?: string;
  cwd?: string;
  homeDir?: string;
}

function resolveUserPath(filePath: string, cwd: string): string {
  return path.resolve(cwd, filePath);
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function assertSafeTempDir(tempDir: string, options: TempDirSafetyOptions = {}): string {
  if (!tempDir || tempDir.trim() === "") {
    throw new Error("Refusing empty temporary directory path.");
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const resolvedTempDir = resolveUserPath(tempDir, cwd);
  const rootDir = path.parse(resolvedTempDir).root;
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const canonicalTempDir = canonicalPath(resolvedTempDir);

  if (resolvedTempDir === rootDir) {
    throw new Error(`Refusing unsafe temporary directory: ${resolvedTempDir}`);
  }

  if (isSameOrInside(canonicalPath(cwd), canonicalTempDir)) {
    throw new Error(`Refusing to use the current working directory as temp: ${resolvedTempDir}`);
  }

  if (homeDir !== rootDir && canonicalTempDir === canonicalPath(homeDir)) {
    throw new Error(`Refusing to use the home directory as temp: ${resolvedTempDir}`);
  }

  if (options.inputPath) {
    const inputPath = canonicalPath(resolveUserPath(options.inputPath, cwd));
    if (isSameOrInside(inputPath, canonicalTempDir)) {
      throw new Error(`Refusing temp directory that contains the input EPUB: ${resolvedTempDir}`);
    }
  }

  if (options.outputPath) {
    const outputPath = canonicalPath(resolveUserPath(options.outputPath, cwd));
    if (isSameOrInside(outputPath, canonicalTempDir)) {
      throw new Error(`Refusing temp directory that contains the output EPUB: ${resolvedTempDir}`);
    }
  }

  return resolvedTempDir;
}

async function removeTempDir(tempDir: string, options: TempDirSafetyOptions = {}): Promise<string> {
  const safeTempDir = assertSafeTempDir(tempDir, options);
  const stat = await fs.lstat(safeTempDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-directory or symbolic link: ${safeTempDir}`);
  }
  const marker = await fs.readJson(path.join(safeTempDir, TEMP_DIR_MARKER));
  if (marker.version !== 1 || marker.directory !== path.basename(safeTempDir)) {
    throw new Error(`Refusing to remove unowned temporary directory: ${safeTempDir}`);
  }
  await fs.remove(safeTempDir);
  return safeTempDir;
}

export async function createManagedTempDir(tempDir: string, inputPath: string): Promise<void> {
  const safeTempDir = assertSafeTempDir(tempDir, { inputPath });
  // Atomic mkdir: concurrent runs and existing user data are never overwritten.
  await fs.ensureDir(path.dirname(safeTempDir));
  await fs.mkdir(safeTempDir, { mode: 0o700 });
  await fs.writeJson(
    path.join(safeTempDir, TEMP_DIR_MARKER),
    {
      version: 1,
      // Keep the marker usable from both the Docker mount and the host path.
      directory: path.basename(safeTempDir),
    },
    { flag: "wx" }
  );
}

export { assertSafeTempDir, removeTempDir };
