import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
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
