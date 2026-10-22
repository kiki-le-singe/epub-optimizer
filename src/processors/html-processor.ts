import fs from "fs-extra";
import path from "node:path";
import { minify } from "html-minifier-terser";
import CleanCSS from "clean-css";
import * as cheerio from "cheerio";
import { minify as terserMinify } from "terser";
import config from "../utils/config.js";
import { isXHTMLContent, normalizeNamedEntities, normalizeVoidElements } from "../utils/xhtml.js";
import { collectFiles, forEachFileLimited, hasExtension } from "../utils/files.js";

const HTML_EXTENSIONS = new Set([".xhtml", ".html"]);
const CSS_EXTENSIONS = new Set([".css"]);
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"]);
const XML_MARKUP_RE = /[<&]|\]\]>/;

/**
 * CleanCSS reports unsupported syntax as warnings and may still return a
 * partial stylesheet. Accept only a complete, smaller result. Inline
 * declarations and media queries need a temporary rule for its CSS parser.
 */
function minifyCssText(text: string, type?: string, xhtml = false): string {
  // Serialized XML references and CDATA are not raw CSS. Passing them through
  // an HTML/CSS parser can truncate references or discard the CDATA wrapper.
  if (xhtml && XML_MARKUP_RE.test(text)) return text;
  const input =
    type === "inline" ? `*{${text}}` : type === "media" ? `@media ${text}{a{top:0}}` : text;
  const result = new CleanCSS({
    // Retain the existing optimization levels for external and embedded CSS.
    level: type === "external" ? 2 : 1,
    inline: false,
  }).minify(input);
  if (result.errors.length > 0 || result.warnings.length > 0) return text;

  let styles = result.styles;
  if (type === "inline" || type === "media") {
    const match = styles.match(
      type === "inline" ? /^\*\{([\s\S]*)\}$/ : /^@media ([\s\S]*?)\s*\{[\s\S]*\}$/
    );
    if (match?.[1] === undefined) return text;
    styles = match[1];
  }
  // A safe input can produce XML delimiters through CSS escape shortening.
  if (xhtml && XML_MARKUP_RE.test(styles)) return text;
  return Buffer.byteLength(styles) < Buffer.byteLength(text) ? styles : text;
}

/**
 * Minify a script body or event attribute of an XHTML document. There the code
 * is XML character data, so `<`, `&` and `]]>` are unsafe: CDATA-wrapped or
 * entity-escaped code is kept byte for byte, and a result that would need
 * escaping (for example `a&&b()`) is discarded in favour of the original.
 */
async function minifyXhtmlJS(text: string, inline?: boolean): Promise<string> {
  if (XML_MARKUP_RE.test(text)) return text;
  try {
    const result = await terserMinify(text, { parse: { bare_returns: inline === true } });
    // Terser retains semicolons that form a required empty statement, such as
    // the body of `while (poll());`. Keep its output syntactically complete.
    const code = result.code;
    return code === undefined || XML_MARKUP_RE.test(code) ? text : code;
  } catch {
    return text;
  }
}

/**
 * Re-express CDATA sections outside script/style as escaped character data,
 * which is equivalent XML. html-minifier parses HTML, where such a section is
 * a bogus comment and would be dropped together with its text.
 */
function escapeCdataSections($: cheerio.CheerioAPI): void {
  $("*")
    .contents()
    .filter((_, node) => (node as { type?: string }).type === "cdata")
    .each((_, node) => {
      const parentName = (node.parent as { name?: string } | null)?.name ?? "";
      if (RAW_TEXT_ELEMENTS.has(parentName.split(":").at(-1)?.toLowerCase() ?? "")) return;
      // cheerio only wraps a bare CDATA node when it is given as a list.
      const section = $([node]);
      section.replaceWith(
        section.text().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      );
    });
}

/**
 * Process HTML and CSS files in a directory recursively.
 * Minifies HTML/XHTML and CSS files in parallel (bounded) to reduce file size.
 * @param dir Directory to process
 * @throws Error if any file fails to minify
 */
async function processHTML(dir: string): Promise<void> {
  try {
    const files = await collectFiles(
      dir,
      (filePath) =>
        hasExtension(filePath, HTML_EXTENSIONS) || hasExtension(filePath, CSS_EXTENSIONS)
    );

    await forEachFileLimited(files, async (filePath) => {
      if (hasExtension(filePath, CSS_EXTENSIONS)) {
        await minifyCSS(filePath);
      } else {
        await minifyHTML(filePath);
      }
    });
  } catch (error) {
    throw new Error(
      `Failed to process HTML/CSS in ${dir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

/**
 * Minify HTML/XHTML file using cheerio and html-minifier-terser
 * @param filePath Path to HTML/XHTML file
 * @throws Error if minification fails
 */
async function minifyHTML(filePath: string): Promise<void> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    // Detect XHTML by content first — the file extension may be `.html` even
    // for true XHTML (the EPUB spec doesn't mandate `.xhtml`). Extension is
    // kept as a fallback signal.
    const isXHTML = isXHTMLContent(content) || filePath.endsWith(".xhtml");
    // Pre-close HTML5-style void elements before the XML parser sees them.
    // Otherwise cheerio xmlMode treats `<link …>` as an opening tag and nests
    // subsequent siblings inside it, producing invalid XHTML.
    // Named references become numeric so output does not depend on an HTML
    // entity DTD to resolve the intended characters.
    const normalized = isXHTML ? normalizeNamedEntities(normalizeVoidElements(content)) : content;
    // Preserve the spelling of references and UTF-8 characters. Decoding and
    // serializing them again encodes style bodies as XML entities, which the
    // subsequent HTML/CSS minifier interprets as CSS syntax instead of text.
    const $ = cheerio.load(normalized, isXHTML ? { xml: { decodeEntities: false } } : {});
    if (isXHTML) escapeCdataSections($);
    // Use .xml() for XHTML to preserve XML structure (self-closing tags, etc.)
    const domContent = isXHTML ? $.xml() : $.html();
    const minified = await minify(domContent, {
      ...config.htmlOptions,
      // html-minifier-terser requires a promise here despite its sync types.
      minifyCSS: (async (text: string, type?: string) =>
        minifyCssText(text, type, isXHTML)) as unknown as (text: string, type?: string) => string,
      ...(isXHTML
        ? {
            // html-minifier-terser awaits minifyJS; its types only declare the sync form.
            minifyJS: minifyXhtmlJS as unknown as (text: string, inline?: boolean) => string,
          }
        : {}),
    });
    await fs.writeFile(filePath, minified);
  } catch (error) {
    throw new Error(
      `Failed to minify HTML file ${path.basename(filePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

/**
 * Minify CSS file using CleanCSS
 * @param filePath Path to CSS file
 * @throws Error if minification fails
 */
async function minifyCSS(filePath: string): Promise<void> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    // Keep @import rules as written: by default CleanCSS inlines them from the
    // current working directory, not from the stylesheet's own directory, and
    // drops the rule when the file is not found there.
    const minified = minifyCssText(content, "external");
    if (minified === content) {
      console.log(
        `Keeping original ${path.basename(filePath)}: CSS minification offered no safe reduction`
      );
      return;
    }
    await fs.writeFile(filePath, minified);
  } catch (error) {
    throw new Error(
      `Failed to minify CSS file ${path.basename(filePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

export { processHTML, minifyHTML, minifyCSS };
