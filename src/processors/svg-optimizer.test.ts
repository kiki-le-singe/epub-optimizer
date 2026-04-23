import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { optimizeSVGs } from "./svg-optimizer.js";

const tempDir = path.join(os.tmpdir(), "epub-optimizer-test-svg-opt");

const svgWithComments = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><!-- comment --><rect width="100" height="100" fill="red"/></svg>`;
const notSVG = `<html><body>Not an SVG</body></html>`;

describe("optimizeSVGs", () => {
  beforeEach(async () => {
    await fs.remove(tempDir);
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it("minifies SVG files", async () => {
    // Create OPS structure for this test
    const opsDir = path.join(tempDir, "OPS");
    const imagesDir = path.join(opsDir, "images");
    await fs.ensureDir(imagesDir);

    const file = path.join(imagesDir, "test.svg");
    await fs.writeFile(file, svgWithComments);
    await optimizeSVGs(tempDir);
    const result = await fs.readFile(file, "utf8");
    expect(result).not.toContain("<!--");
    expect(result).toContain("<svg");
    expect(result).toContain('fill="red"');
    expect(result.length).toBeLessThan(svgWithComments.length);
  });

  it("skips non-SVG files", async () => {
    // Create OPS structure for this test
    const opsDir = path.join(tempDir, "OPS");
    const imagesDir = path.join(opsDir, "images");
    await fs.ensureDir(imagesDir);

    const file = path.join(imagesDir, "not-svg.html");
    await fs.writeFile(file, notSVG);
    await optimizeSVGs(tempDir);
    const result = await fs.readFile(file, "utf8");
    expect(result).toContain("Not an SVG");
  });

  it("works with OEBPS directory structure", async () => {
    // Clean up OPS structure and create OEBPS structure
    await fs.remove(tempDir);
    const oebpsDir = path.join(tempDir, "OEBPS");
    const oebpsImagesDir = path.join(oebpsDir, "images");
    await fs.ensureDir(oebpsImagesDir);

    const file = path.join(oebpsImagesDir, "test.svg");
    await fs.writeFile(file, svgWithComments);
    await optimizeSVGs(tempDir);
    const result = await fs.readFile(file, "utf8");
    expect(result).not.toContain("<!--");
    expect(result).toContain("<svg");
    expect(result).toContain('fill="red"');
    expect(result.length).toBeLessThan(svgWithComments.length);
  });
});
