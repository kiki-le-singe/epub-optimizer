import { afterEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { inspectExtractedEpub } from "./epub-doctor.js";

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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe("EPUB doctor", () => {
  it("reports OPF, navigation, references, image weight, and optimization risks", async () => {
    const root = await createExtractedFixture();
    const report = await inspectExtractedEpub(root, {
      input: "fixture.epub",
      archiveBytes: 1024 * 1024,
    });

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
});
