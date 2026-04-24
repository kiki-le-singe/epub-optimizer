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

const VOID_RE = new RegExp(
  // Match <tag ...> where the char just before the closing `>` is not `/`.
  // Negative lookbehind skips tags that are already self-closed (`<br/>`,
  // `<br />`), so applying this function multiple times is idempotent.
  `<(${VOID_ELEMENTS.join("|")})\\b([^>]*?)(?<!/)>`,
  "gi"
);

/**
 * Rewrite HTML5-style void elements (`<br>`, `<link rel="…">`, etc.) as
 * self-closing XHTML (`<br />`, `<link rel="…" />`). Already-closed tags
 * are left alone. Safe to run before handing content to an XML parser.
 */
export function normalizeVoidElements(content: string): string {
  return content.replace(VOID_RE, "<$1$2 />");
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
