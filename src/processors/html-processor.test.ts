import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
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
});
