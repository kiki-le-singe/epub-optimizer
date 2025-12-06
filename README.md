# EPUB Optimizer

A Node.js utility to optimize EPUB files by compressing HTML, CSS, images and recompressing the archive. This tool can significantly reduce EPUB file sizes while maintaining compatibility with e-readers and ensuring EPUB specification compliance.

## Why Use EPUB Optimizer?

- ✅ **Dramatically reduces file size** - Typically 70-90% smaller files
- ✅ **Maintains full compatibility** - Works with all major e-readers (Kindle, Apple Books, etc.)
- ✅ **Preserves quality** - Smart optimization without visual degradation
- ✅ **Supports all EPUB types** - Both modern (OPS) and legacy (OEBPS) formats
- ✅ **Zero setup with Docker** - No need to install Node.js, Java, or other dependencies
- ✅ **Battle-tested** - Used for real book publishing workflows

![EPUB Optimizer Terminal Output](assets/epub-optimizer-demo.png)

## Table of Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [About This Project](#about-this-project)
- [Requirements](#requirements)
- [Installation](#installation)
- [EPUBCheck Setup](#epubcheck-setup)
- [Docker Alternative](#docker-alternative)
- [Usage](#usage)
  - [Available Scripts](#available-scripts)
  - [Modern Workflow](#modern-workflow)
  - [Command Line Options](#command-line-options)
  - [Docker Usage](#docker-usage)
  - [Debugging with Temporary Files](#debugging-with-temporary-files)
- [Project Structure](#project-structure)
- [Development Information](#development-information)
  - [Source and Build Separation](#source-and-build-separation)
  - [Import Structure](#import-structure)
  - [Testing](#testing)
  - [Development and Production](#development-and-production)
- [Linting and Formatting](#linting-and-formatting)
- [Minification](#minification)
- [Modular Fix Scripts](#modular-fix-scripts)
  - [Customizing the Optimization Process](#customizing-the-optimization-process)
- [Common Issues](#common-issues)
- [Troubleshooting](#troubleshooting)
- [Dependencies](#dependencies)
- [License](#license)

## About This Project

I use this project to optimize EPUB files that I create using Pages on Mac. My workflow is:

- Write (text and images) in Pages.
- Insert a TOC page via the menu: "Insert > Table of Contents > Document". (In the script, I update the EPUB structure files with customizations, adding the cover title as a clickable item in both the book's internal summary page and the navigation table of contents.)
- Export my work as an EPUB file.
- Fill in the required information.
- For "Cover": check the option "Use the first page as the book cover image".
- For "Layout": check the reflowable option, and check both "Use table of contents" and "Embed fonts".

After exporting, my original EPUB file is about 24.4MB. I use this script to optimize it (resulting in about 7.3MB). Then I test the result in Apple Books, Kindle Previewer, etc.

This script is designed for this workflow (I don't use any other tools), but anyone who wants to optimize their EPUB file is welcome to try it! If you have customization needs different from mine, check the [Modular Fix Scripts](#modular-fix-scripts) section to learn how to enable/disable specific features. If you have any questions or issues, let me know. Enjoy! :)

## Quick Start

> **Note:**
> For both Docker and traditional usage, place your EPUB file(s) in the project root directory (the same directory as your `package.json` and Dockerfile), or specify the correct path to your file.

**Traditional installation:**

```bash
pnpm install
pnpm build
pnpm optimize -i YourBook.epub -o YourBook-optimized.epub
```

**Or use Docker (no setup required):**

```bash
git clone https://github.com/kiki-le-singe/epub-optimizer.git
cd epub-optimizer
docker build -t epub-optimizer .
docker run --rm -v $(pwd):/epub-files epub-optimizer \
  -i YourBook.epub -o YourBook-optimized.epub
```

## Features

- **Supports both "OPS" (modern) and "OEBPS" (legacy) EPUB content directories (auto-detected)**
- HTML/XHTML minification (removes whitespace, comments, and unnecessary code)
- CSS optimization (minifies and combines rules)
- Image compression (JPEG, PNG, WebP, GIF, AVIF, SVG optimization without significant quality loss)
- PNG to JPEG conversion for non-transparent images (significantly reduces file size)
- JavaScript minification (reduces script size)
- **Font subsetting** (reduces font file sizes by including only used characters; may not work on encrypted or unsupported fonts)
- **SVG optimization** (minifies SVG files using SVGO)
- **Image downscaling** (optionally resizes large images to a max dimension for e-reader compatibility)
- **Lazy loading for images** (adds `loading="lazy"` to all `<img>` tags in XHTML for EPUB3 readers)
- **Cross-platform archive processing** (pure JavaScript implementation with no external dependencies)
- Archive recompression (EPUB-compliant ZIP packaging with proper compression settings)
- EPUB validation against the EPUB specification
- XML/XHTML validation fixing (automatically repairs common validation issues)
- Modular fix scripts for EPUB and OPF structure
- Command-line interface with customizable options
- File size comparison reporting
- Comprehensive test suite with high coverage

> **Note:**
>
> - Font subsetting is attempted on all fonts, but some fonts (e.g., encrypted or certain OTF/TTF formats) may not be supported by the subsetting library and will be skipped.
> - SVG optimization, image downscaling, and lazy loading are fully automated and require no manual intervention.

## Requirements

**Only required for traditional installation** (skip if using Docker):

- Node.js 14 or higher (my version: v23.11.0)
- Java Runtime Environment (JRE) 1.7 or higher (my version: openjdk 23.0.2)
- pnpm (my version: 9.5.0)
- npm or pnpm for package management

Note: All the examples below use pnpm, but you can substitute with npm if preferred.

## Installation

```bash
# Clone the repository
git clone https://github.com/kiki-le-singe/epub-optimizer.git
cd epub-optimizer

# Install dependencies
pnpm install

# Build the project (required before running optimize commands)
pnpm build
```

### EPUBCheck Setup

This tool requires EPUBCheck to validate EPUB files. Follow these steps:

1. Download EPUBCheck from the [official website](https://www.w3.org/publishing/epubcheck/)
2. Extract the downloaded zip file
3. Copy the extracted `epubcheck-x.x.x` folder (where x.x.x is the version) to the root of this project
4. Make sure the folder is named `epubcheck` to match the path in `epubcheckPath` in src/utils/config.ts

## Docker Alternative

**Docker Requirement:**
You must have [Docker installed](https://docs.docker.com/get-docker/) on your system to use the Docker method.

Docker provides a containerized environment with all dependencies pre-installed, making it easier to run the EPUB optimizer without complex setup.

### Docker Requirements

- Docker installed on your system

### Docker Installation

```bash
# Clone the repository
git clone https://github.com/kiki-le-singe/epub-optimizer.git
cd epub-optimizer

# Build the Docker image (includes all dependencies)
docker build -t epub-optimizer .
```

### Docker Quick Start

```bash
# Optimize an EPUB file
docker run --rm -v $(pwd):/epub-files epub-optimizer \
  -i your-book.epub -o your-book-optimized.epub
```

**Benefits of Docker approach:**

- ✅ No need to install Node.js, Java, or pnpm
- ✅ Works consistently across all platforms (Windows, Mac, Linux)
- ✅ Includes EPUBCheck automatically
- ✅ Guaranteed to work with tested dependency versions

## Usage

### Available Scripts

| Script           | Description                                                                       |
| ---------------- | --------------------------------------------------------------------------------- |
| `build`          | Build TypeScript for production (with minification)                               |
| `build:dev`      | Build TypeScript for development (no minification)                                |
| `build:prod`     | Build TypeScript with minification for production                                 |
| `minify:safe`    | Safely minify JavaScript in dist/ directory using TypeScript source (via ts-node) |
| `optimize`       | Run optimizer, keeping temp files                                                 |
| `optimize:clean` | Run optimizer, removing temp files afterward                                      |
| `cleanup`        | Remove temporary files                                                            |
| `test`           | Run tests in watch mode                                                           |
| `test:run`       | Run tests once and exit                                                           |
| `test:coverage`  | Run tests with coverage report                                                    |
| `lint`           | Lint TypeScript files in src and scripts directories                              |
| `lint:fix`       | Lint and auto-fix TypeScript files in src and scripts                             |
| `format`         | Auto-format all .ts, .json, and .md files with Prettier                           |
| `format:check`   | Check formatting of all .ts, .json, and .md files with Prettier                   |

### Modern Workflow

```bash
# Build for development (faster, not minified)
pnpm build:dev

# Build for production (with minification)
pnpm build
# or
pnpm build:prod

# Then run the optimizer
pnpm optimize -i YourBook.epub -o YourBook-optimized.epub

# Run tests
pnpm test
# or run tests once and exit
pnpm test:run
```

### Command Line Options

```
Usage: pnpm optimize [options]

Options:
  -i, --input       Input EPUB file path                    [string] [default: "mybook.epub"]
  -o, --output      Output EPUB file path                   [string] [default: "mybook_opt.epub"]
  -t, --temp        Temporary directory for processing      [string] [default: "temp_epub"]
  --jpg-quality     JPEG compression quality (0-100)        [number] [default: 70]
  --png-quality     PNG compression quality (0-1 scale)     [number] [default: 0.6]
  --clean           Clean temporary files after processing  [boolean] [default: false]
  -h, --help        Show help message                       [boolean]
  -v, --version     Show version number                     [boolean]

Examples:
  pnpm optimize -i book.epub -o book-optimized.epub            Basic optimization
  pnpm optimize:clean -i book.epub -o book-opt.epub            Optimize and clean temp files
  pnpm optimize -i book.epub -o book-opt.epub --jpg-quality 85 Higher JPEG quality (less compression)
  pnpm optimize -i book.epub -o book-opt.epub --png-quality 0.9 Higher PNG quality (less compression)
  pnpm optimize -i input.epub -o output.epub --jpg-quality 85 --png-quality 0.8 Custom image settings
```

> **Script Differences:**
>
> - `pnpm optimize` - Optimizes the EPUB file and keeps temporary files for inspection
> - `pnpm optimize:clean` - Same as optimize but removes temporary files afterward
> - `pnpm cleanup` - Manually removes the temporary directory (temp_epub)

> **Important Note:** This tool is designed to work with files in the project directory. Using absolute paths or paths outside the project directory may cause issues.

### Docker Usage

If you're using the Docker alternative, here are additional usage examples:

**Basic Docker optimization:**

```bash
docker run --rm -v $(pwd):/epub-files epub-optimizer \
  -i book.epub -o book-optimized.epub
```

**Docker with custom image quality:**

```bash
docker run --rm -v $(pwd):/epub-files epub-optimizer \
  -i book.epub -o book-optimized.epub \
  --jpg-quality 50 --png-quality 0.4
```

**Docker command breakdown:**

- `docker run --rm` - Run container and remove it when done
- `-v $(pwd):/epub-files` - Mount current directory to `/epub-files` in container
- `epub-optimizer` - The Docker image name
- Arguments after the image name are passed to the EPUB optimizer

> **Docker Note:** Temporary files are automatically created in the mounted directory (visible on your host) for easy debugging. By default, they're kept in `temp_epub/` unless you use `--clean`. Use `-t` to specify a custom temp directory location.

### Debugging with Temporary Files

**Traditional usage:**

```bash
# Keep temp files for inspection (default behavior)
pnpm optimize -i book.epub -o book-opt.epub
# Inspect temp_epub/ directory

# Custom temp location
pnpm optimize -i book.epub -o book-opt.epub -t my-debug-folder

# Clean up when done
pnpm cleanup
```

**Docker usage:**

```bash
# Temp files automatically appear in your current directory
docker run --rm -v $(pwd):/epub-files epub-optimizer \
  -i book.epub -o book-optimized.epub
# Inspect temp_epub/ directory on your host

# Custom temp location (still visible on host)
docker run --rm -v $(pwd):/epub-files epub-optimizer \
  -i book.epub -o book-optimized.epub \
  -t my-debug-folder

# Clean temp files after processing
docker run --rm -v $(pwd):/epub-files epub-optimizer \
  -i book.epub -o book-optimized.epub \
  --clean
```

**What's in the temp directory?**

- Extracted EPUB structure
- Processed HTML/CSS/JavaScript files
- Optimized images
- Modified fonts
- All intermediate processing artifacts

This is invaluable for debugging optimization issues or understanding what the tool does to your EPUB.

## Project Structure

```
epub-optimizer/
├── dist/                   # Compiled JavaScript (production code)
├── optimize-epub.ts        # Main entry point (TypeScript)
├── package.json            # Package configuration
├── README.md               # Documentation
├── tsconfig.json           # TypeScript configuration
├── vitest.config.ts        # Test configuration
├── epubcheck/              # EPUBCheck for EPUB validation (not included in repo)
├── scripts/                # Build and maintenance scripts
│   └── minify-dist.ts      # Smart minification script for JavaScript files
└── src/                    # Source code directory
    ├── index.ts            # Main application logic
    ├── cli.ts              # Command-line interface
    ├── pipeline.ts         # Optimization pipeline
    ├── types.ts            # TypeScript type definitions
    ├── types.d.ts          # Additional TypeScript declarations
    ├── processors/         # Processing modules
    │   ├── archive-processor.ts    # EPUB extraction/compression
    │   ├── html-processor.ts       # HTML/CSS processing
    │   └── image-processor.ts      # Image optimization
    ├── scripts/            # Processing scripts
    │   ├── build.ts        # Full optimization pipeline script
    │   ├── create-epub.ts  # EPUB packaging script
    │   ├── validate-epub.ts # EPUB validation script
    │   ├── utils.ts        # Shared utilities for scripts
    │   ├── fix/            # General fix scripts (modular)
    │   │   ├── fix-span-tags.ts
    │   │   ├── fix-xml.ts
    │   │   └── index.ts    # Entry point for all general fixes
    │   └── ops/            # EPUB structure modifications
    │       ├── add-cover-image-property.ts
    │       ├── update-cover-linear.ts
    │       ├── update-toc-with-cover.ts
    │       ├── update-summary-page.ts
    │       └── update-structure.ts # Entry point for all structure updates
    └── utils/              # Utility modules
        └── config.ts       # Application configuration
```

Note: Test files are colocated with their respective source files but omitted from this structure for clarity.

## Development Information

This project is built with TypeScript and uses modern ESM modules. Here's how the development workflow works:

### Source and Build Separation

- TypeScript source files are in the `src/` and `scripts/` directories
- The compiled JavaScript output goes to the `dist/` directory
- The production build is highly optimized:
  - Test files (`*.test.ts`) are completely excluded
  - No TypeScript declaration files (\*.d.ts) are generated
  - No source maps are included
  - JavaScript files are minified using Terser
  - Comments are removed from the final code
- You must run `pnpm build` before running any `optimize` commands

### Import Structure

- Source files use extensionless imports (e.g., `import { foo } from './foo'`)
- The build process adds `.js` extensions to imports in the compiled output for Node.js compatibility

### Testing

- Test files are colocated with the source files they test (e.g., `src/index.ts` and `src/index.test.ts`)
- This "side-by-side" approach has several advantages:
  - Easy to locate tests for any module
  - Promotes keeping tests updated when changing implementation
  - Makes it clear which parts of the codebase are covered by tests
  - Simplifies relative imports between tests and implementation
- Tests are written using Vitest, a modern test framework compatible with Jest syntax
- Run tests with `pnpm test` (watch mode) or `pnpm test:run` (single run)
- Run tests with coverage using `pnpm test:coverage`
- Tests run in Node.js environment and mock external dependencies

### Development and Production

- For development: Make changes to TypeScript files and run `pnpm build:dev`
- For production: Run `pnpm build` to create a minified, optimized `dist/` directory
- The `optimize` commands run against the compiled code in `dist/`

## Linting and Formatting

- **Linting:**
  - `pnpm run lint` lints all TypeScript files in the `src` and `scripts` directories.
  - `pnpm run lint:fix` does the same, but also auto-fixes issues where possible.
- **Formatting:**
  - `pnpm run format` auto-formats all `.ts`, `.json`, and `.md` files in the project using Prettier.
  - `pnpm run format:check` checks formatting without making changes (useful for CI).

## Minification

The production build process includes:

- TypeScript compilation
- ESM import path fixing
- Smart JavaScript minification with Terser:
  - Minifies all files in both `src/` and `scripts/` directories
  - Uses a skip list to avoid minifying problematic files with syntax incompatibilities
  - Maintains class names and function names for better error reporting
  - Compresses and mangles variables for reduced file size
- Source maps for debugging
- Comment removal

> **Note:** The minification script (`minify:safe`) is run using `ts-node` directly on the TypeScript source (`scripts/minify-dist.ts`), not on compiled JavaScript. This ensures the latest TypeScript logic is always used for minification.

## Modular Fix Scripts

- **General fixes** (e.g. span tags, XML/XHTML) are managed in `src/scripts/fix/` and run via `src/scripts/fix/index.ts`.
- **Structure modifications** (TOC, navigation, summary page) are managed in `src/scripts/ops/` and run via `src/scripts/ops/update-structure.ts`.
- To enable/disable a fix, comment or uncomment the relevant `runCommand` line in the corresponding index/entry file.
- To add a new fix, create a new script in the appropriate folder and add a `runCommand` call in the index/entry file.

### Customizing the Optimization Process

If you don't need all the features I've implemented for my own workflow, you can easily customize the process. Here are some examples:

- **Example: Skip adding cover to TOC** - To do this, you'd comment out the line with `update-toc-with-cover.js` in `src/scripts/ops/update-structure.ts`
- **Example: Skip adding cover to summary page** - Comment out the line with `update-summary-page.js` in `src/scripts/ops/update-structure.ts`
- **Example: Skip setting cover as first page** - Comment out the line with `update-cover-linear.js` in `src/scripts/ops/update-structure.ts`
- **Example: Disable specific XML/HTML fixes** - Comment out relevant script calls in `src/scripts/fix/index.ts`

After making any customizations, rebuild the project with `pnpm build` to apply your changes.

## Common Issues

### Docker Issues

**"docker: command not found"**

- Install Docker first: [Download Docker](https://docs.docker.com/get-docker/)
- Make sure Docker Desktop is running

**"Permission denied" or file access errors**

- Ensure your EPUB file is in the project root or mounted directory
- Check file permissions (especially on Linux/Mac)

### Traditional Installation Issues

**"Java not found" or EPUBCheck errors**

- Install Java JRE 1.7+ (see [Requirements](#requirements))
- Download EPUBCheck manually (see [EPUBCheck Setup](#epubcheck-setup))

**"pnpm command not found"**

- Install pnpm: `npm install -g pnpm`
- Or use npm instead: replace `pnpm` with `npm` in commands

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

## Troubleshooting

If you encounter any issues, please check the [GitHub issues page](https://github.com/kiki-le-singe/epub-optimizer/issues) for existing issues or open a new one.

## Dependencies

This project uses the following dependencies:

### System Requirements

- Node.js 14 or higher
- Java Runtime Environment (JRE) 1.7 or higher (for EPUBCheck validation)
- pnpm or npm for package management

### Key npm Packages

- **cheerio** - For robust HTML/XHTML DOM manipulation
- **clean-css** - For CSS minification
- **fs-extra** - Enhanced file system operations
- **html-minifier-terser** - For HTML minification
- **sharp** - For image optimization (JPEG, PNG, WebP, GIF, AVIF, SVG)
- **unzipper** - For extracting EPUB files
- **yazl** - For cross-platform EPUB archive creation (pure JavaScript ZIP implementation)
- **yargs** - For command-line argument parsing

### Development Dependencies

- **typescript** - For static typing and compilation
- **terser** - For JavaScript minification
- **vitest** - For testing
- **typescript-eslint** - For linting TypeScript code
- **prettier** - For code formatting

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.
