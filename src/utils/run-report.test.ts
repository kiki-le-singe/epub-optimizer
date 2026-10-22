import { afterEach, describe, expect, it, vi } from "vitest";
import { completePipelineReport, createPipelineReport, runReportedStep } from "./run-report.js";

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
        console.warn("recoverable warning");
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
        console.log("Created optimized EPUB: /books/warning.epub");
        console.log("Extracted /books/failed.epub");
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
      runReportedStep(report, "example", true, () => console.error("processing error"))
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
        runReportedStep(report, "Author workflow", true, () => console.log(message))
      ).rejects.toThrow("Strict mode rejected");
      expect(report.steps[0]?.messages).toContain(message);
    }
  );
});
