import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { crc32 } from "node:zlib";
import { extractEPUB, compressEPUB } from "./archive-processor.js";
import { TEMP_DIR_MARKER } from "../utils/temp-dir.js";

const tempDir = path.join(os.tmpdir(), "epub-optimizer-test-archive");
const sampleEpubDir = path.join(tempDir, "sample-epub");
const extractDir = path.join(tempDir, "extracted");
const outputEpub = path.join(tempDir, "output.epub");

interface RawEntry {
  name: string;
  data?: string;
  /** Unix mode stored in the high 16 bits of the external attributes. */
  unixMode?: number;
  /** Uncompressed size written in the headers, when it should lie. */
  declaredSize?: number;
}

/**
 * Write a stored (uncompressed) ZIP byte by byte, so tests can use names and
 * metadata that well-behaved ZIP libraries refuse to produce.
 */
async function writeRawZip(file: string, entries: RawEntry[]): Promise<void> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "", "utf8");
    const size = entry.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by Unix, so the mode is meaningful
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await fs.outputFile(file, Buffer.concat([...locals, directory, end]));
}

// Create a minimal EPUB structure
async function createMockEpub(filePath: string): Promise<void> {
  // Create the directory structure
  await fs.ensureDir(sampleEpubDir);

  // Create mimetype file
  await fs.writeFile(path.join(sampleEpubDir, "mimetype"), "application/epub+zip");

  // Create META-INF directory
  await fs.ensureDir(path.join(sampleEpubDir, "META-INF"));

  // Create container.xml
  await fs.writeFile(
    path.join(sampleEpubDir, "META-INF", "container.xml"),
    `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles>
        <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>`
  );

  // Create a simple content file
  await fs.writeFile(
    path.join(sampleEpubDir, "content.opf"),
    `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf">
      <metadata>
        <dc:title>Test Book</dc:title>
        <dc:language>en</dc:language>
        <dc:identifier>test-id</dc:identifier>
      </metadata>
      <manifest>
        <item id="content" href="content.html" media-type="application/xhtml+xml"/>
      </manifest>
      <spine>
        <itemref idref="content"/>
      </spine>
    </package>`
  );

  // Create an HTML content file
  await fs.writeFile(
    path.join(sampleEpubDir, "content.html"),
    `<!DOCTYPE html>
    <html>
      <head><title>Test</title></head>
      <body><h1>Hello World</h1></body>
    </html>`
  );

  // Compress the directory
  try {
    await compressEPUB(filePath, sampleEpubDir);
  } catch (error) {
    console.error("Error creating mock EPUB:", error);
    throw error;
  }
}

describe("Archive Processor", () => {
  const mockEpubPath = path.join(tempDir, "mock.epub");

  beforeEach(async () => {
    await fs.ensureDir(tempDir);
    await fs.ensureDir(sampleEpubDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    vi.restoreAllMocks();
  });

  it("extracts an EPUB file correctly", async () => {
    // Create a test EPUB
    await createMockEpub(mockEpubPath);

    // Extract it
    await extractEPUB(mockEpubPath, extractDir);

    // Verify extracted structure
    expect(await fs.pathExists(path.join(extractDir, "mimetype"))).toBe(true);
    expect(await fs.pathExists(path.join(extractDir, "META-INF", "container.xml"))).toBe(true);
    expect(await fs.pathExists(path.join(extractDir, "content.opf"))).toBe(true);
    expect(await fs.pathExists(path.join(extractDir, "content.html"))).toBe(true);

    // Verify mimetype content
    const mimetypeContent = await fs.readFile(path.join(extractDir, "mimetype"), "utf8");
    expect(mimetypeContent).toBe("application/epub+zip");
  });

  it("never deletes an existing directory, even for invalid input", async () => {
    await fs.outputFile(path.join(extractDir, "important.txt"), "keep");
    await fs.writeFile(mockEpubPath, "invalid zip");
    await expect(extractEPUB(mockEpubPath, extractDir)).rejects.toThrow();
    expect(await fs.readFile(path.join(extractDir, "important.txt"), "utf8")).toBe("keep");
    await createMockEpub(mockEpubPath);
    await expect(extractEPUB(mockEpubPath, extractDir)).rejects.toThrow("EEXIST");
    expect(await fs.readFile(path.join(extractDir, "important.txt"), "utf8")).toBe("keep");
  });

  it("allows only one concurrent extraction into an explicit destination", async () => {
    await createMockEpub(mockEpubPath);
    const runs = await Promise.allSettled([
      extractEPUB(mockEpubPath, extractDir),
      extractEPUB(mockEpubPath, extractDir),
    ]);
    expect(runs.filter((run) => run.status === "fulfilled")).toHaveLength(1);
    expect(await fs.readFile(path.join(extractDir, "mimetype"), "utf8")).toBe(
      "application/epub+zip"
    );
  });

  it("compresses an EPUB directory correctly", async () => {
    // Create EPUB structure directly in extractDir
    await fs.ensureDir(extractDir);
    await fs.writeFile(path.join(extractDir, "mimetype"), "application/epub+zip");

    // Create a minimal META-INF structure for a more realistic test
    await fs.ensureDir(path.join(extractDir, "META-INF"));
    await fs.writeFile(
      path.join(extractDir, "META-INF", "container.xml"),
      `<?xml version="1.0"?>
      <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles>
          <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
        </rootfiles>
      </container>`
    );

    // Compress it using our yazl implementation
    const result = await compressEPUB(outputEpub, extractDir);

    // Verify
    expect(result).toBe(true);
    expect(await fs.pathExists(outputEpub)).toBe(true);

    const stats = await fs.stat(outputEpub);
    expect(stats.size).toBeGreaterThan(0);
  });

  it("rejects archives that exceed configured entry limits", async () => {
    await createMockEpub(mockEpubPath);

    await expect(
      extractEPUB(mockEpubPath, extractDir, {
        maxEntries: 1,
        maxEntryBytes: 1024 * 1024,
        maxTotalBytes: 10 * 1024 * 1024,
        maxCompressionRatio: 10_000,
      })
    ).rejects.toThrow("limit is 1");
  });

  describe("refuses unsafe entries without writing outside the destination", () => {
    const escaped = path.join(tempDir, "escaped.txt");
    it.each([
      ["a parent traversal", "../escaped.txt", "outside extract dir"],
      ["a nested parent traversal", "OPS/../../escaped.txt", "outside extract dir"],
      ["a backslash traversal", "OPS\\..\\..\\escaped.txt", "outside extract dir"],
      ["an absolute path", "/tmp/escaped.txt", "Refusing unsafe archive entry"],
      ["a Windows drive path", "C:/escaped.txt", "Refusing unsafe archive entry"],
      ["a NUL byte", "OPS/a\0.txt", "Refusing unsafe archive entry"],
      ["the temporary directory marker", TEMP_DIR_MARKER, "Refusing reserved archive entry"],
    ])("%s", async (_label, name, message) => {
      await writeRawZip(mockEpubPath, [
        { name: "mimetype", data: "application/epub+zip" },
        { name, data: "payload" },
      ]);

      await expect(extractEPUB(mockEpubPath, extractDir)).rejects.toThrow(message);
      expect(await fs.pathExists(escaped)).toBe(false);
      expect(await fs.pathExists("/tmp/escaped.txt")).toBe(false);
    });

    it("a symbolic link, before extracting anything", async () => {
      await writeRawZip(mockEpubPath, [
        { name: "mimetype", data: "application/epub+zip" },
        { name: "OPS/link.xhtml", data: "/etc/passwd", unixMode: 0o120777 },
      ]);

      await expect(extractEPUB(mockEpubPath, extractDir)).rejects.toThrow("is a symbolic link");
      expect(await fs.pathExists(extractDir)).toBe(false);
    });
  });

  it("creates directory entries and extracts files inside them", async () => {
    await writeRawZip(mockEpubPath, [
      { name: "mimetype", data: "application/epub+zip" },
      { name: "OPS/empty/", unixMode: 0o40755 },
      { name: "OPS/text/c.xhtml", data: "<html/>" },
    ]);

    await extractEPUB(mockEpubPath, extractDir);

    expect((await fs.stat(path.join(extractDir, "OPS/empty"))).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(extractDir, "OPS/text/c.xhtml"), "utf8")).toBe("<html/>");
  });

  describe("enforces size limits on declared and actual bytes", () => {
    const limits = {
      maxEntries: 10,
      maxEntryBytes: 100,
      maxTotalBytes: 150,
      maxCompressionRatio: 10_000,
    };

    it("refuses an entry declared above the per-file limit", async () => {
      await writeRawZip(mockEpubPath, [{ name: "big.txt", data: "x".repeat(101) }]);
      await expect(extractEPUB(mockEpubPath, extractDir, limits)).rejects.toThrow(
        "per-file limit is 100"
      );
    });

    it("refuses entries declared above the total limit", async () => {
      await writeRawZip(mockEpubPath, [
        { name: "a.txt", data: "x".repeat(80) },
        { name: "b.txt", data: "x".repeat(80) },
      ]);
      await expect(extractEPUB(mockEpubPath, extractDir, limits)).rejects.toThrow(
        "beyond the 150 byte total limit"
      );
    });

    it("stops an entry whose real bytes exceed the per-file limit despite a smaller declared size", async () => {
      await writeRawZip(mockEpubPath, [
        { name: "lying.txt", data: "x".repeat(500), declaredSize: 10 },
      ]);
      await expect(extractEPUB(mockEpubPath, extractDir, limits)).rejects.toThrow(
        "exceeded the per-file size limit"
      );
    });

    it("stops when real bytes exceed the total limit despite smaller declared sizes", async () => {
      await writeRawZip(mockEpubPath, [
        { name: "a.txt", data: "x".repeat(90), declaredSize: 10 },
        { name: "b.txt", data: "x".repeat(90), declaredSize: 10 },
      ]);
      await expect(extractEPUB(mockEpubPath, extractDir, limits)).rejects.toThrow(
        "exceeded the total extracted size limit"
      );
    });
  });

  it("removes a partial output when compression fails", async () => {
    await fs.ensureDir(extractDir);
    await fs.writeFile(path.join(extractDir, "mimetype"), "application/epub+zip");
    await fs.symlink("/etc/hosts", path.join(extractDir, "link.txt"));

    await expect(compressEPUB(outputEpub, extractDir)).rejects.toThrow(
      /^Failed to compress EPUB: /
    );
    expect(await fs.pathExists(outputEpub)).toBe(false);
  });

  it("rejects archives with a suspicious compression ratio", async () => {
    await fs.writeFile(path.join(sampleEpubDir, "highly-compressible.txt"), "a".repeat(100_000));
    await createMockEpub(mockEpubPath);

    await expect(
      extractEPUB(mockEpubPath, extractDir, {
        maxEntries: 100,
        maxEntryBytes: 1024 * 1024,
        maxTotalBytes: 10 * 1024 * 1024,
        maxCompressionRatio: 2,
      })
    ).rejects.toThrow("suspicious compression ratio");
  });
});
