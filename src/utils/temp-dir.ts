import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

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

  if (resolvedTempDir === rootDir) {
    throw new Error(`Refusing unsafe temporary directory: ${resolvedTempDir}`);
  }

  if (resolvedTempDir === cwd) {
    throw new Error(`Refusing to use the current working directory as temp: ${resolvedTempDir}`);
  }

  if (homeDir !== rootDir && resolvedTempDir === homeDir) {
    throw new Error(`Refusing to use the home directory as temp: ${resolvedTempDir}`);
  }

  if (options.inputPath) {
    const inputPath = resolveUserPath(options.inputPath, cwd);
    if (isSameOrInside(inputPath, resolvedTempDir)) {
      throw new Error(`Refusing temp directory that contains the input EPUB: ${resolvedTempDir}`);
    }
  }

  if (options.outputPath) {
    const outputPath = resolveUserPath(options.outputPath, cwd);
    if (isSameOrInside(outputPath, resolvedTempDir)) {
      throw new Error(`Refusing temp directory that contains the output EPUB: ${resolvedTempDir}`);
    }
  }

  return resolvedTempDir;
}

async function removeTempDir(tempDir: string, options: TempDirSafetyOptions = {}): Promise<string> {
  const safeTempDir = assertSafeTempDir(tempDir, options);
  await fs.remove(safeTempDir);
  return safeTempDir;
}

export { assertSafeTempDir, removeTempDir };
