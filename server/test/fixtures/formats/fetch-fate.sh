#!/bin/sh
# fetch-fate.sh <dir>: downloads the FFmpeg FATE samples named in fate.sha256 into <dir> and checks
# every one against its pinned SHA-256. The FATE suite states no licence, so these are fetched when
# the format matrix runs and are never committed to a Frameleaf repository.
set -eu
dest=${1:?usage: fetch-fate.sh <dir>}
list="$(cd "$(dirname "$0")" && pwd)/fate.sha256"
mkdir -p "$dest"
while read -r _ path; do
  mkdir -p "$dest/$(dirname "$path")"
  curl -sSfL --retry 3 --connect-timeout 30 --max-time 300 -o "$dest/$path" "https://fate-suite.ffmpeg.org/$path"
done <"$list"
cd "$dest"
if command -v sha256sum >/dev/null; then sha256sum --strict --check "$list"; else shasum -a 256 --check "$list"; fi
