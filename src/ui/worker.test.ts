import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readUiReport, runUiWorker } from "./worker.js";

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
