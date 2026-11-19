# Command-line reference

Every option of `epub-optimizer`, with the JSON configuration file, image settings and
the typed Node.js API. For a first run, see the [README](../README.md#quick-start).

## Modern Workflow

```bash
# Build for development (faster, not minified)
pnpm build:dev

# Build for production (with minification)
pnpm build
# or
pnpm build:prod

# Then run the optimizer
pnpm optimize -i YourBook.epub -o YourBook-optimized.epub

# Or use the project author's Pages/manual-summary workflow
pnpm optimize:author -i YourBook.epub -o YourBook-optimized.epub

# Avoid lossy image changes
pnpm optimize:lossless -i YourBook.epub -o YourBook-optimized.epub

# Apply the explicit XHTML repair passes
pnpm optimize:repair -i YourBook.epub -o YourBook-optimized.epub

# Reject warnings, print timings, and write a machine-readable report
pnpm optimize -i YourBook.epub -o YourBook-optimized.epub \
  --strict --profile --report-json reports/optimization-report.json

# Inspect an EPUB without writing an optimized output
pnpm optimize --doctor -i YourBook.epub \
  --report-json reports/doctor-report.json

# Run tests
pnpm test
# or run tests once and exit
pnpm test:run
# run the EPUBCheck end-to-end fixture after pnpm build
pnpm test:e2e

# after docker compose build, run the raw Docker and Compose fixtures
pnpm test:docker
```

## Command Line Options

```
Usage: epub-optimizer [options]

Options:
  -i, --input       Input EPUB file path                    [string] [default: "mybook.epub"]
  -o, --output      Output EPUB file path                   [string] [default: "mybook_opt.epub"]
  --config          Explicit JSON settings; CLI flags override file values
  --jobs            Concurrent batch books (1-4; default: 1)
  --storage         Inspect a watcher output directory without deleting anything
  --storage-plan    Save a new JSON purge preview (requires --storage)
  --apply-storage-plan  Reverify and apply a saved purge preview
  --keep-revisions  Successful revisions retained per original (minimum 1; default 2)
  --batch           Directory of EPUB files to optimize (non-recursive)
  --watch           Continuously optimize EPUB files dropped in this directory
  --watch-settle-ms  Quiet interval before processing a watched file [default: 3000, minimum: 1000]
  --output-dir      Destination directory required with --batch or --watch
  -t, --temp        Temporary directory for processing      [string] [default: unique temp_epub-<id>]
  --jpg-quality     JPEG compression quality (0-100)        [number] [default: 70]
  --png-quality     PNG compression quality (0-1 scale)     [number] [default: 0.6]
  --min-image-ssim  Minimum SSIM (0-1) for lossy image re-encodes; 0 disables [number] [default: 0.85]
  --lang            UI language for labels (e.g. fr, en)    [string] [default: "fr"]
  --fonts           Enable experimental font subsetting      [boolean] [default: false]
  --preset          Optimization preset: balanced, lossless, author
  --repair          Apply potentially modifying XHTML repairs
  --author-workflow Enable the complete author workflow, including repairs
  --author-config   JSON overrides for the author workflow's summary, cover, and CSS class mapping
  --convert-png     Convert large opaque PNG files to JPEG when safe
  --convert-webp    Convert PNG and JPEG images to WebP when smaller (EPUB 3 only) [boolean] [default: false]
  --png-background  Opt in to flattening eligible transparent PNGs onto #RRGGBB before JPEG conversion
  --no-convert-png  Disable PNG-to-JPEG conversion
  --lazy-loading    Add loading="lazy" to XHTML images
  --no-lazy-loading Disable lazy loading
  --max-image-dim   Maximum image width/height; 0 disables resizing
  --strict          Fail when a step emits warnings or errors
  --validation-timeout
                    Maximum EPUBCheck runtime in milliseconds [number] [default: 120000]
  --image-concurrency
                    Concurrent image operations, from 1 to 64 [number] [default: CPU parallelism, capped at 8]
  --profile         Print execution time for each pipeline step
  --report-json     Write a structured pipeline or batch summary report to JSON
  --report-html     Write a standalone HTML optimization or batch summary report
  --doctor, --inspect
                    Inspect an EPUB without optimizing or writing an output EPUB
  --clean           Clean temporary files after processing  [boolean] [default: false]
  -h, --help        Show help message                       [boolean]
  -v, --version     Show version number                     [boolean]

Examples:
  pnpm optimize -i book.epub -o book-optimized.epub            Basic optimization
  pnpm optimize:clean -i book.epub -o book-opt.epub            Optimize and clean temp files
  pnpm optimize -i book.epub -o book-opt.epub --jpg-quality 85 Higher JPEG quality (less compression)
  pnpm optimize -i book.epub -o book-opt.epub --png-quality 0.9 Higher PNG quality (less compression)
  pnpm optimize -i book.epub -o book-opt.epub --fonts          Enable font subsetting
  pnpm optimize:lossless -i book.epub -o book-opt.epub         Avoid lossy image changes
  pnpm optimize:repair -i book.epub -o book-opt.epub           Apply XHTML repair passes
  pnpm optimize:author -i book.epub -o book-opt.epub           Use the author's Pages/manual-summary workflow
  pnpm optimize -i input.epub -o output.epub --jpg-quality 85 --png-quality 0.8 Custom image settings
  pnpm optimize --doctor -i input.epub                         Inspect without modifying the EPUB
```

> **Script Differences:**
>
> - `pnpm optimize` - Optimizes the EPUB file and keeps temporary files for inspection
> - `pnpm optimize:lossless` - Skips lossy image conversion, recompression, and resizing
> - `pnpm optimize:repair` - Same as optimize, plus explicit XHTML repair passes
> - `pnpm optimize:author` - Complete author workflow: generic optimization, repairs, lazy loading, cover navigation, summary page, and chapter sections
> - `pnpm optimize:clean` - Same as optimize but removes temporary files afterward
> - `pnpm cleanup <directory>` - Removes a marked temporary directory from a previous run

## JSON configuration

Use an explicit JSON file with long, kebab-case option names. There is no automatic
search for configuration files and no executable JavaScript, includes or environment
interpolation. Built-in defaults apply first, file settings second, explicit CLI
flags last (including `--no-fonts` and other negative booleans).

```json
{
  "preset": "balanced",
  "strict": true,
  "clean": true,
  "image-concurrency": 2,
  "watch": "inbox",
  "output-dir": "optimized"
}
```

```bash
pnpm optimize --config optimizer.json
# Override one setting without editing the file:
pnpm optimize --config optimizer.json --image-concurrency 1
```

Paths from the file are relative to that file's directory; CLI paths are relative
to the current working directory. Unknown keys and mistyped values fail before
processing. The file must be regular JSON, at most 64 KiB. Optimization options,
paths, batch/watch settings and `jobs` are supported; help/version, storage/purge
commands, nested config and short/camelCase aliases are deliberately excluded.
Storage maintenance cannot be combined with `--config`. The settings file cannot
alias an output/report target and must stay outside batch/watch output directories.

## Optional background for transparent PNGs

By default, PNGs with an alpha channel are kept as PNG. To allow eligible transparent PNGs to be converted to JPEG, explicitly choose an opaque background:

```bash
pnpm optimize -i book.epub -o book-white.epub --png-background '#ffffff'
```

`--png-background` accepts only a six-digit hex color (`#RRGGBB`), including the `#`; quote it in the shell. There is no default background. This option also applies to each book in batch mode and is available to Node API callers as `args.pngBackground`.

Flattening permanently replaces transparency, including around captions, with the chosen color. White backgrounds can create visible white rectangles in dark reading modes. JPEG encoding is lossy; inspect text inside images, diagrams and edges in the target readers. EPUBCheck and content/text checks do not certify visual quality.

The existing conversion safeguards still apply: PNGs smaller than 200 KiB and animated PNGs are skipped; the JPEG must be smaller than the original PNG, have a manifest entry and have supported, safely rewritable references. Conversion and resizing share one encoding pass; an unsuccessful conversion retains the PNG. This is not a command to recolor every PNG. Opaque PNGs retain their existing conversion behavior. `--png-background` is rejected with `--preset lossless`, `--no-convert-png`, or doctor mode, rather than silently ignored. Existing commands and presets are unchanged when the option is omitted.

## Safe temporary directories and validation deadlines

Each CLI run uses a unique `temp_epub-<id>` directory by default. An explicit
`--temp <path>` must not already exist: even an empty or previously used directory
is refused, so concurrent runs cannot overwrite one another. Existing directories
are never cleared during extraction. The console and JSON report (`tempDir`) show
the actual extraction path. `--clean` removes only the current run's marked
directory after successful publication. For a retained run, use
`pnpm cleanup <directory>`; unmarked directories and symbolic links are refused.
The hidden ownership marker is excluded from the output EPUB.

EPUBCheck has a 120-second deadline. Use `--validation-timeout 300000` for larger
books that need up to five minutes. A timeout fails the run, discards the candidate,
and preserves any previous output and the extracted files.

HTML/XHTML text whitespace and SVG identifiers are preserved because external
stylesheets and references can depend on them. Named character references such as
`&nbsp;` or `&eacute;` (valid in EPUB 2) are rewritten as the equivalent numeric
references, and CDATA text outside scripts and styles is rewritten as escaped text:
the displayed characters are unchanged. XHTML minification keeps existing UTF-8
text in UTF-8.
XHTML documents are identified by their OPF media type as well as their extension
and XML markers. Before accepting minification, the optimizer compares element
nesting and order, identifiers, namespaces, and the position of character data. If these
change, it keeps the original document byte for byte and logs the skipped
optimization. Intentional inline CSS and JavaScript minification is excluded from
this comparison; final EPUBCheck validation still applies.
CDATA-wrapped or entity-escaped inline scripts and styles are kept as written.
CSS `@import` rules are kept instead of being inlined. External stylesheets,
`<style>` blocks and `style` attributes retain their CSS when the minifier reports
an error or warning, or offers no smaller result. XHTML styles also retain their
original CSS if minification would introduce XML delimiters. Raster recompressions
are committed only when smaller, unless they actually change the dimensions
requested by the user.

## Font subsetting

`--fonts` enables HarfBuzz/WASM subsetting of eligible TTF, OTF, WOFF and WOFF2
fonts, preserving their container format, hinting, layout features, embedding
permissions and copyright/license text. It is disabled by default for every
preset. Original bytes are retained when there is no size benefit or processing
fails. The feature does not remove fonts or change the book's text or CSS.

The character pool includes nested XHTML, navigation, SVG, attributes and literal
stylesheets across the archive, including Unicode NFC/NFD and case equivalents.
For safety, the entire font step is skipped when it encounters scripts, MathML,
embedded documents, imported/remote stylesheets, CSS variables, generated content,
unsupported list markers or text transformations. This deliberately sacrifices
some possible savings when displayed characters cannot be determined reliably.
All fonts are preserved when encryption metadata exists. Variable, color, MathML/
Graphite and embedding/subsetting-restricted fonts are also preserved.

Fonts within each book are processed sequentially, with at most 16 fonts per book, 8 MiB per input font,
16 MiB per expanded font, 16 MiB of text resources, 4,096 resources and 65,536
collected code points. Each font runs in a disposable child process with a
10-second timeout and a 128 MiB V8 heap cap. Parent-side RSS sampling every 100 ms
terminates a worker observed above 256 MiB; this is a sampled budget, **not an OS
hard memory limit**, and short allocation spikes can exceed it. Monitoring is
supported on Linux (`/proc`) and macOS (`/bin/ps`); if it is unavailable, fonts
remain unchanged. Other platforms conservatively skip this optional feature.
These budgets apply per book/worker; concurrent API calls can run separate workers.

Failures and uncertain content produce report warnings; `--strict` can reject
these warnings while preserving an existing final EPUB. Known unsupported fonts
and absent size benefits are informational skips. EPUBCheck validates the final
candidate but does not certify font rendering on every reading system. A candidate
cleanup or ownership failure aborts optimization even without `--strict`, rather
than packaging a stray temporary font.

## Image Concurrency

Use `--image-concurrency 2` on memory-constrained machines, or adjust from 1 to 64.
The default is the available CPU parallelism capped at 8. The setting applies to
both PNG-to-JPEG conversion and image recompression. Lower values trade runtime for
lower peak memory; compare with `--profile` on representative books before tuning.

A local Node 24 measurement on the 60 MB example, for the image stage alone, gave:

| Concurrent images | Time    | Peak Node RSS |
| ----------------- | ------- | ------------- |
| 1                 | 13.31 s | 210 MiB       |
| 2                 | 6.99 s  | 307 MiB       |
| 4                 | 4.53 s  | 417 MiB       |
| 8                 | 4.39 s  | 429 MiB       |

These are single measurements on one Mac, not cross-platform guarantees. All four
runs produced identical raster bytes (SHA-256 comparison). Java memory is excluded.

## Image Quality Guard

Size options such as `--jpg-quality` and `--png-quality` apply to every image, but
some images tolerate them worse than others. After each lossy encode (recompression
or PNG-to-JPEG conversion), the optimizer measures its structural similarity (SSIM)
with the source:

- The source is first resized to the encode's dimensions, so an intended
  `--max-image-dim` downscale is not counted as loss. Flattening onto an explicit
  `--png-background` is also part of the reference.
- The score is the lowest per-channel SSIM (1 = identical). Transparent images are
  compared on white and on black. Animated images compare their first frame.
- An encode below `--min-image-ssim` (default `0.85`) is redone at a higher-fidelity
  setting: lossless PNG, or quality 92 for JPEG and WebP (80 for AVIF). If that is
  still below the threshold or no smaller, the original image is kept
  byte-for-byte, and a PNG is not converted to JPEG.
- `--min-image-ssim 0` disables measurement and restores the previous behavior.

On the 60 MB example book, all 13 lossy encodes of the default `balanced` preset
scored between 0.895 and 0.959. The guard therefore changed no image, and the
output content was identical to a run with the guard disabled. Measuring added
about 1 s to the 6.6 s run (single local run, macOS ARM64, Node 25). Lower
thresholds tolerate more loss; raise the threshold to protect detailed artwork at
the cost of larger images.

SSIM is a structural measure, not a guarantee of how an image looks in every
reader. Open the optimized book to check important artwork. Guard decisions are
informational, not warnings, so `--strict` does not fail on them.

## WebP Conversion

`--convert-webp`, available from version 3.19.0, converts PNG and JPEG images to
WebP when the result is smaller. It is **off by default** because of reader
compatibility:

- WebP is a core image type only since EPUB 3.3. EPUBCheck accepts it in EPUB 3
  books; EPUB 2 packages are left unchanged.
- Older reading systems, including some e-ink devices and conversion services,
  do not display WebP. Test the result on the readers you target before
  distributing it, and keep the original book.

What it does:

- Lossy WebP at `--jpg-quality`, with transparency preserved, so transparent
  PNGs no longer need palette quantization or `--png-background`.
- The [image quality guard](#image-quality-guard) applies. Below the threshold,
  a PNG falls back to lossless WebP and a JPEG to quality 92; if that is not
  smaller or still below the threshold, the original image is kept.
- `--max-image-dim` and JPEG EXIF orientation are applied in the same encode.
- References in XHTML, CSS, SVG and `srcset`, and the OPF manifest item
  (`media-type="image/webp"`), are rewritten as one transaction per image. An
  image without a rewritable reference keeps its original file.
- Kept in their original format: the cover image (`cover-image` property or
  `<meta name="cover">`), animated PNGs, images under 10 KB, and images whose
  `.webp` name is already taken. They continue through the normal PNG-to-JPEG
  and recompression steps.
- It cannot be combined with the lossless preset, which preserves image bytes.

On the 60 MB example book (12 PNGs with transparency and 1 JPEG, `balanced`,
single local run on macOS ARM64 with Node 25), the output was 1.96 MB with
`--convert-webp` against 8.69 MB without, with SSIM scores of 0.91 to 0.97 and an
EPUBCheck-clean result. Savings depend on the images; this is one book, not a
general figure.

A `type="image/png"` hint on a `<source>` element or in a CSS `image-set()` is not
rewritten; the image still loads, but remove such hints if your book uses them.

## Optional Author Workflow Configuration

`pnpm optimize:author` continues to use the original Pages/manual-summary conventions by default: `chapter-2.xhtml`, `cover.xhtml`, cover spine id `cover`, chapter classes `p6`/`p8`, section class `p7`, and navigation classes `s3`/`s4`.

For a different authoring workflow, create a JSON file containing only the values that differ:

```json
{
  "summaryHref": "contents.xhtml",
  "coverSpineId": "front-cover",
  "chapterClasses": ["chapter-link"],
  "sectionClasses": ["section-link"],
  "summaryEntryClass": "chapter-link",
  "coverNavClass": "toc-cover",
  "sectionNavClass": "toc-section"
}
```

Then pass it to the same author command:

```bash
pnpm optimize:author -i book.epub -o book-optimized.epub \
  --author-config author-workflow.json
```

The configuration is validated before structure updates. Unknown keys, unsafe paths, and invalid class/id values fail the run while preserving the temporary directory for debugging.

## Debugging with Temporary Files

**Traditional usage:**

```bash
# Keep temp files for inspection (default behavior)
pnpm optimize -i book.epub -o book-opt.epub
# Inspect the temp_epub-<id>/ directory reported by the command

# Custom temp location
pnpm optimize -i book.epub -o book-opt.epub -t my-debug-folder

# Clean up when done
pnpm cleanup my-debug-folder
```

**Docker usage:**

```bash
# Temp files automatically appear in your current directory
docker compose run --rm optimizer \
  -i book.epub -o book-optimized.epub
# Inspect the reported temp_epub-<id>/ directory on your host

# Custom temp location (still visible on host)
docker compose run --rm optimizer \
  -i book.epub -o book-optimized.epub \
  -t my-debug-folder

# Clean temp files after processing
docker compose run --rm optimizer \
  -i book.epub -o book-optimized.epub \
  --clean
```

**What's in the temp directory?**

- Extracted EPUB structure
- Processed HTML/CSS/JavaScript files
- Optimized images
- Modified fonts only when `--fonts` is enabled
- All intermediate processing artifacts

This is invaluable for debugging optimization issues or understanding what the tool does to your EPUB.

Failures before successful cleanup preserve temporary files even when `--clean` was requested. This keeps the failed processing state available for debugging. A later report-writing failure can occur after cleanup and publication have already succeeded.

## Local package and typed Node API

The published package includes the typed Node API. Maintainer publication setup
and staged approval are described in [docs/NPM.md](NPM.md). The local tarball
workflow below is useful for testing unpublished changes.

Build and inspect a local package without publishing it to a registry:

```bash
# From this repository; prepack rebuilds JavaScript and declarations first.
pnpm pack --out /tmp/epub-optimizer.tgz

# From a separate Node.js project:
pnpm add /tmp/epub-optimizer.tgz
bash node_modules/epub-optimizer/scripts/install-epubcheck.sh ./epubcheck
EPUBCHECK_PATH="$PWD/epubcheck/epubcheck.jar" pnpm exec epub-optimizer \
  -i book.epub -o book-optimized.epub --strict
```

The tarball contains compiled JavaScript, TypeScript declarations, README, license and the pinned EPUBCheck installer. It excludes TypeScript implementation sources, tests, development tools, local reports and books. Java and the EPUBCheck JAR are not bundled or downloaded during package installation; configure the JAR explicitly with `EPUBCHECK_PATH` as above. Docker remains the distribution that includes Java and EPUBCheck. Creating a tarball does not publish an npm release.

ESM consumers import the API and its types from the package root:

```typescript
import { optimizeEPUB, type Args, type OptimizeOptions } from "epub-optimizer";

export async function optimizeBook(args: Args, hooks: OptimizeOptions = {}) {
  return optimizeEPUB(args, hooks);
}
```

`Args` still describes fully resolved processing options; this does not introduce a partial-options API or change defaults. Exported types also include `Preset`, `ContentProcessingOptions`, `BatchReport`, `BatchItem`, `PipelineReport`, `StepReport`, `StepStatus` and `EpubCheckReport`. Existing root and deep ESM imports remain available. The same Java/EPUBCheck validation and output protection apply to installed API calls.

`pnpm test:package` packs the project and installs the tarball with production dependencies into a new temporary consumer outside the repository, without dependency lifecycle scripts. It audits that consumer's production dependencies and verifies strict TypeScript usage (including rejected invalid types), CLI/API execution from another working directory, readable JavaScript stack locations, external EPUBCheck configuration and preservation of an existing output when the validator is missing. It requires Java, the pinned validator and registry access for consumer dependencies; it only uses generated EPUB fixtures. CI runs it on Node 22 and 24.

## Migrating to v3

Version 3 makes the default command safer and less specific to this project's original author workflow:

- `pnpm optimize` now uses the generic `balanced` preset. It does not apply XHTML repairs, lazy loading, or author structure changes unless explicitly requested.
- `pnpm optimize:author`, `--preset author`, and `--author-workflow` run the complete Pages/manual-summary workflow, including repairs, lazy loading, cover navigation, summary synchronization, and chapter sections.
- For behavior close to the old generic v2 pipeline without the author structure changes, use `pnpm optimize ... --repair --lazy-loading`.
- Input, output, and JSON report paths must be different. The output is created as a candidate and replaces the requested output only after EPUBCheck succeeds.
- Use `--strict` to reject warnings, `--profile` to inspect step durations, and `--report-json` for a machine-readable result.
