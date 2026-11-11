import { afterEach, describe, expect, it, vi } from "vitest";
import { completePipelineReport, createPipelineReport, runReportedStep } from "./run-report.js";
import { reportError, reportInfo, reportWarning, reportWarningToStdout } from "./diagnostics.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pipeline report", () => {
  it("records successful step durations", async () => {
    const report = createPipelineReport({
      input: "in.epub",
      output: "out.epub",
      preset: "balanced",
      strict: false,
    });

    await runReportedStep(report, "example", false, async () => "done");
    completePipelineReport(report);

    expect(report.success).toBe(true);
    expect(report.steps[0]).toMatchObject({ name: "example", status: "success" });
  });

  it("keeps before/after content metrics in the structured report", () => {
    const report = createPipelineReport({
      input: "in.epub",
      output: "out.epub",
      preset: "balanced",
      strict: false,
    });
    const metrics = {
      manifestItems: 3,
      spineItems: 1,
      contentDocuments: 2,
      images: 1,
      navigationEntries: 1,
      internalReferences: 5,
      missingReferences: 0,
      missingReferenceTargets: [],
    };

    report.content = {
      before: metrics,
      after: metrics,
      integrity: { valid: true, checks: [], newMissingReferences: [], issues: [] },
    };

    expect(report.content.integrity?.valid).toBe(true);
    expect(report.content.after?.images).toBe(1);
  });

  it("turns warnings into failures in strict mode", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = createPipelineReport({
      input: "in.epub",
      output: "out.epub",
      preset: "balanced",
      strict: true,
    });

    await expect(
      runReportedStep(report, "warning step", true, async () => {
        reportWarning("recoverable warning");
      })
    ).rejects.toThrow("Strict mode rejected");

    expect(report.steps[0]).toMatchObject({ status: "failed" });
    expect(report.steps[0].messages).toContain("recoverable warning");
  });

  it("does not mistake words in filenames for processing warnings", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const report = createPipelineReport({
      input: "warning.epub",
      output: "failed.epub",
      preset: "lossless",
      strict: true,
    });
    await expect(
      runReportedStep(report, "Create EPUB", true, async () => {
        reportInfo("Created optimized EPUB: /books/warning.epub");
        reportInfo("Failed is part of this informational title, not a diagnostic");
        reportInfo("Extracted /books/failed.epub");
      })
    ).resolves.toBeUndefined();
    expect(report.steps[0]?.messages).toEqual([]);
  });

  it("still rejects processing errors in strict mode", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const report = createPipelineReport({
      input: "in.epub",
      output: "out.epub",
      preset: "balanced",
      strict: true,
    });
    await expect(
      runReportedStep(report, "example", true, () => reportError("processing error"))
    ).rejects.toThrow("Strict mode rejected");
  });

  it.each(["Warning: no cover spine item found", "⚠ Missing navigation", "Failed to update TOC"])(
    "keeps explicit legacy warning/error log labels: %s",
    async (message) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const report = createPipelineReport({
        input: "in.epub",
        output: "out.epub",
        preset: "author",
        strict: true,
      });
      await expect(
        runReportedStep(report, "Author workflow", true, () => reportWarningToStdout(message))
      ).rejects.toThrow("Strict mode rejected");
      expect(report.steps[0]?.messages).toContain(message);
    }
  );

  it("does not intercept console functions or unrelated console diagnostics", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const original = { log: console.log, warn: console.warn, error: console.error };
    const report = createPipelineReport({
      input: "in.epub",
      output: "out.epub",
      preset: "balanced",
      strict: true,
    });
    await runReportedStep(report, "unrelated logging", true, () => {
      expect(console.log).toBe(original.log);
      expect(console.warn).toBe(original.warn);
      expect(console.error).toBe(original.error);
      console.warn("third-party warning text");
      console.error("third-party error text");
      console.log("Warning: plain console output is not an optimizer diagnostic");
    });
    expect(report.steps[0]?.messages).toEqual([]);
    expect(console.log).toBe(original.log);
    expect(console.warn).toBe(original.warn);
    expect(console.error).toBe(original.error);
  });

  it("isolates overlapping runs that complete out of order", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let releaseA!: () => void;
    let releaseB!: () => void;
    const waitA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const waitB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const a = createPipelineReport({
      input: "a.epub",
      output: "a-out.epub",
      preset: "balanced",
      strict: true,
    });
    const b = createPipelineReport({
      input: "b.epub",
      output: "b-out.epub",
      preset: "balanced",
      strict: false,
    });
    const first = runReportedStep(a, "a step", true, async () => {
      await waitA;
    });
    const second = runReportedStep(b, "b step", false, async () => {
      reportWarning("only book B");
      await waitB;
    });
    releaseA();
    await first;
    releaseB();
    await second;
    expect(a.steps[0]).toMatchObject({ status: "success", messages: [] });
    expect(b.steps[0]).toMatchObject({ status: "success", messages: ["only book B"] });
  });

  it("keeps nested warnings visible to a strict enclosing operation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = createPipelineReport({
      input: "in.epub",
      output: "out.epub",
      preset: "author",
      strict: true,
    });
    await expect(
      runReportedStep(report, "outer", true, () =>
        runReportedStep(report, "inner", false, () => reportWarning("nested warning"))
      )
    ).rejects.toThrow("Strict mode rejected");
    expect(report.steps).toMatchObject([
      { name: "inner", status: "success", messages: ["nested warning"] },
      { name: "outer", status: "failed", messages: ["nested warning"] },
    ]);
  });

  it("stops collecting detached diagnostics after a step finishes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<void>;
    const report = createPipelineReport({
      input: "in.epub",
      output: "out.epub",
      preset: "balanced",
      strict: false,
    });
    await runReportedStep(report, "completed", false, () => {
      detached = wait.then(() => reportWarning("late warning"));
    });
    release();
    await detached;
    expect(report.steps[0]?.messages).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith("late warning");
  });
});
