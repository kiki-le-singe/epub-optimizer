import { reportError, reportInfo } from "./utils/diagnostics.js";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Args } from "./types.js";
import { runOptimization } from "./optimization.js";
import {
  assertDistinctInputOutput,
  assertDistinctPathSet,
  assertSafeOutputTarget,
} from "./utils/output-transaction.js";
import { escapeHtml, htmlDocument } from "./utils/html-report.js";
import type { PipelineReport } from "./utils/run-report.js";
import { resolvePngBackground } from "./utils/pipeline-options.js";

export interface BatchItem {
  input: string;
  output: string;
  reportJson: string;
  reportHtml?: string;
  success: boolean;
  outputPublished: boolean;
  error?: string;
  sizes?: PipelineReport["sizes"];
}
export interface BatchReport {
  inputDirectory: string;
  outputDirectory: string;
  startedAt: string;
  completedAt?: string;
  success: boolean;
  total: number;
  succeeded: number;
  failed: number;
  books: BatchItem[];
}
interface BatchPlan {
  inputDirectory: string;
  outputDirectory: string;
  reportJson: string;
  reportHtml?: string;
  books: Array<Omit<BatchItem, "success" | "outputPublished">>;
}

export async function planBatch(args: Args): Promise<BatchPlan> {
  resolvePngBackground(args);
  if (!args.batch || !args.outputDir)
    throw new Error("Batch processing requires --batch and --output-dir.");
  if (args.watch) throw new Error("Batch cannot be combined with watch mode.");
  if (args.doctor || args.inspect) throw new Error("Batch processing supports optimization only.");
  const inputDirectory = path.resolve(args.batch),
    outputDirectory = path.resolve(args.outputDir);
  if (!(await fs.lstat(inputDirectory)).isDirectory())
    throw new Error("Batch input must be a real directory, not a symbolic link.");
  assertDistinctInputOutput(inputDirectory, outputDirectory);
  try {
    if (!(await fs.lstat(outputDirectory)).isDirectory())
      throw new Error("Batch output must be a real directory, not a symbolic link.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entries = await fs.readdir(inputDirectory, { withFileTypes: true });
  const inputs: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!/\.epub$/i.test(entry.name)) continue;
    if (entry.isSymbolicLink())
      throw new Error(`Refusing symbolic-link batch input: ${entry.name}`);
    if (entry.isFile()) inputs.push(path.join(inputDirectory, entry.name));
  }
  if (inputs.length === 0)
    throw new Error("No regular EPUB files found in the batch input directory.");
  const reportJson = path.resolve(
    args.reportJson ?? path.join(outputDirectory, "batch-report.json")
  );
  const reportHtml = args.reportHtml ? path.resolve(args.reportHtml) : undefined;
  const books = inputs.map((input) => {
    const stem = path.basename(input, path.extname(input));
    return {
      input,
      output: path.join(outputDirectory, `${stem}-optimized.epub`),
      reportJson: path.join(outputDirectory, "reports", `${stem}.json`),
      reportHtml: reportHtml ? path.join(outputDirectory, "reports", `${stem}.html`) : undefined,
    };
  });
  const paths = [
    ...inputs,
    reportJson,
    ...(reportHtml ? [reportHtml] : []),
    ...books.flatMap((book) => [
      book.output,
      book.reportJson,
      ...(book.reportHtml ? [book.reportHtml] : []),
    ]),
  ];
  assertDistinctPathSet(paths);
  // Validate the whole plan before creating directories, reports or outputs.
  for (const target of paths.slice(inputs.length)) await assertSafeOutputTarget(target);
  return { inputDirectory, outputDirectory, reportJson, reportHtml, books };
}

export function renderBatchReport(report: BatchReport): string {
  const e = escapeHtml;
  return htmlDocument(
    "EPUB batch report",
    `<header><p>EPUB Optimizer · batch</p><h1>Batch optimization report</h1><p>${e(report.inputDirectory)}</p></header><div class="cards"><div class="card">Books<strong>${report.total}</strong></div><div class="card">Completed<strong class="success">${report.succeeded}</strong></div><div class="card">Failed<strong class="failed">${report.failed}</strong></div></div><p>Started: ${e(report.startedAt)} · Completed: ${e(report.completedAt ?? "In progress")}</p><p>Output directory: <code>${e(report.outputDirectory)}</code></p><div class="table"><table><thead><tr><th>Book</th><th>Run result</th><th>Output published</th><th>Reduction</th><th>Diagnostic</th></tr></thead><tbody>${report.books.map((book) => `<tr><td>${e(path.basename(book.input))}</td><td class="${book.success ? "success" : "failed"}">${book.success ? "completed" : "failed"}</td><td>${book.outputPublished ? "yes" : "no"}</td><td>${book.sizes ? `${book.sizes.reductionPercent.toFixed(1)}%` : "—"}</td><td>${e(book.error ?? "—")}<br>JSON: <code>${e(book.reportJson)}</code>${book.reportHtml ? `<br>HTML: <code>${e(book.reportHtml)}</code>` : ""}</td></tr>`).join("")}</tbody></table></div><p>Books are processed sequentially. A failed run can still have published a validated output when a later cleanup or report operation failed; check the per-book report.</p>`
  );
}

export async function runBatch(args: Args): Promise<BatchReport> {
  const plan = await planBatch(args);
  const report: BatchReport = {
    inputDirectory: plan.inputDirectory,
    outputDirectory: plan.outputDirectory,
    startedAt: new Date().toISOString(),
    success: false,
    total: plan.books.length,
    succeeded: 0,
    failed: 0,
    books: [],
  };
  await fs.ensureDir(plan.outputDirectory);
  for (const book of plan.books) {
    reportInfo(
      `\n=== Batch book ${report.books.length + 1}/${plan.books.length}: ${path.basename(book.input)} ===`
    );
    const item: BatchItem = { ...book, success: false, outputPublished: false };
    let detail: PipelineReport | undefined;
    try {
      await runOptimization(
        {
          ...args,
          batch: undefined,
          outputDir: undefined,
          input: book.input,
          output: book.output,
          reportJson: book.reportJson,
          reportHtml: book.reportHtml,
          temp: path.join(os.tmpdir(), `epub-batch-${randomUUID()}`),
        },
        {
          onReport: (current) => {
            detail = current;
          },
        }
      );
      item.success = true;
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
      reportError(`Batch book failed: ${path.basename(book.input)}: ${item.error}`);
    }
    // Use the in-memory report from this invocation, never a stale file or old output.
    item.outputPublished =
      detail?.steps.some(
        (step) => step.name === "Publish validated EPUB" && step.status === "success"
      ) ?? false;
    item.sizes = detail?.sizes;
    if (item.success) report.succeeded++;
    else report.failed++;
    report.books.push(item);
  }
  report.completedAt = new Date().toISOString();
  report.success = report.failed === 0;
  await fs.ensureDir(path.dirname(plan.reportJson));
  await fs.writeJson(plan.reportJson, report, { spaces: 2 });
  if (plan.reportHtml) {
    await fs.ensureDir(path.dirname(plan.reportHtml));
    await fs.writeFile(plan.reportHtml, renderBatchReport(report), "utf8");
  }
  reportInfo(
    `Batch complete: ${report.succeeded}/${report.total} succeeded, ${report.failed} failed. Report: ${plan.reportJson}`
  );
  return report;
}
