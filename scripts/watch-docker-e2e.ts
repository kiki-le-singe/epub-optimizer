import fs from "fs-extra";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function assertDockerWatch(runDir: string, image: string): Promise<void> {
  const name = `epub-watch-e2e-${randomUUID()}`;
  const input = path.join(runDir, "watch-in"),
    output = path.join(runDir, "watch-out");
  await fs.ensureDir(input);
  const docker = (args: string[]) => {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 180_000 });
    if (result.status !== 0)
      throw new Error(`Docker watch command failed: ${args[0]}\n${result.stderr}`);
    return result.stdout.trim();
  };
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--read-only",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp",
    "-v",
    `${runDir}:/epub-files`,
    image,
    "--watch",
    "watch-in",
    "--output-dir",
    "watch-out",
    "--watch-settle-ms",
    "1000",
    "--preset",
    "lossless",
    "--strict",
    "--clean",
  ]);
  try {
    await fs.copyFile(path.join(runDir, "input.epub"), path.join(input, "book.epub.part"));
    await fs.rename(path.join(input, "book.epub.part"), path.join(input, "book.epub"));
    const deadline = Date.now() + 90_000;
    let completed: string | undefined;
    while (!completed) {
      for (const entry of (await fs.pathExists(output)) ? await fs.readdir(output) : []) {
        if (
          !entry.startsWith(".") &&
          (await fs.pathExists(path.join(output, entry, "completed.json")))
        )
          completed = entry;
      }
      if (Date.now() > deadline)
        throw new Error(`Docker watch timed out.\n${docker(["logs", name])}`);
      if (!completed) await delay(100);
    }
    const report = await fs.readJson(path.join(output, completed, "report.json"));
    if (
      !report.success ||
      !report.content?.integrity?.valid ||
      report.validation?.totals?.warnings !== 0
    )
      throw new Error("Docker watch output failed validation.");
    const overview = await fs.readFile(path.join(output, "index.html"), "utf8");
    if (!overview.includes("book.epub") || !overview.includes("optimized.epub"))
      throw new Error("Docker watcher summary missing book links");
    docker(["stop", "--time", "120", name]);
    if (docker(["inspect", "--format", "{{.State.ExitCode}}", name]) !== "0")
      throw new Error("Docker watch did not stop gracefully.");
    if (await fs.pathExists(path.join(output, ".epub-watch.lock")))
      throw new Error("Docker watch left its lock.");
  } finally {
    docker(["rm", "-f", name]);
  }
  console.log(
    "Docker watch passed: mounted drop folder, read-only/no-network container, validation and SIGTERM shutdown."
  );
}
