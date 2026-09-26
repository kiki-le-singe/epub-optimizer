import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { compressImage } from "./image-processor.js";

// Guards the optimizer's core promise — shrink images WITHOUT corrupting them —
// against silent regressions from a sharp/libvips/mozjpeg upgrade. Uses a
// realistic, compressible generated image (a smooth gradient with structure),
// never a committed EPUB, so the repo stays binary-free.

const tempDir = path.join(os.tmpdir(), "epub-optimizer-image-quality-test");

/** Builds a smooth RGB gradient — compressible and structured (unlike noise). */
function gradient(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.round((x / (width - 1)) * 255);
      raw[i + 1] = Math.round((y / (height - 1)) * 255);
      raw[i + 2] = Math.round(((x + y) / (width + height - 2)) * 255);
    }
  }
  return raw;
}

async function writeGradientJpeg(
  filePath: string,
  width: number,
  height: number,
  quality = 95
): Promise<void> {
  await sharp(gradient(width, height), { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toFile(filePath);
}

/** Mean absolute per-channel pixel difference (0-255) between two same-size images. */
async function meanAbsDiff(pathA: string, pathB: string): Promise<number> {
  const a = await sharp(pathA).removeAlpha().raw().toBuffer();
  const b = await sharp(pathB).removeAlpha().raw().toBuffer();
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.abs(a[i]! - b[i]!);
  }
  return sum / n;
}

describe("image optimization quality", () => {
  beforeEach(async () => {
    await fs.ensureDir(tempDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    vi.restoreAllMocks();
  });

  it("keeps original bytes when a higher-quality recompression would grow a JPEG", async () => {
    const raw = Buffer.alloc(512 * 512 * 3);
    let seed = 42;
    for (let i = 0; i < raw.length; i++) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      raw[i] = seed >>> 24;
    }
    const file = path.join(tempDir, "already-compressed.jpg");
    await sharp(raw, { raw: { width: 512, height: 512, channels: 3 } })
      .jpeg({ quality: 20, mozjpeg: true })
      .toFile(file);
    const original = await fs.readFile(file);
    expect(original.length).toBeGreaterThan(10 * 1024);
    // A configured maxDim that does not resize must not bypass the size guard.
    await compressImage(file, { jpegQuality: 70, maxDim: 1600 });
    expect(await fs.readFile(file)).toEqual(original);
    expect((await fs.readdir(tempDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("re-encodes a JPEG smaller while staying faithful and same-size", async () => {
    const file = path.join(tempDir, "photo.jpg");
    await writeGradientJpeg(file, 1200, 900);
    const before = await fs.stat(file);
    const original = path.join(tempDir, "photo.original.jpg");
    await fs.copy(file, original);

    await compressImage(file, { jpegQuality: 70 });

    const meta = await sharp(file).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(900);

    const after = await fs.stat(file);
    expect(after.size).toBeLessThan(before.size);

    // Faithful: a real q70 re-encode of a smooth image stays very close to the
    // source. A corrupt/blank/garbled output would blow this far past the bound.
    const mad = await meanAbsDiff(original, file);
    expect(mad).toBeLessThan(8);
  });

  it("downscales to maxDim while preserving aspect ratio and validity", async () => {
    const file = path.join(tempDir, "large.jpg");
    await writeGradientJpeg(file, 2000, 1000);

    await compressImage(file, { jpegQuality: 70, maxDim: 1000 });

    const meta = await sharp(file).metadata();
    expect(meta.format).toBe("jpeg");
    // fit:inside → longest edge clamped to maxDim, aspect (2:1) preserved.
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(500);
  });

  it("preserves every frame and its timing in an animated GIF", async () => {
    const width = 256;
    const height = 256;
    const raw = Buffer.concat([gradient(width, height), gradient(width, height).reverse()]);
    const file = path.join(tempDir, "animation.gif");
    await sharp(raw, { raw: { width, height: height * 2, channels: 3, pageHeight: height } })
      .gif({ delay: [100, 200], loop: 0 })
      .toFile(file);
    expect((await fs.stat(file)).size).toBeGreaterThan(10 * 1024);
    await compressImage(file);
    const metadata = await sharp(file, { animated: true }).metadata();
    expect(metadata.pages).toBe(2);
    expect(metadata.delay).toEqual([100, 200]);
    expect(metadata.pageHeight).toBe(height);
    expect(metadata.width).toBe(width);
  });

  it("re-encodes a PNG to a valid same-size image", async () => {
    const file = path.join(tempDir, "art.png");
    await sharp(gradient(800, 600), { raw: { width: 800, height: 600, channels: 3 } })
      .png()
      .toFile(file);

    await compressImage(file, { pngQuality: 0.6 });

    const meta = await sharp(file).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
  });
});
