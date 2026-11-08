#!/usr/bin/env bash
# apt-get update that fails when any configured index cannot be fetched (FL-191).
#
# Plain `apt-get update` only warns ("W: Failed to fetch ...") when a source is unreachable, for example
# an HTTPS source without CA certificates, and later installs then silently use stale or missing
# indexes. Error-Mode=any makes apt itself fail; the log check below covers any apt that ignores it.
set -euo pipefail

log=$(mktemp)
trap 'rm -f "$log"' EXIT

# PDiffs=false: an incremental index (Packages.diff) caught mid-publish logs "Err:" even though apt then
# fetches the full index, which failed builds on a mirror hiccup. Full indexes keep the check meaningful.
apt-get update -o APT::Update::Error-Mode=any -o Acquire::PDiffs=false "$@" 2>&1 | tee "$log"
if grep -qE '^Err:|Failed to fetch|Some index files failed to download' "$log"; then
  echo "apt-update-strict: at least one package index could not be fetched" >&2
  exit 1
fi
