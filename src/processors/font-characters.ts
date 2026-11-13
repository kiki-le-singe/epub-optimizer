import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { decodeXML } from "entities";
import { hasInternalDtdInText } from "../utils/xml-dtd.js";
import { getOPFPath } from "../utils/epub-utils.js";
import { resolvePathInside } from "../utils/path-safety.js";
import { MAX_FONT_CHARACTERS } from "./font-limits.js";

const TEXT_EXTENSIONS = new Set([
  ".xhtml",
  ".html",
  ".htm",
  ".svg",
  ".xml",
  ".opf",
  ".ncx",
  ".css",
]);
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

/** Remove CSS comments outside strings, then decode CSS escapes for conservative checks. */
function cssText(text: string): string {
  let output = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const character = text[i] ?? "";
    if (character === "\\") {
      output += character + (text[++i] ?? "");
    } else if (quote) {
      output += character;
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
      output += character;
    } else if (character === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unterminated CSS comment");
      i = end + 1;
    } else output += character;
  }
  return output
    .replace(/\\(?:\r\n|[\n\r\f])/g, "")
    .replace(/\\([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?/gi, (_, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "\ufffd";
    })
    .replace(/\\([^\da-f\n\r\f])/gi, "$1");
}

/** Deliberately over-collects literal text; refuses content whose glyphs are not statically known. */
export async function collectFontCharacters(root: string): Promise<string> {
  root = path.resolve(root);
  let visited = 0;
  let bytes = 0;
  let documents = 0;
  const characters = new Set<string>();
  const resources = new Map<string, number>();
  const declared = new Map<string, string>();
  // Common punctuation, spaces, bullets, Latin diacritics and language-dependent quotation marks.
  for (const [start, end] of [
    [0x20, 0x2ff],
    [0x2000, 0x206f],
    [0x3000, 0x303f],
  ] as const)
    for (let cp = start; cp <= end; cp++) characters.add(String.fromCodePoint(cp));
  for (const char of "◦▪□●○■") characters.add(char);
  function add(text: string) {
    // Add equivalent forms without rewriting any publication resource. Inline text nodes
    // must be joined before normalization (e.g. <em>e</em> + combining acute).
    for (const variant of [text, text.toUpperCase(), text.toLowerCase()]) {
      for (const normalized of [variant.normalize("NFC"), variant.normalize("NFD")]) {
        for (const character of new Set(normalized)) {
          characters.add(character);
          if (characters.size > MAX_FONT_CHARACTERS)
            throw new Error("Font character limit exceeded");
        }
      }
    }
  }
  function addStylesheet(source: string): void {
    const css = cssText(source);
    if (/\b(?:counter|counters|attr|var|symbols)\s*\(|@(?:import|counter-style)\b/i.test(css))
      throw new Error("Dynamic or imported CSS text cannot be safely subset");
    for (const match of css.matchAll(/\bcontent\s*:\s*([^;}]+)/gi)) {
      if (
        !["none", "normal", '""', "''"].includes(
          (match[1] ?? "")
            .replace(/!important\s*$/i, "")
            .trim()
            .toLowerCase()
        )
      )
        throw new Error("Generated CSS content cannot be safely subset");
    }
    for (const match of css.matchAll(/\btext-transform\s*:\s*([^;}]+)/gi)) {
      if (
        !/^(?:none|uppercase|lowercase|capitalize)(?:\s*!important)?\s*$/i.test(
          (match[1] ?? "").trim()
        )
      )
        throw new Error("Unsupported CSS text transformation");
    }
    for (const match of css.matchAll(/\blist-style(?:-type)?\s*:\s*([^;}]+)/gi)) {
      if (
        !/^(?:none|disc|circle|square|decimal|decimal-leading-zero|lower-latin|upper-latin|lower-alpha|upper-alpha|lower-roman|upper-roman)(?:\s*!important)?\s*$/i.test(
          (match[1] ?? "").trim()
        )
      )
        throw new Error("Unsupported generated list markers");
    }
    add(source);
    add(css);
  }
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (++visited > 4096) throw new Error("Font resource count limit exceeded");
      const file = path.join(dir, entry.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error("Symlink in font resource tree");
      if (stat.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!stat.isFile()) throw new Error("Non-regular font resource");
      resources.set(file, stat.size);
    }
  }
  if (!(await fs.lstat(root)).isDirectory()) throw new Error("Invalid font resource root");
  await walk(root);
  const container = path.join(root, "META-INF/container.xml");
  if ((resources.get(container) ?? MAX_TEXT_BYTES) >= MAX_TEXT_BYTES)
    throw new Error("Missing or excessive font package metadata");
  const opfPath = await getOPFPath(root);
  if ((resources.get(opfPath) ?? MAX_TEXT_BYTES) >= MAX_TEXT_BYTES)
    throw new Error("Missing or excessive font package metadata");
  const opf = cheerio.load(
    new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(opfPath)),
    { xmlMode: true }
  );
  for (const element of opf("[media-type]").toArray()) {
    const media = (opf(element).attr("media-type") ?? "").trim().toLowerCase();
    if (
      !media.startsWith("text/") &&
      !media.endsWith("+xml") &&
      !["application/xml", "application/javascript"].includes(media)
    )
      continue;
    const href = opf(element).attr("href");
    if (!href) throw new Error("Missing text resource href");
    const file = resolvePathInside(root, path.dirname(opfPath), href, "font text resource");
    if (!resources.has(file)) throw new Error("Missing font text resource");
    declared.set(file, media);
  }
  for (const [file, size] of resources) {
    const extension = path.extname(file).toLowerCase();
    if (
      [".js", ".mjs", ".cjs"].includes(extension) ||
      /javascript|ecmascript/.test(declared.get(file) ?? "")
    )
      throw new Error("Scripted text cannot be safely subset");
    // Probe unknown extensions, since XML resources need not use .xhtml or .xml.
    const handle = await fs.open(file, "r");
    let probe: Buffer;
    try {
      probe = Buffer.alloc(256);
      const read = await handle.read(probe, 0, 256, 0);
      probe = probe.subarray(0, read.bytesRead);
    } finally {
      await handle.close();
    }
    if (
      !TEXT_EXTENSIONS.has(extension) &&
      !declared.has(file) &&
      !/^\s*(?:\uFEFF)?\s*<(?:\?xml|(?:[\w.-]+:)?(?:html|svg)\b)/i.test(probe.toString("utf8"))
    )
      continue;
    bytes += size;
    if (bytes >= MAX_TEXT_BYTES) throw new Error("Font text resources exceed 16 MiB");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file));
    if (hasInternalDtdInText(text)) throw new Error("Internal DTD cannot be safely subset");
    const decoded = decodeXML(text);
    add(decoded);
    if (extension === ".css" || declared.get(file) === "text/css") {
      addStylesheet(text);
      continue;
    }
    if (/<\?xml-stylesheet\b/i.test(text))
      throw new Error("External XML stylesheet cannot be safely subset");
    const $ = cheerio.load(text, { xmlMode: true });
    for (const element of $("*").toArray()) {
      if (!("attribs" in element)) continue;
      const localName = element.name.split(":").pop()?.toLowerCase();
      if (
        [
          "script",
          "math",
          "object",
          "iframe",
          "embed",
          "tref",
          "altglyph",
          "altglyphdef",
          "glyphref",
        ].includes(localName ?? "")
      )
        throw new Error("Dynamic or mathematical text cannot be safely subset");
      if (Object.keys(element.attribs).some((name) => /^on/i.test(name.split(":").pop() ?? "")))
        throw new Error("Scripted text cannot be safely subset");
      if ((element.attribs.properties ?? "").split(/\s+/).includes("scripted"))
        throw new Error("Scripted text cannot be safely subset");
      if (
        localName === "link" &&
        (element.attribs.rel ?? "").toLowerCase().split(/\s+/).includes("stylesheet") &&
        /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test((element.attribs.href ?? "").trim())
      )
        throw new Error("Remote stylesheet cannot be safely subset");
      if (
        localName === "use" &&
        !(element.attribs.href ?? element.attribs["xlink:href"] ?? "").trim().startsWith("#")
      )
        throw new Error("External SVG text cannot be safely subset");
      for (const name of ["text-transform", "list-style-type", "list-style", "content"])
        if (element.attribs[name]) addStylesheet(`${name}:${element.attribs[name]}`);
      if (localName === "style") addStylesheet($(element).text());
      if (element.attribs.style) addStylesheet(element.attribs.style);
      if (localName === "html" || localName === "svg") documents++;
    }
    add($.root().text());
  }
  if (!documents) throw new Error("No readable text documents for font subsetting");
  return [...characters].join("");
}
