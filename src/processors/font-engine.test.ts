import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as hb from "harfbuzzjs";
import { subsetFontBuffer } from "./font-engine.js";
import { MAX_FONT_BYTES, MAX_SFNT_BYTES } from "./font-limits.js";

const require = createRequire(import.meta.url);
const converter = require("fontverter") as {
  convert(data: Buffer, format: string): Promise<Buffer>;
};
const fixture = (ext = "ttf") => fs.readFile(`scripts/fixtures/fonts/fixture.${ext}`);
function table(data: Buffer, tag: string): number {
  for (let i = 0; i < data.readUInt16BE(4); i++) {
    const entry = 12 + i * 16;
    if (data.toString("ascii", entry, entry + 4) === tag) return data.readUInt32BE(entry + 8);
  }
  throw new Error(`Missing ${tag}`);
}
function shape(data: Buffer, text: string) {
  const font = new hb.Font(new hb.Face(new hb.Blob(data)));
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  return buffer.getGlyphInfosAndPositions().map(({ codepoint, ...metrics }) => ({
    ...metrics,
    name: font.glyphName(codepoint),
    outline: font.glyphToPath(codepoint),
  }));
}
const texts = ["AV office fi ffi", "e\u0301 α\u0301 Å", "سلام", "क्ष", "中文"];
const rawText = texts.join(" ");
const characters = rawText + rawText.normalize("NFC") + rawText.normalize("NFD");

describe("HarfBuzz font engine", () => {
  it.each(["ttf", "otf", "woff", "woff2"])(
    "preserves actual shaping, glyph outlines and kerning in %s",
    async (format) => {
      const original = format === "otf" ? await fixture("otf") : await fixture();
      const input = ["woff", "woff2"].includes(format)
        ? await converter.convert(original, format)
        : original;
      const snapshot = Buffer.from(input);
      const result = await subsetFontBuffer(input, characters);
      expect(result.data).toBeDefined();
      expect(result.data!.length).toBeLessThan(input.length);
      const output = await converter.convert(result.data!, "truetype");
      for (const text of texts) expect(shape(output, text)).toEqual(shape(original, text));
      expect(shape(output, "office").some((g) => g.name === "fi" || g.name === "ffi")).toBe(true);
      expect(input).toEqual(snapshot);
    }
  );

  it.each([0x0002, 0x0100, 0x0200])(
    "preserves embedding/subsetting-restricted fonts (%i)",
    async (flag) => {
      const font = await fixture();
      font.writeUInt16BE(flag, table(font, "OS/2") + 8);
      expect(await subsetFontBuffer(font, characters)).toEqual({
        reason: "font embedding/subsetting restriction",
      });
    }
  );
  it("keeps a font when all glyphs are retained and there is no size benefit", async () => {
    const font = await fixture();
    const first = (await subsetFontBuffer(font, characters)).data!;
    expect(await subsetFontBuffer(first, characters)).toEqual({ reason: "no size benefit" });
  });
  it("preserves unsupported variable/color/math font tables", async () => {
    const font = await fixture();
    // A well-bounded directory entry is enough: the font must be refused before subsetting.
    font.write("fvar", 12, "ascii");
    expect(await subsetFontBuffer(font, characters)).toEqual({
      reason: "variable, color, mathematical or Graphite font",
    });
  });
  it("rejects malformed font directories and licensing metadata", async () => {
    const font = await fixture();
    font.writeUInt32BE(0xffffffff, 20);
    await expect(subsetFontBuffer(font, characters)).rejects.toThrow("bounds");
    const naming = await fixture();
    naming.writeUInt16BE(0xffff, table(naming, "name") + 2);
    await expect(subsetFontBuffer(naming, characters)).rejects.toThrow("naming");
  });
  it("rejects empty, excessive, invalid and decompression-bomb inputs", async () => {
    await expect(subsetFontBuffer(Buffer.alloc(0), characters)).rejects.toThrow("input limit");
    await expect(subsetFontBuffer(Buffer.alloc(MAX_FONT_BYTES + 1), characters)).rejects.toThrow(
      "input limit"
    );
    await expect(subsetFontBuffer(await fixture(), "")).rejects.toThrow("character set");
    await expect(subsetFontBuffer(Buffer.from("not a font"), characters)).rejects.toThrow();
    const woff = await converter.convert(await fixture(), "woff");
    woff.writeUInt32BE(MAX_SFNT_BYTES + 1, 16);
    await expect(subsetFontBuffer(woff, characters)).rejects.toThrow("Expanded font");
  });
});
