import { spawnSync } from "node:child_process";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error Node's native TypeScript stripping requires the source extension.
import { assertOptimizedOutput, createEpub, createFixtureEpubStructure } from "./e2e-epubcheck.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imageName = process.env.EPUB_OPTIMIZER_DOCKER_IMAGE ?? "epub-optimizer";

function assertDockerAvailable(): void {
  const result = spawnSync("docker", ["--version"], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(
      "Docker is not available. Build and run the Docker E2E test with Docker installed."
    );
  }

  const composeResult = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  if (composeResult.status !== 0) {
    throw new Error("Docker Compose is not available. Install a current Docker Desktop/Engine.");
  }
}

async function assertSuccessfulRun(
  runDir: string,
  name: string,
  outputEpub: string,
  extractDir: string,
  reportPath: string
): Promise<void> {
  if (!(await fs.pathExists(outputEpub))) {
    throw new Error(`Expected ${name} optimized EPUB output to exist.`);
  }
  if (await fs.pathExists(extractDir)) {
    throw new Error(`Expected ${name} --clean to remove the extraction temp directory.`);
  }
  const report = (await fs.readJson(reportPath)) as { success?: boolean };
  if (report.success !== true) {
    throw new Error(`Expected ${name} JSON pipeline report to record a successful run.`);
  }

  await assertOptimizedOutput(outputEpub, path.join(runDir, `assert-${name}`));
}

async function main(): Promise<void> {
  assertDockerAvailable();

  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "epub-optimizer-docker-e2e-"));
  // GitHub-hosted Linux runners create temp dirs as 0700. The Docker image
  // runs as the non-root node user, so the bind-mounted fixture dir must be
  // writable by that container user.
  await fs.chmod(runDir, 0o777);

  const fixtureDir = path.join(runDir, "fixture");
  const inputEpub = path.join(runDir, "input.epub");
  const runOutputEpub = path.join(runDir, "output-run.epub");
  const runExtractDir = path.join(runDir, "extract-run");
  const runReportPath = path.join(runDir, "report-run.json");
  const composeOutputEpub = path.join(runDir, "output-compose.epub");
  const composeExtractDir = path.join(runDir, "extract-compose");
  const composeReportPath = path.join(runDir, "report-compose.json");

  try {
    await createFixtureEpubStructure(fixtureDir);
    await createEpub(inputEpub, fixtureDir);

    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${runDir}:/epub-files`,
        imageName,
        "-i",
        "input.epub",
        "-o",
        "output-run.epub",
        "--temp",
        "extract-run",
        "--report-json",
        "report-run.json",
        "--clean",
      ],
      { stdio: "inherit" }
    );

    if (result.status !== 0) {
      throw new Error(`Docker run E2E failed with exit ${result.status ?? "unknown"}.`);
    }
    await assertSuccessfulRun(runDir, "docker run", runOutputEpub, runExtractDir, runReportPath);

    const composeResult = spawnSync(
      "docker",
      [
        "compose",
        "run",
        "--rm",
        "optimizer",
        "-i",
        "input.epub",
        "-o",
        "output-compose.epub",
        "--temp",
        "extract-compose",
        "--report-json",
        "report-compose.json",
        "--clean",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          EPUB_FILES_DIR: runDir,
          EPUB_OPTIMIZER_DOCKER_IMAGE: imageName,
        },
        stdio: "inherit",
      }
    );

    if (composeResult.status !== 0) {
      throw new Error(`Docker Compose E2E failed with exit ${composeResult.status ?? "unknown"}.`);
    }
    await assertSuccessfulRun(
      runDir,
      "Docker Compose",
      composeOutputEpub,
      composeExtractDir,
      composeReportPath
    );

    console.log("Docker run and Docker Compose E2E fixtures passed.");
  } finally {
    await fs.remove(runDir);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
