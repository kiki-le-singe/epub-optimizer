# EPUB Optimizer

[![CI](https://github.com/kiki-le-singe/epub-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/kiki-le-singe/epub-optimizer/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Node.js utility to optimize EPUB files by compressing HTML, CSS, images and recompressing the archive. This tool can significantly reduce EPUB file sizes while maintaining compatibility with e-readers and ensuring EPUB specification compliance.

## Why Use EPUB Optimizer?

- ✅ **Can dramatically reduce file size** - The original author workflow often produces files 70-90% smaller
- ✅ **Validates before publishing** - EPUBCheck must succeed before the requested output is replaced
- ✅ **Offers explicit quality trade-offs** - Choose balanced, lossless, or the complete author workflow
- ✅ **Uses the EPUB package as source of truth** - Discovers modern and legacy content through `container.xml` and the OPF manifest
- ✅ **Handles tricky EPUBs gracefully** - Refuses DRM-encrypted books, leaves obfuscated/embedded fonts intact, and skips downscaling for fixed-layout titles instead of corrupting them
- ✅ **Zero setup with Docker** - No need to install Node.js, Java, or other dependencies
- ✅ **Battle-tested** - Used for real book publishing workflows
- ✅ **Structured results** - Optional JSON reports, strict mode, and per-step profiling
- ✅ **Explicit controls** - Generic, lossless, repair, and complete author workflows

![EPUB Optimizer Terminal Output](assets/epub-optimizer-demo.png)

### Results

Measured on one image-heavy EPUB exported from Apple Pages: 12 full-page PNGs (11 with
transparency) and 1 JPEG, 57.26 MiB on disk. Every output is EPUBCheck-clean.

| Run                       | Output    | Change     | EPUBCheck             |
| ------------------------- | --------- | ---------- | --------------------- |
| `balanced` (default)      | 8.29 MiB  | **−85.5%** | 0 errors / 0 warnings |
| `balanced --convert-webp` | 1.87 MiB  | **−96.7%** | 0 errors / 0 warnings |
| `author`                  | 8.29 MiB  | **−85.5%** | 0 errors / 0 warnings |
| `balanced --repair`       | 8.29 MiB  | **−85.5%** | 0 errors / 0 warnings |
| `lossless`                | 57.26 MiB | −559 bytes | 0 errors / 0 warnings |

These are single local runs of version 3.19.0 on one machine (macOS arm64, Node.js 24), on
one book: they show what the presets do, not what every book will gain. Nearly all of the
savings come from raster images, so results scale with how image-heavy a book is.

- `balanced` keeps the transparent PNGs as PNG (palette quantization and a 1600 px limit) and
  converts only the opaque cover to JPEG. The [image quality guard](docs/CLI.md#image-quality-guard)
  scored every changed image between 0.895 and 0.959 (1 = identical).
- `--convert-webp` is optional and off by default: older e-readers may not display WebP. See
  [WebP Conversion](docs/CLI.md#webp-conversion).
- `lossless` keeps image bytes unchanged, so the file barely changes: it only saves on text,
  CSS and packaging.

Memory was observed, not bounded by design. In earlier local runs of the `balanced` preset on
this book (v3.8.0, Node.js 25, Java 25, default image concurrency), the Node.js process peaked
at about 548 MiB of resident memory, and EPUBCheck used about 0.3 GiB in a separate Java
process. Memory depends mainly on image dimensions and
[`--image-concurrency`](docs/CLI.md#image-concurrency).

## Table of Contents

- [Quick Start](#quick-start)
- [Local Graphical Interface](#local-graphical-interface)
- [Features](#features)
- [About This Project](#about-this-project)
- [Requirements](#requirements)
- [Installation](#installation)
- [Docker](#docker)
- [Usage](#usage)
- [Guides](#guides)
- [Safety Model](#safety-model)
- [Common Issues](#common-issues)
- [Development](#development)
- [License](#license)

## Quick Start

> **Note:** Traditional usage accepts absolute or relative file paths. Docker Compose automatically shares the repository directory with the container, so Docker commands also use simple relative paths.

**Fastest: run the published image (no clone, no build):**

```bash
docker run --rm --network none --user "$(id -u):$(id -g)" -v "$PWD:/epub-files" \
  boopykiki/epub-optimizer:3.20.1 \
  -i YourBook.epub -o YourBook-optimized.epub --strict --clean
```

This command uses a macOS/Linux shell and runs with your host UID/GID so the output folder stays writable.
The image ships Node.js, Java, and EPUBCheck pre-installed and supports amd64 and arm64 (Apple Silicon).
It is published on [Docker Hub](https://hub.docker.com/r/boopykiki/epub-optimizer)
and GHCR (`ghcr.io/kiki-le-singe/epub-optimizer:3.20.1`). Both registries serve the
same tested release digest. No npm, Java or EPUBCheck installation is needed on
the host when using Docker. For a background drop folder, see [Docker / NAS setup](docs/NAS.md).

**Traditional installation:**

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm optimize -i YourBook.epub -o YourBook-optimized.epub
```

The default `balanced` preset performs generic optimization without running the modifying XHTML repair or author workflow passes.

**Or use Docker Compose (recommended if you cloned the repository):**

```bash
git clone https://github.com/kiki-le-singe/epub-optimizer.git
cd epub-optimizer
# Place YourBook.epub in this directory, then run:
docker compose run --build --rm optimizer \
  -i YourBook.epub -o YourBook-optimized.epub
```

The first run builds the image and optimizes the EPUB. Later runs can omit `--build`.

For the complete Pages/manual-summary author workflow:

```bash
docker compose run --rm optimizer \
  -i YourBook.epub -o YourBook-optimized.epub --preset author
```

## Local Graphical Interface

The local browser interface supports one EPUB at a time, three presets, progress,
cancellation, strict EPUBCheck validation, and EPUB/HTML/JSON downloads. It can also
analyze a book without changing it, with optimization hints and accessibility checks,
and optionally convert images to WebP. It offers
French, English, Italian, Spanish and German, with light, dark and system themes.
Language and theme choices are remembered by your browser; they do not change the
book's language.

This interface is included from version 3.17.0. Published npm packages and Docker
images for **3.16.1 and earlier do not include it**.

With Docker installed, build and start it from this checkout:

```bash
docker compose -f compose.ui.yaml up -d --build
```

Open <http://127.0.0.1:8787>, choose an EPUB, select a preset and download the result.
See [the local interface guide](docs/LOCAL-UI.md) for requirements, limits and shutdown.

## Features

- **Discovers the package/content root through `META-INF/container.xml` and resolves navigation/resources through the OPF manifest**
- HTML/XHTML minification (removes comments and minifies embedded code while preserving text and significant whitespace)
- CSS optimization (minifies and combines rules)
- Image compression (JPEG, PNG, WebP, GIF, AVIF, and SVG according to the selected preset and quality settings)
- **Image quality guard**: every lossy re-encode is compared with its source (SSIM). Encodes below `--min-image-ssim` are redone at higher quality or the original is kept, and scores appear in JSON/HTML reports. See [Image Quality Guard](docs/CLI.md#image-quality-guard).
- JPEG recompression applies EXIF orientation to the pixels before encoding, preserving the displayed rotation and mirroring.
- PNG to JPEG conversion for non-transparent images (significantly reduces file size)
- **Optional WebP conversion** via `--convert-webp` for EPUB 3 books: much smaller images, transparency preserved, for reading systems that support WebP. See [WebP Conversion](docs/CLI.md#webp-conversion).
- JavaScript minification (reduces script size; license comments such as `/*! … */` are kept, and a script is left unchanged when minification would not shrink it)
- **Optional font subsetting** via `--fonts`, using the included HarfBuzz WebAssembly engine with conservative content and font checks
- **SVG optimization** (minifies SVG files using SVGO)
- **Image downscaling** (optionally resizes large images to a max dimension for e-reader compatibility)
- **Lazy loading for images** (adds `loading="lazy"` to all `<img>` tags in XHTML for EPUB3 readers)
- **Cross-platform archive processing** (pure JavaScript implementation with no external ZIP binaries)
- Archive recompression (EPUB-compliant ZIP packaging): each file is deflated at level 9 or
  stored when that is smaller, and an unchanged file keeps the source EPUB's compressed bytes
  when they are smaller, after verifying that they decompress to the same content. Repackaging
  therefore never makes untouched resources larger.
- EPUB validation against the EPUB specification, with optional structured success and failure reports
- Transactional output publication after successful EPUBCheck validation
- **Optional XHTML repair mode** via `--repair`
- **Optional author workflow preset** (syncs subsections from a manual summary page, updates cover navigation, and applies the project author's structure fixes)
- **Balanced, lossless, and author presets**
- Strict failure mode, per-step profiling, and JSON run reports
- Non-destructive doctor/inspect mode for OPF, navigation, internal reference, image weight, and optimization-risk summaries
- **Accessibility checks in doctor mode**: missing image text alternatives, document languages, EPUB Accessibility metadata and page navigation. See [Accessibility Checks](docs/REPORTS.md#accessibility-checks).
- Archive extraction limits, zip-slip and symlink rejection, and safe OPF/manifest/navigation path resolution
- **Graceful handling of special EPUBs**: detects `META-INF/encryption.xml` and refuses DRM-encrypted books instead of silently corrupting them, while still optimizing books whose only encrypted resources are fonts (the fonts are left byte-for-byte intact)
- **Fixed-layout aware**: automatically disables image downscaling for pre-paginated (`rendition:layout`) EPUBs so page images stay aligned with the declared viewport
- **Animation-safe image processing**: keeps animated PNG (APNG) files byte-for-byte unchanged, including when resizing is requested; preserves animated GIF/WebP/AVIF frames and timing during processing. Recompression that would grow an image is discarded unless its dimensions actually shrink. Image concurrency bounds parallel processing on image-heavy books.
- Modular fix scripts for EPUB and OPF structure
- Command-line interface with customizable options
- File size comparison reporting
- Automated unit, EPUBCheck E2E, and Docker E2E test suites

> **Note:**
>
> - **Font subsetting limitation:** fonts listed in encryption metadata remain byte-for-byte intact. `--fonts` is opt-in and uses the included HarfBuzz engine; no separate font package installation is needed. Dynamic CSS/JavaScript text and unsupported font features are conservatively skipped. See [Font subsetting](docs/CLI.md#font-subsetting) for limits.
> - Lazy loading is enabled by the author preset or explicitly with `--lazy-loading`.

## About This Project

I use this project to optimize EPUB files that I create using Pages on Mac. My workflow is:

- Write (text and images) in Pages.
- Create a manual summary page with bookmark links to chapters and sections. The author workflow preset can synchronize these subsections from the manual summary page to the system navigation files - both EPUB3 toc.xhtml and EPUB2 NCX - so they appear in e-reader navigation menus.
- Export my work as an EPUB file.
- Fill in the required information.
- For "Cover": check the option "Use the first page as the book cover image".
- For "Layout": check the reflowable option and "Use table of contents". For "Embed fonts", see the [Important Note for Apple Pages Users](#important-note-for-apple-pages-users) section below to decide based on whether preserving your typography/design is important to you.

After exporting, my original EPUB file is about 24.4MB. I use the author workflow preset to optimize it (resulting in about 7.3MB). Then I test the result in Apple Books, Kindle Previewer, etc.

This project started with this workflow (I don't use any other tools), but anyone who wants to optimize their EPUB file is welcome to try it! The default `pnpm optimize` path is generic. My complete Pages/manual-summary workflow is available through `pnpm optimize:author`, `--preset author`, or `--author-workflow`. If you have any questions or issues, let me know. Enjoy! :)

### Important Note for Apple Pages Users

**Apple Pages applies DRM encryption to embedded fonts** for copyright protection. This means:

- ✅ **Optional font optimization can work** on eligible unencrypted TTF, OTF, WOFF and WOFF2 fonts when `--fonts` is enabled
- ❌ **Font optimization WILL NOT work** on Pages EPUBs if you check "Embed fonts"
- 🔒 **Why?** Apple encrypts fonts to protect font vendors from piracy (this is intentional and legal)

**Your Decision: To Embed Fonts or Not?**

This depends on whether preserving your book's design and typography is important to you.

**Option 1: Keep "Embed fonts" checked** (Preserve design - recommended if typography matters)

- ✅ Your embedded typography and intended design are preserved more consistently
- ✅ Consistent appearance across all e-readers
- ✅ Full control over typography
- ❌ Fonts remain at their original size (typically 1-3 MB total, can't be optimized due to DRM encryption)
- 📊 My image-heavy workflow still achieves about 85-90% total reduction from image/HTML/CSS optimization

**Option 2: Uncheck "Embed fonts"** (Maximum optimization - recommended if design is not critical)

- ✅ **Maximum file size reduction potential** - optimize images/HTML/CSS and optionally subset compatible fonts with `--fonts`
- ✅ **Better performance** - smaller files load faster
- ✅ **More compatible** - readers' preferred fonts are used (better accessibility)
- ✅ **Cleaner output** - no encrypted font files that can't be processed
- ❌ You lose control over typography - readers will see their default fonts
- ❌ Your book's appearance becomes unpredictable across devices
- ❌ Design integrity may be compromised

**Choose based on your priority:**

- **Professional publications where typography matters** → Embed fonts (accept 1-3 MB overhead)
- **Maximum file size and performance** → Don't embed fonts (lose design control)

## Requirements

**Only required for traditional installation** (skip if using Docker):

- Node.js 22.12 or higher (CI validates Node.js 22 and 24; use Node.js 24 for development)
- Java Runtime Environment (JRE) 17 or higher for EPUBCheck (CI and Docker use OpenJDK 17)
- pnpm 10.30.3 for repository development and packing, pinned by `packageManager`; the installed CLI/API runs directly on Node.js

## Installation

### Install from npm

The CLI is published on [npm as `epub-optimizer`](https://www.npmjs.com/package/epub-optimizer).
Use Node.js 22.12+ and Java 17+. Install locally in a dedicated directory:

```bash
mkdir epub-tools
cd epub-tools
npm init -y
npm install epub-optimizer
bash node_modules/epub-optimizer/scripts/install-epubcheck.sh ./epubcheck
EPUBCHECK_PATH="$PWD/epubcheck/epubcheck.jar" npx --no-install epub-optimizer \
  -i /absolute/path/to/book.epub -o book-optimized.epub --strict --clean
```

The output is written to `epub-tools/book-optimized.epub`; the source book stays
unchanged. The installer downloads the pinned, checksum-verified EPUBCheck validator.
Java must already be installed. npm users do not need pnpm or a repository checkout.
For Docker with Java and EPUBCheck included, use the Docker instructions above.
For an always-on drop folder on a NAS or Linux host, see [the NAS guide](docs/NAS.md).

### Build from the repository

```bash
# Clone the repository
git clone https://github.com/kiki-le-singe/epub-optimizer.git
cd epub-optimizer

# Install dependencies
pnpm install --frozen-lockfile

# Build the project (required before running optimize commands)
pnpm build
```

### EPUBCheck Setup

This tool requires EPUBCheck to validate EPUB files. Follow these steps:

1. Download EPUBCheck from the [official website](https://www.w3.org/publishing/epubcheck/)
2. Extract the downloaded zip file
3. Copy the extracted `epubcheck-x.x.x` folder (where x.x.x is the version) to the root of this project
4. Make sure the folder is named `epubcheck` to match the path in `epubcheckPath` in src/utils/config.ts

Or simply run `bash scripts/install-epubcheck.sh` from the project root — it downloads and installs the pinned EPUBCheck version into `epubcheck/` for you.

The default JAR is resolved from the installed package's `epubcheck/` directory,
so the CLI can run from another working directory. Set `EPUBCHECK_PATH` to use a
different installation, for example:

```bash
EPUBCHECK_PATH=/opt/epubcheck/epubcheck.jar epub-optimizer -i book.epub -o book-opt.epub
```

An explicit relative `EPUBCHECK_PATH` is resolved from the current working
directory. EPUBCheck messages use English regardless of the JVM's language.
`--strict` enables EPUBCheck's native rejection of warnings and also rejects a
missing or unreadable validation totals. Totals come from JSON, with the native
text summary retained as a compatibility fallback when detailed JSON diagnostics
are unavailable. A nonzero validator exit or timeout always fails validation.

CI and Docker pin EPUBCheck 5.4.0 and its sha256 checksum centrally in `scripts/install-epubcheck.sh` (single source of truth); the download is verified against the checksum before installation.

## Docker

No Node.js or Java to install: every release publishes a multi-arch image (amd64 and arm64)
to GitHub Container Registry and Docker Hub. The [Quick Start](#quick-start) command above is
all you need for a single book. The [Docker guide](docs/DOCKER.md) covers pinned images,
Compose, file permissions and troubleshooting.

## Usage

### Available Scripts

| Script              | Description                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `build`             | Build TypeScript for production (with minification)                                           |
| `build:dev`         | Build TypeScript for development (no minification)                                            |
| `build:prod`        | Build TypeScript with minification for production                                             |
| `minify:safe`       | Optional legacy minification of compiled JavaScript; not part of the production/package build |
| `optimize`          | Run optimizer, keeping temp files                                                             |
| `optimize:author`   | Run the complete project-author workflow, including repairs and structure updates             |
| `optimize:repair`   | Run generic optimization plus modifying XHTML repair passes                                   |
| `optimize:lossless` | Avoid lossy image conversion, recompression, and resizing                                     |
| `optimize:clean`    | Run optimizer, removing temp files afterward                                                  |
| `cleanup`           | Remove temporary files                                                                        |
| `test`              | Run tests in watch mode                                                                       |
| `test:run`          | Run tests once and exit                                                                       |
| `test:coverage`     | Run tests with coverage report                                                                |
| `test:package`      | Install and verify a local tarball, its CLI/API and TypeScript declarations                   |
| `test:e2e`          | Validate every public pnpm optimization workflow with fixtures and EPUBCheck                  |
| `test:docker`       | Validate raw Docker and the complete Docker Compose workflow matrix with EPUBCheck            |
| `release:check`     | Validate a requested release version against `package.json` and optional tag/ref guards       |
| `release:prepare`   | Prepare a version PR, wait for Required CI, then merge into `main` (`--dry-run` to preview)   |
| `release:examples`  | Point installation examples and pinned watcher images at a published release                  |
| `lint`              | Lint TypeScript files in the src, scripts and ui directories                                  |
| `lint:fix`          | Lint and auto-fix TypeScript files in src, scripts and ui                                     |
| `format`            | Auto-format all .ts, .json, and .md files with Prettier                                       |
| `format:check`      | Check formatting of all .ts, .json, and .md files with Prettier                               |

### Modes and Presets

| Behavior                           | `balanced` | `lossless` | `author` |
| ---------------------------------- | ---------- | ---------- | -------- |
| HTML/CSS/JavaScript minification   | Yes        | Yes        | Yes      |
| SVG optimization                   | Yes        | Yes        | Yes      |
| PNG-to-JPEG conversion             | Yes        | No         | Yes      |
| Raster image resize/re-encode      | Yes        | No         | Yes      |
| WebP conversion (`--convert-webp`) | Opt-in     | Refused    | Opt-in   |
| Default maximum image dimension    | 1600 px    | Disabled   | 1600 px  |
| Lazy loading                       | No         | No         | Yes      |
| XHTML repairs                      | No         | No         | Yes      |
| Author structure workflow          | No         | No         | Yes      |

- `balanced` is the default generic preset. It optimizes content and images without applying XHTML repairs or author structure changes.
- `lossless` means no lossy raster processing. Text, CSS, JavaScript, and SVG files are still optimized, so the output is not byte-for-byte identical to the input.
- `author` runs this project's complete Pages/manual-summary workflow and is equivalent to `pnpm optimize:author`.
- `--repair` explicitly enables the potentially modifying XHTML repair passes.
- XHTML repair preserves valid scripts and text directly inside `<body>`; it does not remove scripting from an EPUB. XHTML normalization also preserves quoted attributes and markup-like strings inside scripts.
- All three repair passes discover nested `.xhtml` files case-insensitively and XHTML documents declared in the OPF manifest, including `.html` and other extensions. Manifest paths are resolved relative to the OPF, so chapters may live outside its folder within the EPUB. Repair skips symbolic links and keeps valid microdata metadata, CDATA, and UTF-8 text.
- `--author-workflow` remains supported and always enables the complete author workflow, including repairs.
- `--author-config` optionally adapts the author workflow to another summary/cover/class mapping. Without it, the original project-author workflow is unchanged.
- Font subsetting is opt-in through `--fonts` and is not enabled by any preset.

Applicable CLI options override preset defaults. For example, `--preset balanced --no-convert-png` disables PNG-to-JPEG conversion. The `lossless` preset always skips lossy raster processing, and the author workflow always includes repairs and author structure updates.

## Guides

| Guide                                               | What it covers                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Command-line reference](docs/CLI.md)               | Every option, JSON configuration, image quality guard, WebP conversion, font subsetting, the typed Node.js API |
| [Doctor mode and reports](docs/REPORTS.md)          | Inspecting a book without changing it, accessibility checks, JSON and HTML reports, profiling                  |
| [Batch, watched folders and storage](docs/WATCH.md) | Whole directories, the background watcher (native or Docker Compose), lock recovery, purging stored results    |
| [Docker](docs/DOCKER.md)                            | Published images, Compose usage, permissions and Docker troubleshooting                                        |
| [Local interface](docs/LOCAL-UI.md)                 | The browser interface: requirements, limits, analysis and shutdown                                             |
| [Docker / NAS setup](docs/NAS.md)                   | Step-by-step watched-folder installation on a NAS                                                              |
| [Development](docs/DEVELOPMENT.md)                  | Project structure, build, tests, validation and customization                                                  |
| [Releases](docs/RELEASING.md)                       | CI, release preparation, publication and recovery                                                              |

## Safety Model

The exported `optimizeEPUB(args)` Node.js entry point uses the same pipeline as the CLI: content/text preservation checks, optional repair and author passes, candidate EPUBCheck validation, and transactional publication. Java and EPUBCheck must be available for API calls too; `validationTimeout`, `strict`, `reportJson`, and `clean` apply as they do in the CLI. Validation failure or timeout preserves an existing output. The supplied options object is copied before feature detection adjusts processing settings.

Advanced `optimizeEPUB(args, { skipPackaging: true })` calls only prepare extracted content. They never create, replace or validate an output EPUB, and leave the extraction directory available even when `clean` is true. Processing hooks apply to the content-processing stage and do not replace final validation.

The final EPUB is transactional: the optimizer creates a hidden candidate next to the requested output, validates that candidate with EPUBCheck, and publishes it only after validation succeeds. If optimization, packaging, validation, or publication fails before the commit, the candidate is discarded, the previous output remains untouched, and any temporary processing directory already created is preserved for debugging.

Before parsing package metadata or optimizing content, every preset checks for internal DTD subsets in XML resources, regardless of their filename. These are refused with a message identifying the file, even without `--strict`: custom entity declarations can otherwise change displayed text while still passing EPUBCheck. This conservative check also refuses empty or comment-only internal subsets. Ordinary `<!DOCTYPE html>` and standard EPUB 2 external doctypes remain supported. The check does not resolve entities or fetch external DTDs. For affected books, expand the internal declarations to literal text or numeric character references with a tool that supports them before optimizing. A refusal preserves the input, any existing output, and the extracted files for inspection.

Before packaging, the optimizer also compares the extracted EPUB before and after processing. Publication is blocked if manifest, spine, document, image, or navigation counts decrease, or if processing introduces a new missing internal reference. Existing input issues remain visible in the report without turning a previously processable EPUB into a false failure.

The text of every content document is also compared before and after the optimizing and repair passes (the `Validate text preservation` step). Scripts, styles, comments and markup are ignored and character references are resolved, so re-encoding is accepted, but publication is blocked if any displayed character is lost or altered. The check runs before the author workflow, whose navigation and summary edits are intentional.

SVG resources are included: text, titles, accessibility descriptions and foreign object content are checked. Editor metadata and formatting whitespace between graphical elements are ignored. HTML/XHTML documents throughout the archive are checked, including secondary renditions.

Cleanup and JSON report writing happen after the validated EPUB is published. If either of these later operations fails, the command exits non-zero but keeps the newly published, EPUBCheck-validated output.

Input, output, and report collisions are rejected, including aliases through symbolic links or hard links and case-only aliases on macOS/Windows. Existing output and report targets must be regular files.

Temporary-directory cleanup is guarded: the optimizer refuses filesystem roots, the current working directory, the home directory, and any temp directory containing the input or output EPUB. Manual cleanup requires the optimizer's ownership marker and rejects symbolic links. The build cleanup script also refuses paths outside the project or system temp directories.

Archive extraction rejects unsafe absolute/traversal paths and symbolic links. It also limits archives to 20,000 entries, 512 MB per file, 2 GB total extracted size, and a maximum compression ratio of 1000:1.

`META-INF/container.xml` and the OPF package document are the source of truth for content discovery. OPF and navigation references are resolved safely and cannot escape the extracted EPUB root.

## Common Issues

### Traditional Installation Issues

**"Java not found" or EPUBCheck errors**

- Install Java JRE 17+ (see [Requirements](#requirements))
- Download EPUBCheck manually (see [EPUBCheck Setup](#epubcheck-setup))

**"pnpm command not found"**

- Install pnpm: `npm install -g pnpm`

**Build errors**

- Run `pnpm build` before using `pnpm optimize`
- Try `pnpm install` if dependencies are missing

### File Issues

**"Input file not found"**

- Check your file path and name (case-sensitive)
- Make sure the EPUB file is in the correct directory
- Use relative paths from the project root

**"Output file permission errors"**

- Check write permissions in the output directory
- Try a different output filename

For Docker problems, see [Docker Issues](docs/DOCKER.md#docker-issues).

If you encounter any issues, please check the [GitHub issues page](https://github.com/kiki-le-singe/epub-optimizer/issues) for existing issues or open a new one.

## Development

Use Node.js 24 and the pinned pnpm version, then run the checks:

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm exec tsc --noEmit && pnpm test:run && pnpm build
```

The [development guide](docs/DEVELOPMENT.md) describes the project structure, the E2E and
Docker test suites and how to customize the pipeline.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.
