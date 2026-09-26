#!/usr/bin/env bash
# Single source of truth for the EPUBCheck version.
# Used by CI (ci.yml), the Release workflow (release.yml), and the Docker image
# (Dockerfile). To upgrade EPUBCheck, change EPUBCHECK_VERSION and
# EPUBCHECK_SHA256 here ONLY (compute the new hash from the official zip).
set -euo pipefail

EPUBCHECK_VERSION="5.4.0"
# GitHub release assets can be replaced without changing the tag, so the
# pinned version alone does not freeze the bytes — the checksum does.
EPUBCHECK_SHA256="33350c61038e71dfb3d45a76aed04bf5481e6d5500cb780f6e98db8bbd15a28c"

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

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$tmp/epubcheck.zip" | awk '{print $1}')"
else
  ACTUAL_SHA256="$(shasum -a 256 "$tmp/epubcheck.zip" | awk '{print $1}')"
fi
if [ "$ACTUAL_SHA256" != "$EPUBCHECK_SHA256" ]; then
  echo "ERROR: epubcheck-${EPUBCHECK_VERSION}.zip sha256 mismatch" >&2
  echo "  expected: $EPUBCHECK_SHA256" >&2
  echo "  actual:   $ACTUAL_SHA256" >&2
  exit 1
fi

unzip -q "$tmp/epubcheck.zip" -d "$tmp"
rm -rf "$TARGET_DIR"
mv "$tmp/epubcheck-${EPUBCHECK_VERSION}" "$TARGET_DIR"

echo "EPUBCheck ${EPUBCHECK_VERSION} installed to ${TARGET_DIR}"
