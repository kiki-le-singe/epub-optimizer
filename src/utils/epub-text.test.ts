import { afterEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { optimizeSVGs } from "../processors/svg-optimizer.js";
import {
  assertEpubTextPreserved,
  collectEpubTextSnapshot,
  compareEpubTextSnapshots,
  extractDocumentText,
} from "./epub-text.js";

const xhtml = (body: string, head = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Title</title>${head}</head><body>${body}</body></html>`;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe("extractDocumentText", () => {
  it("reads the same text from equivalent escapings of a document", () => {
    const expected = "Le café — 1 < 2 & 3";
    for (const body of [
      "<p>Le caf&eacute;&nbsp;&mdash; 1 &lt; 2 &amp; 3</p>",
      "<p>Le caf&#233;&#160;&#8212; 1 &lt; 2 &amp; 3</p>",
      "<p>Le caf&#xe9;&#xA0;&#x2014; 1 &#x3c; 2 &#x26; 3</p>",
      "<p>Le café — <![CDATA[1 < 2 & 3]]></p>",
      "<!-- note --><p class='x'>Le <b>caf</b>é — 1 &lt; 2 &amp; 3</p>",
    ]) {
      expect(extractDocumentText(xhtml(body), "chapter.xhtml")).toBe(expected);
    }
  });

  it("tells an escaped ampersand apart from the reference it would have formed", () => {
    expect(extractDocumentText(xhtml("<p>caf&amp;eacute;</p>"), "c.xhtml")).toBe("caf&eacute;");
    expect(extractDocumentText(xhtml("<p><![CDATA[caf&eacute;]]></p>"), "c.xhtml")).toBe(
      "caf&eacute;"
    );
  });

  it("distinguishes XHTML angle-bracket entities from their HTML5 replacements", () => {
    const named = extractDocumentText(xhtml("<p>&lang;x&rang;</p>"), "c.xhtml");
    expect(named).toBe("\u2329x\u232a");
    expect(named).toBe(extractDocumentText(xhtml("<p>&#9001;x&#9002;</p>"), "c.xhtml"));
    expect(named).not.toBe(extractDocumentText(xhtml("<p>&#10216;x&#10217;</p>"), "c.xhtml"));
    expect(extractDocumentText("<!DOCTYPE html><p>&lang;x&rang;</p>", "c.html")).toBe(
      "\u27e8x\u27e9"
    );
  });

  it("reads XML numeric references without HTML5 control-character remapping", () => {
    expect(extractDocumentText(xhtml("<p>&#128;&#x80;</p>"), "c.xhtml")).toBe("\u0080\u0080");
    expect(extractDocumentText("<!DOCTYPE html><p>&#128;&#x80;</p>", "c.html")).toBe("€€");
  });

  it("ignores scripts, styles and text outside body", () => {
    const document = xhtml(
      "<p>kept</p><script>var a = 1;</script><style>p { color: red }</style>",
      "<script>ignored()</script>"
    );
    expect(extractDocumentText(document, "chapter.xhtml")).toBe("kept");
  });

  it("keeps whitespace exactly and reads HTML5-style void elements like the processor", () => {
    const document = xhtml("<p>a  <b>b</b>\r\n c<br>d</p>", '<link rel="stylesheet" href="a.css">');
    expect(extractDocumentText(document, "chapter.xhtml")).toBe("a  b\n cd");
  });

  it("reads non-XHTML documents with the HTML parser", () => {
    const html =
      "<!DOCTYPE html><html><head><title>t</title></head><body><p>caf&eacute; &copy 1</p>";
    expect(extractDocumentText(html, "chapter.html")).toBe("café © 1");
  });

  it("reads SVG text and accessibility content without graphical formatting or metadata", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <metadata><title>Editor metadata</title></metadata>
      <title>Diagram</title><desc>A &amp; B</desc>
      <g>\n <path d="M0 0h1"/>\n <text xml:space="preserve">a  <tspan>b</tspan> c</text>\n </g>
      <foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><p>extra</p></body></foreignObject>
      <script><![CDATA[ignored()]]></script><style>ignored { }</style>
    </svg>`;
    expect(extractDocumentText(svg, "chapter.SVG")).toBe("DiagramA & Ba  b cextra");
    expect(extractDocumentText(svg, "chapter.xml")).toBe("DiagramA & Ba  b cextra");
  });
});

describe("EPUB text snapshots", () => {
  async function createFixture(chapter: string, svg?: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-text-"));
    tempDirs.push(root);
    await fs.ensureDir(path.join(root, "META-INF"));
    await fs.ensureDir(path.join(root, "OPS", "text"));
    await fs.writeFile(
      path.join(root, "META-INF", "container.xml"),
      `<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>`
    );
    await fs.writeFile(
      path.join(root, "OPS", "content.opf"),
      `<package><manifest>
        <item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml"/>
        <item id="style" href="book.css" media-type="text/css"/>
        ${svg === undefined ? "" : '<item id="svg-chapter" href="text/chapter.svg" media-type="image/svg+xml"/>'}
      </manifest><spine><itemref idref="chapter"/>${svg === undefined ? "" : '<itemref idref="svg-chapter"/>'}</spine></package>`
    );
    await fs.writeFile(path.join(root, "OPS", "book.css"), "p { color: red }");
    await fs.writeFile(path.join(root, "OPS", "text", "chapter.xhtml"), chapter);
    if (svg !== undefined) await fs.writeFile(path.join(root, "OPS", "text", "chapter.svg"), svg);
    return root;
  }

  it("collects the text of manifest content documents by EPUB path", async () => {
    const root = await createFixture(xhtml("<p>Hello&nbsp;world</p>"));
    const snapshot = await collectEpubTextSnapshot(root);
    expect([...snapshot]).toEqual([
      ["OPS/text/chapter.xhtml", createHash("sha256").update("Hello world").digest("hex")],
    ]);
  });

  it("accepts re-encoded markup and rejects altered, lost or missing text", async () => {
    const before = await collectEpubTextSnapshot(
      await createFixture(xhtml("<p>caf&eacute; ok</p>"))
    );
    const same = await collectEpubTextSnapshot(
      await createFixture(xhtml("<p>caf&#xe9; <i>ok</i></p>"))
    );
    const corrupted = await collectEpubTextSnapshot(
      await createFixture(xhtml("<p>caf&amp;eacute; ok</p>"))
    );

    expect(compareEpubTextSnapshots(before, same)).toEqual([]);
    expect(() => assertEpubTextPreserved(before, same)).not.toThrow();

    expect(compareEpubTextSnapshots(before, corrupted)).toEqual([
      "OPS/text/chapter.xhtml: text differs after processing.",
    ]);
    expect(() => assertEpubTextPreserved(before, corrupted)).toThrow(
      "Text preservation check failed"
    );
    expect(compareEpubTextSnapshots(before, new Map())).toEqual([
      "OPS/text/chapter.xhtml: document is missing after processing.",
    ]);
  });

  it("keeps large snapshots compact and still detects a same-length change at the end", async () => {
    const text = "Large chapter ".repeat(100_000);
    const root = await createFixture(xhtml(`<p>${text}a</p>`));
    const before = await collectEpubTextSnapshot(root);
    expect(before.get("OPS/text/chapter.xhtml")?.length).toBeLessThan(100);

    await fs.writeFile(path.join(root, "OPS", "text", "chapter.xhtml"), xhtml(`<p>${text}b</p>`));
    const after = await collectEpubTextSnapshot(root);
    expect(() => assertEpubTextPreserved(before, after)).toThrow("text differs");
  });

  it.each(["text", "title", "desc"])(
    "detects changes to SVG %s in a spine document",
    async (element) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><${element}>Original</${element}></svg>`;
      const root = await createFixture(xhtml("<p>Chapter</p>"), svg);
      const before = await collectEpubTextSnapshot(root);
      expect(before.has("OPS/text/chapter.svg")).toBe(true);
      await fs.writeFile(
        path.join(root, "OPS", "text", "chapter.svg"),
        svg.replace("Original", "Changed")
      );
      const after = await collectEpubTextSnapshot(root);
      expect(compareEpubTextSnapshots(before, after)).toEqual([
        "OPS/text/chapter.svg: text differs after processing.",
      ]);
    }
  );

  it.each([
    "",
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
    '<?xml version="1.0"?><!-- editor --><!DOCTYPE svg>',
  ])("accepts SVG optimization with prolog %s", async (prolog) => {
    const svg = `${prolog}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <metadata>Editor data</metadata>
      <title>Diagram</title><desc>Accessible description</desc>
      <g>\n <rect width="100" height="100"/>\n <text xml:space="preserve">A  <tspan>B</tspan> C</text>\n </g>
    </svg>`;
    const root = await createFixture(xhtml("<p>Chapter</p>"), svg);
    const before = await collectEpubTextSnapshot(root);
    await optimizeSVGs(root);
    const optimized = await fs.readFile(path.join(root, "OPS", "text", "chapter.svg"), "utf8");
    expect(optimized).not.toContain("Editor data");
    expect(optimized.length).toBeLessThan(svg.length);
    const after = await collectEpubTextSnapshot(root);
    expect(() => assertEpubTextPreserved(before, after)).not.toThrow();
  });

  it("checks documents in a secondary rendition even when the first manifest is usable", async () => {
    const root = await createFixture(xhtml("<p>Primary edition</p>"));
    await fs.ensureDir(path.join(root, "Secondary"));
    const secondaryPath = path.join(root, "Secondary", "chapter.XHTML");
    await fs.writeFile(secondaryPath, xhtml("<p>Secondary edition</p>"));
    await fs.writeFile(
      path.join(root, "Secondary", "content.opf"),
      '<package><manifest><item id="secondary" href="chapter.XHTML" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="secondary"/></spine></package>'
    );
    await fs.writeFile(
      path.join(root, "META-INF", "container.xml"),
      '<container><rootfiles><rootfile full-path="OPS/content.opf"/><rootfile full-path="Secondary/content.opf"/></rootfiles></container>'
    );
    const before = await collectEpubTextSnapshot(root);
    expect([...before.keys()]).toEqual(["OPS/text/chapter.xhtml", "Secondary/chapter.XHTML"]);
    await fs.writeFile(secondaryPath, xhtml("<p>Changed edition</p>"));
    const after = await collectEpubTextSnapshot(root);
    expect(compareEpubTextSnapshots(before, after)).toEqual([
      "Secondary/chapter.XHTML: text differs after processing.",
    ]);
  });
});
