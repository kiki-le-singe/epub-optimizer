import { open } from "node:fs/promises";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CHUNKS = 1024;

/**
 * Detect APNG without decoding pixels or buffering the compressed image.
 * PNG requires acTL before the first IDAT; skip ancillary chunk payloads so
 * strings inside metadata cannot be mistaken for animation control chunks.
 * https://www.w3.org/TR/png-3/#acTL-chunk
 */
export async function isAnimatedPng(filePath: string): Promise<boolean> {
  const file = await open(filePath, "r");
  try {
    const header = Buffer.alloc(8);
    const signature = await file.read(header, 0, 8, 0);
    if (signature.bytesRead !== 8 || !header.equals(PNG_SIGNATURE)) return false;

    const size = (await file.stat()).size;
    let offset = 8;
    let chunks = 0;
    while (offset + 12 <= size) {
      // EPUB images are untrusted. Bound sequential I/O for pathological files
      // with millions of tiny ancillary chunks, preserving the source on error.
      if (++chunks > MAX_CHUNKS) throw new Error("PNG animation scan chunk limit exceeded");
      const { bytesRead } = await file.read(header, 0, 8, offset);
      if (bytesRead !== 8) break;
      const length = header.readUInt32BE(0);
      if (offset + length + 12 > size) break;
      const type = header.toString("ascii", 4, 8);
      if (type === "acTL") return true;
      if (type === "IDAT" || type === "IEND") return false;
      offset += length + 12;
    }
    // Callers retain the source on errors; never rewrite an uncertain PNG.
    throw new Error("Incomplete PNG chunk structure");
  } finally {
    await file.close();
  }
}
