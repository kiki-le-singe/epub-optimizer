import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnimatedPng } from "../../scripts/image-fixtures.js";
import type { ImageQualityRecord } from "../utils/image-quality-record.js";
import { convertToWebp } from "./webp-converter.js";

/** Smooth photo-like pixels with optional transparency in the left third. */
function photo(width: number, height: number, alpha = false): Buffer {
  const channels = alpha ? 4 : 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const ring = Math.sin(Math.hypot(x - width / 3, y - height / 2) / 9) * 60;
      pixels[offset] = Math.max(0, Math.min(255, (x / width) * 200 + ring + 30));
      pixels[offset + 1] = Math.max(0, Math.min(255, (y / height) * 180 - ring + 50));
      pixels[offset + 2] = Math.max(0, Math.min(255, 128 + ring + Math.sin(x / 5) * 40));
      if (alpha) pixels[offset + 3] = x < width / 3 ? 0 : 255;
    }
  return pixels;
}
const png = (width: number, height: number, alpha = false) =>
  sharp(photo(width, height, alpha), { raw: { width, height, channels: alpha ? 4 : 3 } })
    .png()
    .toBuffer();
const jpeg = (width: number, height: number) =>
  sharp(photo(width, height), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();

describe("WebP conversion", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "webp-converter-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(root);
  });

  /** Writes a book whose chapter and stylesheet reference every image once. */
  async function book(
    images: Record<string, Buffer>,
    options: { version?: string; metadata?: string; coverId?: string } = {}
  ) {
    const names = Object.keys(images);
    const type = (name: string) => (name.endsWith(".png") ? "image/png" : "image/jpeg");
    await fs.outputFile(
      path.join(root, "META-INF/container.xml"),
      '<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>'
    );
    await fs.outputFile(
      path.join(root, "OPS/content.opf"),
      `<package version="${options.version ?? "3.0"}"><metadata>${options.metadata ?? ""}</metadata><manifest>${names
        .map(
          (name, index) =>
            `<item id="i${index}" href="images/${name}" media-type="${type(name)}"${name === options.coverId ? ' properties="cover-image"' : ""}/>`
        )
        .join(
          ""
        )}<item id="c" href="text/c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>`
    );
    await fs.outputFile(
      path.join(root, "OPS/text/c.xhtml"),
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>${names
        .map((name) => `<img src="../images/${name}?v=1#top" alt="${name}"/>`)
        .join("")}</body></html>`
    );
    await fs.outputFile(
      path.join(root, "OPS/style.css"),
      names.map((name, index) => `.b${index}{background:url("images/${name}")}`).join("")
    );
    for (const [name, bytes] of Object.entries(images))
      await fs.outputFile(path.join(root, "OPS/images", name), bytes);
    const read = (file: string) => fs.readFile(path.join(root, "OPS", file), "utf8");
    return { read, list: async () => (await fs.readdir(path.join(root, "OPS/images"))).sort() };
  }

  it("converts PNG and JPEG images, keeps alpha and rewrites every reference", async () => {
    const { read, list } = await book({
      "art.png": await png(500, 400, true),
      "photo.jpg": await jpeg(600, 400),
    });
    const records: ImageQualityRecord[] = [];

    const converted = await convertToWebp(root, {
      quality: 80,
      concurrency: 2,
      onQuality: (record) => records.push(record),
    });

    expect([...converted].map((file) => path.basename(file)).sort()).toEqual([
      "art.webp",
      "photo.webp",
    ]);
    expect(await list()).toEqual(["art.webp", "photo.webp"]);
    const art = await sharp(path.join(root, "OPS/images/art.webp")).metadata();
    expect([art.format, art.width, art.height, art.hasAlpha]).toEqual(["webp", 500, 400, true]);
    const opf = await read("content.opf");
    expect(opf).toContain('href="images/art.webp" media-type="image/webp"');
    expect(opf).toContain('href="images/photo.webp" media-type="image/webp"');
    expect(opf).not.toMatch(/\.png|\.jpg|image\/png|image\/jpeg/);
    const chapter = await read("text/c.xhtml");
    expect(chapter).toContain('<img src="../images/art.webp?v=1#top" alt="art.png"/>');
    expect(chapter).toContain('<img src="../images/photo.webp?v=1#top" alt="photo.jpg"/>');
    expect(await read("style.css")).toBe(
      '.b0{background:url("images/art.webp")}.b1{background:url("images/photo.webp")}'
    );
    expect(records.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      {
        path: "OPS/images/art.png",
        operation: "to-webp",
        convertedTo: "OPS/images/art.webp",
        ssim: expect.any(Number),
        outcome: "accepted",
      },
      {
        path: "OPS/images/photo.jpg",
        operation: "to-webp",
        convertedTo: "OPS/images/photo.webp",
        ssim: expect.any(Number),
        outcome: "accepted",
      },
    ]);
  });

  it("leaves EPUB 2 packages unchanged", async () => {
    const original = await jpeg(600, 400);
    const { list, read } = await book({ "photo.jpg": original }, { version: "2.0" });

    expect((await convertToWebp(root)).size).toBe(0);

    expect(await list()).toEqual(["photo.jpg"]);
    expect(await read("content.opf")).toContain('href="images/photo.jpg" media-type="image/jpeg"');
    expect(await read("text/c.xhtml")).toContain("photo.jpg");
  });

  it("keeps cover images and animated PNGs in their original format", async () => {
    const original = await jpeg(600, 400);
    const animated = createAnimatedPng();
    expect(animated.length).toBeGreaterThan(10 * 1024);
    const { list } = await book(
      {
        "cover.jpg": original,
        "legacy-cover.jpg": original,
        "moving.png": animated,
        "page.jpg": original,
      },
      // i1 is the second image: the EPUB 2 style cover pointer.
      { coverId: "cover.jpg", metadata: '<meta name="cover" content="i1"/>' }
    );

    const converted = await convertToWebp(root);

    expect([...converted].map((file) => path.basename(file))).toEqual(["page.webp"]);
    expect(await list()).toEqual(["cover.jpg", "legacy-cover.jpg", "moving.png", "page.webp"]);
    expect((await fs.readFile(path.join(root, "OPS/images/moving.png"))).equals(animated)).toBe(
      true
    );
  });

  it("never overwrites a resource when two sources or an existing file share the target name", async () => {
    const { list, read } = await book({
      "same.png": await png(400, 300),
      "same.jpg": await jpeg(400, 300),
      "taken.jpg": await jpeg(400, 300),
    });
    await fs.writeFile(path.join(root, "OPS/images/taken.webp"), "existing resource");

    expect((await convertToWebp(root)).size).toBe(0);

    expect(await list()).toEqual(["same.jpg", "same.png", "taken.jpg", "taken.webp"]);
    expect(await fs.readFile(path.join(root, "OPS/images/taken.webp"), "utf8")).toBe(
      "existing resource"
    );
    expect(await read("content.opf")).not.toContain("webp");
  });

  it("falls back to lossless WebP for a PNG and keeps a JPEG that cannot reach the threshold", async () => {
    const source = await png(500, 400, true);
    const photoBytes = await jpeg(600, 400);
    const { list } = await book({ "art.png": source, "photo.jpg": photoBytes });
    const records: ImageQualityRecord[] = [];

    const converted = await convertToWebp(root, {
      quality: 1,
      minSsim: 0.9999,
      onQuality: (record) => records.push(record),
    });

    expect([...converted].map((file) => path.basename(file))).toEqual(["art.webp"]);
    expect(await list()).toEqual(["art.webp", "photo.jpg"]);
    expect((await fs.readFile(path.join(root, "OPS/images/photo.jpg"))).equals(photoBytes)).toBe(
      true
    );
    // Lossless WebP may drop colour under fully transparent pixels: compare what is displayed.
    const displayed = (input: string | Buffer) =>
      sharp(input).flatten({ background: "#123456" }).raw().toBuffer();
    expect(
      (await displayed(path.join(root, "OPS/images/art.webp"))).equals(await displayed(source))
    ).toBe(true);
    expect(records.sort((a, b) => a.path.localeCompare(b.path))).toMatchObject([
      { path: "OPS/images/art.png", outcome: "fallback", convertedTo: "OPS/images/art.webp" },
      { path: "OPS/images/photo.jpg", outcome: "kept-original" },
    ]);
    expect(records[1]).not.toHaveProperty("convertedTo");
  });

  it("applies JPEG orientation to the pixels before the size limit", async () => {
    const rotated = await sharp(photo(600, 300), { raw: { width: 600, height: 300, channels: 3 } })
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { list } = await book({ "rotated.jpg": rotated });

    await convertToWebp(root, { quality: 90, maxDim: 200 });

    expect(await list()).toEqual(["rotated.webp"]);
    const metadata = await sharp(path.join(root, "OPS/images/rotated.webp")).metadata();
    // Orientation 6 displays the 600×300 pixels as 300×600; the limit then gives 100×200.
    expect([metadata.width, metadata.height, metadata.orientation]).toEqual([100, 200, undefined]);
  });

  it("keeps an image that WebP would not make smaller", async () => {
    const noise = Buffer.alloc(800 * 800 * 3);
    let seed = 7;
    for (let index = 0; index < noise.length; index++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[index] = seed >>> 24;
    }
    const compact = await sharp(noise, { raw: { width: 800, height: 800, channels: 3 } })
      .jpeg({ quality: 1 })
      .toBuffer();
    expect(compact.length).toBeGreaterThan(10 * 1024);
    const { list, read } = await book({ "compact.jpg": compact });
    const records: ImageQualityRecord[] = [];

    const converted = await convertToWebp(root, {
      quality: 90,
      onQuality: (record) => records.push(record),
    });

    expect(converted.size).toBe(0);
    expect(await list()).toEqual(["compact.jpg"]);
    expect((await fs.readFile(path.join(root, "OPS/images/compact.jpg"))).equals(compact)).toBe(
      true
    );
    expect(await read("text/c.xhtml")).toContain("compact.jpg");
    expect(records).toEqual([]);
  });

  it("keeps the source when an image has no rewritable reference", async () => {
    const { list, read } = await book({ "orphan.jpg": await jpeg(600, 400) });
    await fs.writeFile(path.join(root, "OPS/text/c.xhtml"), "<html><body/></html>");
    await fs.writeFile(path.join(root, "OPS/style.css"), "");

    expect((await convertToWebp(root)).size).toBe(0);

    expect(await list()).toEqual(["orphan.jpg"]);
    expect(await read("content.opf")).toContain('href="images/orphan.jpg" media-type="image/jpeg"');
  });
});
