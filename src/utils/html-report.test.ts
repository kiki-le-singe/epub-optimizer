import { afterEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  compareResources,
  renderHtmlReport,
  snapshotResources,
  writeHtmlReport,
} from "./html-report.js";
import { createPipelineReport } from "./run-report.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.remove(dir)));
});
describe("HTML optimization reports", () => {
  it("escapes untrusted filenames, paths and diagnostics without active embedded content", () => {
    const payload = '<script>alert("x")</script><img src="https://example.invalid/a">';
    const report = createPipelineReport({
      input: payload,
      output: payload,
      preset: "balanced",
      strict: false,
    });
    report.error = payload;
    report.steps.push({ name: payload, status: "failed", durationMs: 5, messages: [payload] });
    report.resources = [{ path: payload, status: "modified", beforeBytes: 100, afterBytes: 50 }];
    const html = renderHtmlReport(report);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img ");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("not run");
    expect(html).toContain("not completed");
  });
  it("distinguishes a validated published output from later cleanup failure", () => {
    const report = createPipelineReport({
      input: "book.epub",
      output: "out.epub",
      preset: "lossless",
      strict: true,
    });
    report.steps = [
      { name: "Validate candidate EPUB", status: "success", durationMs: 100, messages: [] },
      { name: "Publish validated EPUB", status: "success", durationMs: 5, messages: [] },
    ];
    const html = renderHtmlReport(report);
    expect(html).toContain("Failed");
    expect(html).toContain("Output publication: <strong>completed</strong>");
    expect(html).toContain("EPUBCheck: <strong>success</strong>");
  });
  it("compares resource bytes and content while excluding ownership markers and symlinks", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "epub-html-"));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, "same.txt"), "same");
    await fs.writeFile(path.join(dir, "changed.txt"), "before");
    await fs.writeFile(path.join(dir, "removed.png"), "png");
    await fs.symlink(path.join(dir, "same.txt"), path.join(dir, "link"));
    const before = await snapshotResources(dir);
    await fs.writeFile(path.join(dir, "changed.txt"), "after!");
    await fs.remove(path.join(dir, "removed.png"));
    await fs.writeFile(path.join(dir, "added.jpg"), "jpeg");
    const changes = compareResources(before, await snapshotResources(dir));
    expect(changes.map((item) => [item.path, item.status])).toEqual([
      ["added.jpg", "added"],
      ["changed.txt", "modified"],
      ["removed.png", "removed"],
      ["same.txt", "unchanged"],
    ]);
    const report = createPipelineReport({
      input: "book.epub",
      output: "out.epub",
      preset: "balanced",
      strict: false,
    });
    report.resources = changes;
    const target = path.join(dir, "reports", "report.html");
    await writeHtmlReport(report, target);
    expect(await fs.readFile(target, "utf8")).toContain("1 modified");
  });
});
