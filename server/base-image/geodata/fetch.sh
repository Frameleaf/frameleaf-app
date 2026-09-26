#!/usr/bin/env bash
# Fetches the reverse-geocoding inputs listed in geodata.lock into a directory. Each file comes from
# Frameleaf's own host when it is reachable and matches its SHA-256, otherwise from its pinned capture
# URL under the same check. A file that no source provides with the right checksum fails the build.
set -euo pipefail

lock="${1:?usage: fetch.sh <geodata.lock> <destination>}"
destination="${2:?usage: fetch.sh <geodata.lock> <destination>}"
: "${GEODATA_SNAPSHOT:?GEODATA_SNAPSHOT must name the snapshot directory}"
primary="https://static.frameleaf.cloud/geodata/${GEODATA_SNAPSHOT}"

mkdir -p "$destination"
while read -r sum name capture; do
  [[ -z "$sum" || "$sum" == \#* ]] && continue
  [[ "$sum" =~ ^[a-f0-9]{64}$ && -n "$name" && -n "$capture" ]] || {
    echo "geodata: malformed lock entry for '$name'" >&2
    exit 1
  }
  fetched=false
  for url in "$primary/$name" "$capture"; do
    if wget -nv --tries=3 --timeout=60 -O "$destination/$name.part" "$url" &&
      echo "$sum  $destination/$name.part" | sha256sum --strict --quiet -c -; then
      mv "$destination/$name.part" "$destination/$name"
      echo "geodata: $name from $url"
      fetched=true
      break
    fi
    echo "geodata: $name is unavailable or has the wrong checksum at $url" >&2
    rm -f "$destination/$name.part"
  done
  [[ "$fetched" == true ]] || {
    echo "geodata: no source provided $name with sha256 $sum" >&2
    exit 1
  }
done < "$lock"
