import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compressImage } from "../processors/image-processor.js";
import { convertPngToJpeg } from "../processors/image-converter.js";
import {
  DEFAULT_MIN_IMAGE_SSIM,
  imageSsim,
  resolveMinImageSsim,
  type ImageQualityRecord,
} from "./image-quality.js";

/** Smooth photo-like raster: gradients plus soft circles, so JPEG quality matters. */
function photo(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const ring = Math.sin(Math.hypot(x - width / 3, y - height / 2) / 9) * 60;
      pixels[offset] = Math.max(0, Math.min(255, (x / width) * 200 + ring + 30));
      pixels[offset + 1] = Math.max(0, Math.min(255, (y / height) * 180 - ring + 50));
      pixels[offset + 2] = Math.max(0, Math.min(255, 128 + ring + Math.sin(x / 5) * 40));
    }
  return pixels;
}
const raw = (width: number, height: number) => ({ raw: { width, height, channels: 3 as const } });

describe("image quality guard", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "image-quality-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("scores identical images 1, ignores intended resizing and drops for heavy loss", async () => {
    const source = await sharp(photo(400, 300), raw(400, 300)).png().toBuffer();
    expect(await imageSsim(() => sharp(source), source)).toBeCloseTo(1, 6);
    const resized = await sharp(source).resize(200).png().toBuffer();
    expect(await imageSsim(() => sharp(source), resized)).toBeGreaterThan(0.98);
    const degraded = await sharp(source).jpeg({ quality: 2 }).toBuffer();
    expect(await imageSsim(() => sharp(source), degraded)).toBeLessThan(DEFAULT_MIN_IMAGE_SSIM);
  });

  it("checks transparency on dark backgrounds too", async () => {
    const width = 64,
      height = 64;
    const rgba = Buffer.alloc(width * height * 4);
    for (let index = 0; index < width * height; index++) {
      rgba[index * 4] = 255;
      rgba[index * 4 + 3] = index % width < 32 ? 255 : 0;
    }
    const source = await sharp(rgba, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    // Same pixels where opaque, but the transparent half became opaque white.
    const flattened = await sharp(source).flatten({ background: "#ffffff" }).png().toBuffer();
    expect(await imageSsim(() => sharp(source), flattened)).toBeLessThan(0.6);
  });

  it("re-encodes a JPEG at higher quality when the configured quality is too lossy", async () => {
    const file = path.join(dir, "photo.jpg");
    await sharp(photo(600, 400), raw(600, 400)).jpeg({ quality: 100 }).toFile(file);
    const records: ImageQualityRecord[] = [];
    await compressImage(file, {
      jpegQuality: 2,
      minSsim: 0.9,
      root: dir,
      onQuality: (record) => records.push(record),
    });
    expect(records).toEqual([
      { path: "photo.jpg", operation: "recompress", ssim: expect.any(Number), outcome: "fallback" },
    ]);
    expect(records[0]!.ssim).toBeGreaterThanOrEqual(0.9);
    expect(
      await imageSsim(() => sharp(photo(600, 400), raw(600, 400)), file)
    ).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps the original bytes when no smaller encode reaches the threshold", async () => {
    const file = path.join(dir, "art.png");
    await sharp(photo(300, 300), raw(300, 300)).png({ compressionLevel: 9 }).toFile(file);
    const before = await fs.readFile(file);
    const records: ImageQualityRecord[] = [];
    await compressImage(file, {
      pngQuality: 0.01,
      minSsim: 0.999,
      root: dir,
      onQuality: (record) => records.push(record),
    });
    expect((await fs.readFile(file)).equals(before)).toBe(true);
    expect(records).toMatchObject([{ path: "art.png", outcome: "kept-original" }]);
    expect((await fs.readdir(dir)).sort()).toEqual(["art.png"]);
  });

  it("does not measure when the guard is disabled", async () => {
    const file = path.join(dir, "photo.jpg");
    await sharp(photo(600, 400), raw(600, 400)).jpeg({ quality: 100 }).toFile(file);
    const records: ImageQualityRecord[] = [];
    await compressImage(file, { jpegQuality: 2, minSsim: 0, onQuality: (r) => records.push(r) });
    expect(records).toEqual([]);
    expect(await imageSsim(() => sharp(photo(600, 400), raw(600, 400)), file)).toBeLessThan(0.9);
  });

  it("keeps a PNG whose JPEG conversion stays below the threshold", async () => {
    const root = path.join(dir, "book");
    const images = path.join(root, "OPS/images");
    await fs.mkdir(path.join(root, "META-INF"), { recursive: true });
    await fs.mkdir(images, { recursive: true });
    await fs.writeFile(
      path.join(root, "META-INF/container.xml"),
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    );
    await fs.writeFile(
      path.join(root, "OPS/content.opf"),
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="p" href="images/page.png" media-type="image/png"/><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>'
    );
    await fs.writeFile(
      path.join(root, "OPS/c.xhtml"),
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="images/page.png" alt=""/></body></html>'
    );
    const png = path.join(images, "page.png");
    await sharp(photo(900, 700), raw(900, 700)).png({ compressionLevel: 0 }).toFile(png);
    const records: ImageQualityRecord[] = [];

    const converted = await convertPngToJpeg(root, 1, 1, undefined, undefined, {
      minSsim: 0.999,
      onQuality: (record) => records.push(record),
    });

    expect(converted.size).toBe(0);
    expect(await fs.readdir(images)).toEqual(["page.png"]);
    expect(records).toMatchObject([
      { path: "OPS/images/page.png", operation: "png-to-jpeg", outcome: "kept-original" },
    ]);
  });

  it("validates the configured threshold", () => {
    expect(resolveMinImageSsim(undefined)).toBe(0.85);
    expect(resolveMinImageSsim(0)).toBe(0);
    expect(resolveMinImageSsim("0.9")).toBe(0.9);
    for (const value of [-0.1, 1.5, "high", Number.NaN])
      expect(() => resolveMinImageSsim(value)).toThrow("--min-image-ssim must be between 0 and 1.");
  });
});
