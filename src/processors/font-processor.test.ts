import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs-extra";
import nativeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { subsetFonts } from "./font-processor.js";
import { collectDiagnostics, type Diagnostic } from "../utils/diagnostics.js";
import { runFontWorker } from "./font-runner.js";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const converter = require("fontverter") as {
  convert(font: Buffer, format: string): Promise<Buffer>;
};
const roots: string[] = [];
async function makeBook(format = "ttf") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "font-book-"));
  roots.push(root);
  let original = await fs.readFile(
    `scripts/fixtures/fonts/fixture.${format === "otf" ? "otf" : "ttf"}`
  );
  if (["woff", "woff2"].includes(format)) original = await converter.convert(original, format);
  const files = {
    "META-INF/container.xml":
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    "OPS/book.opf": `<package><manifest><item href="nested/ch.xhtml" media-type="application/xhtml+xml"/><item href="Fonts/book%20font.${format}" media-type="font/${format}"/></manifest></package>`,
    "OPS/nested/ch.xhtml": "<html><body>AV office fi ffi é ά سلام क्ष 中文</body></html>",
  };
  for (const [name, data] of Object.entries(files))
    await fs.outputFile(path.join(root, name), data);
  const file = path.join(root, `OPS/Fonts/book font.${format}`);
  await fs.outputFile(file, original);
  return { root, file, original };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => fs.remove(r)));
});

describe("optional font pipeline", () => {
  it.each(["ttf", "otf", "woff", "woff2"])(
    "atomically subsets %s in a real isolated worker",
    async (format) => {
      const { root, file, original } = await makeBook(format);
      const before = await fs.readFile(path.join(root, "OPS/nested/ch.xhtml"));
      const diagnostics: Diagnostic[] = [];
      await collectDiagnostics(
        () => subsetFonts(root, { enabled: true }),
        (d) => diagnostics.push(d)
      );
      expect(diagnostics).toEqual([]);
      expect((await fs.stat(file)).size).toBeLessThan(original.length);
      expect(await fs.readFile(path.join(root, "OPS/nested/ch.xhtml"))).toEqual(before);
      expect(await fs.readdir(path.dirname(file))).toEqual([path.basename(file)]);
    }
  );
  it("preserves the original and removes its own candidate when replacement fails", async () => {
    const { root, file, original } = await makeBook();
    vi.spyOn(nativeFs, "rename").mockRejectedValue(new Error("replacement failed"));
    await subsetFonts(root, { enabled: true });
    expect(await fs.readFile(file)).toEqual(original);
    expect(await fs.readdir(path.dirname(file))).toEqual([path.basename(file)]);
  });
  it("refuses publication when a candidate cannot be safely cleaned up", async () => {
    const { root, file, original } = await makeBook();
    vi.spyOn(nativeFs, "rename").mockImplementation(async (source) => {
      await fs.rename(String(source), String(source) + ".moved");
      await fs.writeFile(String(source), "replacement owned by someone else");
      throw new Error("replacement interrupted");
    });
    await expect(subsetFonts(root, { enabled: true })).rejects.toThrow("Cannot safely clean up");
    expect(await fs.readFile(file)).toEqual(original);
    const leftovers = await fs.readdir(path.dirname(file));
    const foreign = leftovers.find((name) => name.endsWith(".tmp"));
    expect(foreign).toBeDefined();
    expect(await fs.readFile(path.join(path.dirname(file), foreign!), "utf8")).toContain(
      "someone else"
    );
  });
  it("does not warn about dynamic text when there are no fonts to change", async () => {
    const { root, file } = await makeBook();
    await fs.remove(file);
    await fs.writeFile(path.join(root, "OPS/code.js"), "dynamic text");
    const diagnostics: Diagnostic[] = [];
    await collectDiagnostics(
      () => subsetFonts(root, { enabled: true }),
      (d) => diagnostics.push(d)
    );
    expect(diagnostics).toEqual([]);
  });
  it("does nothing by default, even for a missing directory", async () => {
    await expect(subsetFonts("/does-not-exist")).resolves.toBeUndefined();
    const { root, file, original } = await makeBook();
    await subsetFonts(root);
    expect(await fs.readFile(file)).toEqual(original);
  });
  it("preserves encrypted fonts and dynamically generated text", async () => {
    const { root, file, original } = await makeBook();
    await fs.writeFile(path.join(root, "META-INF/encryption.xml"), "encrypted");
    await subsetFonts(root, { enabled: true });
    expect(await fs.readFile(file)).toEqual(original);
    await fs.remove(path.join(root, "META-INF/encryption.xml"));
    await fs.outputFile(path.join(root, "OPS/extra.css"), "p{content:counter(chapter)}");
    const warnings: Diagnostic[] = [];
    await collectDiagnostics(
      () => subsetFonts(root, { enabled: true }),
      (d) => warnings.push(d)
    );
    expect(warnings.some((d) => d.message.includes("Dynamic"))).toBe(true);
    expect(await fs.readFile(file)).toEqual(original);
  });
  it("preserves invalid font bytes", async () => {
    const { root, file } = await makeBook();
    const invalid = Buffer.from("invalid font");
    await fs.writeFile(file, invalid);
    await subsetFonts(root, { enabled: true });
    expect((await fs.readFile(file)).equals(invalid)).toBe(true);
  });
  it("preserves oversized fonts without decoding or rewriting them", async () => {
    const { root, file } = await makeBook();
    const huge = Buffer.alloc(8 * 1024 * 1024 + 1);
    await fs.writeFile(file, huge);
    await subsetFonts(root, { enabled: true });
    expect((await fs.readFile(file)).equals(huge)).toBe(true);
  });
  it("preserves linked fonts", async () => {
    const other = await makeBook();
    await fs.link(other.file, path.join(other.root, "same.ttf"));
    await subsetFonts(other.root, { enabled: true });
    expect(await fs.readFile(other.file)).toEqual(other.original);
  });
  it("preserves an already reduced font without a further size benefit", async () => {
    const small = await makeBook();
    await subsetFonts(small.root, { enabled: true });
    const first = await fs.readFile(small.file);
    expect(first.length).toBeLessThan(small.original.length);
    await subsetFonts(small.root, { enabled: true });
    expect(await fs.readFile(small.file)).toEqual(first);
  });
});

describe("font child resource boundaries", () => {
  async function worker(source: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "font-worker-test-"));
    roots.push(root);
    const file = path.join(root, "worker.mjs");
    await fs.writeFile(file, source);
    return pathToFileURL(file);
  }
  it("kills a stalled worker on timeout", async () => {
    const workerUrl = await worker('process.on("message",()=>setInterval(()=>{},1000));');
    await expect(
      runFontWorker(Buffer.from("font"), "abc", { workerUrl, timeoutMs: 200 })
    ).rejects.toThrow("timed out");
  });
  it("kills a worker when its sampled RSS exceeds the budget", async () => {
    const workerUrl = await worker(
      'process.on("message",()=>{globalThis.bytes=Buffer.alloc(32*1024*1024,1);setInterval(()=>{},1000);});'
    );
    await expect(
      runFontWorker(Buffer.from("font"), "abc", { workerUrl, timeoutMs: 5000, rssBytes: 1 })
    ).rejects.toThrow("RSS budget");
  });
  it.each([
    'process.on("message",()=>{process.send({bad:true});});',
    'process.on("message",()=>process.exit(1));',
    'process.on("message",()=>process.exit(0));',
  ])("rejects malformed/failed child responses", async (source) => {
    await expect(
      runFontWorker(Buffer.from("font"), "abc", { workerUrl: await worker(source) })
    ).rejects.toThrow();
  });
});
