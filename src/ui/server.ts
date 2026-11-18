import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Stats } from "node:fs";
import type { Preset } from "../types.js";
import { uiHtml } from "./page.js";
import { uiMessages, type UiKey } from "./translations.js";
import { runUiWorker, type UiMode, type UiResult, type UiWorker } from "./worker.js";

const MAX_UPLOAD = 256 * 1024 * 1024;
class HttpError extends Error {
  readonly status: number;
  readonly code: UiKey;
  constructor(status: number, code: UiKey) {
    super(uiMessages.en[code]);
    this.code = code;
    this.status = status;
  }
}
interface Job {
  id: string;
  name: string;
  preset: Preset;
  mode: UiMode;
  directory: string;
  owner: Stats;
  state: "uploading" | "running" | "cancelling" | "cancelled" | "success" | "failed";
  stage: string;
  result?: UiResult;
  worker?: UiWorker;
  finished?: Promise<void>;
  downloads: number;
}
async function owned(directory: string, owner: Stats): Promise<void> {
  const current = await fs.lstat(directory);
  if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino)
    throw new Error("Refusing cleanup of a replaced UI directory.");
}
function equal(value: string | string[] | undefined, token: string): boolean {
  return (
    typeof value === "string" &&
    value.length === token.length &&
    Buffer.byteLength(value) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token))
  );
}

// Names the download after the uploaded book, like batch output ("book-optimized.epub").
// The quoted ASCII fallback serves old clients; filename* carries the exact UTF-8 name.
export function attachment(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%;]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase()
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function startLocalUi(
  options: {
    host?: "127.0.0.1" | "0.0.0.0";
    port?: number;
    tempParent?: string;
    assetsDirectory?: string;
    maxUploadBytes?: number;
    worker?: typeof runUiWorker;
  } = {}
): Promise<{ url: string; directory: string; close: () => Promise<void> }> {
  if (options.host !== undefined && !["127.0.0.1", "0.0.0.0"].includes(options.host))
    throw new Error("Unsupported local UI host.");
  const maxUpload = options.maxUploadBytes ?? MAX_UPLOAD;
  if (!Number.isSafeInteger(maxUpload) || maxUpload <= 0) throw new Error("Invalid upload limit.");
  const directory = await fs.mkdtemp(path.join(options.tempParent ?? os.tmpdir(), "epub-ui-"));
  await fs.chmod(directory, 0o700);
  const owner = await fs.lstat(directory);
  const token = randomBytes(32).toString("hex");
  let current: Job | undefined;
  let busy = false,
    closing = false;
  const requests = new Set<Promise<void>>();
  const removeJob = async (job: Job) => {
    await owned(directory, owner);
    await owned(job.directory, job.owner);
    await fs.rm(job.directory, { recursive: true });
  };
  const view = (job: Job | undefined) =>
    job
      ? {
          id: job.id,
          name: job.name,
          preset: job.preset,
          mode: job.mode,
          state: job.state,
          stage: job.stage,
          summary: job.result?.summary,
          diagnosis: job.result?.diagnosis,
          error: job.result?.error,
          errorCode: job.result?.errorCode,
          reports: job.result?.reports,
        }
      : null;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const upload = async (
    req: IncomingMessage,
    res: ServerResponse,
    preset: Preset,
    mode: UiMode
  ) => {
    if (busy || current?.downloads) throw new HttpError(409, "busy");
    if (req.headers["content-type"] !== "application/epub+zip")
      throw new HttpError(415, "uploadType");
    let name: string;
    try {
      name = decodeURIComponent(String(req.headers["x-epub-name"] ?? ""));
    } catch {
      throw new HttpError(400, "invalidName");
    }
    if (!name || name.length > 255 || /[\p{Cc}/\\]/u.test(name) || !/\.epub$/i.test(name))
      throw new HttpError(400, "invalidName");
    const length = req.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxUpload))
      throw new HttpError(413, "tooLarge");
    busy = true;
    let job: Job | undefined;
    try {
      await owned(directory, owner);
      const next = await fs.mkdtemp(path.join(directory, "book-"));
      job = {
        id: randomUUID(),
        name,
        preset,
        mode,
        directory: next,
        owner: await fs.lstat(next),
        state: "uploading",
        stage: "Upload",
        downloads: 0,
      };
      if (current) await removeJob(current);
      current = job;
      const handle = await fs.open(path.join(next, "input.epub"), "wx", 0o600);
      let size = 0;
      try {
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > maxUpload) throw new HttpError(413, "tooLarge");
          let offset = 0;
          while (offset < bytes.length)
            offset += (await handle.write(bytes, offset, bytes.length - offset)).bytesWritten;
        }
      } finally {
        await handle.close();
      }
      if (!size) throw new HttpError(400, "emptyFile");
      if (closing) throw new HttpError(503, "shutdown");
      job.state = "running";
      job.stage = "Prepare";
      const runningJob = job;
      try {
        job.worker = (options.worker ?? runUiWorker)({
          directory: next,
          preset,
          mode,
          onStage: (stage) => {
            if (runningJob.state === "running") runningJob.stage = stage;
          },
        });
        job.finished = job.worker.done
          .then(
            (result) => {
              if (runningJob.state === "running") {
                runningJob.result = result;
                runningJob.state = result.success ? "success" : "failed";
                runningJob.stage = result.success ? "Complete" : "Failed";
              }
            },
            () => {
              if (runningJob.state === "running") {
                runningJob.result = {
                  success: false,
                  errorCode: "processingFailed",
                  reports: { json: false, html: false },
                };
                runningJob.state = "failed";
                runningJob.stage = "Failed";
              }
            }
          )
          .finally(() => {
            if (runningJob.state !== "cancelling") busy = false;
          });
      } catch {
        job.state = "failed";
        job.stage = "Failed";
        busy = false;
        job.result = {
          success: false,
          errorCode: "cannotStart",
          reports: { json: false, html: false },
        };
      }
      json(res, 202, view(job));
    } catch (error) {
      if (job) {
        await removeJob(job);
        if (current === job) current = undefined;
      }
      busy = false;
      throw error;
    }
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    );
    const host = req.headers.host ?? "";
    if (!/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/i.test(host)) throw new HttpError(403, "localOnly");
    let origin: URL;
    try {
      origin = new URL(`http://${host}`);
    } catch {
      throw new HttpError(403, "invalidAddress");
    }
    if (!req.url?.startsWith("/") || req.url.startsWith("//"))
      throw new HttpError(400, "invalidAddress");
    const url = new URL(req.url, origin);
    const cookieName = `epub_ui_${origin.port || "80"}`;
    if (closing) throw new HttpError(503, "shutdown");
    if (req.method === "GET" && url.pathname === "/") {
      res.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(uiHtml(token, maxUpload));
      return;
    }
    if (req.method === "GET" && ["/app.js", "/app.css"].includes(url.pathname)) {
      res.writeHead(200, {
        "Content-Type": url.pathname.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "text/css; charset=utf-8",
      });
      const assets =
        options.assetsDirectory ?? fileURLToPath(new URL("../../ui-assets/", import.meta.url));
      res.end(
        await fs.readFile(path.join(assets, url.pathname === "/app.js" ? "app.js" : "app.css"))
      );
      return;
    }
    const cookie = req.headers.cookie
      ?.split(/;\s*/)
      .find((entry) => entry.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (!equal(cookie, token) || req.headers["sec-fetch-site"] === "cross-site")
      throw new HttpError(403, "sessionExpired");
    if (
      req.method !== "GET" &&
      (!equal(req.headers["x-epub-token"], token) || req.headers.origin !== origin.origin)
    )
      throw new HttpError(403, "forbidden");
    if (req.method === "GET" && url.pathname === "/api/job") {
      json(res, 200, view(current));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const preset = url.searchParams.get("preset");
      if (
        !["balanced", "lossless", "author"].includes(preset ?? "") ||
        url.searchParams.getAll("preset").length !== 1
      )
        throw new HttpError(400, "unknownPreset");
      const mode = url.searchParams.get("mode") ?? "optimize";
      if (!["optimize", "inspect"].includes(mode) || url.searchParams.getAll("mode").length > 1)
        throw new HttpError(400, "unknownMode");
      await upload(req, res, preset as Preset, mode as UiMode);
      return;
    }
    const match = /^\/api\/jobs\/([a-f0-9-]{36})\/(download|json|html|cancel)$/.exec(url.pathname);
    if (!match || !current || current.id !== match[1]) throw new HttpError(404, "notFound");
    const job = current,
      action = match[2];
    if (req.method === "POST" && action === "cancel") {
      if (job.state !== "running") throw new HttpError(409, "cannotCancel");
      job.state = "cancelling";
      try {
        await job.worker!.stop();
        await job.finished;
        job.state = "cancelled";
        job.stage = "Cancelled";
      } finally {
        busy = false;
      }
      json(res, 200, view(job));
      return;
    }
    if (req.method !== "GET" || action === "cancel") throw new HttpError(405, "methodNotAllowed");
    if (
      busy ||
      (action === "download"
        ? job.state !== "success" || job.mode !== "optimize"
        : !job.result?.reports[action as "json" | "html"])
    )
      throw new HttpError(409, "notAvailable");
    const file = action === "download" ? "optimized.epub" : `report.${action}`;
    const stem = job.name.replace(/\.epub$/i, "");
    job.downloads++;
    let input;
    try {
      await owned(directory, owner);
      await owned(job.directory, job.owner);
      input = await fs.open(
        path.join(job.directory, file),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      const stat = await input.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new HttpError(409, "notAvailable");
      res.writeHead(200, {
        "Content-Type":
          action === "download"
            ? "application/epub+zip"
            : action === "json"
              ? "application/json"
              : "text/html; charset=utf-8",
        "Content-Disposition": attachment(
          action === "download"
            ? `${stem}-optimized.epub`
            : `${stem}-${job.mode === "inspect" ? "diagnosis" : "report"}.${action}`
        ),
        "Content-Length": stat.size,
      });
      await pipeline(input.createReadStream({ autoClose: false }), res);
    } finally {
      await input?.close();
      job.downloads--;
    }
  };
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    const request = handle(req, res).catch((error: unknown) => {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      res.setHeader("Connection", "close");
      json(res, error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.message : uiMessages.en.localError,
        code: error instanceof HttpError ? error.code : "localError",
      });
      res.once("finish", () => {
        if (!req.complete) req.destroy();
      });
    });
    requests.add(request);
    void request.then(
      () => requests.delete(request),
      () => requests.delete(request)
    );
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", resolve);
    });
  } catch (error) {
    await owned(directory, owner);
    await fs.rm(directory, { recursive: true });
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local listener.");
  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}`,
    directory,
    close: () =>
      (closed ??= (async () => {
        closing = true;
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        if (current?.worker && ["running", "cancelling"].includes(current.state)) {
          await current.worker.stop();
          await current.finished;
        }
        await Promise.allSettled([...requests]);
        await stopped;
        await owned(directory, owner);
        await fs.rm(directory, { recursive: true });
      })()),
  };
}
