import { spawnSync } from "node:child_process";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { assertOptimizedOutput, createEpub, createFixtureEpubStructure } from "./e2e-epubcheck.ts";

const imageName = process.env.EPUB_OPTIMIZER_DOCKER_IMAGE ?? "epub-optimizer";

function assertDockerAvailable(): void {
  const result = spawnSync("docker", ["--version"], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(
      "Docker is not available. Build and run the Docker E2E test with Docker installed."
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
  const outputEpub = path.join(runDir, "output.epub");
  const extractDir = path.join(runDir, "extract");

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
        "/epub-files/input.epub",
        "-o",
        "/epub-files/output.epub",
        "--temp",
        "/epub-files/extract",
        "--clean",
      ],
      { stdio: "inherit" }
    );

    if (result.status !== 0) {
      throw new Error(`Docker E2E failed with exit ${result.status ?? "unknown"}.`);
    }
    if (!(await fs.pathExists(outputEpub))) {
      throw new Error("Expected Docker optimized EPUB output to exist.");
    }
    if (await fs.pathExists(extractDir)) {
      throw new Error("Expected Docker --clean to remove the extraction temp directory.");
    }

    await assertOptimizedOutput(outputEpub, runDir);
    console.log("Docker E2E fixture passed.");
  } finally {
    await fs.remove(runDir);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
