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
