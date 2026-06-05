import { spawnSync } from "node:child_process";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error Node's native TypeScript stripping requires the source extension.
import * as e2eFixture from "./e2e-epubcheck.ts";

const {
  assertAuthorOutput,
  assertConfiguredAuthorOutput,
  assertLosslessOutput,
  assertOptimizedOutput,
  assertSizeRegression,
  createAuthorFixtureEpubStructure,
  createConfiguredAuthorFixtureEpubStructure,
  createEpub,
  createFixtureEpubStructure,
} = e2eFixture;

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

interface DockerRunReport {
  preset?: string;
  strict?: boolean;
  success?: boolean;
  steps?: Array<{ name?: string; status?: string }>;
  content?: { integrity?: { valid?: boolean } };
}

interface DockerWorkflowResult {
  outputEpub: string;
  report: DockerRunReport;
}

async function assertSuccessfulRun(
  name: string,
  outputEpub: string,
  extractDir: string,
  reportPath: string,
  expectClean: boolean
): Promise<DockerRunReport> {
  if (!(await fs.pathExists(outputEpub))) {
    throw new Error(`Expected ${name} optimized EPUB output to exist.`);
  }
  const tempExists = await fs.pathExists(extractDir);
  if (expectClean && tempExists) {
    throw new Error(`Expected ${name} to remove the extraction temp directory.`);
  }
  if (!expectClean && !tempExists) {
    throw new Error(`Expected ${name} to keep the extraction temp directory.`);
  }
  const report = (await fs.readJson(reportPath)) as DockerRunReport;
  if (report.success !== true || report.content?.integrity?.valid !== true) {
    throw new Error(`Expected ${name} JSON pipeline report to record a successful run.`);
  }

  return report;
}

function assertStepStatus(
  report: DockerRunReport,
  stepName: string,
  expectedStatus: "success" | "skipped"
): void {
  const step = report.steps?.find(({ name }) => name === stepName);
  if (step?.status !== expectedStatus) {
    throw new Error(
      `Expected ${stepName} to be ${expectedStatus}, received ${step?.status ?? "missing"}.`
    );
  }
}

async function runDockerWorkflowCase(
  runDir: string,
  name: string,
  inputFile: string,
  mode: "run" | "compose",
  expectClean: boolean,
  extraArgs: string[] = []
): Promise<DockerWorkflowResult> {
  const outputFile = `${name}.epub`;
  const extractName = `extract-${name}`;
  const reportFile = `report-${name}.json`;
  const cliArgs = [
    "-i",
    inputFile,
    "-o",
    outputFile,
    "--temp",
    extractName,
    "--report-json",
    reportFile,
    ...extraArgs,
  ];
  const dockerArgs =
    mode === "run"
      ? ["run", "--rm", "-v", `${runDir}:/epub-files`, imageName, ...cliArgs]
      : ["compose", "run", "--rm", "optimizer", ...cliArgs];
  const result = spawnSync("docker", dockerArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      EPUB_FILES_DIR: runDir,
      EPUB_OPTIMIZER_DOCKER_IMAGE: imageName,
    },
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Docker ${mode} ${name} E2E failed with exit ${result.status ?? "unknown"}.`);
  }

  const outputEpub = path.join(runDir, outputFile);
  const report = await assertSuccessfulRun(
    `Docker ${mode} ${name}`,
    outputEpub,
    path.join(runDir, extractName),
    path.join(runDir, reportFile),
    expectClean
  );
  return { outputEpub, report };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeDockerE2ERunDir(runDir: string): Promise<void> {
  if (!(await fs.pathExists(runDir))) {
    return;
  }

  try {
    await fs.remove(runDir);
    return;
  } catch (error) {
    const chmodResult = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "0",
        "--entrypoint",
        "/bin/sh",
        "-v",
        `${runDir}:/epub-files`,
        imageName,
        "-c",
        "chmod -R a+rwX /epub-files",
      ],
      { stdio: "ignore" }
    );

    if (chmodResult.status === 0) {
      try {
        await fs.remove(runDir);
        return;
      } catch (retryError) {
        console.warn(
          `Warning: could not remove Docker E2E temp dir ${runDir}: ${getErrorMessage(retryError)}`
        );
        return;
      }
    }

    console.warn(
      `Warning: could not remove Docker E2E temp dir ${runDir}: ${getErrorMessage(error)}`
    );
  }
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
  const authorFixtureDir = path.join(runDir, "author-fixture");
  const authorInputEpub = path.join(runDir, "author-input.epub");
  const configuredAuthorFixtureDir = path.join(runDir, "configured-author-fixture");
  const configuredAuthorInputEpub = path.join(runDir, "configured-author-input.epub");
  const authorConfigPath = path.join(runDir, "author-workflow.json");

  try {
    await createFixtureEpubStructure(fixtureDir);
    await createEpub(inputEpub, fixtureDir);
    await createAuthorFixtureEpubStructure(authorFixtureDir);
    await createEpub(authorInputEpub, authorFixtureDir);
    await createConfiguredAuthorFixtureEpubStructure(configuredAuthorFixtureDir);
    await createEpub(configuredAuthorInputEpub, configuredAuthorFixtureDir);
    await fs.writeJson(authorConfigPath, {
      summaryHref: "contents.xhtml",
      coverSpineId: "front-cover",
      chapterClasses: ["chapter-link"],
      sectionClasses: ["section-link"],
      summaryEntryClass: "chapter-link",
      coverNavClass: "toc-cover",
      sectionNavClass: "toc-section",
    });

    const rawBalanced = await runDockerWorkflowCase(
      runDir,
      "raw-balanced",
      "input.epub",
      "run",
      true,
      ["--clean"]
    );
    await assertOptimizedOutput(rawBalanced.outputEpub, path.join(runDir, "assert-raw-balanced"));

    const rawAuthor = await runDockerWorkflowCase(
      runDir,
      "raw-author",
      "author-input.epub",
      "run",
      true,
      ["--preset", "author", "--strict", "--lang", "en", "--clean"]
    );
    if (rawAuthor.report.preset !== "author" || rawAuthor.report.strict !== true) {
      throw new Error(
        "Expected raw Docker author workflow to record author preset and strict mode."
      );
    }
    for (const stepName of ["Repair XHTML", "Author workflow"]) {
      assertStepStatus(rawAuthor.report, stepName, "success");
    }
    await assertAuthorOutput(rawAuthor.outputEpub, path.join(runDir, "assert-raw-author"));
    await assertSizeRegression(authorInputEpub, rawAuthor.outputEpub, 0.75);

    const composeBalanced = await runDockerWorkflowCase(
      runDir,
      "compose-balanced",
      "input.epub",
      "compose",
      false
    );
    if (composeBalanced.report.preset !== "balanced") {
      throw new Error("Expected Docker Compose default workflow to use the balanced preset.");
    }
    assertStepStatus(composeBalanced.report, "Repair XHTML", "skipped");
    assertStepStatus(composeBalanced.report, "Author workflow", "skipped");
    await assertOptimizedOutput(
      composeBalanced.outputEpub,
      path.join(runDir, "assert-compose-balanced")
    );

    const composeLossless = await runDockerWorkflowCase(
      runDir,
      "compose-lossless",
      "input.epub",
      "compose",
      true,
      ["--preset", "lossless", "--clean"]
    );
    if (composeLossless.report.preset !== "lossless") {
      throw new Error("Expected Docker Compose lossless workflow to record the lossless preset.");
    }
    await assertLosslessOutput(composeLossless.outputEpub, path.join(runDir, "assert-lossless"));

    const composeRepair = await runDockerWorkflowCase(
      runDir,
      "compose-repair",
      "input.epub",
      "compose",
      true,
      ["--repair", "--clean"]
    );
    assertStepStatus(composeRepair.report, "Repair XHTML", "success");
    assertStepStatus(composeRepair.report, "Author workflow", "skipped");
    await assertOptimizedOutput(composeRepair.outputEpub, path.join(runDir, "assert-repair"));

    const composeAuthor = await runDockerWorkflowCase(
      runDir,
      "compose-author",
      "author-input.epub",
      "compose",
      true,
      ["--preset", "author", "--strict", "--lang", "en", "--clean"]
    );
    if (composeAuthor.report.preset !== "author" || composeAuthor.report.strict !== true) {
      throw new Error(
        "Expected Docker Compose author workflow to record author preset and strict mode."
      );
    }
    for (const stepName of ["Repair XHTML", "Author workflow"]) {
      assertStepStatus(composeAuthor.report, stepName, "success");
    }
    await assertAuthorOutput(composeAuthor.outputEpub, path.join(runDir, "assert-author"));
    await assertSizeRegression(authorInputEpub, composeAuthor.outputEpub, 0.75);

    const composeConfiguredAuthor = await runDockerWorkflowCase(
      runDir,
      "compose-configured-author",
      "configured-author-input.epub",
      "compose",
      true,
      [
        "--preset",
        "author",
        "--strict",
        "--lang",
        "en",
        "--author-config",
        "author-workflow.json",
        "--clean",
      ]
    );
    if (
      composeConfiguredAuthor.report.preset !== "author" ||
      composeConfiguredAuthor.report.strict !== true
    ) {
      throw new Error(
        "Expected Docker Compose configured author workflow to record author preset and strict mode."
      );
    }
    for (const stepName of ["Repair XHTML", "Author workflow"]) {
      assertStepStatus(composeConfiguredAuthor.report, stepName, "success");
    }
    await assertConfiguredAuthorOutput(
      composeConfiguredAuthor.outputEpub,
      path.join(runDir, "assert-configured-author")
    );

    console.log(
      "Docker workflows passed E2E validation: raw balanced, raw author, Compose balanced, lossless, repair, author, and configured author."
    );
  } finally {
    await removeDockerE2ERunDir(runDir);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
