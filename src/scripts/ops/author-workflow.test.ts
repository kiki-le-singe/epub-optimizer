import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import {
  resolveAuthorWorkflowConfig,
  type AuthorWorkflowConfig,
} from "../../utils/author-workflow-config.js";
import { run as updateSummary } from "./update-summary-page.js";
import { run as updateToc } from "./update-toc-with-cover.js";
import { run as addSections } from "./add-chapter-sections-to-toc.js";
import { run as addCoverProperty } from "./add-cover-image-property.js";
import { runStructureUpdates } from "./update-structure.js";

const directories: string[] = [];
const xhtml = (body: string) =>
  `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Generated test book</title></head><body>${body}</body></html>`;

async function fixture(
  options: {
    nav?: boolean;
    ncx?: boolean;
    config?: Partial<AuthorWorkflowConfig>;
    nestedNavigation?: boolean;
  } = {}
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-author-regression-"));
  directories.push(root);
  const config = resolveAuthorWorkflowConfig(options.config);
  const content = path.join(root, "Book", "OPS");
  const opf = path.join(content, "package.opf");
  const nav = path.join(content, options.nestedNavigation ? "navigation/toc.xhtml" : "toc.xhtml");
  const ncx = path.join(content, options.nestedNavigation ? "navigation/toc.ncx" : "toc.ncx");
  const summary = path.join(content, config.summaryHref);
  const cover = path.join(content, config.coverHref);
  const chapter = path.join(content, "text/chapter-one.xhtml");
  const chapterTwo = path.join(content, "text/chapter-two.xhtml");
  const relative = (owner: string, target: string) =>
    encodeURI(path.relative(path.dirname(owner), target).split(path.sep).join("/"));
  await fs.outputFile(
    path.join(root, "META-INF/container.xml"),
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="Book/OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  );
  await fs.outputFile(
    opf,
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest>
    <item id="${config.coverSpineId}" href="${encodeURI(config.coverHref)}" media-type="application/xhtml+xml"/>
    <item id="summary" href="${encodeURI(config.summaryHref)}" media-type="application/xhtml+xml"/>
    <item id="one" href="text/chapter-one.xhtml" media-type="application/xhtml+xml"/>
    <item id="two" href="text/chapter-two.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-image" href="images/cover.png" media-type="image/png"/>
    ${options.nav === false ? "" : `<item id="nav" properties="nav" href="${relative(opf, nav)}" media-type="application/xhtml+xml"/>`}
    ${options.ncx === false ? "" : `<item id="ncx" href="${relative(opf, ncx)}" media-type="application/x-dtbncx+xml"/>`}
    </manifest><spine toc="ncx"><itemref idref="${config.coverSpineId}" linear="no"/><itemref idref="summary"/><itemref idref="one"/><itemref idref="two"/></spine></package>`
  );
  await fs.outputFile(
    chapter,
    xhtml(
      '<h1 id="start">Chapter one</h1><h2 id="first">Section α</h2><p>Keep <em>this</em> text &amp; its spacing.</p>'
    )
  );
  await fs.outputFile(chapterTwo, xhtml('<h1 id="start">Chapter two</h1><p>Résumé — café.</p>'));
  await fs.outputFile(cover, xhtml('<p id="cover">Book cover</p>'));
  await fs.outputFile(path.join(content, "images/cover.png"), Buffer.from([137, 80, 78, 71]));
  await fs.outputFile(
    summary,
    xhtml(`
    <p class="${config.summaryEntryClass}"><a href="${relative(summary, summary)}#top">Contents</a></p>
    <p class="${config.sectionClasses[0]}"><a href="${relative(summary, chapter)}#orphan">Unassigned section</a></p>
    <p class="decoration ${config.chapterClasses[0]}"><a href="${relative(summary, chapter)}#start">Chapter one</a></p>
    <p class="${config.sectionClasses[0]}"><a href="${relative(summary, chapter)}#first">Section α</a></p>
    <p class="${config.chapterClasses[1] ?? config.chapterClasses[0]}"><a href="${relative(summary, chapterTwo)}#start">Chapter two</a></p>
    <p id="keep">Unrelated text <em>must stay</em>.</p>`)
  );
  if (options.nav !== false)
    await fs.outputFile(
      nav,
      xhtml(`<nav epub:type="toc"><ol>
    <li id="chapter-one"><a href="${relative(nav, chapter)}">Chapter one</a></li>
    <li id="chapter-two"><a href="${relative(nav, chapterTwo)}">Chapter two</a></li>
    </ol></nav>`)
    );
  if (options.ncx !== false)
    await fs.outputFile(
      ncx,
      `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><head><meta name="dtb:depth" content="1"/></head><navMap>
    <navPoint id="one" playOrder="8"><navLabel><text>Chapter one</text></navLabel><content src="${relative(ncx, chapter)}"/></navPoint>
    <navPoint id="two" playOrder="2"><navLabel><text>Chapter two</text></navLabel><content src="${relative(ncx, chapterTwo)}"/></navPoint>
    </navMap></ncx>`
    );
  return {
    root,
    content,
    opf,
    nav,
    ncx,
    summary,
    cover,
    chapter,
    chapterTwo,
    config,
    opts: { tempDir: root, lang: "en", authorConfig: config },
  };
}

async function readXml(file: string) {
  return cheerio.load(await fs.readFile(file, "utf8"), { xmlMode: true });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fs.remove(directory)));
});

describe("manual author summary", () => {
  it("removes its self-reference, inserts the localized cover once and retains reading links and text", async () => {
    const book = await fixture();
    await updateSummary({ ...book.opts, lang: "fr" });
    const first = await fs.readFile(book.summary, "utf8");
    const $ = await readXml(book.summary);
    expect(
      $("a")
        .map((_, a) => $(a).attr("href"))
        .get()
    ).toEqual([
      "text/chapter-one.xhtml#orphan",
      "cover.xhtml",
      "text/chapter-one.xhtml#start",
      "text/chapter-one.xhtml#first",
      "text/chapter-two.xhtml#start",
    ]);
    expect($("p.p6 > a").first().text()).toBe("Couverture");
    expect($("#keep").text()).toBe("Unrelated text must stay.");
    await updateSummary({ ...book.opts, lang: "fr" });
    expect(await fs.readFile(book.summary, "utf8")).toBe(first);
  });

  it("uses custom classes and owner-relative encoded cover paths", async () => {
    const book = await fixture({
      config: {
        summaryHref: "front/contents.xhtml",
        coverHref: "art/front cover.xhtml",
        summaryEntryClass: "chapter",
        chapterClasses: ["chapter"],
        sectionClasses: ["section"],
      },
    });
    await updateSummary(book.opts);
    const $ = await readXml(book.summary);
    expect($("p.chapter > a").first().attr("href")).toBe("../art/front%20cover.xhtml");
    expect($("p.chapter > a").first().text()).toBe("Cover");
    expect($("a[href='../text/chapter-one.xhtml#first']").text()).toBe("Section α");
    expect($("#keep em").text()).toBe("must stay");
  });

  it("recognizes a cover link with a fragment instead of duplicating it", async () => {
    const book = await fixture();
    await fs.outputFile(
      book.summary,
      xhtml(
        '<p class="p6"><a href="./cover.xhtml#cover">Existing cover</a></p><p class="p6"><a href="text/chapter-one.xhtml">Chapter one</a></p>'
      )
    );
    await updateSummary(book.opts);
    const $ = await readXml(book.summary);
    expect($("a").length).toBe(2);
    expect($("a").first().text()).toBe("Existing cover");
  });

  it("leaves missing summaries absent and reports missing entry classes without removing unrelated text", async () => {
    const book = await fixture();
    await fs.remove(book.summary);
    await updateSummary(book.opts);
    expect(await fs.pathExists(book.summary)).toBe(false);
    await fs.outputFile(book.summary, xhtml('<p id="keep">Keep this text.</p>'));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await updateSummary(book.opts);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Could not find link paragraphs"));
    expect((await readXml(book.summary))("#keep").text()).toBe("Keep this text.");
  });
});

describe("cover navigation", () => {
  it.each([
    [
      "alternate namespace prefix",
      '<nav xmlns:ops="http://www.idpf.org/2007/ops" ops:type="toc">',
      true,
    ],
    ["space-separated type tokens", '<nav epub:type="toc landmarks">', true],
    ["accessibility role", '<nav role="doc-toc">', true],
    ["plain navigation", "<nav>", false],
    ["bare list", "", false],
  ])(
    "finds the TOC via %s without changing unrelated navigation",
    async (_, opening, hasLandmarks) => {
      const book = await fixture({ ncx: false });
      const landmarks =
        '<nav epub:type="landmarks"><ol id="landmarks"><li><a href="chapter-2.xhtml">Contents</a></li></ol></nav>';
      await fs.writeFile(
        book.nav,
        xhtml(
          `${hasLandmarks ? landmarks : ""}${opening}<ol id="toc"><li><a href="text/chapter-one.xhtml">Chapter one</a></li></ol>${opening ? "</nav>" : ""}`
        )
      );
      await updateToc(book.opts);
      const $ = await readXml(book.nav);
      expect(
        $("#toc > li > a")
          .map((_, a) => $(a).attr("href"))
          .get()
      ).toEqual(["cover.xhtml", "text/chapter-one.xhtml"]);
      if (hasLandmarks)
        expect(
          $("#landmarks > li > a")
            .map((_, a) => $(a).attr("href"))
            .get()
        ).toEqual(["chapter-2.xhtml"]);
    }
  );

  it.each([
    ["en", "Cover"],
    ["fr", "Couverture"],
  ])(
    "adds one %s cover to nested EPUB3 and NCX navigation, preserving chapter order",
    async (lang, label) => {
      const book = await fixture({
        nestedNavigation: true,
        config: {
          coverHref: "art/front cover.xhtml",
          coverSpineId: "front",
          coverNavClass: "front-link",
        },
      });
      await updateToc({ ...book.opts, lang });
      const $nav = await readXml(book.nav);
      expect(
        $nav("nav > ol > li > a")
          .map((_, a) => $nav(a).text())
          .get()
      ).toEqual([label, "Chapter one", "Chapter two"]);
      expect($nav("nav > ol > li").first().attr("class")).toBe("front-link");
      expect($nav("nav > ol > li > a").first().attr("href")).toBe("../art/front%20cover.xhtml");
      const $ncx = await readXml(book.ncx);
      expect($ncx("navMap > navPoint > content").first().attr("src")).toBe(
        "../art/front%20cover.xhtml"
      );
      expect($ncx("navMap > navPoint").first().attr("id")).toBe("navpoint-front");
      expect(
        $ncx("navPoint")
          .map((_, point) => $ncx(point).attr("playOrder"))
          .get()
      ).toEqual(["1", "2", "3"]);
      const snapshots = await Promise.all(
        [book.nav, book.ncx].map((file) => fs.readFile(file, "utf8"))
      );
      await updateToc({ ...book.opts, lang });
      expect(
        await Promise.all([book.nav, book.ncx].map((file) => fs.readFile(file, "utf8")))
      ).toEqual(snapshots);
    }
  );

  it.each([
    { nav: true, ncx: false },
    { nav: false, ncx: true },
  ])("supports navigation when only one format is declared: %o", async (formats) => {
    const book = await fixture(formats);
    await updateToc(book.opts);
    const $ = await readXml(formats.nav ? book.nav : book.ncx);
    expect(
      formats.nav
        ? $("nav > ol > li > a").first().text()
        : $("navMap > navPoint > navLabel > text").first().text()
    ).toBe("Cover");
  });

  it("does not create navigation when the manifest declares none", async () => {
    const book = await fixture({ nav: false, ncx: false });
    const opf = await fs.readFile(book.opf, "utf8");
    await updateToc(book.opts);
    expect(await fs.pathExists(book.nav)).toBe(false);
    expect(await fs.pathExists(book.ncx)).toBe(false);
    expect(await fs.readFile(book.opf, "utf8")).toBe(opf);
  });

  it("reports absent navigation containers and preserves the original documents", async () => {
    const book = await fixture();
    const nav = xhtml('<p id="keep">No TOC list.</p>');
    const ncx = "<ncx><head/><docTitle><text>No navMap.</text></docTitle></ncx>";
    await fs.writeFile(book.nav, nav);
    await fs.writeFile(book.ncx, ncx);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await updateToc(book.opts);
    expect(await fs.readFile(book.nav, "utf8")).toBe(nav);
    expect(await fs.readFile(book.ncx, "utf8")).toBe(ncx);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Could not find TOC list"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Could not find navMap"));
  });
});

describe("chapter sections", () => {
  it("copies section links under their chapter in both formats, with sequential NCX order and stable retries", async () => {
    const book = await fixture({ config: { sectionNavClass: "subsection" } });
    await addSections(book.opts);
    const $nav = await readXml(book.nav);
    expect($nav("#chapter-one > ol > li > a").attr("href")).toBe("text/chapter-one.xhtml#first");
    expect($nav("#chapter-one > ol > li > a").text()).toBe("Section α");
    expect($nav("#chapter-one > ol > li").attr("class")).toBe("subsection");
    expect($nav("#chapter-two > ol").length).toBe(0);
    const $ncx = await readXml(book.ncx);
    expect($ncx('navPoint[id="one"] > navPoint > content').attr("src")).toBe(
      "text/chapter-one.xhtml#first"
    );
    expect(
      $ncx("navPoint")
        .map((_, point) => $ncx(point).attr("playOrder"))
        .get()
    ).toEqual(["1", "2", "3"]);
    expect($ncx('meta[name="dtb:depth"]').attr("content")).toBe("2");
    expect(
      $ncx("navPoint")
        .map((_, point) => $ncx(point).attr("id"))
        .get()
    ).toEqual(["one", "one-section-1", "two"]);
    const snapshots = await Promise.all(
      [book.nav, book.ncx].map((file) => fs.readFile(file, "utf8"))
    );
    await addSections(book.opts);
    expect(
      await Promise.all([book.nav, book.ncx].map((file) => fs.readFile(file, "utf8")))
    ).toEqual(snapshots);
  });

  it("can locate existing chapter entries by title when their href includes a fragment", async () => {
    const book = await fixture();
    for (const file of [book.nav, book.ncx])
      await fs.writeFile(
        file,
        (await fs.readFile(file, "utf8")).replaceAll(
          'chapter-one.xhtml"',
          'chapter-one.xhtml#start"'
        )
      );
    await addSections(book.opts);
    expect((await readXml(book.nav))("#chapter-one > ol > li > a").text()).toBe("Section α");
    expect((await readXml(book.ncx))('navPoint[id="one"] > navPoint > content').attr("src")).toBe(
      "text/chapter-one.xhtml#first"
    );
  });

  it.each(["missing summary", "no chapters", "no sections", "no navigation"])(
    "leaves navigation unchanged with %s",
    async (condition) => {
      const book = await fixture(condition === "no navigation" ? { nav: false, ncx: false } : {});
      if (condition === "missing summary") await fs.remove(book.summary);
      if (condition === "no chapters")
        await fs.writeFile(
          book.summary,
          xhtml('<p><a href="text/chapter-one.xhtml">Unclassified entry</a></p>')
        );
      if (condition === "no sections")
        await fs.writeFile(
          book.summary,
          xhtml('<p class="p6"><a href="text/chapter-one.xhtml">Chapter one</a></p>')
        );
      const before = await Promise.all(
        [book.nav, book.ncx].map((file) =>
          fs.pathExists(file).then((exists) => (exists ? fs.readFile(file, "utf8") : undefined))
        )
      );
      await addSections(book.opts);
      const after = await Promise.all(
        [book.nav, book.ncx].map((file) =>
          fs.pathExists(file).then((exists) => (exists ? fs.readFile(file, "utf8") : undefined))
        )
      );
      expect(after).toEqual(before);
    }
  );
});

describe("cover image manifest property", () => {
  it("marks the cover image while preserving the rest of the manifest and spine", async () => {
    const book = await fixture();
    await addCoverProperty(book.opts);
    const $ = await readXml(book.opf);
    expect($('item[id="cover-image"]').attr("properties")).toBe("cover-image");
    expect($('item[id="nav"]').attr("properties")).toBe("nav");
    expect($("manifest item").length).toBe(7);
    expect(
      $("spine itemref")
        .map((_, item) => $(item).attr("idref"))
        .get()
    ).toEqual(["cover", "summary", "one", "two"]);
    const first = await fs.readFile(book.opf, "utf8");
    await addCoverProperty(book.opts);
    expect(await fs.readFile(book.opf, "utf8")).toBe(first);
  });

  it("warns and preserves the OPF when the expected cover image is absent", async () => {
    const book = await fixture();
    const original = (await fs.readFile(book.opf, "utf8")).replace(
      'id="cover-image"',
      'id="other-image"'
    );
    await fs.writeFile(book.opf, original);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await addCoverProperty(book.opts);
    expect(await fs.readFile(book.opf, "utf8")).toBe(original);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Could not find cover-image item"));
  });
});

describe("complete author structure workflow", () => {
  it("updates the cover, summary and both TOCs without changing chapter bytes or reading order", async () => {
    const book = await fixture();
    const protectedFiles = [
      book.chapter,
      book.chapterTwo,
      book.cover,
      path.join(book.content, "images/cover.png"),
    ];
    const originals = await Promise.all(protectedFiles.map((file) => fs.readFile(file)));
    await runStructureUpdates(book.opts);
    const $opf = await readXml(book.opf);
    expect($opf('itemref[idref="cover"]').attr("linear")).toBe("yes");
    expect(
      $opf("spine itemref")
        .map((_, item) => $opf(item).attr("idref"))
        .get()
    ).toEqual(["cover", "summary", "one", "two"]);
    const $nav = await readXml(book.nav);
    expect(
      $nav("nav > ol > li > a")
        .map((_, a) => $nav(a).attr("href"))
        .get()
    ).toEqual(["cover.xhtml", "text/chapter-one.xhtml", "text/chapter-two.xhtml"]);
    expect($nav("#chapter-one > ol > li > a").attr("href")).toBe("text/chapter-one.xhtml#first");
    expect((await readXml(book.summary))("p.p6 > a").first().text()).toBe("Cover");
    const $ncx = await readXml(book.ncx);
    expect(
      $ncx("navPoint")
        .map((_, point) => $ncx(point).attr("playOrder"))
        .get()
    ).toEqual(["1", "2", "3", "4"]);
    expect($ncx('meta[name="dtb:depth"]').attr("content")).toBe("2");
    const changed = [book.opf, book.summary, book.nav, book.ncx];
    const first = await Promise.all(changed.map((file) => fs.readFile(file, "utf8")));
    await runStructureUpdates(book.opts);
    expect(await Promise.all(changed.map((file) => fs.readFile(file, "utf8")))).toEqual(first);
    expect(await Promise.all(protectedFiles.map((file) => fs.readFile(file)))).toEqual(originals);
  });
});
