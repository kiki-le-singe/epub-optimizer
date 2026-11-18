import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import type { Preset } from "../types.js";
import type { UiKey } from "./translations.js";

/** What the image quality guard measured, without any book-derived text. */
export interface UiImageQuality {
  /** Lossy encodes that were measured. */
  checked: number;
  /** Lowest SSIM among the encodes that were kept; null when none was kept. */
  lowestSsim: number | null;
  /** Images converted to WebP. */
  toWebp: number;
  /** Images re-encoded at higher quality after falling below the threshold. */
  fallback: number;
  /** Images left byte-for-byte unchanged because no encode was faithful enough. */
  keptOriginal: number;
}
export interface UiSummary {
  inputBytes: number;
  outputBytes: number;
  reductionPercent: number;
  errors: number;
  warnings: number;
  images?: UiImageQuality;
}

/** Counts guard outcomes from a pipeline report; undefined when the guard recorded nothing usable. */
export function summarizeImageQuality(imageQuality: unknown): UiImageQuality | undefined {
  const records = (imageQuality as { images?: unknown } | undefined)?.images;
  if (!Array.isArray(records)) return undefined;
  const summary: UiImageQuality = {
    checked: 0,
    lowestSsim: null,
    toWebp: 0,
    fallback: 0,
    keptOriginal: 0,
  };
  for (const record of records as Array<Record<string, unknown>>) {
    const { ssim, outcome, operation } = record ?? {};
    if (typeof ssim !== "number" || !(ssim >= 0 && ssim <= 1)) continue;
    if (outcome !== "accepted" && outcome !== "fallback" && outcome !== "kept-original") continue;
    summary.checked++;
    if (outcome === "kept-original") {
      summary.keptOriginal++;
      continue;
    }
    if (outcome === "fallback") summary.fallback++;
    if (operation === "to-webp") summary.toWebp++;
    summary.lowestSsim = Math.min(summary.lowestSsim ?? 1, ssim);
  }
  return summary.checked > 0 ? summary : undefined;
}
export type UiMode = "optimize" | "inspect";
/** Finding codes the interface can explain; other doctor codes stay in the JSON report. */
export const UI_FINDING_CODES = [
  "internal-dtd",
  "drm",
  "missing-references",
  "missing-epub3-nav",
  "image-heavy",
  "large-raster-images",
  "png-conversion-candidates",
  "webp-images",
  "a11y-missing-package-language",
  "a11y-documents-without-language",
  "a11y-images-without-text-alternative",
  "a11y-empty-alt",
  "a11y-missing-metadata",
  "a11y-page-breaks-without-page-list",
] as const;
export type UiFindingCode = (typeof UI_FINDING_CODES)[number];
/** Numbers and known codes only: no book-derived text reaches the page. */
export interface UiDiagnosis {
  blocked: boolean;
  codes: UiFindingCode[];
  archiveBytes: number;
  documents: number;
  missingReferences: number;
  images: {
    count: number;
    archivePercent: number | null;
    large: number;
    pngCandidates: number;
    webp: number;
  };
  accessibility: {
    documents: number;
    documentsWithoutLanguage: number;
    images: number;
    imagesWithoutTextAlternative: number;
    emptyAlt: number;
    missingMetadata: string[];
    pageBreaks: number;
  };
}
export interface UiResult {
  success: boolean;
  summary?: UiSummary;
  diagnosis?: UiDiagnosis;
  error?: string;
  errorCode?: UiKey;
  reports: { json: boolean; html: boolean };
}
export interface UiWorker {
  done: Promise<UiResult>;
  stop: () => Promise<void>;
}

async function availableReports(directory: string): Promise<{ json: boolean; html: boolean }> {
  const reports = { json: false, html: false };
  for (const [kind, file] of [
    ["json", "report.json"],
    ["html", "report.html"],
  ] as const) {
    const stat = await fs.lstat(path.join(directory, file)).catch(() => undefined);
    reports[kind] = !!stat?.isFile() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024;
  }
  return reports;
}

// The report is written by the worker inside the job directory: refuse links and oversized files.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJsonReport(directory: string): Promise<any> {
  const handle = await fs.open(
    path.join(directory, "report.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
      throw new Error("Unsafe report");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

/** Reduces a doctor report to the numbers and known codes shown by the interface. */
export async function readUiDiagnosis(
  directory: string,
  exitCode: number | null
): Promise<UiResult> {
  const reports = { json: (await availableReports(directory)).json, html: false };
  try {
    if (exitCode !== 0 || !reports.json) throw new Error("Missing diagnosis");
    const report = await readJsonReport(directory);
    const count = (value: unknown): number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const length = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
    if (typeof report?.analysisComplete !== "boolean" || count(report.archiveBytes) <= 0)
      throw new Error("Invalid diagnosis");
    const known = new Set<string>(UI_FINDING_CODES);
    const a11y = report.accessibility ?? {};
    const percent = report.images?.archivePercent;
    return {
      success: true,
      reports,
      diagnosis: {
        blocked: report.optimization?.blocked === true || !report.analysisComplete,
        codes: [
          ...(Array.isArray(report.risks) ? report.risks : []),
          ...(Array.isArray(a11y.issues) ? a11y.issues : []),
        ]
          .map((finding: { code?: unknown }) => finding?.code)
          .filter((code): code is UiFindingCode => typeof code === "string" && known.has(code)),
        archiveBytes: count(report.archiveBytes),
        documents: count(report.content?.contentDocuments),
        missingReferences: count(report.references?.missing),
        images: {
          count: count(report.images?.count),
          archivePercent:
            typeof percent === "number" && percent >= 0 && percent <= 100 ? percent : null,
          large: length(report.images?.largeRasterImages),
          pngCandidates: length(report.images?.opaquePngCandidates),
          webp: count(report.images?.byMediaType?.["image/webp"]?.count),
        },
        accessibility: {
          documents: count(a11y.language?.documents),
          documentsWithoutLanguage: length(a11y.language?.documentsWithoutLanguage),
          images: count(a11y.images?.total),
          imagesWithoutTextAlternative: count(a11y.images?.withoutTextAlternative),
          emptyAlt: count(a11y.images?.emptyAlt),
          missingMetadata: (
            ["accessMode", "accessibilityFeature", "accessibilityHazard"] as const
          ).filter((name) => length(a11y.metadata?.[name]) === 0),
          pageBreaks: count(a11y.pageNavigation?.pageBreaks),
        },
      },
    };
  } catch {
    return { success: false, errorCode: "analysisFailed", reports };
  }
}

export async function readUiReport(directory: string, exitCode: number | null): Promise<UiResult> {
  const reports = await availableReports(directory);
  try {
    if (!reports.json) throw new Error("Missing report");
    const report = await readJsonReport(directory);
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
        images: summarizeImageQuality(report.imageQuality),
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
  /** "inspect" runs the read-only doctor instead of optimizing. */
  mode?: UiMode;
  /** Opt-in WebP conversion; ignored by "inspect". */
  webp?: boolean;
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
  const pipeline =
    options.pipelinePath ?? fileURLToPath(new URL("../pipeline.js", import.meta.url));
  const inspect = options.mode === "inspect";
  const child = spawn(
    process.execPath,
    inspect
      ? [pipeline, "--doctor", "-i", "input.epub", "--report-json", "report.json"]
      : [
          pipeline,
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
          ...(options.webp ? ["--convert-webp"] : []),
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
    return inspect
      ? readUiDiagnosis(options.directory, code)
      : readUiReport(options.directory, code);
  });
  return { done, stop: () => stop("cancelled") };
}
