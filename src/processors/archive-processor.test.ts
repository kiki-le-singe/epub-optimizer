import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { extractEPUB, compressEPUB } from "./archive-processor.js";

const tempDir = path.join(os.tmpdir(), "epub-optimizer-test-archive");
const sampleEpubDir = path.join(tempDir, "sample-epub");
const extractDir = path.join(tempDir, "extracted");
const outputEpub = path.join(tempDir, "output.epub");

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
});
