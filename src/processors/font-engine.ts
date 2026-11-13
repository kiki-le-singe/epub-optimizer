import { createRequire } from "node:module";

const { MAX_FONT_BYTES, MAX_SFNT_BYTES, MAX_FONT_CHARACTERS } = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./font-limits.ts" : "./font-limits.js",
    import.meta.url
  ).href
);

interface Converter {
  detectFormat(data: Buffer): string;
  convert(data: Buffer, format: string): Promise<Buffer>;
}
interface SubsetOptions {
  targetFormat: string;
  glyphNames: boolean;
  preserveNameIds: number[];
  noHinting: boolean;
}
const require = createRequire(import.meta.url);
const converter = require("fontverter") as Converter;
const subset = require("subset-font") as (
  data: Buffer,
  text: string,
  options: SubsetOptions
) => Promise<Buffer>;

/** Bounds-check every SFNT directory entry before interpreting font metadata. */
function tables(data: Buffer): Map<string, Buffer> {
  if (data.length < 12 || !["00010000", "4f54544f"].includes(data.subarray(0, 4).toString("hex")))
    throw new Error("Unsupported or malformed SFNT font");
  const count = data.readUInt16BE(4);
  if (!count || count > 256 || 12 + count * 16 > data.length)
    throw new Error("Invalid font table directory");
  const result = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const entry = 12 + i * 16;
    const tag = data.toString("ascii", entry, entry + 4);
    const offset = data.readUInt32BE(entry + 8);
    const length = data.readUInt32BE(entry + 12);
    if (offset < 12 + count * 16 || offset + length > data.length || result.has(tag))
      throw new Error("Invalid font table bounds");
    result.set(tag, data.subarray(offset, offset + length));
  }
  return result;
}

function names(data: Buffer | undefined): { ids: number[]; notices: string[] } {
  if (!data || data.length < 6) throw new Error("Missing font naming table");
  const count = data.readUInt16BE(2);
  const start = data.readUInt16BE(4);
  if (count > 4096 || 6 + count * 12 > data.length || start < 6 + count * 12)
    throw new Error("Invalid font naming table");
  const ids = new Set<number>();
  const notices = new Set<string>();
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 12;
    const platform = data.readUInt16BE(entry);
    const encoding = data.readUInt16BE(entry + 2);
    const id = data.readUInt16BE(entry + 6);
    const length = data.readUInt16BE(entry + 8);
    const offset = start + data.readUInt16BE(entry + 10);
    if (offset + length > data.length) throw new Error("Invalid font name bounds");
    ids.add(id);
    if (![0, 13, 14].includes(id)) continue;
    if (!(platform === 0 || platform === 3 || (platform === 1 && encoding === 0)))
      throw new Error("Unsupported copyright/license name encoding");
    const decoder = new TextDecoder(platform === 1 ? "macintosh" : "utf-16be", {
      fatal: true,
    });
    notices.add(JSON.stringify([id, decoder.decode(data.subarray(offset, offset + length))]));
  }
  return { ids: [...ids], notices: [...notices].sort() };
}

export interface FontSubsetResult {
  data?: Buffer;
  reason?: string;
}

/** Runs only on bounded buffers; production callers execute this in a child process. */
export async function subsetFontBuffer(
  font: Buffer,
  characters: string
): Promise<FontSubsetResult> {
  if (!Buffer.isBuffer(font) || !font.length || font.length > MAX_FONT_BYTES)
    throw new Error("Font exceeds the 8 MiB input limit or is empty");
  if (
    typeof characters !== "string" ||
    !characters.length ||
    characters.length > MAX_FONT_CHARACTERS * 2
  )
    throw new Error("Invalid font character set");
  if (font.toString("ascii", 0, 4) === "ttcf") return { reason: "font collection" };
  const format = converter.detectFormat(font);
  if (!["sfnt", "woff", "woff2"].includes(format)) return { reason: "unsupported font container" };
  // WOFF(2) declares its expanded SFNT size before decompression.
  if (format !== "sfnt" && (font.length < 20 || font.readUInt32BE(16) > MAX_SFNT_BYTES))
    throw new Error("Expanded font exceeds the 16 MiB limit");
  const sfnt = await converter.convert(font, "truetype");
  if (sfnt.length > MAX_SFNT_BYTES) throw new Error("Expanded font exceeds the 16 MiB limit");
  const original = tables(sfnt);
  const os2 = original.get("OS/2");
  if (!os2 || os2.length < 10) throw new Error("Missing font embedding permissions");
  const permissions = os2.readUInt16BE(8);
  if (permissions & (0x0002 | 0x0100 | 0x0200))
    return { reason: "font embedding/subsetting restriction" };
  if (
    ["fvar", "CFF2", "COLR", "CBDT", "sbix", "SVG ", "MATH", "Silf"].some((tag) =>
      original.has(tag)
    )
  )
    return { reason: "variable, color, mathematical or Graphite font" };
  const metadata = names(original.get("name"));
  const data = await subset(font, characters, {
    targetFormat: format,
    glyphNames: true,
    preserveNameIds: metadata.ids,
    noHinting: false,
  });
  if (!data.length || data.length >= font.length) return { reason: "no size benefit" };
  if (converter.detectFormat(data) !== format) throw new Error("Font container changed");
  const output = tables(await converter.convert(data, "truetype"));
  const outputOs2 = output.get("OS/2");
  if (!outputOs2 || outputOs2.length < 10 || outputOs2.readUInt16BE(8) !== permissions)
    throw new Error("Font embedding permissions changed");
  if (JSON.stringify(names(output.get("name")).notices) !== JSON.stringify(metadata.notices))
    throw new Error("Font copyright/license text changed");
  return { data };
}
