import fs from "fs-extra";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function assertWatchCrashRecovery(runDir: string, image: string): Promise<void> {
  const parent = path.join(runDir, "crash-recovery");
  await fs.ensureDir(path.join(parent, "inbox"));
  await fs.chmod(parent, 0o777);
  const first = `watch-crash-first-${randomUUID()}`,
    second = `watch-crash-second-${randomUUID()}`,
    contender = `watch-crash-contender-${randomUUID()}`;
  const volume = `watch-crash-volume-${randomUUID()}`;
  const docker = (...args: string[]) => {
    const r = spawnSync("docker", args, { encoding: "utf8", timeout: 60000 });
    if (r.status !== 0) throw new Error(`Crash test docker ${args[0]} failed: ${r.stderr}`);
    return (r.stdout + (args[0] === "logs" ? r.stderr : "")).trim();
  };
  const start = (name: string) =>
    docker(
      "run",
      "-d",
      "--name",
      name,
      "-v",
      `${parent}:/epub-files`,
      "-v",
      `${volume}:/epub-files/output`,
      image,
      "--watch",
      "inbox",
      "--output-dir",
      "output",
      "--watch-settle-ms",
      "1000",
      "--strict",
      "--clean"
    );
  const waitFor = async (check: () => Promise<boolean>, name: string) => {
    const deadline = Date.now() + 60000;
    while (!(await check())) {
      if (Date.now() > deadline)
        throw new Error(`Crash recovery timed out: ${docker("logs", name)}`);
      await delay(200);
    }
  };
  docker("volume", "create", volume);
  try {
    docker(
      "run",
      "--rm",
      "--user",
      "0",
      "-v",
      `${volume}:/recovery`,
      "--entrypoint",
      "node",
      image,
      "-e",
      'require("fs").chmodSync("/recovery",0o777)'
    );
    start(first);
    await waitFor(async () => docker("logs", first).includes("Watching "), first);
    const record = JSON.parse(docker("exec", first, "cat", "/epub-files/output/.epub-watch.lock"));
    if (record.method !== "linux-flock-v1")
      throw new Error("Native Linux volume did not retain a kernel guard");
    start(contender);
    const contenderExit = docker("wait", contender),
      contenderLog = docker("logs", contender);
    if (contenderExit !== "1" || !contenderLog.includes("holds the output guard"))
      throw new Error(`Concurrent container result ${contenderExit}: ${contenderLog}`);
    docker("kill", "--signal", "KILL", first);
    docker("wait", first);
    const leftover = docker(
      "run",
      "--rm",
      "-v",
      `${volume}:/recovery`,
      "--entrypoint",
      "node",
      image,
      "-e",
      'console.log(require("fs").existsSync("/recovery/.epub-watch.lock"))'
    );
    if (leftover !== "true") throw new Error("Forced termination did not leave a recovery record");
    start(second);
    await waitFor(async () => docker("logs", second).includes("Watching "), second);
    await fs.copyFile(
      path.join(runDir, "input.epub"),
      path.join(parent, "inbox", "book.epub.part")
    );
    await fs.rename(
      path.join(parent, "inbox", "book.epub.part"),
      path.join(parent, "inbox", "book.epub")
    );
    await waitFor(
      async () =>
        docker(
          "exec",
          second,
          "node",
          "-e",
          'const f=require("fs"),p="/epub-files/output/";console.log(f.readdirSync(p).some(n=>!n.startsWith(".")&&f.existsSync(p+n+"/completed.json")&&JSON.parse(f.readFileSync(p+n+"/report.json")).success))'
        ) === "true",
      second
    );
    docker("stop", "--time", "120", second);
    if (docker("inspect", "--format", "{{.State.ExitCode}}", second) !== "0")
      throw new Error("Recovered watcher failed graceful shutdown");
    const clean = docker(
      "run",
      "--rm",
      "-v",
      `${volume}:/recovery`,
      "--entrypoint",
      "node",
      image,
      "-e",
      'const f=require("fs");console.log(!f.existsSync("/recovery/.epub-watch.lock")&&f.existsSync("/recovery/.epub-watch.guard"))'
    );
    if (clean !== "true")
      throw new Error("Recovered watcher did not clean its record or removed its guard");
  } finally {
    for (const name of [first, second, contender])
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30000 });
    docker("volume", "rm", volume);
  }
  console.log(
    "Crash recovery passed: native-volume concurrency exclusion, SIGKILL, cross-container restart and validated processing."
  );
}
