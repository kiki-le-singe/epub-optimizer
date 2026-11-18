import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { resolvePathInside } from "./path-safety.js";

/** Listed images without a text alternative are capped; the count is always exact. */
export const MAX_LISTED_IMAGES = 1000;

export interface AccessibilityIssue {
  level: "info" | "warning";
  code: string;
  message: string;
}

/**
 * Heuristic accessibility findings for one EPUB. This is a subset of what the
 * EPUB Accessibility specification and WCAG require; it is not a conformance audit.
 */
export interface EpubAccessibilityReport {
  language: {
    /** `dc:language` values declared by the package. */
    package: string[];
    documents: number;
    /** XHTML documents whose root element has no `lang` or `xml:lang`. */
    documentsWithoutLanguage: string[];
  };
  images: {
    /** `<img>` elements in XHTML content documents. */
    total: number;
    /** Images with no `alt`, ARIA label, title or presentational role. */
    withoutTextAlternative: number;
    /** Images explicitly marked decorative with `alt=""`. */
    emptyAlt: number;
    /** First images without a text alternative, at most {@link MAX_LISTED_IMAGES}. */
    withoutTextAlternativeImages: Array<{ document: string; src: string }>;
  };
  metadata: {
    accessMode: string[];
    accessModeSufficient: string[];
    accessibilityFeature: string[];
    accessibilityHazard: string[];
    hasAccessibilitySummary: boolean;
    /** `dcterms:conformsTo` values, from `meta` and `link` elements. */
    conformsTo: string[];
  };
  pageNavigation: {
    /** Page break markers (`epub:type="pagebreak"` or `role="doc-pagebreak"`). */
    pageBreaks: number;
    hasPageList: boolean;
    /** `dc:source` or `pageBreakSource` identifies the paginated source. */
    hasPageSource: boolean;
  };
  issues: AccessibilityIssue[];
}

const XHTML_MEDIA_TYPE = "application/xhtml+xml";

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/** Values of one schema.org property, in EPUB 3 (`property`) or EPUB 2 (`name`/`content`) form. */
function metaValues($opf: cheerio.CheerioAPI, property: string): string[] {
  const values: string[] = [];
  for (const element of $opf("metadata meta").toArray()) {
    const meta = $opf(element);
    const value =
      meta.attr("property")?.trim() === property
        ? meta.text()
        : meta.attr("name")?.trim() === property
          ? meta.attr("content")
          : undefined;
    if (value?.trim()) values.push(value.trim());
  }
  return values;
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/** Same acceptance as the axe-core `image-alt` rule used by Ace by DAISY. */
function hasTextAlternative(attr: (name: string) => string | undefined): boolean {
  const role = attr("role")?.trim().toLowerCase();
  return (
    attr("alt") !== undefined ||
    hasText(attr("aria-label")) ||
    hasText(attr("aria-labelledby")) ||
    hasText(attr("title")) ||
    role === "presentation" ||
    role === "none"
  );
}

function buildIssues(report: Omit<EpubAccessibilityReport, "issues">): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  const add = (level: AccessibilityIssue["level"], code: string, message: string) =>
    issues.push({ level, code, message });
  const { language, images, metadata, pageNavigation } = report;

  if (language.package.length === 0)
    add("warning", "a11y-missing-package-language", "The package declares no dc:language.");
  if (language.documentsWithoutLanguage.length > 0)
    add(
      "warning",
      "a11y-documents-without-language",
      `${language.documentsWithoutLanguage.length} of ${language.documents} content document(s) declare no lang or xml:lang on the root element.`
    );
  if (images.withoutTextAlternative > 0)
    add(
      "warning",
      "a11y-images-without-text-alternative",
      `${images.withoutTextAlternative} of ${images.total} image(s) have no text alternative (alt attribute).`
    );
  if (images.emptyAlt > 0)
    add(
      "info",
      "a11y-empty-alt",
      `${images.emptyAlt} of ${images.total} image(s) have an empty alt and are treated as decorative; check that none conveys information.`
    );

  const required = (
    [
      ["schema:accessMode", metadata.accessMode],
      ["schema:accessibilityFeature", metadata.accessibilityFeature],
      ["schema:accessibilityHazard", metadata.accessibilityHazard],
    ] as const
  )
    .filter(([, values]) => values.length === 0)
    .map(([name]) => name);
  if (required.length > 0)
    add(
      "warning",
      "a11y-missing-metadata",
      `Accessibility metadata required by EPUB Accessibility 1.1 is missing: ${required.join(", ")}.`
    );
  const recommended = [
    ...(metadata.accessModeSufficient.length === 0 ? ["schema:accessModeSufficient"] : []),
    ...(metadata.hasAccessibilitySummary ? [] : ["schema:accessibilitySummary"]),
  ];
  if (recommended.length > 0)
    add(
      "info",
      "a11y-missing-recommended-metadata",
      `Recommended accessibility metadata is missing: ${recommended.join(", ")}.`
    );
  if (!metadata.conformsTo.some((value) => /epub accessibility|\/epub\/a11y\//i.test(value)))
    add(
      "info",
      "a11y-no-conformance-claim",
      "No EPUB Accessibility conformance claim (dcterms:conformsTo) is declared."
    );

  if (pageNavigation.pageBreaks > 0 && !pageNavigation.hasPageList)
    add(
      "warning",
      "a11y-page-breaks-without-page-list",
      `${pageNavigation.pageBreaks} page break marker(s) are present, but no page list navigation was found.`
    );
  if (pageNavigation.pageBreaks > 0 && !pageNavigation.hasPageSource)
    add(
      "info",
      "a11y-page-breaks-without-source",
      "Page break markers are present, but no pageBreakSource or dc:source identifies their source; this is required when they follow a paginated edition."
    );

  return issues;
}

/**
 * Collects heuristic accessibility findings from an extracted EPUB.
 * Callers must already have rejected internal DTD subsets before parsing its XML.
 */
export async function collectEpubAccessibility(
  epubDir: string,
  opfPath: string,
  $opf: cheerio.CheerioAPI
): Promise<EpubAccessibilityReport> {
  const opfDir = path.dirname(opfPath);
  const documents: string[] = [];
  const seen = new Set<string>();
  let hasPageList = false;

  for (const element of $opf("manifest item").toArray()) {
    const item = $opf(element);
    const href = item.attr("href");
    const mediaType = (item.attr("media-type") ?? "").trim().toLowerCase();
    if (!href || (mediaType !== XHTML_MEDIA_TYPE && mediaType !== "application/x-dtbncx+xml"))
      continue;
    let filePath: string;
    try {
      filePath = resolvePathInside(epubDir, opfDir, href, "manifest href");
    } catch {
      continue;
    }
    if (seen.has(filePath) || !(await fs.pathExists(filePath))) continue;
    seen.add(filePath);
    if (mediaType === XHTML_MEDIA_TYPE) documents.push(filePath);
    else if (
      cheerio.load(await fs.readFile(filePath, "utf8"), { xmlMode: true })("pageList pageTarget")
        .length > 0
    )
      hasPageList = true;
  }

  const documentsWithoutLanguage: string[] = [];
  const withoutTextAlternativeImages: Array<{ document: string; src: string }> = [];
  let total = 0;
  let withoutTextAlternative = 0;
  let emptyAlt = 0;
  let pageBreaks = 0;

  for (const filePath of documents) {
    const relative = toPosixPath(path.relative(epubDir, filePath));
    const $ = cheerio.load(await fs.readFile(filePath, "utf8"), { xmlMode: true });
    const root = $("html").first();
    if (!hasText(root.attr("lang")) && !hasText(root.attr("xml:lang")))
      documentsWithoutLanguage.push(relative);

    for (const element of $("img").toArray()) {
      const attr = (name: string) => $(element).attr(name);
      total++;
      if (!hasTextAlternative(attr)) {
        withoutTextAlternative++;
        if (withoutTextAlternativeImages.length < MAX_LISTED_IMAGES)
          withoutTextAlternativeImages.push({ document: relative, src: attr("src") ?? "" });
      } else if (
        attr("alt")?.trim() === "" &&
        !hasText(attr("aria-label")) &&
        !hasText(attr("aria-labelledby"))
      ) {
        emptyAlt++;
      }
    }

    pageBreaks += $('[epub\\:type~="pagebreak"], [role~="doc-pagebreak"]').length;
    if ($('nav[epub\\:type~="page-list"] a, nav[role~="doc-pagelist"] a').length > 0)
      hasPageList = true;
  }

  const conformsTo = [
    ...metaValues($opf, "dcterms:conformsTo"),
    ...$opf("metadata link")
      .toArray()
      .filter((element) =>
        ($opf(element).attr("rel") ?? "").split(/\s+/).includes("dcterms:conformsTo")
      )
      .map((element) => ($opf(element).attr("href") ?? "").trim())
      .filter(Boolean),
  ];
  const report = {
    language: {
      package: $opf("metadata dc\\:language")
        .toArray()
        .map((element) => $opf(element).text().trim())
        .filter(Boolean),
      documents: documents.length,
      documentsWithoutLanguage,
    },
    images: { total, withoutTextAlternative, emptyAlt, withoutTextAlternativeImages },
    metadata: {
      accessMode: metaValues($opf, "schema:accessMode"),
      accessModeSufficient: metaValues($opf, "schema:accessModeSufficient"),
      accessibilityFeature: metaValues($opf, "schema:accessibilityFeature"),
      accessibilityHazard: metaValues($opf, "schema:accessibilityHazard"),
      hasAccessibilitySummary: metaValues($opf, "schema:accessibilitySummary").length > 0,
      conformsTo,
    },
    pageNavigation: {
      pageBreaks,
      hasPageList,
      hasPageSource:
        $opf("metadata dc\\:source").text().trim() !== "" ||
        metaValues($opf, "pageBreakSource").length > 0,
    },
  };
  return { ...report, issues: buildIssues(report) };
}
