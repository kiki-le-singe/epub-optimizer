import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  collectWatchSummary,
  refreshWatchSummary,
  renderWatchSummary,
  writeWatchFile,
} from "./watch-summary.js";
let root: string;
const name = `book-${"a".repeat(16)}-${"b".repeat(64)}-${"c".repeat(16)}`;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "watch-summary-test-"));
});
afterEach(async () => {
  await fs.remove(root);
});
it("renders escaped diagnostics and fixed relative links without scripts", () => {
  const html = renderWatchSummary([
    {
      name: "<script>alert(1)</script>",
      job: name,
      success: false,
      outputPublished: false,
      error: '<img onerror="evil">',
    },
  ]);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img onerror");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain('href="' + name + '/optimized.epub"');
  expect(html).toContain("Failed");
});
it("reloads bounded records across restarts and ignores malformed data and symlink directories", async () => {
  const job = path.join(root, name);
  await fs.mkdir(job);
  await fs.writeJson(path.join(job, "watch-status.json"), {
    name: "book.epub",
    success: true,
    outputPublished: true,
    reductionPercent: 30,
  });
  expect(await collectWatchSummary(root)).toEqual([
    {
      name: "book.epub",
      job: name,
      success: true,
      outputPublished: true,
      reductionPercent: 30,
      error: undefined,
    },
  ]);
  await refreshWatchSummary(root);
  expect(await fs.readFile(path.join(root, "index.html"), "utf8")).toContain("30.0%");
  await fs.writeFile(path.join(job, "watch-status.json"), "invalid");
  expect(await collectWatchSummary(root)).toEqual([]);
});
it("refuses a symlink target and never truncates a hard-linked original", async () => {
  const original = path.join(root, "original");
  await fs.writeFile(original, "keep");
  const target = path.join(root, "index.html");
  await fs.symlink(original, target);
  await expect(writeWatchFile(target, "replace")).rejects.toThrow("unsafe");
  await fs.unlink(target);
  await fs.link(original, target);
  await writeWatchFile(target, "replace");
  expect(await fs.readFile(original, "utf8")).toBe("keep");
  expect(await fs.readFile(target, "utf8")).toBe("replace");
});
it("ignores oversized records and symlink records", async () => {
  const job = path.join(root, name);
  await fs.mkdir(job);
  const file = path.join(job, "watch-status.json");
  await fs.writeFile(file, " ".repeat(1024 * 1024 + 1));
  expect(await collectWatchSummary(root)).toEqual([]);
  await fs.unlink(file);
  await fs.writeJson(path.join(root, "foreign"), { name: "outside", success: true });
  await fs.symlink(path.join(root, "foreign"), file);
  expect(await collectWatchSummary(root)).toEqual([]);
});

it("reconstructs older jobs from reports and completion records", async () => {
  const job = path.join(root, name);
  await fs.mkdir(job);
  await fs.writeJson(path.join(job, "completed.json"), { input: "/private/inbox/Original.epub" });
  await fs.writeJson(path.join(job, "report.json"), {
    success: true,
    steps: [{ name: "Publish validated EPUB", status: "success" }],
    sizes: { reductionPercent: 20 },
  });
  expect(await collectWatchSummary(root)).toMatchObject([
    { name: "Original.epub", success: true, outputPublished: true, reductionPercent: 20 },
  ]);
});
