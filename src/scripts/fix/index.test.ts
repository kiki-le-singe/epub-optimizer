import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { runFixes } from "./index.js";
import { run as fixSpanTags } from "./fix-span-tags.js";
import { run as fixXml } from "./fix-xml.js";
import { run as removeEmptyStyles } from "./remove-empty-styles.js";

const xhtml = (body: string) =>
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Repair</title></head><body>${body}</body></html>`;

describe("repair file discovery", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-repair-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(root);
  });

  async function fixture(opfDir: string, items: string, files: Record<string, string>) {
    const epubDir = path.join(root, "book");
    const opfPath = path.posix.join(opfDir, "book.opf");
    await fs.outputFile(
      path.join(epubDir, "META-INF", "container.xml"),
      `<container><rootfiles><rootfile full-path="${opfPath}"/></rootfiles></container>`
    );
    await fs.outputFile(
      path.join(epubDir, opfPath),
      `<package><manifest>${items}</manifest></package>`
    );
    for (const [file, content] of Object.entries(files)) {
      await fs.outputFile(path.join(epubDir, file), content);
    }
    return epubDir;
  }

  it.each([
    {
      name: "span repair",
      run: fixSpanTags,
      body: "<p><span>kept</p>",
      expected: "<span>kept</span></p>",
    },
    { name: "XML repair", run: fixXml, body: "<p>kept<br></br>after</p>", expected: "<br/>after" },
    {
      name: "empty styles",
      run: removeEmptyStyles,
      body: '<p style="">kept</p>',
      expected: "<p>kept</p>",
    },
  ])(
    "$name processes nested, uppercase and manifest-typed XHTML",
    async ({ run, body, expected }) => {
      const original = xhtml(body);
      const paths = [
        "OPS/flat.xhtml",
        "OPS/Text/part/deep.XHTML",
        "OPS/Text/part/undeclared.xhtml",
        "OPS/Text/chapter.html",
        "OPS/Text/typed.content",
        "OPS/Text/été 1.xhtml",
      ];
      const epubDir = await fixture(
        "OPS",
        `
      <item href="Text/part/deep.XHTML" media-type="application/xhtml+xml"/>
      <item href="Text/chapter.html" media-type="application/xhtml+xml"/>
      <item href="Text/typed.content" media-type="application/xhtml+xml"/>
      <item href="Text/%C3%A9t%C3%A9%201.xhtml" media-type="application/xhtml+xml"/>
    `,
        Object.fromEntries([...paths.map((file) => [file, original]), ["OPS/other.html", original]])
      );

      await run({ tempDir: epubDir });

      for (const file of paths)
        expect(await fs.readFile(path.join(epubDir, file), "utf8")).toContain(expected);
      expect(await fs.readFile(path.join(epubDir, "OPS/other.html"), "utf8")).toBe(original);
    }
  );

  it.each(["", "OEBPS", "Package/metadata"])(
    "repairs manifest resources relative to an OPF in '%s'",
    async (opfDir) => {
      const href = opfDir ? "../Text/chapter.content" : "Text/chapter.content";
      const chapter = path.posix.normalize(path.posix.join(opfDir, href));
      const epubDir = await fixture(
        opfDir,
        `<item href="${href}" media-type="application/xhtml+xml"/>`,
        {
          [chapter]: xhtml('<p style="">kept</p>'),
        }
      );
      await runFixes({ tempDir: epubDir });
      expect(await fs.readFile(path.join(epubDir, chapter), "utf8")).toContain("<p>kept</p>");
    }
  );

  it("keeps valid content when all repair passes reach a nested chapter", async () => {
    const body = `Text <em>around</em> inline elements.
<p style="" title="&quot;a &amp; b&quot;">Le café — 日本語。 &amp;lt; &lt; &eacute;</p><p itemscope="itemscope">Before <meta itemprop="name" content="Example"/>after.</p>
<script><![CDATA[window.marker = "<br></br>&";]]></script>
<style><![CDATA[p::before { content: "<tag>&"; }]]></style>`;
    const epubDir = await fixture(
      "OPS",
      '<item href="Text/ch.xhtml" media-type="application/xhtml+xml"/>',
      { "OPS/Text/ch.xhtml": xhtml(body) }
    );
    await runFixes({ tempDir: epubDir });
    const output = await fs.readFile(path.join(epubDir, "OPS/Text/ch.xhtml"), "utf8");
    const $ = cheerio.load(output, { xmlMode: true });
    expect(output).toContain("Text <em>around</em> inline elements.");
    expect(output).toContain("Le café — 日本語。");
    expect(output).not.toContain('style=""');
    expect($("p").first().attr("title")).toBe('"a & b"');
    expect($("p").first().text()).toBe("Le café — 日本語。 &lt; < é");
    expect($("meta[itemprop='name']").attr("content")).toBe("Example");
    expect(output).toContain('<script><![CDATA[window.marker = "<br></br>&";]]></script>');
    expect(output).toContain('<style><![CDATA[p::before { content: "<tag>&"; }]]></style>');
  });

  it("does not follow file or directory symlinks, unsafe manifest paths, or directories with XHTML names", async () => {
    const original = xhtml('<p style="">outside</p>');
    await fs.outputFile(path.join(root, "outside", "chapter.xhtml"), original);
    const epubDir = await fixture(
      "OPS",
      `
      <item href="linked.xhtml" media-type="application/xhtml+xml"/>
      <item href="linked-dir/chapter.xhtml" media-type="application/xhtml+xml"/>
      <item href="../../outside/chapter.xhtml" media-type="application/xhtml+xml"/>
      <item href="directory.xhtml" media-type="application/xhtml+xml"/>
    `,
      { "OPS/Text/real.xhtml": xhtml('<p style="">inside</p>') }
    );
    await fs.symlink(
      path.join(root, "outside", "chapter.xhtml"),
      path.join(epubDir, "OPS", "linked.xhtml")
    );
    await fs.symlink(path.join(root, "outside"), path.join(epubDir, "OPS", "linked-dir"), "dir");
    await fs.ensureDir(path.join(epubDir, "OPS", "directory.xhtml"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await runFixes({ tempDir: epubDir });

    expect(await fs.readFile(path.join(root, "outside", "chapter.xhtml"), "utf8")).toBe(original);
    expect(await fs.readFile(path.join(epubDir, "OPS/Text/real.xhtml"), "utf8")).toContain(
      "<p>inside</p>"
    );
    expect(errors).not.toHaveBeenCalled();
  });
});
