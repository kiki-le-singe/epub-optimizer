import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { collectFontCharacters } from "./font-characters.js";

const roots: string[] = [];
async function book(files: Record<string, string | Buffer> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "font-chars-"));
  roots.push(root);
  for (const [name, data] of Object.entries({
    "META-INF/container.xml":
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    "OPS/book.opf": "<package><manifest/></package>",
    "OPS/nested/ch.xhtml": "<html><body><em>α</em>\u0301 e\u0301</body></html>",
    ...files,
  })) {
    await fs.outputFile(path.join(root, name), data);
  }
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.remove(r)));
});

describe("font character collection", () => {
  it("includes navigation, SVG, attributes and NFC/NFD/case equivalents across inline nodes", async () => {
    const root = await book({
      "elsewhere/nav.xhtml": '<html><body title="Ж">中文</body></html>',
      "OPS/picture.data": '<?xml version="1.0"?><svg><text>Ω</text></svg>',
      "OPS/book.css": 'p { font-family: "Demo"; color: red; }',
    });
    const chars = await collectFontCharacters(path.relative(process.cwd(), root));
    for (const c of "άα\u0301ΆЖ中文ΩéÉ") expect(chars).toContain(c);
    expect(new Set(chars).size).toBe([...chars].length);
  });
  it.each([
    ["script tag", '<html><body><script>document.write("☃")</script></body></html>'],
    ["event handler", '<html><body onload="x()">text</body></html>'],
    ["MathML", "<html><body><math><mi>x</mi></math></body></html>"],
    ["embedded document", '<html><body><object data="remote.html"/></body></html>'],
    [
      "remote CSS",
      '<html><head><link rel="stylesheet" href="https://example.org/a.css"/></head><body>text</body></html>',
    ],
    ["DTD", '<!DOCTYPE html [<!ENTITY example "☃">]><html><body>&example;</body></html>'],
  ])("refuses unknown displayed characters: %s", async (_, xml) => {
    await expect(
      collectFontCharacters(await book({ "OPS/nested/ch.xhtml": xml }))
    ).rejects.toThrow();
  });
  it.each([
    'p{content:"☃"}',
    "p{content:counter(chapter)}",
    'p{c\\6f ntent:"☃"}',
    '@import "other.css";',
    "p{text-transform:full-width}",
    "p{list-style-type:armenian}",
    "p{color:var(--color)}",
  ])("refuses uncertain CSS: %s", async (css) => {
    await expect(collectFontCharacters(await book({ "OPS/book.css": css }))).rejects.toThrow();
  });
  it("checks inline CSS independently of XML quoting and text examples", async () => {
    await expect(
      collectFontCharacters(
        await book({
          "OPS/nested/ch.xhtml": '<html><body style="co/**/ntent:&quot;☃&quot;">text</body></html>',
        })
      )
    ).rejects.toThrow("Generated CSS");
    await expect(
      collectFontCharacters(
        await book({
          "OPS/nested/ch.xhtml":
            '<html><head><style>p{content:"☃"}</style></head><body>text</body></html>',
        })
      )
    ).rejects.toThrow("Generated CSS");
    await expect(
      collectFontCharacters(
        await book({ "OPS/nested/ch.xhtml": "<html><body>Example: counter(chapter)</body></html>" })
      )
    ).resolves.toContain("E");
  });
  it.each([
    '<html><head><link rel="StyleSheet" href=" https://example.org/style.css "/></head><body>text</body></html>',
    '<svg text-transform="full-width"><text>ABC</text></svg>',
    '<svg><use href="https://example.org/text.svg#text"/></svg>',
    '<svg><tref href="other.svg#text"/></svg>',
  ])("preserves fonts for external or transformed SVG/CSS text", async (xml) => {
    await expect(
      collectFontCharacters(await book({ "OPS/nested/ch.xhtml": xml }))
    ).rejects.toThrow();
  });
  it("accepts ordinary doctypes followed by brackets in the document text", async () => {
    await expect(
      collectFontCharacters(
        await book({
          "OPS/nested/ch.xhtml": "<!DOCTYPE html><html><body>[ordinary text]</body></html>",
        })
      )
    ).resolves.toContain("[");
  });
  it("reads manifest-declared text without recognizable file extensions", async () => {
    const root = await book({
      "OPS/book.opf":
        '<package><manifest><item href="style.data" media-type="text/css"/></manifest></package>',
      "OPS/style.data": 'p{content:"☃"}',
    });
    await expect(collectFontCharacters(root)).rejects.toThrow("Generated CSS");
  });
  it("accepts ordinary safe declarations and empty generated content", async () => {
    await expect(
      collectFontCharacters(
        await book({
          "OPS/book.css": 'p{content:"";text-transform:uppercase;list-style-type:upper-roman}',
        })
      )
    ).resolves.toContain("ά");
  });
  it("refuses scripts even when they are separate resources", async () => {
    await expect(collectFontCharacters(await book({ "OPS/code.js": "alert(1)" }))).rejects.toThrow(
      "Scripted"
    );
  });
  it("refuses symlinks, unreadable encodings, excessive text and excessive character sets", async () => {
    const root = await book();
    await fs.symlink(os.tmpdir(), path.join(root, "linked"));
    await expect(collectFontCharacters(root)).rejects.toThrow("Symlink");
    await expect(
      collectFontCharacters(await book({ "OPS/a.xhtml": Buffer.from([0xff, 0xfe, 0x3c, 0]) }))
    ).rejects.toThrow();
    await expect(
      collectFontCharacters(await book({ "OPS/a.css": "x".repeat(16 * 1024 * 1024) }))
    ).rejects.toThrow("16 MiB");
    const many = Array.from({ length: 66_000 }, (_, i) => String.fromCodePoint(i + 0x10000)).join(
      ""
    );
    await expect(collectFontCharacters(await book({ "OPS/a.css": many }))).rejects.toThrow(
      "character limit"
    );
  }, 15_000);
});
