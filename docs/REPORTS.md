# Doctor mode and reports

Inspect a book without changing it, and read the JSON and HTML reports written by an
optimization run.

## Doctor / Inspect Mode

Use `--doctor` or `--inspect` to analyze an EPUB without publishing a candidate output and without modifying the input archive:

```bash
pnpm optimize --doctor -i book.epub
pnpm optimize --inspect -i book.epub --report-json reports/book-doctor.json
```

Doctor mode extracts the EPUB to a system temporary directory, reads `container.xml` and the OPF manifest, prints a console summary, writes JSON when `--report-json` is provided, and removes its temporary extraction directory. It does not run the optimizing processors and it does not replace EPUBCheck.

For supported books, the report includes OPF path/version, manifest and spine counts, EPUB3/NCX navigation presence, internal reference counts and missing targets, image byte totals and largest images, duplicate image basenames, large raster images, opaque PNG conversion candidates, WebP images that older reading systems may not display, and other optimization-risk hints.

Doctor checks internal DTD subsets and content DRM before interpreting package or content XML. When either blocks optimization, it prints the reason and writes `analysisComplete: false`, `optimization.blocked: true`, and structured blockers in `optimization.blockers` and `risks`. Detailed `opf`, `navigation`, `references`, `images`, `content`, and `accessibility` fields are omitted rather than reporting misleading metrics. Font obfuscation alone remains inspectable. Exit code 0 means the diagnosis completed, including a diagnosis that finds a blocker; optimizing a blocked book still fails.

For a complete diagnosis, `analysisComplete` is true and `optimization.blocked` is false. These fields do not certify EPUB validity or replace EPUBCheck. Consumers of doctor JSON must check `analysisComplete` before reading detailed metrics.

Image reporting distinguishes `images.totalBytes` (uncompressed manifest image file bytes) from `images.compressedBytes` (the compressed ZIP payload of unique image resources). `images.archivePercent` uses compressed image bytes divided by the EPUB archive size, including ZIP overhead. Multiple manifest references to the same resource count once in the compressed share. When inspecting only an extracted directory without ZIP metadata, `compressedBytes` and `archivePercent` are `null`; uncompressed bytes are never presented as a percentage of compressed archive size.

### Accessibility Checks

A complete diagnosis also includes an `accessibility` object and a console section.
EPUBCheck validates the EPUB format, not accessibility; these checks cover a few
frequent, machine-detectable problems:

| Field            | What is checked                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `language`       | `dc:language` values of the package, and XHTML documents whose root element has no `lang` or `xml:lang`.                                                                                                           |
| `images`         | `<img>` elements without a text alternative. An image passes with an `alt` attribute (even empty), an ARIA label, a `title`, or `role="presentation"`/`"none"`. Images with an empty `alt` are counted separately. |
| `metadata`       | `schema:accessMode`, `accessModeSufficient`, `accessibilityFeature`, `accessibilityHazard`, `accessibilitySummary` and `dcterms:conformsTo`, in EPUB 3 or EPUB 2 (`name`/`content`) form.                          |
| `pageNavigation` | Page break markers, a page list (EPUB 3 `nav` or NCX `pageList`) and a paginated source (`dc:source` or `pageBreakSource`).                                                                                        |
| `issues`         | Findings as `{ level, code, message }`, with `a11y-` codes. Warnings are requirements of EPUB Accessibility 1.1 or WCAG; infos are recommendations or items to review.                                             |

`images.withoutTextAlternativeImages` lists at most 1,000 images as
`{ document, src }`; `images.withoutTextAlternative` is always the exact count.
Accessibility findings stay in `accessibility.issues` and are not added to the
optimization `risks`. They never change the exit code.

These are heuristics, not a conformance audit. They do not judge whether an
alternative text is meaningful, and they do not check contrast, heading order,
reading order, tables, link text, inline SVG or media overlays. Use a dedicated
checker such as [Ace by DAISY](https://daisy.github.io/ace/) and a manual review
before claiming conformance. The optimizer itself does not add or change
accessibility metadata or alternative text.

## Structured Reports and Profiling

- `--strict` also fails the run on processing or EPUBCheck warnings; processing and EPUBCheck errors always fail.
- `--report-html reports/book.html` writes a standalone, offline HTML report with archive size changes, validation/publication status, step diagnostics and a byte/content comparison of extracted resources. It is available for optimization runs; doctor mode continues to use JSON.
- `--profile` prints each pipeline step's status and duration.
- `--report-json reports/report.json` writes a structured report on success and on pipeline failures that occur after preflight path validation.
- The report directory is created automatically. Local reports under `reports/` are ignored by Git.

Processing diagnostics are emitted explicitly and collected within each asynchronous step; the optimizer does not replace global `console` methods or infer severity from message text. Step `messages` and strict warning/error handling retain their existing format. Custom API processing hooks should use the exported `reportWarning(...args)` and `reportError(...args)` helpers to participate in reports and strict checks. Ordinary `console` output remains display-only; thrown exceptions still fail the operation. Nested step diagnostics also reach the enclosing operation, while concurrent operations have separate collectors and completed steps stop collecting late callbacks. Batch concurrency is bounded by `--jobs` (one by default).

Unless `--min-image-ssim 0` is set, optimization reports include `imageQuality`: the configured `minSsim` and, sorted by path, one entry per lossy image encode that was kept or rejected. Each entry has the root-relative `path`, its `operation` (`recompress`, `png-to-jpeg` or `to-webp`), `convertedTo` for a kept conversion, the `ssim` score and the `outcome`: `accepted` (configured settings kept), `fallback` (higher-quality encode kept) or `kept-original`. HTML reports show the same table. Images that were skipped, or not reduced in size, have no entry.

Once EPUBCheck runs, optimization reports include an optional `validation` object with its native `exitCode`, diagnostic `source` (`json`, `text`, or `unavailable`), version when available, `totals` (`fatals`, `errors`, `warnings`, `infos`), and detailed `messages`. Each message contains a `code`, uppercase `severity`, `message`, `locations` (path and available line/column/context), `additionalLocations`, and an optional suggestion. The same details appear in HTML reports and per-book batch reports, including failed runs. These fields are additive; existing step statuses and messages are retained, and doctor mode is unchanged.

EPUBCheck groups repeated messages and [defaults to at most 25 occurrences per code/message combination](https://www.w3.org/publishing/epubcheck/docs/cli/); totals may exceed the detailed entries returned. Unknown line/column values are omitted. Publication metadata and unrelated raw validator fields are not copied into the optimization report. JSON diagnostics are read from a unique private temporary file with a 16 MiB limit and removed after the invocation. If they are missing, malformed, unsupported or too large, `diagnosticsError` explains that details are unavailable and the native text totals are used when readable. Strict mode still rejects warnings and unavailable totals; non-strict mode retains its native-exit fallback with an explicit warning when totals cannot be read. Fatal/error diagnostics also block publication even if a validator incorrectly exits with code 0.

HTML reports can be used alongside `--report-json`; all report paths must be distinct from the EPUBs and from each other, including symbolic/hard-link aliases. Reports are written on success and on processing/validation failures after preflight. A report write failure makes the command fail, while preserving any already-published validated EPUB. Resource hashing adds disk reads only when HTML reporting is requested. The report contains no external assets or scripts and escapes book-derived filenames and diagnostics. It contains local paths; review it before sharing. Added and removed resources can describe format conversion, and byte comparisons do not certify visual rendering.

```bash
pnpm optimize -i book.epub -o book-optimized.epub --clean \
  --report-html reports/book.html --report-json reports/book.json
```

Reports contain the configured input/output paths, preset, strict mode, timestamps, total duration, size reduction when available, per-step statuses/durations/messages, before/after content metrics, integrity checks, and the final error when a run fails:

```json
{
  "input": "/books/input.epub",
  "output": "/books/output.epub",
  "preset": "balanced",
  "strict": true,
  "success": true,
  "durationMs": 1234,
  "content": {
    "before": {
      "manifestItems": 42,
      "spineItems": 18,
      "contentDocuments": 20,
      "images": 12,
      "navigationEntries": 36,
      "missingReferences": 0
    },
    "after": {
      "manifestItems": 42,
      "spineItems": 18,
      "contentDocuments": 20,
      "images": 12,
      "navigationEntries": 36,
      "missingReferences": 0
    },
    "integrity": {
      "valid": true,
      "newMissingReferences": [],
      "issues": []
    }
  },
  "steps": [
    {
      "name": "Extract EPUB",
      "status": "success",
      "durationMs": 42,
      "messages": []
    }
  ]
}
```

The report path must differ from the input and output EPUB paths and must be absent or a regular file. A report write failure fails the command.
