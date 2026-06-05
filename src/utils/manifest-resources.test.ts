import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { collectManifestResources } from "./epub-utils.js";

const SVG = { mediaTypes: new Set(["image/svg+xml"]), extensions: new Set([".svg"]) };
const FONTS = {
  mediaTypes: new Set(["application/vnd.ms-opentype", "font/ttf"]),
  extensions: new Set([".ttf", ".otf"]),
};

const createdDirs: string[] = [];

function container(opfPath: string): string {
  return `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
}

function opf(items: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
  <manifest>
    ${items}
  </manifest>
  <spine><itemref idref="c"/></spine>
</package>`;
}

async function makeEpub(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-res-"));
  createdDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((d) => fs.remove(d)));
});

describe("collectManifestResources", () => {
  it("finds SVG and fonts in CAPITALIZED folders (Sigil/EDRLab layout)", async () => {
    const dir = await makeEpub({
      "META-INF/container.xml": container("OEBPS/content.opf"),
      "OEBPS/content.opf": opf(`
        <item id="c" href="Text/ch.xhtml" media-type="application/xhtml+xml"/>
        <item id="s" href="Images/pic.svg" media-type="image/svg+xml"/>
        <item id="f" href="Fonts/font.ttf" media-type="font/ttf"/>
      `),
      "OEBPS/Text/ch.xhtml": "<html></html>",
      "OEBPS/Images/pic.svg": "<svg></svg>",
      "OEBPS/Fonts/font.ttf": "FONTDATA",
    });

    const svgs = await collectManifestResources(dir, SVG);
    const fonts = await collectManifestResources(dir, FONTS);

    expect(svgs.map((p) => path.basename(p))).toEqual(["pic.svg"]);
    expect(svgs[0]).toContain(path.join("OEBPS", "Images", "pic.svg"));
    expect(fonts.map((p) => path.basename(p))).toEqual(["font.ttf"]);
    expect(fonts[0]).toContain(path.join("OEBPS", "Fonts", "font.ttf"));
  });

  it("still finds the lowercase Pages layout (regression)", async () => {
    const dir = await makeEpub({
      "META-INF/container.xml": container("OPS/content.opf"),
      "OPS/content.opf": opf(`
        <item id="c" href="text/ch.xhtml" media-type="application/xhtml+xml"/>
        <item id="s" href="images/pic.svg" media-type="image/svg+xml"/>
      `),
      "OPS/text/ch.xhtml": "<html></html>",
      "OPS/images/pic.svg": "<svg></svg>",
    });

    const svgs = await collectManifestResources(dir, SVG);
    expect(svgs[0]).toContain(path.join("OPS", "images", "pic.svg"));
  });

  it("finds a resource in a flat layout (no subfolder)", async () => {
    const dir = await makeEpub({
      "META-INF/container.xml": container("content.opf"),
      "content.opf": opf(`
        <item id="c" href="ch.xhtml" media-type="application/xhtml+xml"/>
        <item id="s" href="diagram.svg" media-type="image/svg+xml"/>
      `),
      "ch.xhtml": "<html></html>",
      "diagram.svg": "<svg></svg>",
    });

    const svgs = await collectManifestResources(dir, SVG);
    expect(svgs.map((p) => path.basename(p))).toEqual(["diagram.svg"]);
  });

  it("falls back to a recursive scan for an undeclared resource", async () => {
    // The SVG exists on disk but is NOT listed in the manifest → the manifest
    // pass finds nothing, the recursive fallback finds it by extension.
    const dir = await makeEpub({
      "META-INF/container.xml": container("OEBPS/content.opf"),
      "OEBPS/content.opf": opf(`
        <item id="c" href="Text/ch.xhtml" media-type="application/xhtml+xml"/>
      `),
      "OEBPS/Text/ch.xhtml": "<html></html>",
      "OEBPS/Graphics/orphan.svg": "<svg></svg>",
    });

    const svgs = await collectManifestResources(dir, SVG);
    expect(svgs.map((p) => path.basename(p))).toEqual(["orphan.svg"]);
  });

  it("returns empty when there are no matching resources", async () => {
    const dir = await makeEpub({
      "META-INF/container.xml": container("OEBPS/content.opf"),
      "OEBPS/content.opf": opf(`
        <item id="c" href="Text/ch.xhtml" media-type="application/xhtml+xml"/>
      `),
      "OEBPS/Text/ch.xhtml": "<html></html>",
    });

    const svgs = await collectManifestResources(dir, SVG);
    expect(svgs).toEqual([]);
  });
});
