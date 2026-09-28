import fs from "fs-extra";
import path from "node:path";

/** Export only reports from generated test fixtures, never a user's EPUB. */
export async function saveDiagnostics(runDir: string, suite: string): Promise<void> {
  const destination = process.env.EPUB_E2E_ARTIFACT_DIR;
  if (!destination) return;
  const output = path.resolve(destination, suite, path.basename(runDir));
  await fs.ensureDir(output);
  for (const file of await fs.readdir(runDir)) {
    if (file.endsWith(".json")) {
      const source = path.join(runDir, file);
      if ((await fs.lstat(source)).isFile()) await fs.copy(source, path.join(output, file));
    }
  }
}
