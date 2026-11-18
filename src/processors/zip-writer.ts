import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import unzipper from "unzipper";

const LIMIT_32 = 0xffffffff;
const LIMIT_16 = 0xffff;
const DEFLATE = 8;
const STORE = 0;

/** Deflated entry of the source EPUB whose compressed bytes may be reused verbatim. */
export interface OriginalEntry {
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface WrittenData {
  crc32: number;
  size: number;
  written: number;
}

/**
 * Lists the deflated, unencrypted entries of an EPUB that fit the classic ZIP format.
 * Ambiguous (duplicate) paths are dropped so they are always recompressed.
 */
export async function readOriginalEntries(epubPath: string): Promise<Map<string, OriginalEntry>> {
  const directory = await unzipper.Open.file(epubPath);
  const entries = new Map<string, OriginalEntry>();
  const duplicates = new Set<string>();
  for (const file of directory.files) {
    const name = file.path.replace(/\\/g, "/");
    if (entries.has(name)) duplicates.add(name);
    if (
      file.type !== "File" ||
      file.compressionMethod !== DEFLATE ||
      file.flags & 1 ||
      [file.compressedSize, file.uncompressedSize, file.offsetToLocalFileHeader].some(
        (value) => value >= LIMIT_32
      )
    )
      continue;
    entries.set(name, {
      crc32: file.crc32 >>> 0,
      compressedSize: file.compressedSize,
      uncompressedSize: file.uncompressedSize,
      localHeaderOffset: file.offsetToLocalFileHeader,
    });
  }
  for (const name of duplicates) entries.delete(name);
  return entries;
}

function dosDateTime(date: Date): { time: number; date: number } {
  if (date.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date:
      ((Math.min(date.getFullYear(), 2107) - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

/**
 * Minimal streaming ZIP writer for EPUB packaging. Every entry is written with
 * the smallest of: stored bytes, a fresh level-9 deflate, or (for a file whose
 * content is unchanged) the source EPUB's original deflate stream, copied only
 * after inflating it and matching its SHA-256 with the file being packaged.
 */
export class EpubZipWriter {
  private position = 0;
  private readonly central: Buffer[] = [];

  private readonly output: FileHandle;
  private readonly source?: { handle: FileHandle; entries: Map<string, OriginalEntry> };

  constructor(
    output: FileHandle,
    source?: { handle: FileHandle; entries: Map<string, OriginalEntry> }
  ) {
    this.output = output;
    this.source = source;
  }

  async addFile(
    filePath: string,
    zipName: string,
    options: { store?: boolean } = {}
  ): Promise<void> {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile()) throw new Error(`Refusing to package non-regular file: ${zipName}`);
    const name = Buffer.from(zipName, "utf8");
    const headerOffset = this.position;
    const dataOffset = headerOffset + 30 + name.length;
    const original = options.store ? undefined : this.source?.entries.get(zipName);

    let method = options.store ? STORE : DEFLATE;
    let data: WrittenData | undefined;
    if (original && original.uncompressedSize === stats.size) {
      const scan = await this.scan(filePath);
      if (
        scan.crc32 === original.crc32 &&
        scan.size === original.uncompressedSize &&
        original.compressedSize < Math.min(scan.size, scan.deflated) &&
        (await this.copyOriginal(original, dataOffset, scan.sha256))
      )
        data = { crc32: scan.crc32, size: scan.size, written: original.compressedSize };
      else await this.output.truncate(dataOffset);
    }
    if (!data) {
      data = await this.writeData(filePath, dataOffset, method);
      if (method === DEFLATE && data.written >= data.size) {
        await this.output.truncate(dataOffset);
        const stored = await this.writeData(filePath, dataOffset, STORE);
        if (stored.crc32 !== data.crc32 || stored.size !== data.size)
          throw new Error(`File changed while packaging: ${zipName}`);
        data = stored;
        method = STORE;
      }
    }

    if ([data.size, data.written, headerOffset].some((value) => value >= LIMIT_32))
      throw new Error(`Archive entry ${zipName} exceeds the ZIP size limit.`);
    const flags = /^[\x20-\x7e]*$/.test(zipName) ? 0 : 0x0800;
    const version = method === DEFLATE ? 20 : 10;
    const { time, date } = dosDateTime(stats.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(data.crc32, 14);
    local.writeUInt32LE(data.written, 18);
    local.writeUInt32LE(data.size, 22);
    local.writeUInt16LE(name.length, 26);
    await this.writeAt(Buffer.concat([local, name]), headerOffset);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(version, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(data.crc32, 16);
    entry.writeUInt32LE(data.written, 20);
    entry.writeUInt32LE(data.size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(headerOffset, 42);
    this.central.push(Buffer.concat([entry, name]));
    this.position = dataOffset + data.written;
  }

  async finish(): Promise<void> {
    if (this.central.length > LIMIT_16) throw new Error("Archive has too many entries for ZIP.");
    const directory = Buffer.concat(this.central);
    if (this.position + directory.length >= LIMIT_32)
      throw new Error("Archive exceeds the ZIP size limit.");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(this.position, 16);
    await this.writeAt(Buffer.concat([directory, end]), this.position);
    await this.output.truncate(this.position + directory.length + end.length);
  }

  private async writeAt(buffer: Buffer, offset: number): Promise<void> {
    let done = 0;
    while (done < buffer.length)
      done += (await this.output.write(buffer, done, buffer.length - done, offset + done))
        .bytesWritten;
  }

  private async writeData(filePath: string, offset: number, method: number) {
    const result: WrittenData = { crc32: 0, size: 0, written: 0 };
    await pipeline(
      createReadStream(filePath),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          result.crc32 = zlib.crc32(chunk, result.crc32);
          result.size += chunk.length;
          yield chunk;
        }
      },
      method === DEFLATE
        ? zlib.createDeflateRaw({ level: 9 })
        : async function* (source: AsyncIterable<Buffer>) {
            yield* source;
          },
      async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) {
          await this.writeAt(chunk, offset + result.written);
          result.written += chunk.length;
        }
      }
    );
    return result;
  }

  /** Reads a file once for its CRC-32, SHA-256, size and fresh deflate size. */
  private async scan(filePath: string) {
    const hash = createHash("sha256");
    const result = { crc32: 0, size: 0, deflated: 0, sha256: "" };
    await pipeline(
      createReadStream(filePath),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          result.crc32 = zlib.crc32(chunk, result.crc32);
          result.size += chunk.length;
          hash.update(chunk);
          yield chunk;
        }
      },
      zlib.createDeflateRaw({ level: 9 }),
      async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) result.deflated += (chunk as Buffer).length;
      }
    );
    result.sha256 = hash.digest("hex");
    return result;
  }

  /**
   * Copies the original deflate stream to the output while inflating it; returns
   * false (leaving bytes for the caller to truncate) unless it inflates to the
   * exact file content.
   */
  private async copyOriginal(entry: OriginalEntry, offset: number, sha256: string) {
    const handle = this.source!.handle;
    const write = (buffer: Buffer, at: number) => this.writeAt(buffer, at);
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(header, 0, 30, entry.localHeaderOffset);
    if (
      bytesRead !== 30 ||
      header.readUInt32LE(0) !== 0x04034b50 ||
      header.readUInt16LE(6) & 1 ||
      header.readUInt16LE(8) !== DEFLATE
    )
      return false;
    const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const hash = createHash("sha256");
    let copied = 0;
    let inflated = 0;
    try {
      await pipeline(
        handle.createReadStream({
          start,
          end: start + entry.compressedSize - 1,
          autoClose: false,
        }),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            await write(chunk, offset + copied);
            copied += chunk.length;
            yield chunk;
          }
        },
        zlib.createInflateRaw(),
        async (source: AsyncIterable<Buffer>) => {
          for await (const chunk of source) {
            inflated += chunk.length;
            hash.update(chunk);
          }
        }
      );
    } catch {
      return false;
    }
    return (
      copied === entry.compressedSize &&
      inflated === entry.uncompressedSize &&
      hash.digest("hex") === sha256
    );
  }
}
