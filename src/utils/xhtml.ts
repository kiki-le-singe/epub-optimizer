import { decodeHTMLStrict } from "entities";

// HTML5 void elements — must be self-closed in XHTML.
// See: https://html.spec.whatwg.org/multipage/syntax.html#void-elements
const VOID_ELEMENTS = [
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
] as const;

const VOID_NAMES: ReadonlySet<string> = new Set(VOID_ELEMENTS);

/** Find a markup boundary without treating quoted text as markup. */
function findMarkupEnd(content: string, start: number, declaration = false): number {
  let quote: string | undefined;
  let subsetDepth = 0;
  for (let i = start; i < content.length; i++) {
    const char = content[i];
    if (declaration && !quote && content.startsWith("<!--", i)) {
      const end = content.indexOf("-->", i + 4);
      if (end === -1) return -1;
      i = end + 2;
    } else if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (declaration && char === "[") {
      subsetDepth++;
    } else if (declaration && char === "]") {
      subsetDepth--;
    } else if (char === ">" && subsetDepth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Rewrite HTML5-style void elements (`<br>`, `<link rel="…">`, etc.) as
 * self-closing XHTML (`<br />`, `<link rel="…" />`). Already-closed tags
 * are left alone. Only actual markup is changed: quoted attributes, comments,
 * declarations, CDATA, and script/style bodies are preserved byte for byte.
 */
export function normalizeVoidElements(
  content: string,
  opts: { removeInvalidBrClosings?: boolean } = {}
): string {
  const tagStart = /<\/?([a-z][\w:.-]*)(?=[\s/>])/giy;
  const parts: string[] = [];
  let copiedUntil = 0;
  let position = 0;
  let rawElement: string | undefined;

  while (position < content.length) {
    const start = content.indexOf("<", position);
    if (start === -1) break;

    // Skip complete opaque regions, including a DTD's internal subset. Leave
    // an unfinished region unchanged rather than guessing where it ends.
    const terminator = content.startsWith("<!--", start)
      ? "-->"
      : content.startsWith("<![CDATA[", start)
        ? "]]>"
        : !rawElement && content.startsWith("<?", start)
          ? "?>"
          : undefined;
    if (terminator) {
      const end = content.indexOf(terminator, start + 2);
      if (end === -1) break;
      position = end + terminator.length;
      continue;
    }
    if (!rawElement && content.startsWith("<!", start)) {
      const end = findMarkupEnd(content, start + 2, true);
      if (end === -1) break;
      position = end + 1;
      continue;
    }

    tagStart.lastIndex = start;
    const match = tagStart.exec(content);
    const name = match?.[1]?.toLowerCase();
    const closing = content[start + 1] === "/";
    if (!name || (rawElement && !(closing && name === rawElement))) {
      position = start + 1;
      continue;
    }
    const end = findMarkupEnd(content, tagStart.lastIndex);
    if (end === -1) break;
    const selfClosed = content[end - 1] === "/";

    if (rawElement) {
      rawElement = undefined;
    } else if (closing && name === "br" && opts.removeInvalidBrClosings) {
      parts.push(content.slice(copiedUntil, start));
      copiedUntil = end + 1;
    } else if (!closing && !selfClosed && VOID_NAMES.has(name)) {
      parts.push(content.slice(copiedUntil, end), " />");
      copiedUntil = end + 1;
    } else if (
      !closing &&
      !selfClosed &&
      (name.split(":").at(-1) === "script" || name.split(":").at(-1) === "style")
    ) {
      rawElement = name;
    }
    position = end + 1;
  }

  parts.push(content.slice(copiedUntil));
  return parts.join("");
}

// The only named references an XML parser resolves without a DTD.
const XML_ENTITY_NAMES: ReadonlySet<string> = new Set(["amp", "lt", "gt", "quot", "apos"]);

// XHTML 1.x defines these differently from HTML5. All other shared named
// references have the same values. https://www.w3.org/TR/xhtml1/dtds.html
const XHTML_ENTITY_OVERRIDES = new Map([
  ["&lang;", "\u2329"],
  ["&rang;", "\u232a"],
]);

/** Decode one level of XHTML references, preserving XML numeric code points. */
export function decodeXhtmlEntities(text: string): string {
  return text.replace(/&(?:#(?:x[\da-f]+|\d+)|[a-z][a-z\d]*);/gi, (reference) => {
    if (reference.startsWith("&#")) {
      const hexadecimal = reference.charAt(2).toLowerCase() === "x";
      const codePoint = Number.parseInt(
        reference.slice(hexadecimal ? 3 : 2, -1),
        hexadecimal ? 16 : 10
      );
      return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : reference;
    }
    return XHTML_ENTITY_OVERRIDES.get(reference) ?? decodeHTMLStrict(reference);
  });
}

/**
 * Rewrite HTML named character references (`&nbsp;`, `&eacute;`, …) as numeric
 * ones (`&#xa0;`, `&#xe9;`). XHTML 1.1 documents (EPUB 2) may use them, but an
 * XML parser without the DTD leaves them as literal text and re-escapes the
 * ampersand on output, which would display `&nbsp;` to the reader. Comments,
 * CDATA, processing instructions and declarations are preserved byte for byte;
 * names that are not HTML entities are left for the reader to resolve.
 */
export function normalizeNamedEntities(content: string): string {
  const next = /<!--|<!\[CDATA\[|<\?|<!|&([a-z][a-z\d]*);/gi;
  const parts: string[] = [];
  let copiedUntil = 0;
  let match: RegExpExecArray | null;

  while ((match = next.exec(content)) !== null) {
    const name = match[1];
    if (name === undefined) {
      // Skip a complete opaque region; leave an unfinished one unchanged.
      const terminator =
        match[0] === "<!--"
          ? "-->"
          : match[0] === "<![CDATA["
            ? "]]>"
            : match[0] === "<?"
              ? "?>"
              : undefined;
      const end = terminator
        ? content.indexOf(terminator, next.lastIndex)
        : findMarkupEnd(content, next.lastIndex, true);
      if (end === -1) break;
      next.lastIndex = end + (terminator?.length ?? 1);
      continue;
    }
    if (XML_ENTITY_NAMES.has(name)) continue;

    const decoded = decodeXhtmlEntities(match[0]);
    if (decoded === match[0]) continue;
    parts.push(
      content.slice(copiedUntil, match.index),
      Array.from(decoded, (char) => `&#x${char.codePointAt(0)?.toString(16)};`).join("")
    );
    copiedUntil = next.lastIndex;
  }

  if (copiedUntil === 0) return content;
  parts.push(content.slice(copiedUntil));
  return parts.join("");
}

/**
 * Best-effort detection of XHTML content. Returns true if the string contains
 * any of the canonical XHTML markers: an XML declaration, the XHTML namespace,
 * or an XHTML DOCTYPE. We only inspect the first 2KB since these markers live
 * near the top of the file.
 */
export function isXHTMLContent(content: string): boolean {
  const head = content.slice(0, 2048);
  if (/^\s*<\?xml\b/i.test(head)) return true;
  if (head.includes('xmlns="http://www.w3.org/1999/xhtml"')) return true;
  if (/<!DOCTYPE\s+html\s+PUBLIC\s+"[^"]*XHTML/i.test(head)) return true;
  return false;
}
