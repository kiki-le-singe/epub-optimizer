import { createHash } from "node:crypto";
import type { CheerioAPI } from "cheerio";
import { decodeXhtmlEntities } from "./xhtml.js";

interface XmlNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: XmlNode[];
}

interface Visit {
  node: XmlNode;
  literal: boolean;
  ignoreText?: boolean;
  close?: boolean;
}

/**
 * Fingerprint the XML tree, identifiers, namespaces and the position of character
 * data. Ignore comments and the CSS/JS values deliberately minified elsewhere.
 * This is a preservation check, not a replacement for EPUBCheck validation.
 */
export function xhtmlStructure($: CheerioAPI): string {
  const hash = createHash("sha256");
  const stack: Visit[] = ($.root().children().toArray() as unknown as XmlNode[])
    .reverse()
    .map((node) => ({ node, literal: false }));
  let text: string[] = [];
  const flushText = () => {
    if (text.length) {
      hash.update(JSON.stringify(["text", text.join("").replace(/\r\n?/g, "\n")]));
      text = [];
    }
  };

  while (stack.length) {
    const { node, literal, ignoreText, close } = stack.pop()!;
    if (close) {
      flushText();
      hash.update("]");
    } else if (node.type === "text") {
      if (!ignoreText)
        text.push(literal ? (node.data ?? "") : decodeXhtmlEntities(node.data ?? ""));
    } else if (node.name && ["tag", "script", "style"].includes(node.type)) {
      flushText();
      const attributes = Object.entries(node.attribs ?? {})
        .filter(
          ([name]) =>
            name === "id" || name === "xml:id" || name === "xmlns" || name.startsWith("xmlns:")
        )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, value]) => [name, decodeXhtmlEntities(value)]);
      hash.update(JSON.stringify(["element", node.name, attributes]));
      stack.push({ node, literal, close: true });
      const localName = node.name.split(":").at(-1)?.toLowerCase();
      for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--)
        stack.push({
          node: node.children![i]!,
          literal,
          ignoreText: ignoreText || localName === "script" || localName === "style",
        });
    } else if (node.type === "cdata") {
      for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--)
        stack.push({ node: node.children![i]!, literal: true, ignoreText });
    }
  }
  flushText();
  return hash.digest("hex");
}
