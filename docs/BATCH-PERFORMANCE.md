# Batch concurrency measurement

Run `pnpm build` then `pnpm benchmark:batch` with Node 24, Java 17+ and the pinned
EPUBCheck installation. The script creates three identical generated font EPUBs
in a fresh owned temporary directory, measures `--jobs 1` then `--jobs 2`, and
removes those fixtures. Both runs use `lossless`, strict validation, font subsetting,
image concurrency 1, cleanup and per-step profiling. Private user books are never
read. Results and logs are saved under ignored `.cache/batch-benchmark*` paths.

Observed on 2026-11-15, macOS ARM64, Node 24.22.1, Java 25.0.2, one run per mode:

| Batch jobs | Elapsed | Sampled Node peak RSS | Each output |
| ---------- | ------- | --------------------- | ----------- |
| 1          | 5.84 s  | 154.6 MiB             | 11,980 B    |
| 2          | 4.35 s  | 156.3 MiB             | 11,980 B    |

Each input was 17,325 B; all six optimizations passed strict EPUBCheck and the
pipeline's text/content checks. These fonts are generated shaping fixtures, not
representative image-heavy books. This is a comparison of concurrency settings
on the same build, not a general speedup claim or a pre/post rewrite benchmark.
The second run can benefit from warm caches. RSS is sampled every 20 ms in the
Node orchestration process; Java and font child-process memory are **excluded**,
so these values are not a combined memory budget. Two simultaneous Java processes
can increase total system memory substantially.

The default remains one job. Raise concurrency only after testing representative
books on the actual machine, with enough memory for each book's image operations
and native validation. No additional font format has been enabled in this change:
TTF, OTF, WOFF and WOFF2 are already covered by shaping/outline tests. Variable,
color, mathematical and Graphite fonts, collections and restricted embedding remain
preserved until dedicated fixtures and rendering checks justify broader subsetting.
