#!/usr/bin/env bash
# Builds frameleaf-lightroom-<version>.zip (+ .sha256) from the repository version.
# Usage: integrations/lightroom/scripts/package.sh <output-directory>
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$(mkdir -p "${1:?output directory}" && cd "$1" && pwd)"
version="$(sed -nE 's/^  "version": "([0-9]+)\.([0-9]+)\.([0-9]+)".*/\1.\2.\3/p' "$repo/package.json")"
[[ -n "$version" ]] || { echo "no version in package.json" >&2; exit 1; }
IFS=. read -r major minor revision <<<"$version"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$here/frameleaf.lrplugin" "$work/"
rm -f "$work/frameleaf.lrplugin/TranslatedStrings_en.txt"
sed -i.bak -E "s/VERSION = \{[^}]*\}/VERSION = { major = $major, minor = $minor, revision = $revision, display = '$version' }/" \
  "$work/frameleaf.lrplugin/Info.lua"
rm "$work/frameleaf.lrplugin/Info.lua.bak"
grep -q "display = '$version'" "$work/frameleaf.lrplugin/Info.lua"

zip="$out/frameleaf-lightroom-$version.zip"
rm -f "$zip"
# Fixed timestamps and sorted entries keep the archive reproducible.
find "$work/frameleaf.lrplugin" -exec touch -t 202001010000 {} +
(cd "$work" && find frameleaf.lrplugin -type f | LC_ALL=C sort | zip -X -q "$zip" -@)
(cd "$out" && shasum -a 256 "$(basename "$zip")" >"$(basename "$zip").sha256")
echo "$zip"
