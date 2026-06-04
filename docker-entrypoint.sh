#!/bin/sh
set -e

# Docker entrypoint wrapper for epub-optimizer.
# The image works from /epub-files, so input/output arguments can use simple
# relative paths while application code and dependencies remain under /app.

# Check if temp directory argument is provided
HAS_TEMP_ARG=false
for arg in "$@"; do
  case $arg in
    -t|--temp)
      HAS_TEMP_ARG=true
      break
      ;;
    -t=*|--temp=*)
      HAS_TEMP_ARG=true
      break
      ;;
  esac
done

# If no temp directory specified, default to /epub-files/temp_epub
# This ensures temp files are visible on the host system for debugging
if [ "$HAS_TEMP_ARG" = false ]; then
  set -- "$@" --temp /epub-files/temp_epub
fi

# Execute the pipeline from /app directory (where the application code lives)
exec node /app/dist/src/pipeline.js "$@"
