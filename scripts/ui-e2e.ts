import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

async function waitFor<T>(read: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await delay(100);
  }
}
async function exerciseUi(url: string, input: string, output: string): Promise<void> {
  const home = await fetch(url);
  const html = await home.text();
  const cookie = home.headers.get("set-cookie")?.split(";")[0];
  const token = /name="epub-token" content="([a-f0-9]+)"/.exec(html)?.[1];
  if (!cookie || !token || !html.includes('id="root"') || !html.includes('type="module"'))
    throw new Error("UI bootstrap missing.");
  for (const [asset, contentType] of [
    ["app.js", "javascript"],
    ["app.css", "text/css"],
  ]) {
    const response = await fetch(url + "/" + asset);
    if (!response.ok || !response.headers.get("content-type")?.includes(contentType!))
      throw new Error("UI asset missing: " + asset);
    if (!(await response.text()).length) throw new Error("Empty UI asset: " + asset);
  }
  const headers = { Cookie: cookie, "X-Epub-Token": token, Origin: url };
  const upload = (body: Uint8Array | string) =>
    fetch(url + "/api/jobs?preset=balanced", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/epub+zip",
        "X-Epub-Name": "fixture.epub",
      },
      body: typeof body === "string" ? body : Uint8Array.from(body).buffer,
    });
  const settle = () =>
    waitFor(async () => {
      const response = await fetch(url + "/api/job", { headers });
      const job = (await response.json()) as { id: string; state: string };
      return ["failed", "success", "cancelled"].includes(job.state) ? job : undefined;
    }, "UI optimization timed out.");
  if ((await upload("invalid ZIP")).status !== 202) throw new Error("UI rejected test job.");
  const failed = await settle();
  if (
    failed.state !== "failed" ||
    (await fetch(url + `/api/jobs/${failed.id}/download`, { headers })).status !== 409
  )
    throw new Error("UI exposed failed output.");
  const original = await fs.readFile(input);
  if ((await upload(original)).status !== 202) throw new Error("UI valid upload failed.");
  const job = await settle();
  if (job.state !== "success") throw new Error("UI pipeline did not succeed.");
  const download = await fetch(url + `/api/jobs/${job.id}/download`, { headers });
  if (!download.ok || !download.headers.get("content-disposition")?.startsWith("attachment"))
    throw new Error("UI download unavailable.");
  await fs.writeFile(output, Buffer.from(await download.arrayBuffer()));
  const report = (await (await fetch(url + `/api/jobs/${job.id}/json`, { headers })).json()) as {
    success: boolean;
    strict: boolean;
    content: { integrity: { valid: boolean } };
    validation: { totals: { errors: number; warnings: number } };
  };
  if (
    !report.success ||
    !report.strict ||
    !report.content.integrity.valid ||
    report.validation.totals.errors ||
    report.validation.totals.warnings
  )
    throw new Error("UI validation guarantees failed.");
  if (!original.equals(await fs.readFile(input))) throw new Error("UI modified fixture source.");
}

export async function assertNativeUi(
  runDir: string,
  input: string,
  env: NodeJS.ProcessEnv,
  serverModule = path.resolve("dist/src/ui/server.js")
): Promise<string> {
  const module = pathToFileURL(serverModule).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {startLocalUi} from ${JSON.stringify(module)}; const app=await startLocalUi({port:0}); console.log(app.url); process.on('SIGTERM',()=>{void app.close().catch(()=>{process.exitCode=1;});});`,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    logs += String(chunk);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  try {
    const url = await waitFor(async () => {
      if (child.exitCode !== null) throw new Error("UI server exited before startup: " + logs);
      return /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
    }, "UI server startup timed out.");
    const output = path.join(runDir, "ui-native-output.epub");
    await exerciseUi(url, input, output);
    console.log(
      "Local UI E2E passed: private session, failed-upload recovery, strict validation, reports and download."
    );
    return output;
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function assertDockerUi(
  runDir: string,
  input: string,
  image: string,
  repo: string
): Promise<string> {
  const project = "epub-ui-e2e-" + randomUUID();
  const override = path.join(runDir, "ui-override.yaml");
  await fs.writeFile(
    override,
    `services:\n  ui:\n    image: ${JSON.stringify(image)}\n    ports: !override\n      - "127.0.0.1::8787"\n`
  );
  const compose = (...args: string[]) => {
    const result = spawnSync(
      "docker",
      ["compose", "-p", project, "-f", path.join(repo, "compose.ui.yaml"), "-f", override, ...args],
      { encoding: "utf8", timeout: 180_000 }
    );
    if (result.status !== 0) throw new Error("UI Compose failed: " + result.stderr);
    return result.stdout.trim();
  };
  try {
    compose("up", "-d", "--no-build");
    const address = compose("port", "ui", "8787");
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("UI port is not loopback-only.");
    const url = "http://" + address;
    await waitFor(async () => {
      try {
        return (await fetch(url)).ok ? true : undefined;
      } catch {
        return undefined;
      }
    }, "Docker UI startup timed out.");
    const output = path.join(runDir, "ui-docker-output.epub");
    await exerciseUi(url, input, output);
    console.log(
      "Docker UI E2E passed: loopback port, upload, failure recovery and validated download."
    );
    return output;
  } finally {
    compose("down", "--volumes", "--remove-orphans");
  }
}
