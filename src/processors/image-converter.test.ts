import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { convertPngToJpeg } from "./image-converter.js";
import { createAnimatedPng, createTransparentPng } from "../../scripts/image-fixtures.js";

const tempDir = path.join(os.tmpdir(), "epub-optimizer-image-converter-test");

async function createLargeOpaquePng(filePath: string): Promise<void> {
  const width = 500;
  const height = 500;
  const raw = Buffer.alloc(width * height * 3);
  let seed = 123456789;

  for (let index = 0; index < raw.length; index++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    raw[index] = (seed >>> 24) & 0xff;
  }

  await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(filePath);
}

async function createSmallOpaquePng(filePath: string): Promise<void> {
  await sharp({
    create: {
      width: 20,
      height: 20,
      channels: 3,
      background: { r: 20, g: 120, b: 220 },
    },
  })
    .png()
    .toFile(filePath);
}

async function createEpubTree(
  epubDir: string,
  opts: { includeCatManifest?: boolean; includeCatReferences?: boolean } = {}
): Promise<void> {
  const includeCatManifest = opts.includeCatManifest ?? true;
  const includeCatReferences = opts.includeCatReferences ?? true;
  const contentDir = path.join(epubDir, "OPS");

  await fs.ensureDir(path.join(epubDir, "META-INF"));
  await fs.ensureDir(path.join(contentDir, "chapters"));
  await fs.ensureDir(path.join(contentDir, "images"));
  await fs.ensureDir(path.join(contentDir, "styles"));
  await fs.ensureDir(path.join(contentDir, "vector"));

  await fs.writeFile(path.join(epubDir, "mimetype"), "application/epub+zip");
  await fs.writeFile(
    path.join(epubDir, "META-INF", "container.xml"),
    `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles>
        <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>`
  );

  await fs.writeFile(
    path.join(contentDir, "content.opf"),
    `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata>
        <dc:title>Image Converter Test</dc:title>
        <dc:language>en</dc:language>
        <dc:identifier>test-id</dc:identifier>
      </metadata>
      <manifest>
        <item id="chapter" href="chapters/chapter-1.xhtml" media-type="application/xhtml+xml"/>
        <item id="style" href="styles/book.css" media-type="text/css"/>
        <item id="graphic" href="vector/graphic.svg" media-type="image/svg+xml"/>
        ${includeCatManifest ? '<item id="cat" href="images/cat.png" media-type="image/png"/>' : ""}
        <item id="scat" href="images/scat.png" media-type="image/png"/>
      </manifest>
      <spine>
        <itemref idref="chapter"/>
      </spine>
    </package>`
  );

  await createLargeOpaquePng(path.join(contentDir, "images", "cat.png"));
  await createSmallOpaquePng(path.join(contentDir, "images", "scat.png"));

  await fs.writeFile(
    path.join(contentDir, "chapters", "chapter-1.xhtml"),
    includeCatReferences
      ? `<?xml version="1.0" encoding="UTF-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head>
            <link rel="stylesheet" href="../styles/book.css" />
          </head>
          <body>
            <img src="../images/cat.png" alt="cat" />
            <img src="../images/scat.png" alt="scat" />
            <img srcset="../images/cat.png 1x, ../images/cat.png?density=2 2x" alt="cat set" />
            <picture><source srcset="../images/cat.png 640w" /></picture>
            <div style="background-image:url(&apos;../images/cat.png#inline&apos;)"></div>
          </body>
        </html>`
      : `<?xml version="1.0" encoding="UTF-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml">
          <body><img src="../images/scat.png" alt="scat" /></body>
        </html>`
  );

  await fs.writeFile(
    path.join(contentDir, "styles", "book.css"),
    includeCatReferences
      ? `.hero { background-image: url("../images/cat.png#css"); }
        .retina { background-image: image-set(url("../images/cat.png") 1x, "../images/cat.png?css=2" 2x); }
        .scat { background-image: url("../images/scat.png"); }`
      : `.scat { background-image: url("../images/scat.png"); }`
  );

  await fs.writeFile(
    path.join(contentDir, "vector", "graphic.svg"),
    includeCatReferences
      ? `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
          <image href="../images/cat.png" />
          <image xlink:href="../images/cat.png?svg=1" />
        </svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg"></svg>`
  );
}

describe("PNG to JPEG converter", () => {
  beforeEach(async () => {
    await fs.ensureDir(tempDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    vi.restoreAllMocks();
  });

  it.each([undefined, "#ffffff"])(
    "preserves APNG bytes and references with background %s",
    async (background) => {
      const epubDir = path.join(tempDir, "animation");
      await createEpubTree(epubDir);
      const contentDir = path.join(epubDir, "OPS");
      const file = path.join(contentDir, "images", "cat.png");
      const original = createAnimatedPng();
      expect(original.length).toBeGreaterThan(200 * 1024);
      expect((await sharp(original).metadata()).hasAlpha).toBe(false);
      await fs.writeFile(file, original);
      const opf = await fs.readFile(path.join(contentDir, "content.opf"), "utf8");
      const chapterPath = path.join(contentDir, "chapters", "chapter-1.xhtml");
      const chapter = await fs.readFile(chapterPath, "utf8");

      expect((await convertPngToJpeg(epubDir, 70, 1, 100, background)).size).toBe(0);

      expect((await fs.readFile(file)).equals(original)).toBe(true);
      expect(await fs.pathExists(file.replace(/\.png$/, ".jpg"))).toBe(false);
      expect(await fs.readFile(path.join(contentDir, "content.opf"), "utf8")).toBe(opf);
      expect(await fs.readFile(chapterPath, "utf8")).toBe(chapter);
    }
  );

  it("keeps transparent PNG bytes and references unchanged by default", async () => {
    const epubDir = path.join(tempDir, "transparent-default");
    await createEpubTree(epubDir);
    const png = path.join(epubDir, "OPS/images/cat.png");
    const original = await createTransparentPng();
    await fs.writeFile(png, original);
    const chapter = await fs.readFile(path.join(epubDir, "OPS/chapters/chapter-1.xhtml"));
    const opf = await fs.readFile(path.join(epubDir, "OPS/content.opf"));
    expect((await convertPngToJpeg(epubDir, 90, 1, 256)).size).toBe(0);
    expect(await fs.readFile(png)).toEqual(original);
    expect(await fs.readFile(path.join(epubDir, "OPS/chapters/chapter-1.xhtml"))).toEqual(chapter);
    expect(await fs.readFile(path.join(epubDir, "OPS/content.opf"))).toEqual(opf);
  });

  it.each([
    ["#ffffff", [255, 255, 255], [255, 127, 127]],
    ["#204060", [32, 64, 96], [144, 32, 48]],
  ] as const)(
    "flattens full and partial alpha onto %s, resizes and safely rewrites references",
    async (background, clear, halfRed) => {
      const epubDir = path.join(tempDir, "flattened");
      await createEpubTree(epubDir);
      const png = path.join(epubDir, "OPS/images/cat.png");
      const small = await fs.readFile(path.join(epubDir, "OPS/images/scat.png"));
      const original = await createTransparentPng();
      expect(original.length).toBeGreaterThan(200 * 1024);
      await fs.writeFile(png, original);
      const jpeg = png.replace(/\.png$/, ".jpg");
      expect([...(await convertPngToJpeg(epubDir, 90, 1, 256, background))]).toEqual([jpeg]);
      expect(await fs.pathExists(png)).toBe(false);
      expect((await fs.stat(jpeg)).size).toBeLessThan(original.length);
      expect(await sharp(jpeg).metadata()).toMatchObject({
        width: 256,
        height: 256,
        hasAlpha: false,
      });
      const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
      for (const [x, expected] of [
        [5, clear],
        [45, halfRed],
      ] as const) {
        const offset = (5 * info.width + x) * info.channels;
        expected.forEach((value, c) => expect(Math.abs(data[offset + c] - value)).toBeLessThan(6));
      }
      expect(await fs.readFile(path.join(epubDir, "OPS/images/scat.png"))).toEqual(small);
      const chapter = await fs.readFile(path.join(epubDir, "OPS/chapters/chapter-1.xhtml"), "utf8");
      expect(chapter).toContain("../images/cat.jpg?density=2 2x");
      expect(chapter).toContain("../images/cat.jpg#inline");
      expect(await fs.readFile(path.join(epubDir, "OPS/styles/book.css"), "utf8")).toContain(
        "../images/cat.jpg#css"
      );
      expect(await fs.readFile(path.join(epubDir, "OPS/vector/graphic.svg"), "utf8")).toContain(
        "../images/cat.jpg?svg=1"
      );
      expect(await fs.readFile(path.join(epubDir, "OPS/content.opf"), "utf8")).toContain(
        'href="images/cat.jpg" media-type="image/jpeg"'
      );
    }
  );

  it("keeps transparent source bytes when a flattened candidate has no manifest entry", async () => {
    const epubDir = path.join(tempDir, "flattened-rollback");
    await createEpubTree(epubDir, { includeCatManifest: false });
    const png = path.join(epubDir, "OPS/images/cat.png");
    const original = await createTransparentPng();
    await fs.writeFile(png, original);
    expect((await convertPngToJpeg(epubDir, 70, 1, undefined, "#ffffff")).size).toBe(0);
    expect(await fs.readFile(png)).toEqual(original);
    expect(await fs.pathExists(png.replace(/\.png$/, ".jpg"))).toBe(false);
    expect(await fs.readFile(path.join(epubDir, "OPS/chapters/chapter-1.xhtml"), "utf8")).toContain(
      'src="../images/cat.png"'
    );
  });

  it("keeps transparency and references when flattening would increase file size", async () => {
    const epubDir = path.join(tempDir, "flattened-no-benefit");
    await createEpubTree(epubDir);
    const png = path.join(epubDir, "OPS/images/cat.png");
    const original = await sharp(await createTransparentPng())
      .png({ palette: true, colours: 32 })
      .toBuffer();
    expect(original.length).toBeGreaterThan(200 * 1024);
    const candidate = await sharp(original)
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 100, mozjpeg: true })
      .toBuffer();
    expect(candidate.length).toBeGreaterThan(original.length);
    await fs.writeFile(png, original);
    const opf = await fs.readFile(path.join(epubDir, "OPS/content.opf"));
    expect((await convertPngToJpeg(epubDir, 100, 1, undefined, "#ffffff")).size).toBe(0);
    expect(await fs.readFile(png)).toEqual(original);
    expect(await fs.pathExists(png.replace(/\.png$/, ".jpg"))).toBe(false);
    expect(await fs.readFile(path.join(epubDir, "OPS/content.opf"))).toEqual(opf);
    expect(await fs.readFile(path.join(epubDir, "OPS/chapters/chapter-1.xhtml"), "utf8")).toContain(
      'src="../images/cat.png"'
    );
  });

  it("commits only exact resolved PNG references across nested XHTML, CSS, srcset, and SVG", async () => {
    const epubDir = path.join(tempDir, "commit");
    const contentDir = path.join(epubDir, "OPS");
    const catPng = path.join(contentDir, "images", "cat.png");
    const catJpg = path.join(contentDir, "images", "cat.jpg");
    const scatPng = path.join(contentDir, "images", "scat.png");
    const scatJpg = path.join(contentDir, "images", "scat.jpg");

    await createEpubTree(epubDir);

    const converted = await convertPngToJpeg(epubDir, 70, 1);

    expect(Array.from(converted)).toEqual([catJpg]);
    expect(await fs.pathExists(catPng)).toBe(false);
    expect(await fs.pathExists(catJpg)).toBe(true);
    expect(await fs.pathExists(scatPng)).toBe(true);
    expect(await fs.pathExists(scatJpg)).toBe(false);

    const chapter = await fs.readFile(path.join(contentDir, "chapters", "chapter-1.xhtml"), "utf8");
    expect(chapter).toContain('src="../images/cat.jpg"');
    expect(chapter).toContain("../images/cat.jpg?density=2 2x");
    expect(chapter).toContain("../images/cat.jpg 640w");
    expect(chapter).toContain("url(&apos;../images/cat.jpg#inline&apos;)");
    expect(chapter).toContain('src="../images/scat.png"');
    expect(chapter).not.toContain("scat.jpg");

    const css = await fs.readFile(path.join(contentDir, "styles", "book.css"), "utf8");
    expect(css).toContain('url("../images/cat.jpg#css")');
    expect(css).toContain('url("../images/cat.jpg") 1x');
    expect(css).toContain('"../images/cat.jpg?css=2" 2x');
    expect(css).toContain('url("../images/scat.png")');
    expect(css).not.toContain("scat.jpg");

    const svg = await fs.readFile(path.join(contentDir, "vector", "graphic.svg"), "utf8");
    expect(svg).toContain('href="../images/cat.jpg"');
    expect(svg).toContain('xlink:href="../images/cat.jpg?svg=1"');

    const opf = await fs.readFile(path.join(contentDir, "content.opf"), "utf8");
    expect(opf).toContain('href="images/cat.jpg"');
    expect(opf).toContain('media-type="image/jpeg"');
    expect(opf).toContain('href="images/scat.png"');
  });

  it("rolls back a JPEG candidate when no supported content reference is found", async () => {
    const epubDir = path.join(tempDir, "unreferenced");
    const contentDir = path.join(epubDir, "OPS");
    const catPng = path.join(contentDir, "images", "cat.png");
    const catJpg = path.join(contentDir, "images", "cat.jpg");

    await createEpubTree(epubDir, { includeCatReferences: false });

    const converted = await convertPngToJpeg(epubDir, 70, 1);

    expect(converted.size).toBe(0);
    expect(await fs.pathExists(catPng)).toBe(true);
    expect(await fs.pathExists(catJpg)).toBe(false);

    const opf = await fs.readFile(path.join(contentDir, "content.opf"), "utf8");
    expect(opf).toContain('href="images/cat.png"');
    expect(opf).not.toContain('href="images/cat.jpg"');
  });

  it("rewrites URL-encoded paths with spaces while preserving query and fragment suffixes", async () => {
    const epubDir = path.join(tempDir, "space-paths");
    const contentDir = path.join(epubDir, "OPS");
    const spacedDir = path.join(contentDir, "images", "space dir");
    const spacedPng = path.join(spacedDir, "cat copy.png");
    const spacedJpg = path.join(spacedDir, "cat copy.jpg");

    await createEpubTree(epubDir);
    await fs.ensureDir(spacedDir);
    await createLargeOpaquePng(spacedPng);

    const opfPath = path.join(contentDir, "content.opf");
    await fs.writeFile(
      opfPath,
      (await fs.readFile(opfPath, "utf8")).replace(
        '<item id="scat" href="images/scat.png" media-type="image/png"/>',
        `<item id="space-cat" href="images/space%20dir/cat%20copy.png" media-type="image/png"/>
        <item id="scat" href="images/scat.png" media-type="image/png"/>`
      )
    );

    const chapterPath = path.join(contentDir, "chapters", "chapter-1.xhtml");
    await fs.writeFile(
      chapterPath,
      (await fs.readFile(chapterPath, "utf8")).replace(
        "</body>",
        `<img src="../images/space%20dir/cat%20copy.png?space=1#frag" alt="space cat" /></body>`
      )
    );

    const cssPath = path.join(contentDir, "styles", "book.css");
    await fs.appendFile(
      cssPath,
      `.space { background-image: url("../images/space%20dir/cat%20copy.png?css=1#frag"); }`
    );

    const svgPath = path.join(contentDir, "vector", "graphic.svg");
    await fs.writeFile(
      svgPath,
      (await fs.readFile(svgPath, "utf8")).replace(
        "</svg>",
        `<image href="../images/space%20dir/cat%20copy.png?svg=1#frag" /></svg>`
      )
    );

    const converted = await convertPngToJpeg(epubDir, 70, 1);

    expect(Array.from(converted)).toContain(spacedJpg);
    expect(await fs.pathExists(spacedPng)).toBe(false);
    expect(await fs.pathExists(spacedJpg)).toBe(true);

    const chapter = await fs.readFile(chapterPath, "utf8");
    expect(chapter).toContain("../images/space%20dir/cat%20copy.jpg?space=1#frag");

    const css = await fs.readFile(cssPath, "utf8");
    expect(css).toContain("../images/space%20dir/cat%20copy.jpg?css=1#frag");

    const svg = await fs.readFile(svgPath, "utf8");
    expect(svg).toContain("../images/space%20dir/cat%20copy.jpg?svg=1#frag");

    const opf = await fs.readFile(opfPath, "utf8");
    expect(opf).toContain('href="images/space%20dir/cat%20copy.jpg"');
  });

  it("rolls back a JPEG candidate when the PNG has no OPF manifest item", async () => {
    const epubDir = path.join(tempDir, "missing-opf-item");
    const contentDir = path.join(epubDir, "OPS");
    const catPng = path.join(contentDir, "images", "cat.png");
    const catJpg = path.join(contentDir, "images", "cat.jpg");

    await createEpubTree(epubDir, { includeCatManifest: false });

    const converted = await convertPngToJpeg(epubDir, 70, 1);

    expect(converted.size).toBe(0);
    expect(await fs.pathExists(catPng)).toBe(true);
    expect(await fs.pathExists(catJpg)).toBe(false);

    const chapter = await fs.readFile(path.join(contentDir, "chapters", "chapter-1.xhtml"), "utf8");
    expect(chapter).toContain('src="../images/cat.png"');
    expect(chapter).not.toContain('src="../images/cat.jpg"');
  });
});
