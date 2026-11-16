import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { planStorage, saveStoragePlan, applyStoragePlan } from "./storage.js";

let root: string, out: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-storage-test-"));
  out = path.join(root, "out");
  await fs.mkdir(out);
});
afterEach(async () => {
  await fs.remove(root);
});
async function revision(n: number, input = path.join(root, "original.epub")) {
  const hash = n.toString(16).padStart(64, "0");
  const job = `book-${"a".repeat(16)}-${hash}-${"b".repeat(16)}`;
  const dir = path.join(out, job);
  await fs.mkdir(dir);
  const contents = `validated-output-${n}`;
  await fs.writeFile(path.join(dir, "optimized.epub"), contents);
  await fs.writeJson(path.join(dir, "completed.json"), {
    input,
    inputSha256: hash,
    settings: "b".repeat(16),
    outputSha256: createHash("sha256").update(contents).digest("hex"),
  });
  await fs.writeJson(path.join(dir, "report.json"), {
    success: true,
    validation: { exitCode: 0, totals: { errors: 0, fatals: 0 } },
  });
  await fs.utimes(path.join(dir, "completed.json"), n * 1000, n * 1000);
  return { dir, job };
}
async function preview() {
  const file = path.join(root, "plan.json");
  const plan = await planStorage(out, 1);
  await saveStoragePlan(plan, file);
  return { file, plan };
}
describe("storage maintenance", () => {
  it("previews without mutation, retains newest revisions per source and preserves originals", async () => {
    await fs.writeFile(path.join(root, "original.epub"), "original");
    const old = await revision(1),
      latest = await revision(2);
    const other = await revision(3, path.join(root, "other.epub"));
    const { file, plan } = await preview();
    expect(plan.candidates.map((r) => r.job)).toEqual([old.job]);
    expect(plan.retained.map((r) => r.job).sort()).toEqual([latest.job, other.job].sort());
    expect(await fs.pathExists(old.dir)).toBe(true);
    expect(plan.candidateBytes).toBeGreaterThan(0);
    expect(await applyStoragePlan(file)).toEqual({
      removed: [old.job],
      fileBytes: plan.candidateBytes,
    });
    expect(await fs.pathExists(old.dir)).toBe(false);
    expect(await fs.pathExists(latest.dir)).toBe(true);
    expect(await fs.readFile(path.join(root, "original.epub"), "utf8")).toBe("original");
    expect(await fs.pathExists(path.join(out, ".epub-watch.lock"))).toBe(false);
  });
  it.each(["unknown", "failed", "checksum", "symlink", "hardlink", "nested"])(
    "protects %s revisions",
    async (kind) => {
      const old = await revision(1);
      await revision(2);
      if (kind === "unknown") await fs.writeFile(path.join(old.dir, "notes.txt"), "user notes");
      if (kind === "failed")
        await fs.writeJson(path.join(old.dir, "report.json"), { success: false });
      if (kind === "checksum") await fs.appendFile(path.join(old.dir, "optimized.epub"), "changed");
      if (kind === "nested") await fs.mkdir(path.join(old.dir, "extra"));
      if (kind === "symlink" || kind === "hardlink") {
        const target = path.join(root, "precious");
        await fs.writeFile(target, "preserve");
        const file = path.join(old.dir, "report.html");
        if (kind === "symlink") await fs.symlink(target, file);
        else await fs.link(target, file);
      }
      const plan = await planStorage(out, 1);
      expect(plan.candidates).toEqual([]);
      expect(plan.protected.some((p) => p.name === old.job)).toBe(true);
      expect(await fs.pathExists(old.dir)).toBe(true);
    }
  );
  it("refuses stale plans and releases its own lock", async () => {
    const old = await revision(1);
    await revision(2);
    const { file } = await preview();
    await fs.appendFile(path.join(old.dir, "optimized.epub"), "changed");
    await expect(applyStoragePlan(file)).rejects.toThrow("changed since preview");
    expect(await fs.pathExists(old.dir)).toBe(true);
    expect(await fs.pathExists(path.join(out, ".epub-watch.lock"))).toBe(false);
  });
  it("refuses an existing watcher lock and preserves it", async () => {
    await revision(1);
    await revision(2);
    const { file } = await preview();
    await fs.writeFile(path.join(out, ".epub-watch.lock"), "unknown lock");
    await expect(applyStoragePlan(file)).rejects.toThrow();
    expect(await fs.readFile(path.join(out, ".epub-watch.lock"), "utf8")).toBe("unknown lock");
  });
  it("never overwrites plans or accepts symlink roots, invalid retention or forged candidates", async () => {
    await revision(1);
    await revision(2);
    const { file, plan } = await preview();
    await expect(saveStoragePlan(plan, file)).rejects.toThrow();
    await expect(planStorage(out, 0)).rejects.toThrow("at least one");
    const link = path.join(root, "link");
    await fs.symlink(out, link);
    await expect(planStorage(link)).rejects.toThrow("real directory");
    await fs.writeJson(file, { ...plan, candidates: [{ job: "../original.epub" }] });
    await expect(applyStoragePlan(file)).rejects.toThrow("changed since preview");
  });
});
