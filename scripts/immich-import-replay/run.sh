#!/usr/bin/env bash
# Regenerates the importer's replayed Immich 2.x fixtures: each tag's own upstream migrations are replayed into
# an empty PostgreSQL database, its content catalog and ledger are recorded, and one schema-only dump is kept per
# distinct content shape. Needs Docker, an `upstream` remote with Immich tags, and installed server dependencies.
# Usage: scripts/immich-import-replay/run.sh            (every stable v2.x tag)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
fixtures=$root/server/src/immich-import/fixtures
image=${REPLAY_POSTGRES_IMAGE:-frameleaf-postgres:development}
port=${REPLAY_POSTGRES_PORT:-55439}
container=immich-import-replay-$$
work=$(mktemp -d)
trap 'docker stop "$container" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

tags=$(git -C "$root" tag -l 'v2.*' --sort=v:refname | grep -v -- '-rc')
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=replay -p "127.0.0.1:$port:5432" "$image" >/dev/null
until docker exec "$container" pg_isready -U postgres -q; do sleep 1; done
sleep 2

database() { echo "r_$(echo "$1" | tr -c 'a-z0-9\n' '_')"; }
ln -sfn "$root/server/node_modules" "$here/node_modules"
for tag in $tags; do
  mkdir -p "$work/mig/$tag"
  for file in $(git -C "$root" ls-tree --name-only "$tag" server/src/schema/migrations/ | grep '\.ts$'); do
    git -C "$root" show "$tag:$file" >"$work/mig/$tag/$(basename "$file")"
  done
  docker exec "$container" psql -U postgres -qc "CREATE DATABASE $(database "$tag")" >/dev/null
  (cd "$here" && "$root/server/node_modules/.bin/tsx" replay.ts "$tag" \
    "postgres://postgres:replay@127.0.0.1:$port/$(database "$tag")" "$work/$tag.json" "$work/mig/$tag")
done
# shellcheck disable=SC2086
node "$here/generate.mjs" "$work" "$root" $tags

for version in $(node -p "Object.keys(require('$fixtures/structure/2.x.json').releases).join(' ')"); do
  # pg_dump emits psql meta-command lines (\restrict); '^\\' drops them.
  # shellcheck disable=SC1003
  docker exec "$container" pg_dump -U postgres --schema-only --no-owner --no-privileges \
    --exclude-table=kysely_migrations --exclude-table=kysely_migrations_lock "$(database "v$version")" |
    grep -v '^\\' | grep -v "set_config('search_path'" >"$work/$version.sql"
  gzip -9nc "$work/$version.sql" | base64 >"$fixtures/structure/replayed-$version.sql.gz.base64"
  node -e "
    const fs = require('node:fs'), crypto = require('node:crypto'), cp = require('node:child_process');
    const file = '$fixtures/structure/provenance.json', p = JSON.parse(fs.readFileSync(file, 'utf8'));
    p.replayed ??= {};
    p.replayed['$version'] = {
      tag: 'v$version',
      commit: cp.execFileSync('git', ['-C', '$root', 'rev-parse', 'v$version^{commit}'], { encoding: 'utf8' }).trim(),
      dump: 'replayed-$version.sql.gz.base64',
      sha256: crypto.createHash('sha256').update(fs.readFileSync('$work/$version.sql')).digest('hex'),
    };
    fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n');"
done
rm -f "$here/node_modules"
(cd "$root" && npx prettier --write "$fixtures/frozen-sources.json" "$fixtures/structure/2.x.json" "$fixtures/structure/provenance.json" >/dev/null)
