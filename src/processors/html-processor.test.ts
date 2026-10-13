import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { Script, runInNewContext } from "node:vm";
import * as cheerio from "cheerio";
import { minifyHTML } from "./html-processor.js";

const sampleHTML = `<!DOCTYPE html>
<html>
  <head>
    <title>Test</title>
    <style>  body { color: red; }  </style>
  </head>
  <body>
    <h1>  Hello   World!  </h1>
    <!-- comment -->
  </body>
</html>`;

const expectedMinified = `<!DOCTYPE html><html><head><title>Test</title><style>body{color:red}</style></head><body><h1>Hello World!</h1></body></html>`;

const tempDir = path.join(os.tmpdir(), "epub-optimizer-test");
const tempFile = path.join(tempDir, "test.html");

describe("minifyHTML", () => {
  beforeEach(async () => {
    await fs.ensureDir(tempDir);
    await fs.writeFile(tempFile, sampleHTML);
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it("minifies HTML file as expected", async () => {
    await minifyHTML(tempFile);
    const result = await fs.readFile(tempFile, "utf8");
    // Remove whitespace for comparison
    expect(result.replace(/\s+/g, "")).toBe(expectedMinified.replace(/\s+/g, ""));
  });

  it("preserves text whitespace whose rendering is controlled by external CSS", async () => {
    const poem = "First line\n    Second line";
    await fs.writeFile(
      tempFile,
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Poem</title><link rel="stylesheet" href="book.css"/></head><body><p class="poem">${poem}</p></body></html>`
    );
    await fs.writeFile(path.join(tempDir, "book.css"), ".poem { white-space: pre-wrap; }");
    await minifyHTML(tempFile);
    expect(await fs.readFile(tempFile, "utf8")).toContain(`<p class="poem">${poem}</p>`);
  });

  it("preserves attribute values and script strings in valid XHTML", async () => {
    await fs.writeFile(
      tempFile,
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><img src="x.jpg" alt="a > b"/><script><![CDATA[window.marker = "<br>";]]></script></body></html>`
    );
    await minifyHTML(tempFile);
    const $ = cheerio.load(await fs.readFile(tempFile, "utf8"), { xmlMode: true });
    expect($("img").attr("alt")).toBe("a > b");
    expect($("script").text()).toContain('"<br>"');
  });

  const xhtml = (body: string, head = "") =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title>${head}</head><body>${body}</body></html>`;
  const minifyXhtml = async (body: string, head = "") => {
    const file = path.join(tempDir, "test.xhtml");
    await fs.writeFile(file, xhtml(body, head));
    await minifyHTML(file);
    const output = await fs.readFile(file, "utf8");
    return { output, $: cheerio.load(output, { xmlMode: true }) };
  };

  it("preserves HTML named character references used by EPUB 2 documents", async () => {
    const { output, $ } = await minifyXhtml(
      `<p title="caf&eacute;">Le caf&eacute;&nbsp;&mdash; na&iuml;ve &laquo;&nbsp;x&nbsp;&raquo; 1 &lt; 2 &amp; 3</p>`
    );
    expect($("p").text()).toBe("Le café\u00a0— naïve «\u00a0x\u00a0» 1 < 2 & 3");
    expect($("p").attr("title")).toBe("café");
    expect(output).not.toContain("&amp;eacute;");
  });

  it("preserves the text of CDATA sections outside script and style", async () => {
    const code = 'if (a < b && c[0]> d) { print("<tag>&nbsp;"); }';
    const { output, $ } = await minifyXhtml(`<pre><![CDATA[${code}]]></pre><p>after</p>`);
    expect($("pre").text()).toBe(code);
    expect($("p").text()).toBe("after");
    expect(output).not.toContain("<tag>");
  });

  it("preserves XHTML angle-bracket entities in text and attributes", async () => {
    const { $ } = await minifyXhtml('<p title="&lang;x&rang;">&lang;x&rang;</p>');
    expect($("p").text()).toBe("\u2329x\u232a");
    expect($("p").attr("title")).toBe("\u2329x\u232a");
  });

  it("keeps a CDATA-wrapped script well-formed instead of unwrapping its operators", async () => {
    const script = `//<![CDATA[\nfunction f(a, b, c, d) { if (a < b && c > d) { return "<p>"; } return ""; }\n//]]>`;
    const { output } = await minifyXhtml("<p>x</p>", `<script>${script}</script>`);
    expect(output).toContain(`<script>${script}</script>`);
  });

  it("minifies a plain XHTML script only when the result needs no XML escaping", async () => {
    const plain = await minifyXhtml(
      "<p>x</p>",
      "<script>var total = 1 + 2 ; go( total ) ;</script>"
    );
    expect(plain.output).toContain("<script>var total=3;go(total);</script>");

    // Terser would turn this into `ready&&go()`, which is not well-formed XML.
    const source = "if (ready) { go(); }";
    const guarded = await minifyXhtml(`<p onclick="${source}">x</p>`, `<script>${source}</script>`);
    expect(guarded.output).toContain(`<script>${source}</script>`);
    expect(guarded.$("p").attr("onclick")).toBe(source);
    expect(guarded.output).not.toContain("&&");
  });

  it("keeps a script when minification would introduce a CDATA terminator in XML text", async () => {
    const source = "window.marker = `\\x5d\\x5d\\x3e`;";
    const { output, $ } = await minifyXhtml("<p>x</p>", `<script>${source}</script>`);
    expect(output).not.toContain("]]>");
    expect($("script").text()).toBe(source);
    const context = { window: { marker: "" } };
    runInNewContext($("script").text(), context);
    expect(context.window.marker).toBe("]]>");
  });

  it.each(["for (;;);", "while (poll());"])(
    "preserves the required empty statement in scripts and handlers: %s",
    async (source) => {
      const { $ } = await minifyXhtml(`<p onclick="${source}">x</p>`, `<script>${source}</script>`);
      expect(() => new Script($("script").text())).not.toThrow();
      expect(() => new Script(`(function () { ${$("p").attr("onclick")} })`)).not.toThrow();
    }
  );

  it("keeps @import rules of inline stylesheets", async () => {
    const { $ } = await minifyXhtml(
      "<p>x</p>",
      "<style>@import url(base.css); p { color: red; }</style>"
    );
    expect($("style").text()).toMatch(/@import url\(base\.css\);\s*p\{color:red\}/);
  });
});

const sampleCSS = `body {    color: red;    font-size: 16px;  } /* comment */`;
const expectedMinifiedCSS = `body{color:red;font-size:16px}`;
const tempCSSFile = path.join(tempDir, "test.css");

describe("minifyCSS", () => {
  beforeEach(async () => {
    await fs.ensureDir(tempDir);
    await fs.writeFile(tempCSSFile, sampleCSS);
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it("minifies CSS file as expected", async () => {
    // Import minifyCSS here to avoid hoisting issues
    const { minifyCSS } = await import("./html-processor");
    await minifyCSS(tempCSSFile);
    const result = await fs.readFile(tempCSSFile, "utf8");
    expect(result.replace(/\s+/g, "")).toBe(expectedMinifiedCSS.replace(/\s+/g, ""));
  });

  it("keeps @import rules instead of inlining or dropping them", async () => {
    const { minifyCSS } = await import("./html-processor");
    await fs.writeFile(path.join(tempDir, "base.css"), "h1 { margin: 0; }");
    await fs.writeFile(
      tempCSSFile,
      `@import "base.css";\n@import url(missing.css) screen;\np { color: red; }`
    );
    await minifyCSS(tempCSSFile);
    expect(await fs.readFile(tempCSSFile, "utf8")).toBe(
      "@import url(base.css);@import url(missing.css) screen;p{color:red}"
    );
  });

  it("keeps the original stylesheet when the minifier cannot parse it without loss", async () => {
    const { minifyCSS } = await import("./html-processor");
    for (const css of [
      ".a { color: red; &:hover { color: blue; } }",
      "@layer base { p { margin: 0; } }\n@layer base, theme;",
    ]) {
      await fs.writeFile(tempCSSFile, css);
      await minifyCSS(tempCSSFile);
      expect(await fs.readFile(tempCSSFile, "utf8")).toBe(css);
    }
  });
});
