# Validation corpus

Build with Node 24 and run `pnpm test:e2e` with Java 17+ and the pinned EPUBCheck
installation (`bash scripts/install-epubcheck.sh epubcheck`). Fixtures are generated
in a unique temporary directory. No user EPUB or system font is committed or uploaded.

## Automated coverage

| Publication or condition                                                          | Check                                                                                                                                               |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| EPUB 3 with nested and manifest-typed content, navigation and internal references | Existing optimizing, repair, author and configured-author E2E workflows; text/content integrity and EPUBCheck                                       |
| EPUB 2, external XHTML doctype, named entities and CDATA                          | Existing legacy and legacy-repair E2E workflows                                                                                                     |
| Transparent, opaque and animated images                                           | Existing default/lossless/explicit background E2E workflows                                                                                         |
| Embedded generated fonts                                                          | Existing default preservation, opt-in subsetting and strict failure E2E workflows                                                                   |
| Pre-paginated EPUB 3 with a 2200 × 1100 image                                     | New balanced case keeps image dimensions; lossless case additionally retains exact image bytes; both preserve default font bytes and pass EPUBCheck |
| Fixed-layout warning in strict mode                                               | New case refuses publication and retains an existing output                                                                                         |
| Internal DTD/entity declaration                                                   | New case refuses publication even without strict mode and retains an existing output                                                                |
| Continuous processing                                                             | Existing native CLI, Docker and Compose cases cover failed-book continuation, completion records and graceful restart/stop                          |

`scripts/validation-corpus.ts` adds the focused fixed-layout/refusal cases to the
normal E2E suite. Its `corpus-summary.json` records expected outcomes, actual exit
codes, validator totals, integrity and sizes. The usual E2E diagnostic collection
can retain generated reports with `EPUB_E2E_ARTIFACT_DIR=reports/e2e`; input and output
EPUB archives are not diagnostic artifacts. Temporary fixtures are removed after tests.

These synthetic fixtures test specific contracts. They do not establish compatibility
with every publisher, certify rendering, measure general performance, or replace a
representative set of legally available real books.

## Manual reading-system review

For private/local trials, keep the original and optimized book side by side and record:

- Reader name/version, operating system, optimizer version, preset and explicit options.
- Cover, table of contents, reading order, chapter navigation and internal links.
- Text selection/search, accents and combining characters, right-to-left text, ligatures.
- Image orientation, transparency, fine text in images, light/dark themes and zoom.
- Embedded font appearance, fallback glyphs and fixed-layout page/image alignment.
- Input/output sizes and JSON/HTML report, including all warnings or skipped features.

Include EPUB 2/3, embedded fonts, fixed-layout, image-heavy and large representative
books. Run the same input/options/runtime when comparing versions. Record Node and
Java memory separately if measuring resources. Do not upload private books, screenshots,
metadata or local reports without explicit permission. A rendering issue should become
a minimal generated regression fixture whenever possible.
