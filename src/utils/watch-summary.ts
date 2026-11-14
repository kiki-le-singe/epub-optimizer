import fs from "fs-extra";
import path from "node:path";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { escapeHtml, htmlDocument } from "./html-report.js";

export interface WatchSummaryItem {
  name: string;
  job: string;
  success: boolean;
  outputPublished: boolean;
  error?: string;
  reductionPercent?: number;
}

async function readRecord(file: string): Promise<Record<string, unknown> | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > 1024 * 1024) return undefined;
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export async function collectWatchSummary(output: string): Promise<WatchSummaryItem[]> {
  const items: WatchSummaryItem[] = [];
  for (const entry of await fs.readdir(output, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !/^[a-zA-Z0-9_-]+-[a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{16}$/.test(entry.name)
    )
      continue;
    const job = path.join(output, entry.name);
    let record = await readRecord(path.join(job, "watch-status.json"));
    if (!record) {
      const report = await readRecord(path.join(job, "report.json"));
      const completion = await readRecord(path.join(job, "completed.json"));
      if (report && typeof report.success === "boolean") {
        const sizes =
          report.sizes !== null && typeof report.sizes === "object"
            ? (report.sizes as Record<string, unknown>)
            : undefined;
        record = {
          name:
            typeof completion?.input === "string"
              ? path.basename(completion.input)
              : entry.name.replace(/-[a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{16}$/, ""),
          success: report.success,
          error: report.error,
          reductionPercent: sizes?.reductionPercent,
          outputPublished:
            Array.isArray(report.steps) &&
            report.steps.some(
              (step: unknown) =>
                step !== null &&
                typeof step === "object" &&
                "name" in step &&
                step.name === "Publish validated EPUB" &&
                "status" in step &&
                step.status === "success"
            ),
        };
      }
    }
    if (!record || typeof record.name !== "string" || typeof record.success !== "boolean") continue;
    items.push({
      name: record.name.slice(0, 1024),
      job: entry.name,
      success: record.success,
      outputPublished: record.outputPublished === true,
      error: typeof record.error === "string" ? record.error.slice(0, 4096) : undefined,
      reductionPercent:
        typeof record.reductionPercent === "number" && Number.isFinite(record.reductionPercent)
          ? record.reductionPercent
          : undefined,
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name) || a.job.localeCompare(b.job));
}

export function renderWatchSummary(items: WatchSummaryItem[]): string {
  const e = escapeHtml;
  const rows = items
    .map((item) => {
      const link = (file: string, label: string) =>
        `<a href="${e(encodeURIComponent(item.job) + "/" + file)}">${label}</a>`;
      return `<tr><td>${e(item.name)}</td><td>${item.success ? "Completed" : "Failed"}</td><td>${item.reductionPercent === undefined ? "—" : `${item.reductionPercent.toFixed(1)}%`}</td><td>${item.outputPublished ? link("optimized.epub", "EPUB") : "—"} · ${link("report.html", "HTML report")} · ${link("report.json", "JSON report")}</td><td>${e(item.error ?? "—")}</td></tr>`;
    })
    .join("");
  return htmlDocument(
    "Watched-folder results",
    `<header><p>EPUB Optimizer · watched folder</p><h1>Watched-folder results</h1></header><p>${items.filter((i) => i.success).length} completed · ${items.filter((i) => !i.success).length} failed</p><p>Updated ${e(new Date().toISOString())}. Refresh this page after processing. Separate rows can represent different versions or settings of the same book.</p><div class="table"><table><thead><tr><th>Book</th><th>Result</th><th>Reduction</th><th>Files</th><th>Diagnostic</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No recorded results yet.</td></tr>'}</tbody></table></div><p>A failed run may still have published a validated EPUB if a later reporting or cleanup step failed. Inspect the detailed report. An unchanged failure is retried after changing the input or restarting the watcher.</p>`
  );
}

/** Rename a private sibling rather than truncating an existing file or hard-link alias. */
export async function writeWatchFile(file: string, content: string): Promise<void> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error("Refusing unsafe watch summary target");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(path.dirname(file), `.watch-summary-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o644);
  const owner = await handle.stat();
  try {
    await handle.writeFile(content);
    await handle.close();
    await fs.rename(temporary, file);
  } finally {
    await handle.close();
    await removeOwnedTemporary(temporary, owner.dev, owner.ino);
  }
}

export async function refreshWatchSummary(output: string): Promise<void> {
  await writeWatchFile(
    path.join(output, "index.html"),
    renderWatchSummary(await collectWatchSummary(output))
  );
}

async function removeOwnedTemporary(file: string, dev: number, ino: number): Promise<void> {
  try {
    const current = await fs.lstat(file);
    if (current.dev === dev && current.ino === ino && current.isFile()) await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
