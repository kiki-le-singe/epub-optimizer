import fs from "node:fs/promises";
import sharp, { type Sharp } from "sharp";

/** Default minimum SSIM accepted for a lossy image re-encode (0 disables the guard). */
export const DEFAULT_MIN_IMAGE_SSIM = 0.85;

export type { ImageQualityOutcome, ImageQualityRecord } from "./image-quality-record.js";

const WINDOW = 8;
const STEP = 4;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/** Mean SSIM of one interleaved channel over 8×8 windows sampled every 4 pixels. */
function planeSsim(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
  channels: number,
  channel: number
): number {
  if (width < WINDOW || height < WINDOW) {
    let same = true;
    for (let index = channel; index < a.length && same; index += channels)
      same = a[index] === b[index];
    return same ? 1 : 0;
  }
  const n = WINDOW * WINDOW;
  let total = 0;
  let count = 0;
  for (let y = 0; y + WINDOW <= height; y += STEP) {
    for (let x = 0; x + WINDOW <= width; x += STEP) {
      let sa = 0,
        sb = 0,
        saa = 0,
        sbb = 0,
        sab = 0;
      for (let row = 0; row < WINDOW; row++) {
        let offset = ((y + row) * width + x) * channels + channel;
        for (let column = 0; column < WINDOW; column++, offset += channels) {
          const p = a[offset]!,
            q = b[offset]!;
          sa += p;
          sb += q;
          saa += p * p;
          sbb += q * q;
          sab += p * q;
        }
      }
      const ma = sa / n,
        mb = sb / n;
      const va = saa / n - ma * ma,
        vb = sbb / n - mb * mb,
        cov = sab / n - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
    }
  }
  return total / count;
}

async function render(image: Sharp, width: number, height: number, background: string) {
  return image
    .resize(width, height, { fit: "fill" })
    .flatten({ background })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

/**
 * Structural similarity between a reference rendering and an encoded candidate.
 *
 * The reference is resized to the candidate's dimensions first, so an intended
 * downscale is not counted as quality loss; only encoding loss is measured. The
 * score is the lowest per-channel SSIM, composited on white and, when either
 * image has transparency, also on black. Animated images compare their first frame.
 *
 * @param reference Factory for the source image with the same orientation and
 *   flattening as the candidate pipeline, before resizing and encoding.
 */
export async function imageSsim(
  reference: () => Sharp,
  candidate: string | Buffer
): Promise<number> {
  // Read a path into memory: libvips can cache a file by name, and callers
  // re-encode to the same path between measurements.
  const encoded = typeof candidate === "string" ? await fs.readFile(candidate) : candidate;
  const candidateMeta = await sharp(encoded).metadata();
  const referenceMeta = await reference().metadata();
  const width = candidateMeta.width;
  const height = candidateMeta.pageHeight ?? candidateMeta.height;
  const backgrounds =
    candidateMeta.hasAlpha || referenceMeta.hasAlpha ? ["#ffffff", "#000000"] : ["#ffffff"];
  let score = 1;
  for (const background of backgrounds) {
    const [a, b] = await Promise.all([
      render(reference(), width, height, background),
      render(sharp(encoded), width, height, background),
    ]);
    if (a.info.width !== b.info.width || a.info.height !== b.info.height)
      throw new Error("Image quality comparison produced mismatched dimensions.");
    for (let channel = 0; channel < a.info.channels; channel++)
      score = Math.min(
        score,
        planeSsim(a.data, b.data, a.info.width, a.info.height, a.info.channels, channel)
      );
  }
  return score;
}

/** Validates a configured minimum SSIM; 0 disables the quality guard. */
export function resolveMinImageSsim(value: unknown): number {
  if (value === undefined) return DEFAULT_MIN_IMAGE_SSIM;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1)
    throw new Error("--min-image-ssim must be between 0 and 1.");
  return number;
}
