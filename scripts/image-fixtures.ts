import { deflateSync } from "node:zlib";
import sharp from "sharp";

export function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

/** Two opaque, full-canvas RGB frames, with real APNG control chunks and CRCs. */
export function createAnimatedPng(): Buffer {
  const width = 256;
  const height = 256;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2);
  animation.writeUInt32BE(3, 4);
  const chunks = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("acTL", animation),
  ];
  let sequence = 0;
  let seed = 42;
  for (let frame = 0; frame < 2; frame++) {
    const control = Buffer.alloc(26);
    control.writeUInt32BE(sequence++);
    control.writeUInt32BE(width, 4);
    control.writeUInt32BE(height, 8);
    control.writeUInt16BE(frame + 1, 20);
    control.writeUInt16BE(10, 22);
    chunks.push(pngChunk("fcTL", control));
    const scanlines = Buffer.alloc(height * (width * 3 + 1));
    for (let y = 0; y < height; y++) {
      for (let x = 1; x <= width * 3; x++) {
        seed = (1664525 * seed + 1013904223) >>> 0;
        scanlines[y * (width * 3 + 1) + x] = seed >>> 24;
      }
    }
    const pixels = deflateSync(scanlines);
    if (frame === 0) {
      chunks.push(pngChunk("IDAT", pixels));
    } else {
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(sequence++);
      chunks.push(pngChunk("fdAT", Buffer.concat([prefix, pixels])));
    }
  }
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

/** Low-quality animation whose higher-quality re-encoding grows without resizing. */
export async function createAnimatedWebp(quality = 10): Promise<Buffer> {
  const width = 256;
  const pageHeight = 128;
  const pixels = Buffer.alloc(width * pageHeight * 2 * 3);
  let seed = 42;
  for (let i = 0; i < pixels.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  return sharp(pixels, { raw: { width, height: pageHeight * 2, pageHeight, channels: 3 } })
    .webp({ quality, delay: [100, 200], loop: 3 })
    .toBuffer();
}
