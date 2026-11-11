import { reportInfo } from "./diagnostics.js";
import fs from "fs-extra";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { collectFiles, forEachFileLimited } from "./files.js";
import { TEMP_DIR_MARKER } from "./temp-dir.js";
import type { PipelineReport } from "./run-report.js";

export interface ResourceSnapshot {
  bytes: number;
  digest: string;
}
export interface ResourceChange {
  path: string;
  status: "unchanged" | "modified" | "added" | "removed";
  beforeBytes?: number;
  afterBytes?: number;
}

export async function snapshotResources(root: string): Promise<Map<string, ResourceSnapshot>> {
  const result = new Map<string, ResourceSnapshot>();
  await forEachFileLimited(
    await collectFiles(root, (file) => path.relative(root, file) !== TEMP_DIR_MARKER),
    async (file) => {
      if (!(await fs.lstat(file)).isFile()) return;
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(file)) {
        bytes += chunk.length;
        hash.update(chunk);
      }
      result.set(path.relative(root, file).split(path.sep).join("/"), {
        bytes,
        digest: hash.digest("hex"),
      });
    }
  );
  return result;
}

export function compareResources(
  before: Map<string, ResourceSnapshot>,
  after: Map<string, ResourceSnapshot>
): ResourceChange[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((file) => {
    const a = before.get(file),
      b = after.get(file);
    return {
      path: file,
      status: !a ? "added" : !b ? "removed" : a.digest === b.digest ? "unchanged" : "modified",
      beforeBytes: a?.bytes,
      afterBytes: b?.bytes,
    };
  });
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string
  );
}
function bytes(value: number | undefined): string {
  if (value === undefined) return "—";
  return `${(value / 1024).toLocaleString("en", { maximumFractionDigits: 1 })} KiB`;
}

export function htmlDocument(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>
body{margin:0;background:#f4f6fa;color:#19253b;font:16px/1.6 system-ui,sans-serif}main{max-width:1080px;margin:40px auto;padding:0 24px 48px}header{padding:28px;background:#172a45;color:white;border-radius:16px}h1{margin:0 0 8px;font-size:32px}h2{margin-top:32px}p{overflow-wrap:anywhere}.cards{display:flex;flex-wrap:wrap;gap:16px;margin:24px 0}.card{flex:1;min-width:160px;padding:20px;background:white;border:1px solid #dce2eb;border-radius:12px}.card strong{display:block;font-size:24px}.table{overflow-x:auto;background:white;border:1px solid #dce2eb;border-radius:12px}table{border-collapse:collapse;width:100%}th,td{padding:12px 16px;text-align:left;border-bottom:1px solid #e6eaf0;vertical-align:top}td:first-child{overflow-wrap:anywhere;max-width:480px}th{background:#eaf0f8}.success{color:#146744}.failed{color:#a32535}.skipped{color:#646b78}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}.validation-diagnostics th:last-child,.validation-diagnostics td:last-child{min-width:220px}details{margin:8px 0}li{overflow-wrap:anywhere}@media(max-width:600px){main{padding:0 12px}header{padding:20px}h1{font-size:25px}}@media print{body{background:white}main{margin:0}header{color:#19253b;background:white;border:1px solid #ddd}details{display:block}}
</style></head><body><main>${content}</main></body></html>`;
}

function renderValidationDiagnostics(validation: PipelineReport["validation"]): string {
  if (!validation) return "";
  const e = escapeHtml;
  const totals = validation.totals;
  const summary = totals
    ? `Fatal: ${e(totals.fatals)} · Errors: ${e(totals.errors)} · Warnings: ${e(totals.warnings)} · Informational: ${e(totals.infos)}`
    : "Message totals unavailable.";
  const rows = validation.messages
    .map((message) => {
      const locations = message.locations
        .map((location) => {
          const position = `${location.path}${location.line === undefined ? "" : `:${location.line}${location.column === undefined ? "" : `:${location.column}`}`}`;
          return `<p><code>${e(position)}</code></p>${location.context === undefined ? "" : `<pre>${e(location.context)}</pre>`}`;
        })
        .join("");
      return `<tr><td>${e(message.severity)}<br><code>${e(message.code)}</code></td><td>${e(message.message)}${message.suggestion ? `<p>${e(message.suggestion)}</p>` : ""}</td><td>${locations || "—"}${message.additionalLocations ? `<p>${e(message.additionalLocations)} additional locations not listed.</p>` : ""}</td></tr>`;
    })
    .join("");
  return `<h2>EPUBCheck diagnostics</h2><p>Version: ${e(validation.checkerVersion ?? "unavailable")} · Diagnostic source: ${e(validation.source)} · Exit code: ${e(validation.exitCode ?? "unavailable")}</p><p>${summary}</p>${validation.diagnosticsError ? `<p class="failed">${e(validation.diagnosticsError)}</p>` : ""}${rows ? `<div class="table"><table class="validation-diagnostics"><thead><tr><th>Severity / code</th><th>Message / suggestion</th><th>Locations / context</th></tr></thead><tbody>${rows}</tbody></table></div>` : "<p>No detailed messages returned.</p>"}<p>EPUBCheck groups repeated diagnostics and limits reported locations. Totals may exceed the detailed entries shown.</p>`;
}

export function renderHtmlReport(report: PipelineReport): string {
  const e = escapeHtml;
  const validation = report.steps.find((step) => step.name === "Validate candidate EPUB");
  const published = report.steps.some(
    (step) => step.name === "Publish validated EPUB" && step.status === "success"
  );
  const rows = report.steps
    .map(
      (step) =>
        `<tr><td>${e(step.name)}</td><td class="${e(step.status)}">${e(step.status)}</td><td>${(step.durationMs / 1000).toFixed(2)} s</td><td>${[...step.messages, ...(step.error ? [step.error] : [])].map((message) => `<p>${e(message)}</p>`).join("") || "—"}</td></tr>`
    )
    .join("");
  const resources = report.resources;
  const counts = resources
    ? ["modified", "unchanged", "added", "removed"]
        .map((status) => `${resources.filter((item) => item.status === status).length} ${status}`)
        .join(" · ")
    : "Resource comparison unavailable: processing did not reach the comparison stage.";
  const resourceTable = resources
    ? `<div class="table"><table><thead><tr><th>Resource</th><th>Result</th><th>Before</th><th>After</th></tr></thead><tbody>${resources.map((item) => `<tr><td>${e(item.path)}</td><td>${e(item.status === "removed" ? "removed / replaced" : item.status)}</td><td>${bytes(item.beforeBytes)}</td><td>${bytes(item.afterBytes)}</td></tr>`).join("")}</tbody></table></div>`
    : "";
  const integrity = report.content?.integrity;
  const diagnostics = renderValidationDiagnostics(report.validation);
  return htmlDocument(
    "EPUB optimization report",
    `<header><p>EPUB Optimizer · ${e(report.preset)}</p><h1>Optimization report</h1><p>${e(path.basename(report.input))}</p></header><div class="cards"><div class="card">Run result<strong class="${report.success ? "success" : "failed"}">${report.success ? "Completed" : "Failed"}</strong></div><div class="card">Archive size<strong>${bytes(report.sizes?.inputBytes)} → ${bytes(report.sizes?.outputBytes)}</strong></div><div class="card">Size reduction<strong>${report.sizes ? `${report.sizes.reductionPercent.toFixed(1)}%` : "Unavailable"}</strong></div></div><h2>Validation and output</h2><p>EPUBCheck: <strong>${e(validation?.status ?? "not run")}</strong> · Output publication: <strong>${published ? "completed" : "not completed"}</strong> · Content integrity: <strong>${integrity ? (integrity.valid ? "passed" : "failed") : "not checked"}</strong></p>${diagnostics}${report.error ? `<p class="failed">${e(report.error)}</p>` : ""}<p>Input: <code>${e(report.input)}</code><br>Output: <code>${e(report.output)}</code></p><p>Started: ${e(report.startedAt)} · Duration: ${((report.durationMs ?? 0) / 1000).toFixed(2)} s · Strict mode: ${report.strict ? "yes" : "no"}</p><h2>Transformations and diagnostics</h2><div class="table"><table><thead><tr><th>Step</th><th>Result</th><th>Time</th><th>Messages / skipped reasons</th></tr></thead><tbody>${rows}</tbody></table></div><h2>Resources before and after</h2><p>${e(counts)}</p><p>Byte changes describe extracted resources. PNG-to-JPEG conversion may appear as a removed resource and an added resource. Unchanged bytes do not certify rendering quality.</p>${resourceTable}<footer><p>Generated locally. This report contains paths and diagnostics from this run.</p></footer>`
  );
}

export async function writeHtmlReport(report: PipelineReport, target: string): Promise<void> {
  await fs.ensureDir(path.dirname(path.resolve(target)));
  await fs.writeFile(target, renderHtmlReport(report), "utf8");
  reportInfo(`Wrote HTML report: ${path.resolve(target)}`);
}
