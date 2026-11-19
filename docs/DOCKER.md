# Docker

You must have [Docker installed](https://docs.docker.com/get-docker/) with Docker Compose v2. Docker Desktop includes both.

## Pre-built Image (GHCR)

Every release publishes a multi-arch image (amd64 and arm64, including Apple Silicon) to GitHub Container Registry. It is the fastest way to use the optimizer — no clone, no build, no Node.js or Java to install:

```bash
docker run --rm -v "$PWD:/epub-files" ghcr.io/kiki-le-singe/epub-optimizer \
  -i your-book.epub -o your-book-optimized.epub
```

Pin a specific release with a version tag, e.g. `ghcr.io/kiki-le-singe/epub-optimizer:3.5.0` (images are published starting with v3.5.0). Building locally with Compose (below) remains fully supported and is the right choice when modifying the source.

Docker Compose provides a containerized environment with all dependencies pre-installed. It automatically mounts the repository directory, so the same relative EPUB paths work on Windows, macOS, and Linux. When working from a clone, Compose builds the image locally.

## Docker Requirements

- Docker Desktop, or Docker Engine with Docker Compose v2

## Docker Installation

```bash
# Clone the repository
git clone https://github.com/kiki-le-singe/epub-optimizer.git
cd epub-optimizer

# Build the local image (includes all dependencies)
docker compose build
```

## Docker Quick Start

```bash
# Build when needed, then optimize an EPUB from the repository directory
docker compose run --build --rm optimizer \
  -i your-book.epub -o your-book-optimized.epub
```

**Benefits of Docker approach:**

- ✅ No need to install Node.js, Java, or pnpm
- ✅ Works consistently across all platforms (Windows, Mac, Linux)
- ✅ Includes EPUBCheck automatically
- ✅ Uses the dependency versions tested by the project
- ✅ Automatically mounts the working directory and accepts relative EPUB paths
- ✅ Runs non-root with no network, no Linux capabilities, and a read-only container filesystem

## Docker Usage

Docker Compose is the recommended cross-platform Docker interface. It automatically builds or reuses the local image, mounts the repository at `/epub-files`, and lets the CLI use normal relative paths.

**First run or rebuild after updating the repository:**

```bash
docker compose run --build --rm optimizer \
  -i book.epub -o book-optimized.epub
```

**Later runs:**

```bash
docker compose run --rm optimizer \
  -i book.epub -o book-optimized.epub
```

**Custom image quality:**

```bash
docker compose run --rm optimizer \
  -i book.epub -o book-optimized.epub \
  --jpg-quality 50 --png-quality 0.4
```

**Complete author workflow:**

```bash
docker compose run --rm optimizer \
  -i book.epub -o book-optimized.epub \
  --preset author --clean
```

**Author workflow with an optional configuration file:**

```bash
docker compose run --rm optimizer \
  -i book.epub -o book-optimized.epub \
  --preset author --author-config author-workflow.json
```

**Compose command breakdown:**

- `docker compose run` - Run the `optimizer` service defined in `compose.yaml`
- `--build` - Build or refresh the image before running; needed on the first run and after code updates
- `--rm` - Remove the stopped one-off container after processing
- Arguments after `optimizer` are passed directly to the EPUB optimizer

By default, Compose shares the repository directory with the container. Place EPUB files in that directory and use their normal relative names. Temporary files also appear there unless `--clean` is used.

<details>
<summary>Advanced: raw Docker</summary>

Raw `docker run` remains supported, but its bind-mount syntax varies by shell. The image now works from `/epub-files`, so the EPUB arguments themselves remain relative:

```bash
docker build -t epub-optimizer .
docker run --rm -v "$PWD:/epub-files" epub-optimizer \
  -i book.epub -o book-optimized.epub
```

</details>

## Docker Issues

**"docker: command not found"**

- Install Docker first: [Download Docker](https://docs.docker.com/get-docker/)
- Make sure Docker Desktop is running

**"`docker compose` is not a docker command"**

- Install Docker Compose v2 or update Docker Desktop
- Verify with `docker compose version`

**"Permission denied" or file access errors**

- Ensure your EPUB file is in the project root or mounted directory
- Check file permissions (especially on Linux/Mac)
