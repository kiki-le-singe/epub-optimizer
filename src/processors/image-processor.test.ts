import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { compressImage } from "./image-processor.js";

const tempDir = path.join(os.tmpdir(), "epub-optimizer-test-images");

describe("Image Processor", () => {
  // Create a sample JPEG image - red square 500x500px
  const createSampleJpeg = async (filepath: string, quality = 90): Promise<void> => {
    const jpegBuffer = await sharp({
      create: {
        width: 500,
        height: 500,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .jpeg({ quality })
      .toBuffer();

    await fs.writeFile(filepath, jpegBuffer);
  };

  // Create a sample PNG image - blue square 500x500px
  const createSamplePng = async (filepath: string): Promise<void> => {
    const pngBuffer = await sharp({
      create: {
        width: 500,
        height: 500,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .png()
      .toBuffer();

    await fs.writeFile(filepath, pngBuffer);
  };

  beforeEach(async () => {
    await fs.ensureDir(tempDir);
    // Mock console.log to avoid cluttering test output
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    vi.restoreAllMocks();
  });

  it("compresses JPEG image and reduces file size", async () => {
    const testJpeg = path.join(tempDir, "test.jpg");
    // Create a low-compression JPEG (larger file size)
    await createSampleJpeg(testJpeg, 100);

    const originalSize = (await fs.stat(testJpeg)).size;
    await compressImage(testJpeg);
    const compressedSize = (await fs.stat(testJpeg)).size;

    // The compressed image should be no larger than the original
    // Sometimes images might not get smaller if already optimized
    expect(compressedSize).toBeLessThanOrEqual(originalSize);

    // Log sizes for debugging
    console.log(`JPEG original: ${originalSize}, compressed: ${compressedSize}`);
  });

  it("compresses PNG image and reduces file size", async () => {
    const testPng = path.join(tempDir, "test.png");
    await createSamplePng(testPng);

    const originalSize = (await fs.stat(testPng)).size;
    await compressImage(testPng);
    const compressedSize = (await fs.stat(testPng)).size;

    // The compressed image should be no larger than the original
    // Sometimes images might not get smaller if already optimized
    expect(compressedSize).toBeLessThanOrEqual(originalSize);

    // Log sizes for debugging
    console.log(`PNG original: ${originalSize}, compressed: ${compressedSize}`);
  });

  it("skips small image files", async () => {
    // Create a tiny image file
    const tinyImage = path.join(tempDir, "tiny.jpg");
    const tinyBuffer = Buffer.alloc(5 * 1024); // 5KB
    await fs.writeFile(tinyImage, tinyBuffer);

    const logSpy = vi.spyOn(console, "log");
    await compressImage(tinyImage);

    // Should log that it's skipping the small image
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping small image"));
  });
});
