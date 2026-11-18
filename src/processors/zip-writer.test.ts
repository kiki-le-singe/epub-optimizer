import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import unzipper from "unzipper";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compressEPUB } from "./archive-processor.js";

interface FixtureEntry {
  name: string;
  content: Buffer;
  /** Deflate stream stored in the source archive (defaults to a fresh level-9 deflate). */
  raw?: Buffer;
}

/** Builds a classic ZIP whose deflate streams are chosen by the test. */
function buildZip(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const stored = entry.name === "mimetype";
    const data = stored ? entry.content : (entry.raw ?? zlib.deflateRawSync(entry.content));
    const method = stored ? 0 : 8;
    const crc = zlib.crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(entry.content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Text that zlib compresses slightly better with memLevel 9 than with the default. */
function text(seed: number): Buffer {
  let value = seed;
  let result = "";
  for (let index = 0; index < 20000; index++) {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    result += ["alpha ", "beta ", "gamma ", "<p>", "</p>\n"][value % 5]! + (value % 97) + " ";
  }
  return Buffer.from(result);
}

async function rawEntry(epub: string, name: string) {
  const directory = await unzipper.Open.file(epub);
  const entry = directory.files.find((file) => file.path === name)!;
  const handle = await fs.open(epub, "r");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.offsetToLocalFileHeader);
    const start =
      entry.offsetToLocalFileHeader + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = Buffer.alloc(entry.compressedSize);
    await handle.read(raw, 0, raw.length, start);
    return {
      method: entry.compressionMethod,
      extra: header.readUInt16LE(28),
      raw,
      content: await entry.buffer(),
      index: directory.files.indexOf(entry),
    };
  } finally {
    await handle.close();
  }
}

describe("EPUB packaging with source passthrough", () => {
  let root: string;
  let source: string;
  let tree: string;
  let output: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "zip-writer-"));
    source = path.join(root, "source.epub");
    tree = path.join(root, "tree");
    output = path.join(root, "out.epub");
    await fs.mkdir(path.join(tree, "OPS"), { recursive: true });
    await fs.writeFile(path.join(tree, "mimetype"), "application/epub+zip");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const writeSource = (entries: FixtureEntry[]) =>
    fs.writeFile(
      source,
      buildZip([{ name: "mimetype", content: Buffer.from("application/epub+zip") }, ...entries])
    );

  it("reuses a smaller original deflate stream for an unchanged file", async () => {
    const content = text(1);
    const better = zlib.deflateRawSync(content, { level: 9, memLevel: 9 });
    expect(better.length).toBeLessThan(zlib.deflateRawSync(content, { level: 9 }).length);
    await writeSource([{ name: "OPS/chapter.xhtml", content, raw: better }]);
    await fs.writeFile(path.join(tree, "OPS/chapter.xhtml"), content);

    await compressEPUB(output, tree, source);

    const entry = await rawEntry(output, "OPS/chapter.xhtml");
    expect(entry.method).toBe(8);
    expect(entry.raw.equals(better)).toBe(true);
    expect(entry.content.equals(content)).toBe(true);
    const mimetype = await rawEntry(output, "mimetype");
    expect([mimetype.index, mimetype.method, mimetype.extra]).toEqual([0, 0, 0]);
  });

  it("recompresses a changed file and an original stream that is not smaller", async () => {
    const changed = text(2);
    const same = text(3);
    await writeSource([
      {
        name: "OPS/changed.xhtml",
        content: text(4),
        raw: zlib.deflateRawSync(text(4), { level: 9, memLevel: 9 }),
      },
      { name: "OPS/same.xhtml", content: same, raw: zlib.deflateRawSync(same, { level: 1 }) },
    ]);
    await fs.writeFile(path.join(tree, "OPS/changed.xhtml"), changed);
    await fs.writeFile(path.join(tree, "OPS/same.xhtml"), same);

    await compressEPUB(output, tree, source);

    for (const [name, content] of [
      ["OPS/changed.xhtml", changed],
      ["OPS/same.xhtml", same],
    ] as const) {
      const entry = await rawEntry(output, name);
      expect(entry.raw.equals(zlib.deflateRawSync(content, { level: 9 }))).toBe(true);
      expect(entry.content.equals(content)).toBe(true);
    }
  });

  it("never copies an original stream that does not inflate to the packaged file", async () => {
    const content = text(5);
    // Same size and declared CRC as the file, but the stream holds other bytes.
    const forged = Buffer.from(content);
    forged[0] = forged[0]! ^ 1;
    const raw = zlib.deflateRawSync(forged, { level: 9, memLevel: 9 });
    expect(raw.length).toBeLessThan(zlib.deflateRawSync(content, { level: 9 }).length);
    await writeSource([{ name: "OPS/chapter.xhtml", content, raw }]);
    await fs.writeFile(path.join(tree, "OPS/chapter.xhtml"), content);

    await compressEPUB(output, tree, source);

    expect((await rawEntry(output, "OPS/chapter.xhtml")).content.equals(content)).toBe(true);
  });

  it("stores incompressible files instead of growing them", async () => {
    const noise = randomBytes(64 * 1024);
    await fs.writeFile(path.join(tree, "OPS/image.png"), noise);

    await compressEPUB(output, tree);

    const entry = await rawEntry(output, "OPS/image.png");
    expect(entry.method).toBe(0);
    expect(entry.raw.equals(noise)).toBe(true);
  });

  it("refuses symbolic links and removes the partial output", async () => {
    await fs.writeFile(path.join(root, "outside.txt"), "secret");
    await fs.symlink(path.join(root, "outside.txt"), path.join(tree, "OPS/link.xhtml"));

    await expect(compressEPUB(output, tree)).rejects.toThrow("non-regular file");
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back to recompression when the source EPUB is unreadable", async () => {
    const content = text(6);
    await fs.writeFile(path.join(tree, "OPS/chapter.xhtml"), content);

    await compressEPUB(output, tree, path.join(root, "missing.epub"));

    expect((await rawEntry(output, "OPS/chapter.xhtml")).content.equals(content)).toBe(true);
  });
});
