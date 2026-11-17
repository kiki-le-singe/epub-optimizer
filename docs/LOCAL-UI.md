# Local graphical interface

The interface runs on your own machine. It uses the existing TypeScript optimizer
and EPUBCheck, with React (TypeScript/TSX), Tailwind CSS and shadcn/ui components
in the browser. Vite bundles all browser dependencies into local assets during
`pnpm build`; no CDN or development server is required at runtime. No external fonts,
analytics or account are required.

## Start with Docker

Use Docker with Compose 2.24.4 or newer. From this source checkout:

```bash
docker compose -f compose.ui.yaml up -d --build
```

Open <http://127.0.0.1:8787>. Choose or drop one EPUB, select Balanced, Lossless
images or Author workflow, then start optimization. Download the optimized book
and optional HTML/JSON reports before starting another job.

Stop with:

```bash
docker compose -f compose.ui.yaml down
```

The service only publishes its port on localhost and mounts no host book directory.
It uses a standard Docker bridge network; outbound traffic is not blocked at the
network level. Uploaded copies and results live in temporary
container storage. Do not expose this single-user service to the Internet or LAN.

The UI is not included in the published 3.16.1 images or npm package. Until a new
release includes it, build from source using the command above.

## Start natively

Install the development dependencies and Java/EPUBCheck as described in the README:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm ui
```

Use `EPUBCHECK_PATH` for a nonstandard EPUBCheck installation. The optional
`--port` flag changes the local port; `pnpm ui --help` shows the server options.
The default address is `127.0.0.1`, port 8787.

## Languages and appearance

Choose Français, English, Italiano, Español or Deutsch using the language selector.
The initial language follows the browser's supported language preference, falling
back to English. Light and dark themes each offer green (Neon-inspired) and blue (Next.js-inspired)
accents. System follows the operating system with green accents. Both choices are saved in this browser's local storage when
available. Changing language does not restart processing or translate the book.

Interface messages are translated. Technical diagnostics produced by the engine
and downloaded reports retain their original language.

## Scope and limits

- One book at a time, up to 256 MiB; one active job per server.
- Balanced, Lossless images and Author workflow presets. Author workflow can
  adjust book structure and is intended for this project's Pages workflow.
- Strict validation is always enabled. An EPUB is downloadable only after
  successful content checks and EPUBCheck with no errors or warnings.
- Progress, cancellation, size reduction and report downloads are available.
- Image concurrency is fixed at one; jobs time out after 15 minutes.
- Docker is limited to two CPUs, 2 GiB memory and 1 GiB temporary storage. Large
  expanded archives may exceed these limits even below the upload limit.
- Working files and results are removed at the next job or service shutdown.
  The original file on your computer is preserved. There is no persistent history.
- Batch processing, watched folders, inspection/repair-only modes and advanced
  CLI options remain command-line features.

This first interface does not cover every CLI use case. Validation cannot guarantee
visual fidelity: open the optimized book in your reader before using it for publication.
Native Windows behavior requires separate platform validation.
