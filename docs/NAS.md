# Docker / NAS drop folder

Run the published image on a Docker host with Compose v2 (Linux AMD64 or ARM64).
The container includes Node.js, Java and EPUBCheck. It needs no inbound port or
network access while processing. The host needs network access to download the image.
Vendor UI instructions and storage permissions vary; these commands are for the
NAS/server shell. Synology/QNAP UI installation has not been verified on a physical NAS.

## Prepare storage

From a checkout of this repository, choose an absolute data directory that your
NAS account can read and write. Replace the example path with your own:

```bash
sh scripts/setup-watch.sh /absolute/path/to/epub-library .env.watch
```

This creates `inbox`, `optimized` and a private `.env.watch` file. It preserves
existing env files and refuses symbolic-link storage roots. It does not start Docker.
If `.env.watch` already exists, review it instead of rerunning setup over it.

Edit `.env.watch`. Check `WATCH_UID` and `WATCH_GID` against the NAS account that
owns the data folders (`id -u` and `id -g`). Set this exact published image, replacing
any older `EPUB_OPTIMIZER_DOCKER_IMAGE` line rather than adding a duplicate:

```dotenv
EPUB_OPTIMIZER_DOCKER_IMAGE=ghcr.io/kiki-le-singe/epub-optimizer:3.16.1@sha256:a5188ae0d649e822fac5b72750fe29eecb8b6f2087917b4de25b7775b85247b7
```

The setup helper and Compose defaults deliberately retain older pinned images.
The explicit setting above selects 3.16.1 and its tested multi-platform digest.
Do not change ownership broadly or run the watcher as root to work around NAS ACLs;
grant the chosen account read access to `inbox` and write access to `optimized`.

## Start and test

```bash
docker compose --env-file .env.watch -f compose.watch.yaml config --quiet
docker compose --env-file .env.watch -f compose.watch.yaml pull
docker compose --env-file .env.watch -f compose.watch.yaml up -d
docker compose --env-file .env.watch -f compose.watch.yaml logs -f watch
```

Copy one EPUB into the configured `inbox` through the NAS file manager or a mounted
share. For large transfers, copy with a `.part` extension and rename it to `.epub`
after the transfer completes. The source stays in the read-only inbox.

In `optimized`, each book revision gets a directory containing `optimized.epub`,
`report.json`, `report.html` and completion/status records. Open `optimized/index.html`
from the mounted share for an offline overview and links to the results. Refresh it
after processing. Open the EPUB in your reader to inspect images, text and navigation;
automatic checks do not establish visual fidelity.

Ctrl+C stops following logs; it does not stop the service. Once the test succeeds,
leave the service running and drop in more books. Use image concurrency 1 on a
memory-constrained host when configuring custom CLI options; measure the workload
before processing large books in parallel. Docker's default command processes books
sequentially with strict validation and cleanup.

## Stop, restart and update

```bash
docker compose --env-file .env.watch -f compose.watch.yaml down
```

Books and reports remain on the host. The running service restarts with Docker
unless explicitly stopped. Shutdown allows five minutes for the current book.

Before updating, stop the service, review the next release and replace the image
setting with its tested version/digest. Repeat `pull` and `up -d`, then test one book.
An unchanged completed revision is skipped; processing settings can create a new
revision. Keep storage backups and review retained results before deleting anything.

If startup reports an output lock, confirm that no other watcher/container is using
that output directory before investigating it. Never delete a lock while another
watcher is running. On Linux, 3.16.1 supports recovery of its own interrupted records;
filesystem and kernel support still matter. See the README for lock troubleshooting.
