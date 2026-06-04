import fs from "fs-extra";
import path from "node:path";

function normalizeComparisonPath(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function canonicalize(filePath: string): string {
  const suffix: string[] = [];
  let current = path.resolve(filePath);

  while (true) {
    try {
      return normalizeComparisonPath(path.join(fs.realpathSync(current), ...suffix));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return normalizeComparisonPath(path.resolve(filePath));
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isSamePathOrFile(firstPath: string, secondPath: string): boolean {
  if (canonicalize(firstPath) === canonicalize(secondPath)) {
    return true;
  }

  try {
    const firstStats = fs.statSync(firstPath);
    const secondStats = fs.statSync(secondPath);
    return firstStats.dev === secondStats.dev && firstStats.ino === secondStats.ino;
  } catch {
    return false;
  }
}

function uniqueSiblingPath(outputPath: string, kind: "candidate" | "backup"): string {
  const absoluteOutput = path.resolve(outputPath);
  const outputDir = path.dirname(absoluteOutput);
  const extension = path.extname(absoluteOutput);
  const basename = path.basename(absoluteOutput, extension);
  return path.join(outputDir, `.${basename}.${kind}-${process.pid}-${Date.now()}${extension}`);
}

export function assertDistinctInputOutput(inputPath: string, outputPath: string): void {
  if (isSamePathOrFile(inputPath, outputPath)) {
    throw new Error(
      "Input and output paths must be different. Use a separate output file to protect the original EPUB."
    );
  }
}

export function assertSafeReportPath(
  reportPath: string,
  inputPath: string,
  outputPath: string
): void {
  if (isSamePathOrFile(reportPath, inputPath) || isSamePathOrFile(reportPath, outputPath)) {
    throw new Error("JSON report path must be different from the input and output EPUB paths.");
  }

  try {
    const stats = fs.lstatSync(reportPath);
    if (!stats.isFile()) {
      throw new Error(
        `JSON report path must be a regular file or not exist; refusing unsafe target: ${path.resolve(reportPath)}`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function assertSafeOutputTarget(outputPath: string): Promise<void> {
  try {
    const stats = await fs.lstat(outputPath);
    if (!stats.isFile()) {
      throw new Error(
        `Output path must be a regular file or not exist; refusing unsafe target: ${path.resolve(outputPath)}`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function createCandidateOutputPath(outputPath: string): Promise<string> {
  const candidatePath = uniqueSiblingPath(outputPath, "candidate");
  await fs.ensureDir(path.dirname(candidatePath));
  return candidatePath;
}

export async function discardCandidateOutput(candidatePath: string | undefined): Promise<void> {
  if (candidatePath) {
    await fs.remove(candidatePath);
  }
}

export async function commitCandidateOutput(
  candidatePath: string,
  outputPath: string
): Promise<void> {
  const absoluteCandidate = path.resolve(candidatePath);
  const absoluteOutput = path.resolve(outputPath);
  const backupPath = uniqueSiblingPath(absoluteOutput, "backup");
  await assertSafeOutputTarget(absoluteOutput);
  const hadPreviousOutput = await fs.pathExists(absoluteOutput);

  if (!(await fs.pathExists(absoluteCandidate))) {
    throw new Error(`Validated candidate output does not exist: ${absoluteCandidate}`);
  }

  try {
    if (hadPreviousOutput) {
      await fs.rename(absoluteOutput, backupPath);
    }
    await fs.rename(absoluteCandidate, absoluteOutput);
    await fs.remove(backupPath);
  } catch (error) {
    if (hadPreviousOutput && (await fs.pathExists(backupPath))) {
      await fs.remove(absoluteOutput);
      await fs.rename(backupPath, absoluteOutput);
    }
    throw new Error(
      `Failed to publish validated EPUB: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}
