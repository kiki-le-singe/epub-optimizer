import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectEpubAccessibility, MAX_LISTED_IMAGES } from "./epub-accessibility.js";
import { getOPFPath, parseOPF } from "./epub-utils.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

const XHTML = 'xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"';

async function inspect(options: {
  metadata?: string;
  manifest?: string;
  files: Record<string, string>;
  /** Files written next to the EPUB root, outside the book. */
  outside?: Record<string, string>;
}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "epub-a11y-"));
  tempDirs.push(parent);
  const root = path.join(parent, "book");
  const items = Object.keys(options.files)
    .filter((name) => name.endsWith(".xhtml"))
    .map(
      (name, index) => `<item id="d${index}" href="${name}" media-type="application/xhtml+xml"/>`
    )
    .join("");
  await fs.outputFile(
    path.join(root, "META-INF/container.xml"),
    '<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>'
  );
  await fs.outputFile(
    path.join(root, "OPS/content.opf"),
    `<package version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata>${options.metadata ?? ""}</metadata><manifest>${items}${options.manifest ?? ""}</manifest><spine/></package>`
  );
  for (const [name, content] of Object.entries(options.files))
    await fs.outputFile(path.join(root, "OPS", name), content);
  for (const [name, content] of Object.entries(options.outside ?? {}))
    await fs.outputFile(path.join(parent, name), content);
  const opfPath = await getOPFPath(root);
  return { report: await collectEpubAccessibility(root, opfPath, await parseOPF(opfPath)) };
}

describe("EPUB accessibility checks", () => {
  it("finds no issue in a book with language, text alternatives, metadata and page navigation", async () => {
    const { report } = await inspect({
      metadata: `<dc:language>en</dc:language><dc:source>urn:isbn:9780000000000</dc:source>
        <meta property="schema:accessMode">textual</meta><meta property="schema:accessMode">visual</meta>
        <meta property="schema:accessModeSufficient">textual</meta>
        <meta property="schema:accessibilityFeature">alternativeText</meta>
        <meta property="schema:accessibilityHazard">none</meta>
        <meta property="schema:accessibilitySummary">Images are described.</meta>
        <meta property="dcterms:conformsTo">EPUB Accessibility 1.1 - WCAG 2.1 Level AA</meta>`,
      files: {
        "chapter.xhtml": `<html ${XHTML} lang="en"><body>
          <span epub:type="pagebreak" role="doc-pagebreak" id="p1" aria-label="1"/>
          <img src="a.png" alt="A cat"/><img src="b.png" aria-label="A dog"/>
          <img src="c.png" aria-labelledby="caption"/><img src="d.png" title="A bird"/>
          <img src="e.png" role="presentation"/><img src="f.png" role="none"/></body></html>`,
        "nav.xhtml": `<html ${XHTML} xml:lang="en"><body><nav epub:type="page-list"><ol><li><a href="chapter.xhtml#p1">1</a></li></ol></nav></body></html>`,
      },
    });

    expect(report.issues).toEqual([]);
    expect(report.language).toEqual({
      package: ["en"],
      documents: 2,
      documentsWithoutLanguage: [],
    });
    expect(report.images).toEqual({
      total: 6,
      withoutTextAlternative: 0,
      emptyAlt: 0,
      withoutTextAlternativeImages: [],
    });
    expect(report.metadata).toEqual({
      accessMode: ["textual", "visual"],
      accessModeSufficient: ["textual"],
      accessibilityFeature: ["alternativeText"],
      accessibilityHazard: ["none"],
      hasAccessibilitySummary: true,
      conformsTo: ["EPUB Accessibility 1.1 - WCAG 2.1 Level AA"],
    });
    expect(report.pageNavigation).toEqual({
      pageBreaks: 1,
      hasPageList: true,
      hasPageSource: true,
    });
  });

  it("reports missing language, text alternatives, metadata and page list with exact locations", async () => {
    const { report } = await inspect({
      // A manifest href that leaves the EPUB root must never be read.
      manifest: '<item id="out" href="../../outside.xhtml" media-type="application/xhtml+xml"/>',
      outside: { "outside.xhtml": `<html ${XHTML}><body><img src="secret.png"/></body></html>` },
      files: {
        "one.xhtml": `<html ${XHTML}><body><img src="images/a.png"/><img alt="" src="b.png"/>
          <img src="c.png" alt="Described"/><img src="d.png" title=" " aria-label=""/>
          <span epub:type="pagebreak" id="p1"/><div role="doc-pagebreak" id="p2"/></body></html>`,
        "two.xhtml": `<html ${XHTML} lang=" "><body><img alt="  " src="e.png"/></body></html>`,
        "three.xhtml": `<html ${XHTML} xml:lang="fr"><body><p>Texte</p></body></html>`,
      },
    });
    expect(report.language).toEqual({
      package: [],
      documents: 3,
      documentsWithoutLanguage: ["OPS/one.xhtml", "OPS/two.xhtml"],
    });
    expect(report.images).toEqual({
      total: 5,
      withoutTextAlternative: 2,
      emptyAlt: 2,
      withoutTextAlternativeImages: [
        { document: "OPS/one.xhtml", src: "images/a.png" },
        { document: "OPS/one.xhtml", src: "d.png" },
      ],
    });
    expect(report.pageNavigation).toEqual({
      pageBreaks: 2,
      hasPageList: false,
      hasPageSource: false,
    });
    expect(report.issues.map((issue) => [issue.level, issue.code])).toEqual([
      ["warning", "a11y-missing-package-language"],
      ["warning", "a11y-documents-without-language"],
      ["warning", "a11y-images-without-text-alternative"],
      ["info", "a11y-empty-alt"],
      ["warning", "a11y-missing-metadata"],
      ["info", "a11y-missing-recommended-metadata"],
      ["info", "a11y-no-conformance-claim"],
      ["warning", "a11y-page-breaks-without-page-list"],
      ["info", "a11y-page-breaks-without-source"],
    ]);
    expect(report.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "2 of 3 content document(s) declare no lang or xml:lang on the root element.",
        "2 of 5 image(s) have no text alternative (alt attribute).",
        "Accessibility metadata required by EPUB Accessibility 1.1 is missing: schema:accessMode, schema:accessibilityFeature, schema:accessibilityHazard.",
        "2 page break marker(s) are present, but no page list navigation was found.",
      ])
    );
  });

  it("reads EPUB 2 metadata, link conformance claims and an NCX page list", async () => {
    const { report } = await inspect({
      metadata: `<dc:language>fr</dc:language>
        <meta name="schema:accessMode" content="textual"/>
        <meta name="schema:accessibilityFeature" content="structuralNavigation"/>
        <meta name="schema:accessibilityHazard" content="none"/>
        <meta name="pageBreakSource" content="urn:isbn:9780000000000"/>
        <link rel="dcterms:conformsTo" href="http://www.idpf.org/epub/a11y/accessibility-20170105.html#wcag-aa"/>`,
      manifest: '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
      files: {
        "chapter.xhtml": `<html ${XHTML} xml:lang="fr"><body><span epub:type="pagebreak" id="p1"/></body></html>`,
        "toc.ncx":
          '<ncx><navMap/><pageList><pageTarget><content src="chapter.xhtml#p1"/></pageTarget></pageList></ncx>',
      },
    });

    expect(report.metadata).toMatchObject({
      accessMode: ["textual"],
      accessibilityFeature: ["structuralNavigation"],
      accessibilityHazard: ["none"],
      conformsTo: ["http://www.idpf.org/epub/a11y/accessibility-20170105.html#wcag-aa"],
    });
    expect(report.pageNavigation).toEqual({
      pageBreaks: 1,
      hasPageList: true,
      hasPageSource: true,
    });
    expect(report.issues.map((issue) => issue.code)).toEqual(["a11y-missing-recommended-metadata"]);
  });

  it("caps the listed images but keeps the exact count", async () => {
    const count = MAX_LISTED_IMAGES + 5;
    const { report } = await inspect({
      files: {
        "gallery.xhtml": `<html ${XHTML} lang="en"><body>${Array.from({ length: count }, (_, index) => `<img src="i${index}.png"/>`).join("")}</body></html>`,
      },
    });

    expect(report.images.withoutTextAlternative).toBe(count);
    expect(report.images.withoutTextAlternativeImages).toHaveLength(MAX_LISTED_IMAGES);
    expect(report.images.withoutTextAlternativeImages.at(-1)).toEqual({
      document: "OPS/gallery.xhtml",
      src: `i${MAX_LISTED_IMAGES - 1}.png`,
    });
  });
});
