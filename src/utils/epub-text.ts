import fs from "fs-extra";
import path from "node:path";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { collectManifestResources } from "./epub-utils.js";
import { collectFiles, hasExtension } from "./files.js";
import { decodeXhtmlEntities, isXHTMLContent, normalizeVoidElements } from "./xhtml.js";

/** SHA-256 of each document's reader-visible text, keyed by its EPUB path. */
export type EpubTextSnapshot = Map<string, string>;

const DOCUMENT_QUERY = {
  mediaTypes: new Set(["application/xhtml+xml", "text/html", "image/svg+xml"]),
  extensions: new Set([".xhtml", ".html", ".svg"]),
};
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"]);
const SVG_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["text", "title", "desc", "foreignobject"]);

interface DomNode {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
}

function collectSvgText(node: DomNode, parts: string[]): void {
  const name = node.name?.split(":").at(-1)?.toLowerCase();
  if (name === "metadata" || (name && RAW_TEXT_ELEMENTS.has(name))) return;
  if (name && SVG_TEXT_ELEMENTS.has(name)) {
    collectText(node, true, parts);
    return;
  }
  // Whitespace between graphical elements is formatting, not displayed text.
  for (const child of node.children ?? []) collectSvgText(child, parts);
}

function collectText(node: DomNode, decodeReferences: boolean, parts: string[]): void {
  if (node.type === "text") {
    const data = node.data ?? "";
    parts.push(decodeReferences ? decodeXhtmlEntities(data) : data);
    return;
  }
  if (node.type === "comment" || node.type === "directive") return;
  if (node.name && RAW_TEXT_ELEMENTS.has(node.name.split(":").at(-1)?.toLowerCase() ?? "")) {
    return;
  }
  // CDATA content is literal: no reference inside it is resolved.
  const decodeChildren = decodeReferences && node.type !== "cdata";
  for (const child of node.children ?? []) {
    collectText(child, decodeChildren, parts);
  }
}

/**
 * Extract the text a reader sees in a content document: the character data of
 * `<body>` with references resolved, excluding scripts, styles and comments.
 * SVG documents include text, accessibility descriptions and foreign objects,
 * excluding metadata and formatting between graphical elements.
 */
export function extractDocumentText(content: string, filePath = ""): string {
  // Same detection as the HTML processor, so both read the document alike.
  const isXML =
    isXHTMLContent(content) ||
    /\.(?:xhtml|svg)$/i.test(filePath) ||
    /^(?:\s|<!--[\s\S]*?-->)*<(?:[\w.-]+:)?svg(?:\s|>)/i.test(content);
  const $ = isXML
    ? cheerio.load(normalizeVoidElements(content), { xml: { decodeEntities: false } })
    : cheerio.load(content);
  const body = $("body").first();
  const documentRoot = $.root()[0] as unknown as DomNode;
  const documentElement = documentRoot.children?.find((child) => child.type === "tag");
  const isSVG = documentElement?.name?.split(":").at(-1)?.toLowerCase() === "svg";
  const root = (body.length > 0 ? body[0] : documentRoot) as unknown as DomNode | undefined;
  const parts: string[] = [];
  if (isSVG) collectSvgText(documentRoot, parts);
  else if (root) collectText(root, isXML, parts);
  return parts.join("").replace(/\r\n?/g, "\n");
}

export async function collectEpubTextSnapshot(epubDir: string): Promise<EpubTextSnapshot> {
  const snapshot: EpubTextSnapshot = new Map();
  // The manifest also covers atypical file extensions. HTML processing walks
  // the whole archive, so include its documents even in secondary renditions.
  const [manifestDocuments, archiveDocuments] = await Promise.all([
    collectManifestResources(epubDir, DOCUMENT_QUERY),
    collectFiles(epubDir, (filePath) => hasExtension(filePath, DOCUMENT_QUERY.extensions)),
  ]);
  const documents = [...new Set([...manifestDocuments, ...archiveDocuments])];

  for (const filePath of documents.sort()) {
    const content = await fs.readFile(filePath, "utf8");
    const document = path.relative(epubDir, filePath).split(path.sep).join("/");
    // Retain a fixed-size digest per document, not the complete text of the book.
    snapshot.set(
      document,
      createHash("sha256").update(extractDocumentText(content, filePath)).digest("hex")
    );
  }

  return snapshot;
}

/** @returns One message per document whose text was lost or altered. */
export function compareEpubTextSnapshots(
  before: EpubTextSnapshot,
  after: EpubTextSnapshot
): string[] {
  const issues: string[] = [];

  for (const [document, expected] of before) {
    const actual = after.get(document);
    if (actual === undefined) {
      issues.push(`${document}: document is missing after processing.`);
      continue;
    }
    if (actual === expected) continue;

    issues.push(`${document}: text differs after processing.`);
  }

  return issues;
}

export function assertEpubTextPreserved(before: EpubTextSnapshot, after: EpubTextSnapshot): void {
  const issues = compareEpubTextSnapshots(before, after);
  if (issues.length > 0) {
    throw new Error(`Text preservation check failed:\n- ${issues.join("\n- ")}`);
  }
}
