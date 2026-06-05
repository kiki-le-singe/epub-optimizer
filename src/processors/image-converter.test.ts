import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { convertPngToJpeg } from "./image-converter.js";

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
