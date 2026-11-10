import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { compressEPUB } from "../processors/archive-processor.js";
import unzipper from "unzipper";
import { inspectExtractedEpub, runDoctor } from "./epub-doctor.js";

const tempDirs: string[] = [];

async function createOpaquePng(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);

  for (let i = 0; i < pixels.length; i += 3) {
    const n = i / 3;
    const x = n % width;
    const y = Math.floor(n / width);
    pixels[i] = (x * 13 + y * 7) % 256;
    pixels[i + 1] = (x * 5 + y * 17) % 256;
    pixels[i + 2] = (x * 19 + y * 3) % 256;
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

async function createExtractedFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-doctor-"));
  tempDirs.push(root);

  await fs.ensureDir(path.join(root, "META-INF"));
  await fs.ensureDir(path.join(root, "OPS", "images", "a"));
  await fs.ensureDir(path.join(root, "OPS", "images", "b"));

  await fs.writeFile(
    path.join(root, "META-INF", "container.xml"),
    `<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>`
  );
  await fs.writeFile(
    path.join(root, "OPS", "content.opf"),
    `<package version="3.0"><manifest>
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
      <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
      <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
      <item id="photo-a" href="images/a/photo.png" media-type="image/png"/>
      <item id="photo-b" href="images/b/photo.png" media-type="image/png"/>
    </manifest><spine toc="ncx"><itemref idref="chapter"/></spine></package>`
  );
  await fs.writeFile(
    path.join(root, "OPS", "nav.xhtml"),
    `<html><body><nav><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>`
  );
  await fs.writeFile(
    path.join(root, "OPS", "toc.ncx"),
    `<ncx><navMap><navPoint><navLabel><text>Chapter</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>`
  );
  await fs.writeFile(
    path.join(root, "OPS", "chapter.xhtml"),
    `<html><body><img src="images/a/photo.png"/></body></html>`
  );

  const image = await createOpaquePng(1701, 32);
  await fs.writeFile(path.join(root, "OPS", "images", "a", "photo.png"), image);
  await fs.writeFile(path.join(root, "OPS", "images", "b", "photo.png"), image);

  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe("EPUB doctor", () => {
  it("reports OPF, navigation, references, image weight, and optimization risks", async () => {
    const root = await createExtractedFixture();
    const report = await inspectExtractedEpub(root, {
      input: "fixture.epub",
      archiveBytes: 1024 * 1024,
    });

    if (!report.analysisComplete) throw new Error("Expected a complete diagnosis");
    expect(report.optimization.blocked).toBe(false);
    expect(report.images.archivePercent).toBeNull();
    expect(report.opf).toMatchObject({
      path: "OPS/content.opf",
      version: "3.0",
      manifestItems: 5,
      spineItems: 1,
      contentDirectory: "OPS",
    });
    expect(report.navigation).toEqual({
      hasEpub3Nav: true,
      hasNcx: true,
      entries: 2,
    });
    expect(report.references.missing).toBe(0);
    expect(report.images.count).toBe(2);
    expect(report.images.duplicateBasenames).toEqual([
      {
        basename: "photo.png",
        hrefs: ["images/a/photo.png", "images/b/photo.png"],
      },
    ]);
    expect(report.images.largeRasterImages).toHaveLength(2);
    expect(report.risks.map((risk) => risk.code)).toEqual(
      expect.arrayContaining(["large-raster-images", "duplicate-image-basenames"])
    );
  });
  it.each(["OPS/chapter.xhtml", "OPS/content.opf", "OPS/resource.custom"])(
    "reports DTD blockers without interpreting XML metrics: %s",
    async (file) => {
      const root = await createExtractedFixture();
      await fs.writeFile(
        path.join(root, file),
        '<!DOCTYPE html [<!ENTITY custom "Example">]><html>&custom;</html>'
      );
      const report = await inspectExtractedEpub(root, {
        input: "fixture.epub",
        archiveBytes: 1000,
      });
      expect(report.analysisComplete).toBe(false);
      expect(report.optimization).toMatchObject({
        blocked: true,
        blockers: [{ code: "internal-dtd", level: "error" }],
      });
      expect(report.optimization.blockers[0].message).toContain(file);
      expect(report).not.toHaveProperty("content");
      expect(report).not.toHaveProperty("images");
    }
  );

  it("reports content DRM as a blocker but keeps font obfuscation inspectable", async () => {
    const root = await createExtractedFixture();
    const encryption = (algorithm: string, href: string) =>
      `<encryption><EncryptedData><EncryptionMethod Algorithm="${algorithm}"/><CipherData><CipherReference URI="${href}"/></CipherData></EncryptedData></encryption>`;
    await fs.writeFile(
      path.join(root, "META-INF/encryption.xml"),
      encryption("http://www.w3.org/2001/04/xmlenc#aes256-cbc", "OPS/chapter.xhtml")
    );
    const blocked = await inspectExtractedEpub(root, { input: "fixture.epub", archiveBytes: 1000 });
    expect(blocked.analysisComplete).toBe(false);
    expect(blocked.optimization.blockers.map((risk) => risk.code)).toEqual(["drm"]);
    await fs.writeFile(
      path.join(root, "META-INF/encryption.xml"),
      encryption("http://www.idpf.org/2008/embedding", "OPS/font.ttf")
    );
    const supported = await inspectExtractedEpub(root, {
      input: "fixture.epub",
      archiveBytes: 1000,
    });
    expect(supported.analysisComplete).toBe(true);
    expect(supported.optimization.blocked).toBe(false);
  });

  it("measures compressed image share once per archive resource, even with duplicate manifest references", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await createExtractedFixture();
    const opf = path.join(root, "OPS/content.opf");
    await fs.writeFile(
      opf,
      (await fs.readFile(opf, "utf8")).replace(
        "</manifest>",
        '<item id="alias" href="images/a/photo.png" media-type="image/png"/><item id="svg" href="diagram.svg" media-type="image/svg+xml"/></manifest>'
      )
    );
    await fs.writeFile(
      path.join(root, "OPS/diagram.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        Array.from(
          { length: 4000 },
          (_, i) => `<rect x="${i % 100}" width="10" height="10"/>`
        ).join("") +
        "</svg>"
    );
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "epub-doctor-zip-"));
    tempDirs.push(archiveDir);
    const archive = path.join(archiveDir, "book.epub");
    await compressEPUB(archive, root);
    const entries = (await unzipper.Open.file(archive)).files;
    const imageBytes = entries
      .filter((entry) => /\.(png|svg)$/.test(entry.path))
      .reduce((sum, entry) => sum + entry.compressedSize, 0);
    const inputBefore = await fs.readFile(archive);
    const report = await runDoctor({ input: archive });
    if (!report.analysisComplete) throw new Error("Expected complete image analysis");
    expect(report.images.totalBytes).toBeGreaterThan(report.archiveBytes);
    expect(report.images.compressedBytes).toBe(imageBytes);
    expect(report.images.archivePercent).toBeCloseTo((imageBytes / report.archiveBytes) * 100);
    expect(report.images.archivePercent).toBeLessThanOrEqual(100);
    expect(await fs.readFile(archive)).toEqual(inputBefore);
  });

  it("writes a structured blocked diagnosis even when the OPF contains an internal DTD", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await createExtractedFixture();
    await fs.writeFile(
      path.join(root, "OPS/content.opf"),
      '<!DOCTYPE package [<!ENTITY custom "Example">]><package>&custom;</package>'
    );
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "epub-doctor-blocked-"));
    tempDirs.push(archiveDir);
    const archive = path.join(archiveDir, "book.epub");
    const reportJson = path.join(archiveDir, "report.json");
    await compressEPUB(archive, root);
    const report = await runDoctor({ input: archive, reportJson });
    expect(report.analysisComplete).toBe(false);
    expect(await fs.readJson(reportJson)).toEqual(report);
    expect(report.optimization.blockers[0].message).toContain("OPS/content.opf");
  });
});
