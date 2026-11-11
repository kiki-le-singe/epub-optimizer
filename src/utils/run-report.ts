import { collectDiagnostics, reportInfo } from "./diagnostics.js";
import fs from "fs-extra";
import path from "node:path";
import type { ResourceChange } from "./html-report.js";
import type { EpubCheckReport } from "./epubcheck-report.js";
import type { Preset } from "../types.js";
import type { EpubContentMetrics, EpubIntegrityComparison } from "./epub-integrity.js";

export type StepStatus = "success" | "skipped" | "failed";

export interface StepReport {
  name: string;
  status: StepStatus;
  durationMs: number;
  messages: string[];
  error?: string;
}

export interface PipelineReport {
  input: string;
  output: string;
  preset: Preset;
  strict: boolean;
  success: boolean;
  startedAt: string;
  tempDir?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  sizes?: {
    inputBytes: number;
    outputBytes: number;
    savedBytes: number;
    reductionPercent: number;
  };
  content?: {
    before?: EpubContentMetrics;
    after?: EpubContentMetrics;
    integrity?: EpubIntegrityComparison;
  };
  resources?: ResourceChange[];
  validation?: EpubCheckReport;
  steps: StepReport[];
}

export function createPipelineReport(options: {
  input: string;
  output: string;
  preset: Preset;
  strict: boolean;
}): PipelineReport {
  return {
    ...options,
    success: false,
    startedAt: new Date().toISOString(),
    steps: [],
  };
}

export function recordSkippedStep(report: PipelineReport, name: string, reason: string): void {
  report.steps.push({
    name,
    status: "skipped",
    durationMs: 0,
    messages: [reason],
  });
}

export async function runReportedStep<T>(
  report: PipelineReport,
  name: string,
  strict: boolean,
  operation: () => Promise<T> | T
): Promise<T> {
  const startedAt = performance.now();
  const messages: string[] = [];
  try {
    const result = await collectDiagnostics(operation, (diagnostic) => {
      messages.push(diagnostic.message);
    });
    if (strict && messages.length > 0) {
      throw new Error(`Strict mode rejected ${messages.length} warning/error message(s).`);
    }
    report.steps.push({
      name,
      status: "success",
      durationMs: performance.now() - startedAt,
      messages,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.steps.push({
      name,
      status: "failed",
      durationMs: performance.now() - startedAt,
      messages,
      error: message,
    });
    throw error;
  }
}

export function completePipelineReport(report: PipelineReport, error?: unknown): void {
  const completedAt = new Date();
  report.completedAt = completedAt.toISOString();
  report.durationMs = completedAt.getTime() - new Date(report.startedAt).getTime();
  report.success = error === undefined;
  if (error !== undefined) {
    report.error = error instanceof Error ? error.message : String(error);
  }
}

export async function writePipelineReport(
  report: PipelineReport,
  reportPath: string
): Promise<void> {
  const absolutePath = path.resolve(reportPath);
  await fs.ensureDir(path.dirname(absolutePath));
  await fs.writeJson(absolutePath, report, { spaces: 2 });
  reportInfo(`Wrote JSON report: ${absolutePath}`);
}

export function printProfile(report: PipelineReport): void {
  reportInfo("\n=== Profile ===");
  for (const step of report.steps) {
    reportInfo(`${step.name}: ${step.status} (${step.durationMs.toFixed(0)} ms)`);
  }
  reportInfo(`Total: ${(report.durationMs ?? 0).toFixed(0)} ms`);
}
