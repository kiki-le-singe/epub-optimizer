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
