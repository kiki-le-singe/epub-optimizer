import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createAnimatedPng, pngChunk } from "../../scripts/image-fixtures.js";
import { isAnimatedPng } from "./png-animation.js";

describe("PNG animation detection", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "epub-png-animation-"));
    file = path.join(dir, "image.png");
  });
  afterEach(async () => {
    await fs.remove(dir);
  });

  it("finds animation control after a large ancillary chunk", async () => {
    const png = createAnimatedPng();
    const text = pngChunk("tEXt", Buffer.from(`Comment\0${"x".repeat(128 * 1024)}`));
    await fs.writeFile(file, Buffer.concat([png.subarray(0, 33), text, png.subarray(33)]));
    expect(await isAnimatedPng(file)).toBe(true);
  });

  it("ignores animation-like text inside a static PNG's ancillary payload", async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const text = pngChunk("tEXt", Buffer.from("Comment\0acTL is just text here"));
    await fs.writeFile(file, Buffer.concat([png.subarray(0, 33), text, png.subarray(33)]));
    expect(await isAnimatedPng(file)).toBe(false);
  });

  it("rejects a truncated chunk instead of treating it as a static image", async () => {
    const png = createAnimatedPng();
    await fs.writeFile(file, png.subarray(0, 45));
    await expect(isAnimatedPng(file)).rejects.toThrow("Incomplete PNG chunk structure");
  });

  it.each(["", "not a PNG image"])(
    "does not identify non-PNG input as animated: %j",
    async (data) => {
      await fs.writeFile(file, data);
      expect(await isAnimatedPng(file)).toBe(false);
    }
  );
});
