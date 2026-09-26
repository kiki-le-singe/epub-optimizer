#!/bin/sh
set -e

# The CLI creates a unique temporary directory in /epub-files by default.
# An explicit --temp path must not already exist.
exec node /app/dist/src/pipeline.js "$@"
