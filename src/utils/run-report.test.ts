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
});
