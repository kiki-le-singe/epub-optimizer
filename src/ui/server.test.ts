import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { attachment, startLocalUi } from "./server.js";
import type { UiResult, runUiWorker } from "./worker.js";

const apps: Awaited<ReturnType<typeof startLocalUi>>[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined);
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function setup(maxUploadBytes = 1024) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-ui-server-test-"));
  roots.push(root);
  const assetsDirectory = path.join(root, "assets");
  await fs.mkdir(assetsDirectory);
  await fs.writeFile(path.join(assetsDirectory, "app.js"), "export {};");
  await fs.writeFile(path.join(assetsDirectory, "app.css"), ":root { color-scheme: light dark; }");
  let finish!: (value: UiResult) => void;
  let work!: Parameters<typeof runUiWorker>[0];
  const stop = vi.fn(async () => {
    finish({ success: false, error: "cancelled", reports: { json: false, html: false } });
  });
  const worker = vi.fn((options: Parameters<typeof runUiWorker>[0]) => {
    work = options;
    return {
      done: new Promise<UiResult>((resolve) => {
        finish = resolve;
      }),
      stop,
    };
  });
  const app = await startLocalUi({
    port: 0,
    tempParent: root,
    maxUploadBytes,
    worker,
    assetsDirectory,
  });
  apps.push(app);
  const home = await fetch(app.url);
  const html = await home.text();
  const cookie = home.headers.get("set-cookie")!.split(";")[0]!;
  const token = /name="epub-token" content="([a-f0-9]+)"/.exec(html)![1]!;
  const headers = { Cookie: cookie, Origin: app.url, "X-Epub-Token": token };
  const request = (url: string, init: RequestInit = {}) =>
    fetch(app.url + url, { ...init, headers: { ...headers, ...init.headers } });
  const upload = (name = "book.epub", body = "epub bytes", preset = "balanced") =>
    request("/api/jobs?preset=" + preset, {
      method: "POST",
      headers: { "Content-Type": "application/epub+zip", "X-Epub-Name": encodeURIComponent(name) },
      body,
    });
  const complete = async (success = true) => {
    await fs.writeFile(path.join(work.directory, "optimized.epub"), "validated epub");
    await fs.writeFile(path.join(work.directory, "report.html"), "<p>report</p>");
    await fs.writeFile(path.join(work.directory, "report.json"), "{}");
    finish({
      success,
      summary: success
        ? { inputBytes: 20, outputBytes: 14, reductionPercent: 30, errors: 0, warnings: 0 }
        : undefined,
      error: success ? undefined : "Invalid EPUB",
      reports: { json: true, html: true },
    });
    await vi.waitFor(async () =>
      expect((await (await request("/api/job")).json()).state).toBe(success ? "success" : "failed")
    );
  };
  return { app, request, upload, complete, worker, stop, headers, work: () => work };
}
it("serves a self-contained local page with a private session and restrictive browser headers", async () => {
  const { app } = await setup();
  const page = await fetch(app.url);
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(await page.text()).toContain('id="root"');
  expect((await fetch(app.url + "/app.js")).headers.get("content-type")).toContain("javascript");
  expect((await fetch(app.url + "/app.css")).headers.get("content-type")).toContain("text/css");
});
it("rejects rebinding hosts, missing sessions, cross-origin submissions and unknown presets", async () => {
  const { app, request, worker } = await setup();
  const rebinding = await new Promise<number>((resolve, reject) => {
    http
      .get(app.url, { headers: { Host: "attacker.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      })
      .on("error", reject);
  });
  expect(rebinding).toBe(403);
  expect((await fetch(app.url + "/api/job")).status).toBe(403);
  expect(
    (
      await request("/api/jobs?preset=balanced", {
        method: "POST",
        headers: { Origin: "https://attacker.example" },
      })
    ).status
  ).toBe(403);
  expect(
    (
      await request("/api/jobs?preset=balanced", {
        method: "POST",
        headers: { "X-Epub-Token": "é".repeat(64) },
      })
    ).status
  ).toBe(403);
  const unknown = await request("/api/jobs?preset=unknown", { method: "POST" });
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toEqual({ error: "Unknown preset.", code: "unknownPreset" });
  expect(worker).not.toHaveBeenCalled();
});
it("uses fixed owned paths, exposes progress, runs only one book, and streams validated results", async () => {
  const { upload, request, complete, work, worker } = await setup();
  const response = await upload("<book>.epub", "original bytes", "lossless");
  expect(response.status).toBe(202);
  const job = await response.json();
  expect(job.name).toBe("<book>.epub");
  expect(work().preset).toBe("lossless");
  expect(await fs.readFile(path.join(work().directory, "input.epub"), "utf8")).toBe(
    "original bytes"
  );
  work().onStage("Optimize images");
  expect((await (await request("/api/job")).json()).stage).toBe("Optimize images");
  expect((await upload()).status).toBe(409);
  expect(worker).toHaveBeenCalledOnce();
  expect((await request(`/api/jobs/${job.id}/download`)).status).toBe(409);
  await complete();
  const download = await request(`/api/jobs/${job.id}/download`);
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toBe(
    `attachment; filename="<book>-optimized.epub"; filename*=UTF-8''%3Cbook%3E-optimized.epub`
  );
  expect(await download.text()).toBe("validated epub");
  expect((await (await request("/api/job")).json()).stage).toBe("Complete");
  for (const report of ["html", "json"]) {
    const response = await request(`/api/jobs/${job.id}/${report}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      `filename="<book>-report.${report}"`
    );
  }
  expect((await request("/api/jobs/../../etc/passwd/download")).status).toBe(404);
  const previous = work().directory;
  expect((await upload()).status).toBe(202);
  await expect(fs.stat(previous)).rejects.toMatchObject({ code: "ENOENT" });
});
it("never downloads a failed output, but preserves available diagnostic reports", async () => {
  const { upload, request, complete } = await setup();
  const job = await (await upload()).json();
  await complete(false);
  expect((await request(`/api/jobs/${job.id}/download`)).status).toBe(409);
  expect((await request(`/api/jobs/${job.id}/json`)).status).toBe(200);
});
it("rejects empty, unsafe and oversized uploads and frees the processing slot afterwards", async () => {
  const { upload, app, request, worker } = await setup(16);
  expect((await upload("../book.epub")).status).toBe(400);
  expect((await upload("book.txt")).status).toBe(400);
  expect((await upload("book.epub", "")).status).toBe(400);
  expect((await upload("book.epub", "x".repeat(17))).status).toBe(413);
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      app.url + "/api/jobs?preset=balanced",
      { method: "POST", headers: { ...{}, Cookie: "", Origin: app.url } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      }
    );
    req.on("error", reject);
    req.end("chunked");
  });
  expect(status).toBe(403);
  expect(worker).not.toHaveBeenCalled();
  expect((await request("/api/job")).status).toBe(200);
  expect((await upload()).status).toBe(202);
});
it("bounds chunked uploads too", async () => {
  const { app, headers, worker, upload } = await setup(16);
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      app.url + "/api/jobs?preset=balanced",
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/epub+zip", "X-Epub-Name": "book.epub" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      }
    );
    req.on("error", reject);
    req.write("x".repeat(10));
    req.end("x".repeat(10));
  });
  expect(status).toBe(413);
  expect(worker).not.toHaveBeenCalled();
  expect((await upload()).status).toBe(202);
});
it("cancels workers, hides incomplete results, and cleans owned files on shutdown", async () => {
  const { app, upload, request, stop } = await setup();
  const job = await (await upload()).json();
  expect((await request(`/api/jobs/${job.id}/cancel`, { method: "POST" })).status).toBe(200);
  expect(stop).toHaveBeenCalledOnce();
  expect((await request(`/api/jobs/${job.id}/download`)).status).toBe(409);
  expect(await (await request("/api/job")).json()).toMatchObject({
    state: "cancelled",
    stage: "Cancelled",
  });
  await app.close();
  await expect(fs.stat(app.directory)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses to remove an owned root that was replaced with a symlink", async () => {
  const { app } = await setup();
  const original = app.directory + "-original";
  const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "epub-ui-foreign-"));
  roots.push(foreign);
  await fs.writeFile(path.join(foreign, "keep"), "preserve");
  await fs.rename(app.directory, original);
  roots.push(original);
  await fs.symlink(foreign, app.directory);
  await expect(app.close()).rejects.toThrow("replaced");
  expect(await fs.readFile(path.join(foreign, "keep"), "utf8")).toBe("preserve");
});

it("names attachments after the book while keeping the header safe for any title", () => {
  expect(attachment("Les Misérables.epub")).toBe(
    `attachment; filename="Les Mis_rables.epub"; filename*=UTF-8''Les%20Mis%C3%A9rables.epub`
  );
  expect(attachment(`a "quoted"; 100% (draft)'s.epub`)).toBe(
    `attachment; filename="a _quoted__ 100_ (draft)'s.epub"; filename*=UTF-8''a%20%22quoted%22%3B%20100%25%20%28draft%29%27s.epub`
  );
});
