#!/bin/sh
set -e

# The CLI creates a unique temporary directory in /epub-files by default.
# An explicit --temp path must not already exist.
if [ "${1:-}" = "--ui" ]; then
  shift
  exec node /app/dist/src/ui.js "$@"
fi
exec node /app/dist/src/pipeline.js "$@"
