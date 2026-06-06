#!/usr/bin/env bash
# Single source of truth for the EPUBCheck version.
# Used by CI (ci.yml), the Release workflow (release.yml), and the Docker image
# (Dockerfile). To upgrade EPUBCheck, change EPUBCHECK_VERSION here ONLY.
set -euo pipefail

EPUBCHECK_VERSION="5.3.0"

# Install target directory (default: ./epubcheck for local + CI; the Docker
# build passes an absolute path).
TARGET_DIR="${1:-epubcheck}"
ZIP_URL="https://github.com/w3c/epubcheck/releases/download/v${EPUBCHECK_VERSION}/epubcheck-${EPUBCHECK_VERSION}.zip"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Retry transient download failures (e.g. GitHub CDN 5xx/timeouts).
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors "$ZIP_URL" -o "$tmp/epubcheck.zip"
else
  wget -q --tries=5 --waitretry=3 --retry-connrefused "$ZIP_URL" -O "$tmp/epubcheck.zip"
fi

unzip -q "$tmp/epubcheck.zip" -d "$tmp"
rm -rf "$TARGET_DIR"
mv "$tmp/epubcheck-${EPUBCHECK_VERSION}" "$TARGET_DIR"

echo "EPUBCheck ${EPUBCHECK_VERSION} installed to ${TARGET_DIR}"
