# Development

Repository layout, build, tests and the internals you can customize. Contribution rules
for automated agents are in [AGENTS.md](../AGENTS.md); releases are in
[RELEASING.md](RELEASING.md).

## Project Structure

```
epub-optimizer/
├── .github/workflows/
│   ├── ci.yml                 # Audit, shared quality/Docker checks, and Required CI gate
│   ├── docker-check.yml       # Shared native AMD64/ARM64 Docker E2E and image scans
│   ├── epubcheck-watch.yml    # Weekly check for new EPUBCheck releases (opens an issue)
│   ├── npm-publish.yml        # Stage a verified release on npm for maintainer approval
│   ├── prepare-release.yml    # Prepare and merge a checked release PR to main
│   ├── quality.yml            # Shared Node 22/24, coverage, lint, types, and EPUBCheck checks
│   ├── release-published.yml  # Promote tested image digests and sync main into develop by PR
│   ├── release.yml            # Validate candidates, tag the source, and create a release draft
│   └── security-audit.yml     # Required production audit, also available weekly/manually
├── compose.yaml            # Recommended cross-platform Docker interface
├── Dockerfile              # Multi-stage production container image
├── docker-entrypoint.sh    # Docker defaults and CLI entrypoint
├── docs/                   # Guides: CLI, reports, watch, Docker, interface, NAS, development, releases
├── dist/                   # Compiled JavaScript (production code)
├── package.json            # Package configuration
├── README.md               # Overview, quick start and links to the guides
├── tsconfig.json           # TypeScript configuration
├── vitest.config.ts        # Test configuration
├── epubcheck/              # EPUBCheck for EPUB validation (not included in repo)
├── scripts/                # Build and maintenance scripts
│   ├── benchmark-batch.ts     # Generated-book concurrency and Node RSS comparison
│   ├── setup-watch.sh         # Non-overwriting NAS/host directory and env setup
│   ├── clean-path.ts          # Guarded cleanup helper used instead of rm -rf
│   ├── docker-e2e.ts          # Docker fixture test runner
│   ├── e2e-epubcheck.ts       # Local fixture test runner with EPUBCheck
│   ├── install-epubcheck.sh   # Single source of the EPUBCheck version (CI + Docker)
│   ├── minify-dist.ts         # Optional legacy minification, outside the default build
│   ├── package-e2e.ts         # Installed tarball, CLI/API and TypeScript checks
│   ├── prepare-release.ts     # Prepare and validate a release PR (pnpm release:prepare)
│   └── validate-release.ts    # Release version/tag/ref guards (pnpm release:check)
└── src/                    # Source code directory
    ├── index.ts            # Validated Node.js API entry point
    ├── watch.ts            # Stable-file polling, snapshots and durable completion records
    ├── batch.ts            # Sequential batch planning, reports and execution
    ├── optimization.ts     # Shared API/CLI validation and publication pipeline
    ├── pipeline.ts         # CLI entry point for the shared optimization pipeline
    ├── cli.ts              # yargs-based argument parser
    ├── types.ts            # TypeScript type definitions
    ├── types.d.ts          # Additional TypeScript declarations
    ├── processors/         # Content-processing modules
    │   ├── epub-processor.ts       # Extraction and content processing without publication
    │   ├── archive-processor.ts    # EPUB extraction/compression (zip-slip safe)
    │   ├── zip-writer.ts           # EPUB ZIP writer with verified source passthrough
    │   ├── html-processor.ts       # HTML/CSS processing
    │   ├── js-processor.ts         # JavaScript minification
    │   ├── svg-optimizer.ts        # SVG optimization
    │   ├── lazy-img.ts             # Add loading="lazy" to <img>
    │   ├── font-processor.ts       # Optional font subsetting
    │   ├── image-converter.ts      # PNG → JPEG conversion (parallel)
    │   └── image-processor.ts      # Resize + re-encode (single-pass, parallel)
    ├── scripts/            # Post-processing steps (exported run(opts) fns)
    │   ├── create-epub.ts  # Package the final EPUB archive
    │   ├── validate-epub.ts # Run EPUBCheck via java
    │   ├── utils.ts        # Shared helpers (RunOpts, isEntryPoint, …)
    │   ├── fix/            # General XHTML fix scripts (modular)
    │   │   ├── fix-span-tags.ts
    │   │   ├── fix-xml.ts
    │   │   ├── remove-empty-styles.ts
    │   │   ├── xhtml-files.ts # Shared recursive and manifest-based repair discovery
    │   │   └── index.ts    # runFixes(): call every fix in sequence
    │   └── ops/            # EPUB structure modifications
    │       ├── add-cover-image-property.ts
    │       ├── update-cover-linear.ts
    │       ├── update-toc-with-cover.ts
    │       ├── update-summary-page.ts
    │       ├── add-chapter-sections-to-toc.ts
    │       └── update-structure.ts # runStructureUpdates(): call every op
    └── utils/              # Utility modules
        ├── config.ts       # Application configuration
        ├── epub-utils.ts   # OPF / TOC file discovery
        ├── output-transaction.ts # Candidate output commit/rollback
        ├── author-workflow-config.ts # Optional validated author workflow mapping
        ├── epub-doctor.ts    # Non-destructive EPUB inspection and optimization-risk summary
        ├── epub-integrity.ts # Before/after content metrics and regression checks
        ├── epub-text.ts      # Before/after text preservation check
        ├── path-safety.ts  # Safe path resolution inside the extracted EPUB
        ├── pipeline-options.ts # Preset resolution
        ├── run-report.ts   # Structured results and profiling
        └── i18n.ts         # Localized label lookup
```

Note: Test files are colocated with their respective source files but omitted from this structure for clarity.

## Development Information

This project is built with TypeScript and uses modern ESM modules. Here's how the development workflow works:

### Source and Build Separation

- TypeScript source files are in the `src/` and `scripts/` directories
- The compiled JavaScript output goes to the `dist/` directory
- The production build contains:
  - Test files (`*.test.ts`) are completely excluded
  - TypeScript declaration files (`*.d.ts`) for the API and its referenced types
  - No source maps are included
  - Readable JavaScript with comments and function names, so stack locations point to inspectable code
- You must run `pnpm build` before running any `optimize` commands

### Import Structure

- The project uses TypeScript's `NodeNext` module resolution, which mirrors Node.js ESM semantics exactly
- Relative imports must include the explicit `.js` extension in source files (e.g., `import { foo } from './foo.js'`), matching what Node.js resolves at runtime
- Type-only imports use `import type` (enforced by `verbatimModuleSyntax`) so they are fully erased at build time

### Testing

See the [validation corpus and manual reading-system checklist](VALIDATION.md) for what automated checks cover and what still requires visual review.

- Test files are colocated with the source files they test (e.g., `src/index.ts` and `src/index.test.ts`)
- This "side-by-side" approach has several advantages:
  - Easy to locate tests for any module
  - Promotes keeping tests updated when changing implementation
  - Makes it clear which parts of the codebase are covered by tests
  - Simplifies relative imports between tests and implementation
- Tests are written using Vitest, a modern test framework compatible with Jest syntax
- Run tests with `pnpm test` (watch mode) or `pnpm test:run` (single run)
- Run tests with coverage using `pnpm test:coverage`
- `pnpm test:e2e` runs the public `optimize`, `optimize:clean`, `optimize:lossless`, `optimize:repair`, and `optimize:author` commands, including a configured author workflow
- Every pnpm E2E output is checked for content integrity and validated with EPUBCheck; clean/keep-temp behavior and workflow-specific transformations are also verified
- The author E2E fixture also checks before/after content integrity, sequential NCX navigation, and a maximum output-size ratio to catch compression regressions
- `pnpm test:docker` validates raw Docker balanced/author/fonts plus Docker Compose balanced, lossless, repair, author, and configured-author workflows
- Docker E2E verifies reports, content integrity, EPUBCheck output, workflow-specific transformations, and clean/keep-temp behavior
- CI validates the project on Node.js 22 and 24, and runs the Docker E2E workflow on Node.js 24
- Unit tests run in a Node.js environment and mock external dependencies where appropriate

### Production Validation

Use Node 24 LTS for development and release checks (`.node-version`); the minimum
supported runtime is Node 22.12. The interface tests use jsdom, which needs Node
22.22.2 or 24.15 and newer to run the test suite; this does not apply to the
published package. Install with `pnpm install --frozen-lockfile`.
CI validates Node 22 and 24, coverage, formatting, EPUBCheck and Docker workflows.
The production dependency audit is required by every CI and release run, including
release retries; it also runs weekly and can be started manually.
Publishing a prerelease promotes its tested image to the version tag without changing `latest`.

### Release Validation

Run **Prepare release** from `main` in GitHub Actions with the next version after develop's CI passes. It prepares a PR, waits for **Required CI**, merges through branch rules and dispatches the shared validation and native AMD64/ARM64 image tests. **Release** creates a draft with the tested image digests; publishing that draft promotes the same images to their version tag and, for stable releases, `latest`, then synchronizes develop. Release retries preserve existing notes and reuse recorded images.

The local `pnpm release:prepare X.Y.Z` command uses the same PR flow with authenticated Git/GitHub CLI access; follow it by dispatching **Release** from main with the printed `expected-sha`. Configure the dedicated repository-scoped release App before using the automated workflows. See [Releases and CI](RELEASING.md) for setup, diagnostics, scan policy, prereleases and recovery.

Before creating a release manually, run the CI quality gates plus coverage, audit, and local Docker checks:

```bash
pnpm release:check --version "$(node -p 'require("./package.json").version')"
pnpm lint
pnpm format:check
pnpm build
pnpm test:run
pnpm test:coverage
pnpm audit --prod
pnpm test:e2e
docker compose config --quiet
docker compose build
pnpm test:docker
```

Also validate a representative real EPUB through both execution paths:

```bash
pnpm optimize:author -i YourBook.epub -o YourBook-pnpm.epub \
  --strict --report-json reports/YourBook-pnpm-report.json

docker compose run --rm optimizer \
  -i YourBook.epub -o YourBook-docker.epub \
  --preset author --strict --report-json reports/YourBook-docker-report.json
```

A successful release candidate exits with code 0, passes EPUBCheck without errors or warnings in strict mode, and produces reports with `"success": true` and `"content.integrity.valid": true`.

### Development and Production

- For development: Make changes to TypeScript files and run `pnpm build:dev`
- For production: Run `pnpm build` to create readable JavaScript and API declarations in `dist/`
- The `optimize` commands run against the compiled code in `dist/`

## Linting and Formatting

- **Linting:**
  - `pnpm run lint` lints all TypeScript files in the `src` and `scripts` directories.
  - `pnpm run lint:fix` does the same, but also auto-fixes issues where possible.
- **Formatting:**
  - `pnpm run format` auto-formats all `.ts`, `.json`, and `.md` files in the project using Prettier.
  - `pnpm run format:check` checks formatting without making changes (useful for CI).

## Minification

JavaScript embedded inside EPUBs is still minified with Terser. The optimizer's own Node.js code is compiled without application minification so stack traces retain useful file/line/column locations. Source maps are not needed to read those JavaScript locations and are not shipped by the production build.

The legacy `pnpm minify:safe` command remains available as an explicit development-tool opt-in; it reduces readability and is not called by `pnpm build`. `pnpm pack` runs a clean build through `prepack`, regenerating readable JavaScript and declarations before creating the tarball.

## Modular Fix Scripts

Every processing step is a plain async function. `pipeline.ts` runs them all in-process (no sub-process spawns), forwarding a shared `{ tempDir, lang, output }` down the chain.

- **Explicit repair passes** (span tags, XML/XHTML sanity, empty styles) live in `src/scripts/fix/`. They run only with `--repair` or the author workflow because they intentionally modify document structure.
- **Author workflow structure modifications** (cover linear, TOC, summary page, chapter sections) live in `src/scripts/ops/`. `src/scripts/ops/update-structure.ts` exports `runStructureUpdates(opts)`, and the pipeline runs it only when `--author-workflow` is enabled.
- To enable/disable a step, comment or uncomment the corresponding `await …(opts)` call in the matching orchestrator file.
- To add a new step, create a script that exports `async run(opts: RunOpts)` and add an `await run(opts)` line in the orchestrator.
- Each leaf script also auto-runs when executed directly (`node dist/src/scripts/fix/fix-xml.js`); the `isEntryPoint()` guard keeps that from firing on import.

### Customizing the Optimization Process

Use the default generic optimizer for EPUBs that do not need the project author's Pages/manual-summary workflow:

```bash
pnpm optimize -i book.epub -o book-opt.epub
```

If you do want the complete Pages/manual-summary workflow, enable the author preset:

```bash
pnpm optimize:author -i YourBook.epub -o YourBook-optimized.epub
# equivalent:
pnpm optimize -i YourBook.epub -o YourBook-optimized.epub --preset author
```

The existing project-author conventions remain the defaults. To adapt summary/cover paths or CSS classes without editing source code, use `--author-config author-workflow.json` as documented under [Optional Author Workflow Configuration](CLI.md#optional-author-workflow-configuration).

For deeper source-level customization, there are two levels of granularity:

**Wholesale (in `src/pipeline.ts`)** — comment out an entire step to disable a whole group at once:

- Omit `--repair` and the author preset to skip **all** modifying XHTML repair passes.
- Omit `--author-workflow` / `--preset author` to skip **all** author workflow structure updates.
- EPUBCheck validation is required for transactional publication. When a run fails, inspect the preserved temporary directory instead of disabling validation.

**Granular (in the orchestrator files)** — keep some steps, skip others:

- **Example: Skip adding cover to TOC** — comment out `await updateTocWithCover(opts)` in `src/scripts/ops/update-structure.ts`
- **Example: Skip adding cover to summary page** — comment out `await updateSummaryPage(opts)` in the same file
- **Example: Skip setting cover as first page** — comment out `await updateCoverLinear(opts)` in the same file
- **Example: Skip chapter sections synchronization** — comment out `await addChapterSectionsToToc(opts)` in the same file (useful if you don't have subsections in your manual summary page)
- **Example: Disable specific XML/HTML fixes** — comment out the relevant `await …(opts)` call in `src/scripts/fix/index.ts`

After making any customizations, rebuild the project with `pnpm build` to apply your changes.

## Dependencies

This project uses the following dependencies:

### System Requirements

- Node.js 22.12 or higher (Node.js 24 for development)
- Java Runtime Environment (JRE) 17 or higher (for EPUBCheck validation)
- pnpm 10.30.3

### Key npm Packages

- **cheerio** - For robust HTML/XHTML DOM manipulation
- **entities** - For resolving HTML named character references in XHTML
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
