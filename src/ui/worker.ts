import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import type { Preset } from "../types.js";
import type { UiKey } from "./translations.js";

export interface UiSummary {
  inputBytes: number;
  outputBytes: number;
  reductionPercent: number;
  errors: number;
  warnings: number;
}
export interface UiResult {
  success: boolean;
  summary?: UiSummary;
  error?: string;
  errorCode?: UiKey;
  reports: { json: boolean; html: boolean };
}
export interface UiWorker {
  done: Promise<UiResult>;
  stop: () => Promise<void>;
}

export async function readUiReport(directory: string, exitCode: number | null): Promise<UiResult> {
  const reports = { json: false, html: false };
  for (const [kind, file] of [
    ["json", "report.json"],
    ["html", "report.html"],
  ] as const) {
    const stat = await fs.lstat(path.join(directory, file)).catch(() => undefined);
    reports[kind] = !!stat?.isFile() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024;
  }
  try {
    if (!reports.json) throw new Error("Missing report");
    const handle = await fs.open(
      path.join(directory, "report.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    let report;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
        throw new Error("Unsafe report");
      report = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
    const output = await fs.lstat(path.join(directory, "optimized.epub")).catch(() => undefined);
    const totals = report.validation?.totals;
    const sizes = report.sizes;
    if (
      exitCode !== 0 ||
      report.success !== true ||
      report.content?.integrity?.valid !== true ||
      report.validation?.exitCode !== 0 ||
      !totals ||
      totals.fatals !== 0 ||
      totals.errors !== 0 ||
      totals.warnings !== 0 ||
      !output?.isFile() ||
      output.nlink !== 1 ||
      !sizes ||
      !Number.isSafeInteger(sizes.inputBytes) ||
      sizes.inputBytes <= 0 ||
      sizes.outputBytes !== output.size ||
      output.size <= 0 ||
      !Number.isFinite(sizes.reductionPercent)
    ) {
      const message =
        typeof report.error === "string"
          ? report.error.split(directory).join("[livre]").slice(0, 1500)
          : undefined;
      return { success: false, errorCode: "processingFailed", error: message, reports };
    }
    return {
      success: true,
      reports,
      summary: {
        inputBytes: sizes.inputBytes,
        outputBytes: sizes.outputBytes,
        reductionPercent: sizes.reductionPercent,
        errors: totals.errors,
        warnings: totals.warnings,
      },
    };
  } catch {
    return { success: false, errorCode: "processingFailed", reports };
  }
}

/** Isolate the existing CLI and its Java/font children from the HTTP event loop. */
export function runUiWorker(options: {
  directory: string;
  preset: Preset;
  onStage: (name: string) => void;
  pipelinePath?: string;
  timeoutMs?: number;
  killGraceMs?: number;
}): UiWorker {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "JAVA_HOME",
    "EPUBCHECK_PATH",
    "LANG",
    "LC_ALL",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, {
    HOME: options.directory,
    TMPDIR: options.directory,
    TMP: options.directory,
    TEMP: options.directory,
  });
  const child = spawn(
    process.execPath,
    [
      options.pipelinePath ?? fileURLToPath(new URL("../pipeline.js", import.meta.url)),
      "-i",
      "input.epub",
      "-o",
      "optimized.epub",
      "--preset",
      options.preset,
      "--strict",
      "--clean",
      "--image-concurrency",
      "1",
      "--report-json",
      "report.json",
      "--report-html",
      "report.html",
    ],
    {
      cwd: options.directory,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let reason: UiKey | undefined;
  let stopping: Promise<void> | undefined;
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
  const signal = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const stop = (message: UiKey): Promise<void> => {
    if (!stopping) {
      reason = message;
      stopping = (async () => {
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            timeout: 5000,
            stdio: "ignore",
          });
          child.kill();
          await closed;
          return;
        }
        signal("SIGTERM");
        // The leader can exit before Java/font descendants; finish the group too.
        await delay(options.killGraceMs ?? 1000);
        signal("SIGKILL");
        await closed;
      })();
    }
    return stopping;
  };
  const decoder = new StringDecoder("utf8");
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop()!.slice(-4096);
    for (const line of lines) {
      const stage = /^=== ([\w /-]{1,80}) ===$/.exec(line);
      if (stage) options.onStage(stage[1]!);
    }
  });
  // Drain diagnostics without retaining unbounded or untrusted console output.
  child.stderr.resume();
  const timer = setTimeout(
    () => {
      void stop("timeout").catch(() => undefined);
    },
    options.timeoutMs ?? 15 * 60_000
  );
  const done = closed.then(async (code) => {
    clearTimeout(timer);
    if (stopping) await stopping;
    if (reason) return { success: false, errorCode: reason, reports: { json: false, html: false } };
    return readUiReport(options.directory, code);
  });
  return { done, stop: () => stop("cancelled") };
}
