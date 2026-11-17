import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { waitForWatchOverview } from "../../scripts/watch-e2e-readiness.js";

let output: string;
beforeEach(async () => {
  output = await fs.mkdtemp(path.join(os.tmpdir(), "epub-summary-ready-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(output, { recursive: true, force: true });
});

it("does not accept a completion record or stale HTML before the book links are published", async () => {
  await fs.mkdir(path.join(output, "job"));
  await fs.writeFile(path.join(output, "job", "completed.json"), "{}");
  await fs.writeFile(path.join(output, "index.html"), "No recorded results yet.");
  const reads = vi.spyOn(fs, "readFile");
  let settled = false;
  const waiting = waitForWatchOverview(output, ["book.epub", "optimized.epub"], {
    timeoutMs: 3000,
    pollIntervalMs: 5,
  }).then(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(reads).toHaveBeenCalled());
    await reads.mock.results[0].value;
    expect(settled).toBe(false);
    // A partially updated summary is insufficient too.
    await fs.writeFile(path.join(output, "index.html"), "book.epub");
    const nextRead = reads.mock.calls.length + 1;
    await vi.waitFor(() => expect(reads.mock.calls.length).toBeGreaterThanOrEqual(nextRead));
    await reads.mock.results.at(-1)!.value;
    expect(settled).toBe(false);
    await fs.writeFile(
      path.join(output, "pending.html"),
      'book.epub <a href="job/optimized.epub">EPUB</a>'
    );
    await fs.rename(path.join(output, "pending.html"), path.join(output, "index.html"));
    await waiting;
    expect(settled).toBe(true);
  } finally {
    // Ensure even a failed assertion cannot leave polling or temp-file I/O alive.
    await fs.writeFile(path.join(output, "index.html"), "book.epub optimized.epub");
    await waiting;
  }
});

it("waits through an initially missing index and requires failed-book details too", async () => {
  const reads = vi.spyOn(fs, "readFile");
  const waiting = waitForWatchOverview(output, ["book.epub", "broken.epub", "optimized.epub"], {
    timeoutMs: 3000,
    pollIntervalMs: 5,
  });
  try {
    await vi.waitFor(() => expect(reads).toHaveBeenCalled());
  } finally {
    await fs.writeFile(path.join(output, "index.html"), "book.epub broken.epub optimized.epub");
    await waiting;
  }
});

it("fails with missing links and container diagnostics when a summary never catches up", async () => {
  await fs.writeFile(path.join(output, "index.html"), "book.epub");
  const logs = vi.fn(() => "watcher diagnostics");
  await expect(
    waitForWatchOverview(output, ["book.epub", "optimized.epub"], {
      timeoutMs: 20,
      pollIntervalMs: 1,
      logs,
    })
  ).rejects.toThrow(/missing: optimized\.epub\.\nwatcher diagnostics/);
  expect(logs).toHaveBeenCalledOnce();
});

it("does not retry permission errors as delayed publication", async () => {
  const error = Object.assign(new Error("access denied"), { code: "EACCES" });
  const reads = vi.spyOn(fs, "readFile").mockRejectedValue(error);
  await expect(waitForWatchOverview(output, ["book.epub"])).rejects.toBe(error);
  expect(reads).toHaveBeenCalledOnce();
});
