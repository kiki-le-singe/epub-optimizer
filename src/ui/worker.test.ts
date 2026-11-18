import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readUiDiagnosis, readUiReport, runUiWorker } from "./worker.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "epub-ui-worker-test-"));
  roots.push(dir);
  await fs.writeFile(path.join(dir, "optimized.epub"), "output");
  const report = {
    success: true,
    content: { integrity: { valid: true } },
    validation: { exitCode: 0, totals: { fatals: 0, errors: 0, warnings: 0 } },
    sizes: { inputBytes: 12, outputBytes: 6, reductionPercent: 50 },
  };
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report));
  await fs.writeFile(path.join(dir, "report.html"), "report");
  return { dir, report };
}
it("accepts only successful, validated output with consistent sizes", async () => {
  const { dir } = await fixture();
  expect((await readUiReport(dir, 0)).summary).toMatchObject({
    inputBytes: 12,
    outputBytes: 6,
    reductionPercent: 50,
  });
  expect((await readUiReport(dir, 1)).success).toBe(false);
});
it.each(["warnings", "fatals", "integrity", "size", "report", "symlink"])(
  "refuses %s even with exit code zero",
  async (mode) => {
    const { dir, report } = await fixture();
    if (mode === "warnings") report.validation.totals.warnings = 1;
    if (mode === "fatals") report.validation.totals.fatals = 1;
    if (mode === "integrity") report.content.integrity.valid = false;
    if (mode === "size") report.sizes.outputBytes = 99;
    await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report));
    if (mode === "report") await fs.writeFile(path.join(dir, "report.json"), "invalid");
    if (mode === "symlink") {
      await fs.unlink(path.join(dir, "optimized.epub"));
      await fs.symlink(path.join(dir, "report.json"), path.join(dir, "optimized.epub"));
    }
    expect((await readUiReport(dir, 0)).success).toBe(false);
  }
);
it("runs a separate worker, parses split progress lines and keeps CLI safety options", async () => {
  const { dir } = await fixture();
  const script = path.join(dir, "fixture.cjs");
  await fs.writeFile(
    script,
    `const fs=require('node:fs');fs.writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));process.stdout.write('=== Optimize');setTimeout(()=>process.stdout.write(' images ===\\n'),10);`
  );
  const stage = vi.fn();
  const worker = runUiWorker({
    directory: dir,
    preset: "lossless",
    onStage: stage,
    pipelinePath: script,
  });
  expect((await worker.done).success).toBe(true);
  expect(stage).toHaveBeenCalledWith("Optimize images");
  expect(JSON.parse(await fs.readFile(path.join(dir, "args.json"), "utf8"))).toEqual(
    expect.arrayContaining(["--strict", "--clean", "lossless"])
  );
});
it("terminates a stalled worker on timeout", async () => {
  const { dir } = await fixture();
  const script = path.join(dir, "fixture.cjs");
  await fs.writeFile(script, "setInterval(()=>{},1000)");
  const worker = runUiWorker({
    directory: dir,
    preset: "balanced",
    onStage: () => {},
    pipelinePath: script,
    timeoutMs: 100,
    killGraceMs: 20,
  });
  expect(await worker.done).toMatchObject({
    success: false,
    errorCode: "timeout",
  });
});
it("supports explicit cancellation without accepting an existing output", async () => {
  const { dir } = await fixture();
  const script = path.join(dir, "fixture.cjs");
  await fs.writeFile(script, "setInterval(()=>{},1000)");
  const worker = runUiWorker({
    directory: dir,
    preset: "balanced",
    onStage: () => {},
    pipelinePath: script,
    killGraceMs: 20,
  });
  await worker.stop();
  expect(await worker.done).toMatchObject({ success: false, errorCode: "cancelled" });
});

const doctorReport = {
  analysisComplete: true,
  input: "input.epub",
  archiveBytes: 5000,
  optimization: { blocked: false, blockers: [] },
  opf: { version: "<script>alert(1)</script>" },
  content: { contentDocuments: 3 },
  references: { missing: 2, missingTargets: ["OPS/<b>.xhtml -> x.png"] },
  images: {
    count: 4,
    archivePercent: 72.5,
    largeRasterImages: [{}, {}],
    opaquePngCandidates: [{}],
    largest: [{ href: "<img src=x onerror=alert(1)>" }],
  },
  risks: [
    { level: "warning", code: "missing-references", message: "<b>untrusted</b>" },
    { level: "info", code: "image-heavy", message: "text" },
    { level: "info", code: "<script>", message: "unknown code" },
    { level: "info", code: "duplicate-image-basenames", message: "not shown" },
  ],
  accessibility: {
    language: { package: ["fr"], documents: 3, documentsWithoutLanguage: ["a", "b"] },
    images: { total: 4, withoutTextAlternative: 1, emptyAlt: 2 },
    metadata: { accessMode: ["textual"], accessibilityFeature: [], accessibilityHazard: [] },
    pageNavigation: { pageBreaks: 7 },
    issues: [
      { level: "warning", code: "a11y-images-without-text-alternative", message: "<i>x</i>" },
      { level: "info", code: "a11y-no-conformance-claim", message: "not shown" },
    ],
  },
};
it("reduces a doctor report to numbers and known codes, without book-derived text", async () => {
  const { dir } = await fixture();
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(doctorReport));
  const result = await readUiDiagnosis(dir, 0);
  expect(result).toEqual({
    success: true,
    reports: { json: true, html: false },
    diagnosis: {
      blocked: false,
      codes: ["missing-references", "image-heavy", "a11y-images-without-text-alternative"],
      archiveBytes: 5000,
      documents: 3,
      missingReferences: 2,
      images: { count: 4, archivePercent: 72.5, large: 2, pngCandidates: 1 },
      accessibility: {
        documents: 3,
        documentsWithoutLanguage: 2,
        images: 4,
        imagesWithoutTextAlternative: 1,
        emptyAlt: 2,
        missingMetadata: ["accessibilityFeature", "accessibilityHazard"],
        pageBreaks: 7,
      },
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/[<>]/);
});
it("reports a blocked book and refuses failed, malformed or linked diagnoses", async () => {
  const { dir } = await fixture();
  const report = path.join(dir, "report.json");
  const blocked = {
    analysisComplete: false,
    archiveBytes: 900,
    optimization: { blocked: true },
    risks: [{ level: "error", code: "drm", message: "blocked" }],
  };
  await fs.writeFile(report, JSON.stringify(blocked));
  expect((await readUiDiagnosis(dir, 0)).diagnosis).toMatchObject({
    blocked: true,
    codes: ["drm"],
    documents: 0,
    images: { count: 0, archivePercent: null },
  });
  const failed = { success: false, errorCode: "analysisFailed" };
  expect(await readUiDiagnosis(dir, 1)).toMatchObject(failed);
  await fs.writeFile(report, JSON.stringify({ ...blocked, archiveBytes: -1 }));
  expect(await readUiDiagnosis(dir, 0)).toMatchObject(failed);
  await fs.writeFile(report, "invalid");
  expect(await readUiDiagnosis(dir, 0)).toMatchObject(failed);
  await fs.writeFile(path.join(dir, "real.json"), JSON.stringify(blocked));
  await fs.unlink(report);
  await fs.symlink(path.join(dir, "real.json"), report);
  expect(await readUiDiagnosis(dir, 0)).toMatchObject(failed);
});
it("runs the read-only doctor in inspect mode", async () => {
  const { dir } = await fixture();
  await fs.unlink(path.join(dir, "optimized.epub"));
  const script = path.join(dir, "fixture.cjs");
  await fs.writeFile(
    script,
    `const fs=require('node:fs');fs.writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));fs.writeFileSync('report.json',${JSON.stringify(JSON.stringify(doctorReport))});`
  );
  const worker = runUiWorker({
    directory: dir,
    preset: "balanced",
    mode: "inspect",
    onStage: () => {},
    pipelinePath: script,
  });
  expect((await worker.done).diagnosis?.documents).toBe(3);
  expect(JSON.parse(await fs.readFile(path.join(dir, "args.json"), "utf8"))).toEqual([
    "--doctor",
    "-i",
    "input.epub",
    "--report-json",
    "report.json",
  ]);
});
