#!/bin/sh
# Prepare host directories and an explicit Compose env file; never start a service.
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: sh scripts/setup-watch.sh DATA_DIRECTORY [ENV_FILE]" >&2
  exit 1
fi
store=$1
case "$store" in /*) ;; *) store="$PWD/$store" ;; esac
env_file=${2:-.env.watch}
# Compose single-quoted values are literal. Reject delimiters rather than interpolate them.
carriage_return=$(printf '\r')
case "$store$env_file" in
  *"'"*|*"$carriage_return"*|*'
'*) echo "Paths must not contain quotes or line breaks." >&2; exit 1 ;;
esac
if [ -L "$store" ] || [ -L "$store/inbox" ] || [ -L "$store/optimized" ]; then
  echo "Storage directories must not be symbolic links." >&2
  exit 1
fi
if [ -e "$env_file" ] || [ -L "$env_file" ]; then
  echo "Environment file already exists; preserving it: $env_file" >&2
  exit 1
fi
umask 077
mkdir -p "$store/inbox" "$store/optimized"
store=$(CDPATH= cd -- "$store" && pwd -P)
case "$store" in *"'"*|*"$carriage_return"*|*'
'*) echo "Canonical path contains unsupported characters." >&2; exit 1 ;; esac
# noclobber also protects concurrent setup and symlinks.
(set -C; {
  printf 'WATCH_UID=%s\nWATCH_GID=%s\n' "$(id -u)" "$(id -g)"
  printf "EPUB_WATCH_INBOX='%s/inbox'\nEPUB_WATCH_OUTPUT='%s/optimized'\n" "$store" "$store"
  printf '%s\n' 'EPUB_OPTIMIZER_DOCKER_IMAGE=ghcr.io/kiki-le-singe/epub-optimizer:3.19.0@sha256:8818070446c02c6f3951782e6266969213389369d46461857aba466911c77509'
} > "$env_file")
printf 'Prepared %s and %s. Check UID/GID for your NAS account before starting Compose.\n' "$store" "$env_file"
