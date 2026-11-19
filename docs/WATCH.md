# Batch runs, watched folders and storage

Process a whole directory once, keep a folder watched in the background (natively or with
Docker Compose), and inspect or purge the stored results. For a step-by-step NAS
installation, see [NAS.md](NAS.md).

## Batch optimization

`--jobs 2` enables two books in flight (`1` by default, maximum `4`). Output paths
are checked for the entire batch before work starts, each book has a unique temp
directory and report, and summary rows retain input order even when completion
order differs. A failed book does not stop the others. Each book retains its own
image concurrency and Java memory requirements; start with `--image-concurrency 1`
on a constrained NAS. EPUBCheck runs asynchronously so timers and sibling books remain responsive.
Concurrency is not a guarantee of a proportional speedup. See the reproducible
[batch measurement](BATCH-PERFORMANCE.md).

Optimize the regular `.epub` files directly inside a directory (case-insensitive extension, non-recursive):

```bash
pnpm optimize --batch books --output-dir optimized --preset balanced --clean \
  --report-json reports/batch.json --report-html reports/batch.html
```

Books are processed one at a time in filename order, using the same candidate validation and transactional output publication as single-book runs. Image concurrency still applies within each book. A failure is recorded and the remaining books continue. Exit code 0 means every book succeeded; exit code 1 means one or more books failed, or planning/report writing failed.

Outputs are named `<original-stem>-optimized.epub`. Per-book JSON reports are always written under `<output-dir>/reports`; requesting an HTML summary also creates per-book HTML reports there. Without `--report-json`, the JSON summary defaults to `<output-dir>/batch-report.json`. The summary lists each book's result, whether this invocation published a validated output, and any error. A later cleanup/report failure can mark a run failed even though its validated output was already published.

The entire path plan is checked before processing: input/output/report aliases, hard links, duplicate target names and file/parent collisions are rejected. EPUB input symlinks and symbolic-link directory roots are refused. Use a distinct output directory. Do not combine `--batch` with explicit `--input`, `--output`, `--temp`, or doctor mode. Empty directories fail without creating outputs. Each book receives a unique system temporary directory; `--clean` removes successful extraction directories while failed runs keep their diagnostics.

The exported `runBatch(args)` API returns the structured summary without setting a process exit code. Pass resolved options, including `batch` and `outputDir`; use `optimizeEPUB(args)` for single-book calls.

## Background Docker watcher

For a step-by-step installation using the published 3.20.2 image, see
[Docker / NAS setup](NAS.md). The Compose default and the setup helper
pin the published 3.20.2 release on GHCR, by digest; set
`EPUB_OPTIMIZER_DOCKER_IMAGE` to choose another one.

For a NAS or custom host directory, the setup helper creates directories and a
private env file without starting Docker or changing existing settings:

```bash
sh scripts/setup-watch.sh /absolute/path/to/epub-library .env.watch
docker compose --env-file .env.watch -f compose.watch.yaml config
docker compose --env-file .env.watch -f compose.watch.yaml up -d
```

Review `WATCH_UID`/`WATCH_GID` for the NAS account allowed to access the files.
The helper writes that pinned image to the env file; it does not install Docker, elevate
permissions, change ownership or enable unreleased source features in that image.
It refuses existing env files and symbolic-link storage directories. Linux NAS
vendor interfaces and ACLs vary; validate permissions on the target device.

One-time setup from the repository root (Docker Compose v2 required):

```bash
mkdir -p watch/inbox watch/optimized
printf 'WATCH_UID=%s\nWATCH_GID=%s\n' "$(id -u)" "$(id -g)" > .env.watch
```

Start the published, digest-pinned image in the background:

```bash
docker compose --env-file .env.watch -f compose.watch.yaml up -d
```

Drop EPUBs into `watch/inbox`. Results and per-book reports appear in
`watch/optimized`, in separate revision directories. The inbox is mounted read-only;
both directories and `.env.watch` are ignored by Git and Docker builds. No server
or network connection runs inside the container. The initial image download requires
network access on the host. The existing `compose.yaml` single-book workflow is unchanged.

```bash
# Show progress (Ctrl+C stops following logs, not the watcher)
docker compose --env-file .env.watch -f compose.watch.yaml logs -f watch
# Stop and remove the service; books and results remain on the host
docker compose --env-file .env.watch -f compose.watch.yaml down
```

Docker restarts the service after normal daemon/machine restarts unless explicitly
stopped. Shutdown allows five minutes for the current book; increase
`stop_grace_period` for longer operations. **Forced termination or power loss can
leave a stale output lock:** stop the service, confirm no other watcher is using
that output, remove `watch/optimized/.epub-watch.lock`, then start again. The service
does not automatically break locks. An unchanged failed book is retried after restart.
Logs rotate at 10 MB with three files retained.

Newer Linux/Docker builds use a kernel-backed guard and can recover their own
interrupted watch records automatically after process/container death. Releases
before 3.16.1 predate this capability. An env file created by an older setup helper
can still name one: update its `EPUB_OPTIMIZER_DOCKER_IMAGE` line before relying on
automatic crash recovery.

Use `EPUB_WATCH_INBOX` and `EPUB_WATCH_OUTPUT` for other host directories (create them
first). On a NAS, set `WATCH_UID` and `WATCH_GID` in `.env.watch` to an account allowed
to read the inbox and write the output. Override `EPUB_OPTIMIZER_DOCKER_IMAGE` only
with the version/digest you intend to run; it is never updated implicitly by this file.

## Watched folder

Open `<output-dir>/index.html` in a browser for an offline overview of completed
and failed processing attempts, size reductions, diagnostics and links to each
optimized book and JSON/HTML report. The file updates after each recorded attempt;
refresh the browser to see changes. Results survive restart via `watch-status.json`
in each job directory. No web server, scripts or external assets are needed. Older
jobs are also listed when their bounded JSON reports are readable. Invalid/oversized
records are ignored; original reports remain available.

```bash
mkdir -p inbox optimized
pnpm optimize --watch inbox --output-dir optimized --strict --clean
```

The process keeps running, scans the top level every second (including existing books),
and optimizes one book at a time. Drop an EPUB into `inbox`; each successful job gets
its own directory under `optimized`, containing `optimized.epub`, `report.json`,
`report.html`, and `completed.json`. Original files remain in the inbox untouched.
The directory name includes the book name and hashes of its name, contents, tool
version and settings. Changed books or different optimization settings get new
outputs; previous successful outputs remain available. Author configuration is
snapshotted at startup; restart the watcher after editing that configuration. Books with the same contents
and settings are skipped on restart using the completion record and output checksum.
Do not edit the completion records. Reports refer to the private input snapshot;
`completed.json` records the original inbox path.

Files must remain unchanged in size, timestamps and identity for at least three
seconds before processing. Adjust with `--watch-settle-ms 10000` (minimum 1000).
**A quiet interval cannot prove that a copy has finished.** Prefer copying with a
name such as `book.epub.part`, then renaming it to `book.epub` once the transfer
finishes. The watcher ignores other extensions, nested directories, empty files,
and symbolic links. A private snapshot is used during optimization; changes during
snapshot copying defer processing until the file settles again.

Failed books are logged and do not stop later books. An unchanged failure is tried
once per session; change the file or restart the watcher to retry it. Existing
successful output is protected by the same EPUBCheck-before-publication pipeline.
`--strict`, presets, `--fonts` and image options apply normally. JSON and HTML reports
are automatic; do not pass `--report-json` or `--report-html`. Input and output
directories must be separate, non-nested real directories. Watch mode cannot be
combined with batch, doctor, or explicit input/output/temp paths.

For Docker, mount the parent containing both directories (build the current sources first):

```bash
docker build --target runtime -t epub-optimizer .
docker run -d --name epub-watch --read-only --network none --tmpfs /tmp \
  -v "$PWD:/epub-files" epub-optimizer \
  --watch inbox --output-dir optimized --strict --clean
docker logs -f epub-watch
# In another terminal, allow the current book time to finish:
docker stop --time 300 epub-watch
docker rm epub-watch
```

The mounted output directory must be writable by the container user. Files and
reports stay on the host; Java and EPUBCheck are included in the image.

Ctrl+C or SIGTERM stops accepting new books and lets the current book finish. Exit
status is 1 if any book failed during that session, otherwise 0. Polling works on
mounted folders as well as local disks. Only one watcher may use an output directory;
an exclusive `.epub-watch.lock` enforces this. With legacy exclusive-file locking, if the process was forcibly killed or
the machine crashed, first confirm no watcher is running, then remove that stale lock
before restarting. An output or completion record altered externally is refused;
choose a fresh output directory to rerun it safely.

### Watch lock recovery

On Linux with `/usr/bin/flock` and a mount that retains descriptor locks, the watcher
retains an exclusive lock on a persistent
`.epub-watch.guard` file for its entire lifetime. Process/container death releases
the kernel lock. After reacquiring that same guard, a new watcher can remove its
own modern interrupted `.epub-watch.lock` record and resume. No timestamp timeout
or PID guessing is used. **Do not delete or replace the guard file.**

Legacy/unknown records, changed guard identity, unsafe targets and lock errors are
refused. macOS, Windows and Linux without the utility retain the previous exclusive
file behavior and require manual recovery after a crash. The watcher probes lock
retention at startup; shared mounts that do not retain descriptor locks also use
this conservative fallback. For those cases, stop the
service, confirm no watcher uses the output, then remove the stale record before
restarting. Never remove another active watcher's lock. Automatic recovery is tested
on local Linux-backed Docker mounts; remote/network filesystems and their locking
mount options require separate validation. See [Linux flock semantics](https://man7.org/linux/man-pages/man2/flock.2.html).

## Storage inventory and controlled purge

Stop the watcher before applying a purge. Preview is read-only; keep two successful
revisions per original by default, or explicitly choose at least one:

```bash
pnpm optimize --storage watch/optimized --keep-revisions 2 \
  --storage-plan /tmp/epub-storage-plan.json
# Review that JSON file, then explicitly apply that same preview:
pnpm optimize --apply-storage-plan /tmp/epub-storage-plan.json
```

A saved plan is created exclusively: an existing file is never overwritten.
`verifiedRevisionBytes` counts recognized, checksum-verified successful revisions
only; `candidateBytes` is their proposed removal size. These are apparent file
bytes, not total filesystem usage or guaranteed reclaimed space. Unknown entries,
failed runs, unexpected files, symlinks, hard links and altered outputs are listed
as protected rather than deleted. Revisions are grouped by original absolute path
and ordered by completion-record modification time. Originals are never read or
removed by maintenance.

Apply acquires the same lock as the watcher and recomputes the saved candidates;
changed candidates require a new preview. Only recognized revision files are
unlinked; no recursive deletion follows links. An interruption can leave an
`.epub-prune-*` recovery directory: it is preserved as an unknown entry, so inspect
it manually before any cleanup. A purge is irreversible; keep backups of outputs
you need. Paths in a container must refer to that container's mounted output directory;
create and apply a plan in the same path namespace.

Temporary extraction directories are kept separately. Use `--clean` for future
successful runs; remove an old, inspected, marked extraction directory explicitly
with `pnpm cleanup <directory>`. Storage retention does not sweep system temporary
folders or discard failed-run diagnostics automatically.
