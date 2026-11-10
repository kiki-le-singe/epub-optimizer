import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { planBatch, renderBatchReport, runBatch } from "./batch.js";
import { runOptimization } from "./optimization.js";
import type { Args } from "./types.js";
vi.mock("./optimization.js", () => ({ runOptimization: vi.fn() }));
let root: string;
let args: Args;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-batch-test-"));
  await fs.ensureDir(path.join(root, "input"));
  args = {
    batch: path.join(root, "input"),
    outputDir: path.join(root, "out"),
    input: "unused.epub",
    output: "unused-out.epub",
    preset: "lossless",
    clean: true,
    strict: false,
  } as Args;
  vi.mocked(runOptimization).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(root);
});
describe("batch optimization", () => {
  it("plans only top-level regular EPUBs in stable order without writes", async () => {
    await fs.writeFile(path.join(args.batch!, "b.EPUB"), "book");
    await fs.writeFile(path.join(args.batch!, "a.epub"), "book");
    await fs.writeFile(path.join(args.batch!, "notes.txt"), "notes");
    await fs.ensureDir(path.join(args.batch!, "nested.epub"));
    const plan = await planBatch(args);
    expect(plan.books.map((book) => path.basename(book.input))).toEqual(["a.epub", "b.EPUB"]);
    expect(await fs.pathExists(args.outputDir!)).toBe(false);
  });
  it("continues after a failed book and records only this invocation's publication state", async () => {
    for (const name of ["a.epub", "b.epub", "c.epub"])
      await fs.writeFile(path.join(args.batch!, name), name);
    args.reportHtml = path.join(root, "summary.html");
    const temps: string[] = [];
    vi.mocked(runOptimization).mockImplementation(async (book, options) => {
      temps.push(book.temp);
      await fs.ensureDir(path.dirname(book.reportJson!));
      const failed = path.basename(book.input) === "b.epub";
      const detail = {
        input: book.input,
        output: book.output,
        startedAt: new Date().toISOString(),
        steps: failed ? [] : [{ name: "Publish validated EPUB", status: "success" }],
      };
      options?.onReport?.(detail as import("./utils/run-report.js").PipelineReport);
      if (failed) throw new Error("<script>blocked</script>");
    });
    const report = await runBatch(args);
    expect(report).toMatchObject({ success: false, total: 3, succeeded: 2, failed: 1 });
    expect(report.books.map((book) => book.outputPublished)).toEqual([true, false, true]);
    expect(new Set(temps).size).toBe(3);
    expect((await fs.readJson(path.join(args.outputDir!, "batch-report.json"))).failed).toBe(1);
    const html = await fs.readFile(args.reportHtml, "utf8");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(renderBatchReport(report)).toContain("Batch optimization report");
  });
  it("rejects symlink inputs, aliases and empty batches before any processing", async () => {
    await expect(runBatch(args)).rejects.toThrow("No regular EPUB");
    const input = path.join(args.batch!, "a.epub");
    await fs.writeFile(input, "original");
    await fs.symlink(input, path.join(args.batch!, "link.epub"));
    await expect(runBatch(args)).rejects.toThrow("symbolic-link");
    await fs.remove(path.join(args.batch!, "link.epub"));
    await fs.ensureDir(args.outputDir!);
    await fs.link(input, path.join(args.outputDir!, "a-optimized.epub"));
    await expect(runBatch(args)).rejects.toThrow("alias");
    expect(await fs.readFile(input, "utf8")).toBe("original");
    expect(runOptimization).not.toHaveBeenCalled();
  });
  it("rejects collisions between summary and per-book reports and nested file targets", async () => {
    await fs.writeFile(path.join(args.batch!, "a.epub"), "book");
    args.reportJson = path.join(args.outputDir!, "reports", "a.json");
    await expect(runBatch(args)).rejects.toThrow("distinct");
    args.reportJson = path.join(args.outputDir!, "a-optimized.epub", "summary.json");
    await expect(runBatch(args)).rejects.toThrow("parent directory");
    expect(await fs.pathExists(args.outputDir!)).toBe(false);
  });
  it("reports success only when all books succeed", async () => {
    await fs.writeFile(path.join(args.batch!, "a.epub"), "book");
    vi.mocked(runOptimization).mockResolvedValue(undefined);
    expect((await runBatch(args)).success).toBe(true);
    expect(runOptimization).toHaveBeenCalledWith(
      expect.objectContaining({ batch: undefined, preset: "lossless", clean: true }),
      expect.objectContaining({ onReport: expect.any(Function) })
    );
  });
  it("does not mistake an old future-dated report for this invocation", async () => {
    await fs.writeFile(path.join(args.batch!, "a.epub"), "book");
    await fs.ensureDir(path.join(args.outputDir!, "reports"));
    await fs.writeJson(path.join(args.outputDir!, "reports", "a.json"), {
      startedAt: "9999-01-01T00:00:00Z",
      steps: [{ name: "Publish validated EPUB", status: "success" }],
    });
    vi.mocked(runOptimization).mockRejectedValue(new Error("preflight failure"));
    expect((await runBatch(args)).books[0]?.outputPublished).toBe(false);
  });
});
