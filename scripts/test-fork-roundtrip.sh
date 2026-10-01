#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/e2e/docker-compose.fork-roundtrip.yml"
STATE_DIR="${FORK_ROUNDTRIP_STATE_DIR:-$ROOT/.cache/fork-roundtrip}"
# FL-44: certification evidence outlives reset_lane (which empties STATE_DIR) and names the exact
# candidate and official images the proof ran against.
EVIDENCE_DIR="${FORK_ROUNDTRIP_EVIDENCE_DIR:-$ROOT/.cache/fork-roundtrip-evidence}"
CANDIDATE_IMAGE='immich-fork-roundtrip:local'
# The project name (COMPOSE_PROJECT_NAME) and these ports can be changed so a run never touches
# another stack on this machine.
export FORK_ROUNDTRIP_DB_PORT="${FORK_ROUNDTRIP_DB_PORT:-5437}"
export FORK_ROUNDTRIP_API_PORT="${FORK_ROUNDTRIP_API_PORT:-2287}"
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:$FORK_ROUNDTRIP_DB_PORT/immich"
API_URL="http://127.0.0.1:$FORK_ROUNDTRIP_API_PORT/api"
BACKUP_ID='fork-roundtrip-db-v3.1.0'
SNAPSHOT_ID='fork-roundtrip-media-v3.1.0'

manifest_tag="$(node -e '
  const manifest = require(process.argv[1]);
  if (!Array.isArray(manifest.certifiedTags) || manifest.certifiedTags.length !== 1) process.exit(2);
  process.stdout.write(manifest.certifiedTags[0]);
' "$ROOT/server/src/fork-schema/supported-versions.json")"
manifest_digest="$(node -e '
  const manifest = require(process.argv[1]);
  const digest = manifest.certification?.officialDigest;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) process.exit(2);
  process.stdout.write(digest);
' "$ROOT/server/src/fork-schema/supported-versions.json")"

if [[ "$manifest_tag" != 'v3.1.0' ]]; then
  echo "Certified manifest tag must be exactly v3.1.0, received: $manifest_tag" >&2
  exit 1
fi
if [[ -n "${OFFICIAL_IMMICH_TAG:-}" && "$OFFICIAL_IMMICH_TAG" != "$manifest_tag" ]]; then
  echo "OFFICIAL_IMMICH_TAG must match supported-versions.json exactly ($manifest_tag)" >&2
  exit 1
fi
export OFFICIAL_IMMICH_TAG="$manifest_tag"
export FORK_ROUNDTRIP_API_URL="$API_URL"
export FORK_ROUNDTRIP_DATABASE_URL="$DATABASE_URL"
export FORK_ROUNDTRIP_STATE_DIR="$STATE_DIR"
export VITEST_DISABLE_DOCKER_SETUP=true

selected_lane="${FORK_ROUNDTRIP_LANE:-all}"
case "$selected_lane" in
  all|origin-v3.1.0-to-fork|current-fork-to-official-v3.1.0|official-v3.1.0-to-fork-return|official-v3.1.0-to-fork-to-official-v3.1.0-to-fork) ;;
  *) echo "Unknown certification lane: $selected_lane" >&2; exit 1 ;;
esac
EVIDENCE_FILE="$EVIDENCE_DIR/fork-roundtrip-$selected_lane.json"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
phase() {
  local name="$1" spec="$2"
  local log="$STATE_DIR/$name.log" status
  set +e
  FORK_ROUNDTRIP_PHASE="$name" pnpm --dir "$ROOT" --filter immich-e2e exec vitest --run "$spec" 2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"
  set -e
  if [[ "$status" -ne 0 ]]; then
    echo "Phase $name failed; durable output: $log" >&2
    return "$status"
  fi
}
wait_healthy() {
  local service="$1" id status
  for _ in {1..120}; do
    id="$(compose ps -a -q "$service")"
    status="$(docker inspect --format '{{if ne .State.Status "running"}}{{.State.Status}}{{else if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
    [[ "$status" == healthy ]] && return 0
    if [[ "$status" == exited || "$status" == dead ]]; then
      compose logs "$service" >&2
      return 1
    fi
    sleep 1
  done
  compose logs "$service" >&2
  echo "$service did not become healthy" >&2
  return 1
}
reset_lane() {
  compose down --volumes --remove-orphans
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
  compose up -d database redis
  wait_healthy database
  wait_healthy redis
}
start_official() {
  compose up -d official-server
  wait_healthy official-server
  local id logs
  id="$(compose ps -q official-server)"
  for _ in {1..120}; do
    logs="$(docker logs --since 5m "$id" 2>&1)"
    grep -Fq 'Immich Microservices is running' <<<"$logs" && return 0
    sleep 1
  done
  docker logs "$id" >&2
  echo 'official-server microservices did not become ready' >&2
  return 1
}
stop_official() { compose stop official-server; }
start_fork() {
  compose up -d fork-server
  wait_healthy fork-server
}
start_fork_normal() {
  start_fork
  local id logs
  id="$(compose ps -q fork-server)"
  for _ in {1..120}; do
    logs="$(docker logs --since 5m "$id" 2>&1)"
    grep -Fq 'Frameleaf Microservices is running' <<<"$logs" && return 0
    sleep 1
  done
  docker logs "$id" >&2
  echo 'fork-server microservices did not become ready after return' >&2
  return 1
}
stop_fork() { compose stop fork-server; }
interrupt_fork() {
  local id
  id="$(compose ps -a -q fork-server)"
  [[ -n "$id" ]] || { echo 'No fork container to interrupt' >&2; return 1; }
  compose kill -s SIGKILL fork-server
  # A successful kill request can precede the daemon's exited state. Without
  # this barrier, compose up can reuse the dying container instead of starting it.
  docker wait "$id" >/dev/null
}
psql_sql() { compose exec -T database psql -v ON_ERROR_STOP=1 -U postgres -d immich "$@"; }

# FL-295: what the server answers while it starts on a library the official server created: the
# "Getting Ready…" screen, its status and the 503 refusals. One JSON line every 0.25 s until the
# normal API answers the ping (or five minutes pass). While the status answers, the container's own
# health check (by its old name, as the Compose file uses it) runs too: it must report healthy, so an
# orchestrator never restarts the container in the middle of the copy.
watch_getting_ready() {
  local out="$1" base="${API_URL%/api}" ping page status redirect health
  : >"$out"
  for _ in $(seq 1 1200); do
    health=null
    ping="$(curl -s -o /dev/null --max-time 2 -w '%{http_code} %header{retry-after}' "$API_URL/server/ping" || true)"
    redirect="$(curl -s -o /dev/null --max-time 2 -w '%{http_code} %{redirect_url}' "$base/photos" || true)"
    page="$(curl -s --max-time 2 "$base/getting-ready" | grep -c '<html' || true)"
    status="$(curl -s --max-time 2 "$API_URL/server/getting-ready" || true)"
    if jq -e 'has("state")' <<<"$status" >/dev/null 2>&1; then
      health=0
      compose exec -T fork-server immich-healthcheck >/dev/null 2>&1 || health=$?
    fi
    jq -cn --arg ping "$ping" --arg redirect "$redirect" --arg page "$page" --arg status "$status" \
      --argjson health "$health" \
      '{ping: $ping, redirect: $redirect, page: ($page | tonumber? // 0), healthcheck: $health,
        status: (($status | fromjson? // null) | if type == "object" and has("state") then . else null end)}' >>"$out"
    [[ "$ping" == 200* ]] && return 0
    sleep 0.25
  done
}
# FL-295: the fork's first start on the official library, watched; then the backups folder, the
# pre-upgrade copy's contents and the log, recorded for the origin-pre-migrator phase. `expected` is
# `taken` (no recent backup) or `skipped` (an official backup taken just before).
start_fork_first_launch() {
  local expected="$1" watch="$STATE_DIR/getting-ready.jsonl" watcher id copy complete fork_schema skipped_for
  watch_getting_ready "$watch" &
  watcher=$!
  start_fork
  wait "$watcher" || true
  id="$(compose ps -q fork-server)"
  compose exec -T fork-server sh -c 'ls -1 /data/backups' >"$STATE_DIR/backups.txt"
  copy="$(grep -E '^immich-db-backup-[0-9]{8}T[0-9]{6}-pre-upgrade-v.*\.sql\.gz$' "$STATE_DIR/backups.txt" || true)"
  complete=false
  fork_schema=null
  if [[ -n "$copy" ]]; then
    if compose exec -T fork-server sh -c "gunzip -t '/data/backups/$copy' && gunzip -c '/data/backups/$copy' | tail -c 4096 | grep -q 'PostgreSQL database dump complete'"; then
      complete=true
    fi
    fork_schema="$(compose exec -T fork-server sh -c "gunzip -c '/data/backups/$copy' | grep -c 'CREATE SCHEMA immich_fork' || true")"
  fi
  # The backups each skip names: the "Getting Ready…" worker's, and the boot's own check before it
  # migrates (which finds the copy just taken). Read in full first: `grep -q` stopping early would
  # fail the pipeline (pipefail).
  docker logs "$id" >"$STATE_DIR/first-launch.log" 2>&1
  skipped_for="$(grep -F 'so no safety copy is needed before upgrading' "$STATE_DIR/first-launch.log" \
    | grep -oE 'The database backup [^ ]+' | cut -d' ' -f4 | jq -Rsc 'split("\n") | map(select(length > 0))' || true)"
  jq -n \
    --arg expected "$expected" \
    --arg copy "$copy" \
    --argjson complete "$complete" \
    --argjson forkSchema "$fork_schema" \
    --argjson skippedFor "${skipped_for:-[]}" \
    --rawfile backups "$STATE_DIR/backups.txt" \
    --slurpfile observations "$watch" \
    '{
      expected: $expected,
      copy: (if $copy == "" then null else {filename: $copy, complete: $complete, forkSchemaStatements: $forkSchema} end),
      backups: ($backups | split("\n") | map(select(length > 0))),
      skippedFor: $skippedFor,
      observations: $observations
    }' >"$STATE_DIR/first-launch.json"
  echo "First launch ($expected): copy=${copy:-none}, complete=$complete; $(wc -l <"$watch" | tr -d ' ') observations"
}
# FL-295: the official server's own database backup, through its API, as an administrator would
# take one just before swapping the image.
official_backup() {
  local token_state="$1" token before
  token="$(jq -r '.admin.accessToken' "$token_state")"
  before="$(compose exec -T official-server sh -c 'ls -1 /data/backups 2>/dev/null | grep -c "^immich-db-backup-.*\.sql\.gz$" || true')"
  curl --fail --silent --show-error \
    --request POST \
    --header "Authorization: Bearer $token" \
    --header 'Content-Type: application/json' \
    --data '{"name":"backup-database"}' \
    "$API_URL/jobs"
  for _ in {1..120}; do
    count="$(compose exec -T official-server sh -c 'ls -1 /data/backups 2>/dev/null | grep -c "^immich-db-backup-.*\.sql\.gz$" || true')"
    [[ "$count" -gt "$before" ]] && return 0
    sleep 1
  done
  echo 'The official server did not write a database backup' >&2
  return 1
}
admin() { compose exec -T fork-server immich-admin "$@"; }

# FL-44 (FN-304): the proof is tied to the exact candidate commit. A tree with uncommitted changes
# is refused unless FORK_ROUNDTRIP_ALLOW_DIRTY=true, and then recorded as dirty. The harness's own
# state and evidence under .cache are not part of the candidate.
resolve_candidate_commit() {
  local sha tree
  sha="$(git -C "$ROOT" rev-parse --verify HEAD 2>/dev/null)" || {
    echo 'Cannot determine the candidate git commit' >&2
    return 1
  }
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Candidate commit is not a full SHA: $sha" >&2; return 1; }
  tree="$(git -C "$ROOT" status --porcelain -- . ':(exclude).cache')" || {
    echo 'Cannot determine whether the candidate tree is clean' >&2
    return 1
  }
  candidate_dirty=false
  if [[ -n "$tree" ]]; then
    if [[ "${FORK_ROUNDTRIP_ALLOW_DIRTY:-false}" != true ]]; then
      echo 'The candidate tree has uncommitted changes; commit them, or set FORK_ROUNDTRIP_ALLOW_DIRTY=true to certify it recorded as dirty' >&2
      return 1
    fi
    candidate_dirty=true
  fi
  candidate_commit="$sha"
}
# The built image must carry the candidate commit as its revision label (server/Dockerfile sets it
# from BUILD_SOURCE_COMMIT = FORK_ROUNDTRIP_CANDIDATE_SHA), so the image id recorded is the candidate's.
resolve_candidate_image() {
  local id revision digests
  id="$(docker image inspect "$CANDIDATE_IMAGE" --format '{{.Id}}' 2>/dev/null)" || {
    echo "Cannot inspect the candidate image $CANDIDATE_IMAGE" >&2
    return 1
  }
  [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Candidate image id is not a digest: $id" >&2; return 1; }
  revision="$(docker image inspect "$CANDIDATE_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  [[ "$revision" == "$candidate_commit" ]] || {
    echo "Candidate image $CANDIDATE_IMAGE is labelled with revision '$revision', not $candidate_commit" >&2
    return 1
  }
  digests="$(docker image inspect "$CANDIDATE_IMAGE" --format '{{json .RepoDigests}}')"
  jq -e 'type == "array"' <<<"$digests" >/dev/null || { echo "Cannot read candidate repo digests: $digests" >&2; return 1; }
  candidate_image_id="$id"
  candidate_repo_digests="$digests"
}
write_evidence() {
  local status="$1"
  [[ -n "${candidate_commit:-}" && -n "${candidate_image_id:-}" && -n "${official_digest:-}" && -n "${official_image_id:-}" ]] || {
    echo 'Certification evidence is incomplete: candidate commit, candidate image and official image must all be known' >&2
    return 1
  }
  mkdir -p "$EVIDENCE_DIR"
  jq -n \
    --arg lane "$selected_lane" \
    --arg status "$status" \
    --arg recordedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg commit "$candidate_commit" \
    --argjson dirty "$candidate_dirty" \
    --arg image "$CANDIDATE_IMAGE" \
    --arg imageId "$candidate_image_id" \
    --argjson repoDigests "$candidate_repo_digests" \
    --arg officialTag "$OFFICIAL_IMMICH_TAG" \
    --arg officialImage "ghcr.io/immich-app/immich-server:$OFFICIAL_IMMICH_TAG" \
    --arg officialDigest "$official_digest" \
    --arg officialImageId "$official_image_id" \
    --arg officialArchitecture "$official_architecture" \
    --arg officialCorePluginDigest "$expected_official_core_digest" \
    '{
      lane: $lane,
      status: $status,
      recordedAt: $recordedAt,
      candidate: { commit: $commit, dirty: $dirty, image: $image, imageId: $imageId, repoDigests: $repoDigests },
      official: {
        tag: $officialTag,
        image: $officialImage,
        repoDigest: $officialDigest,
        imageId: $officialImageId,
        architecture: $officialArchitecture,
        corePluginDigest: $officialCorePluginDigest
      }
    }' >"$EVIDENCE_FILE.tmp"
  mv "$EVIDENCE_FILE.tmp" "$EVIDENCE_FILE"
  echo "Certification evidence ($status): $EVIDENCE_FILE"
}

# Retries `fork-schema-cutover prepare` while it refuses only because the fork server's own
# background jobs (queued by the seed's asset creation, e.g. media-health) still hold a live
# handoff lease - a real, product-correct refusal (assertNoLiveHandoffLeases), not a bug, but one
# the certification script itself races by calling prepare before those jobs drain. Any other
# error - or the same refusal still present once every reported lease has had time to lapse -
# fails hard immediately; this never masks a genuine handoff problem.
prepare_official_handoff() {
  local deadline=0
  # A lease that keeps renewing (a job that never finishes) would keep moving the reported lapse
  # time; this absolute cap stops the retry loop from outliving a stuck job.
  local give_up_at="$(($(date -u +%s) + 900))"
  while true; do
    prepare_output="$(admin fork-schema-cutover prepare --batch-size 32)"
    echo "$prepare_output"
    if ! grep -q '^Error:' <<<"$prepare_output"; then
      grep -q 'Verified: yes' <<<"$prepare_output" || { echo 'Official handoff preparation did not verify' >&2; exit 1; }
      return 0
    fi
    if ! grep -q '^Error: Official handoff refused:.*claimed by a worker' <<<"$prepare_output"; then
      exit 1
    fi
    local lapses_at lapses_at_epoch
    lapses_at="$(grep -oE 'lapses at [0-9T:.Z-]+' <<<"$prepare_output" | cut -d' ' -f3 || true)"
    # Strip fractional seconds (toISOString() includes milliseconds); GNU and BSD date agree on
    # whole-second ISO 8601 without them.
    lapses_at="${lapses_at%.*Z}Z"
    if [[ -n "$lapses_at" && "$lapses_at" != "Z" ]]; then
      # A grace period past the reported lapse for the worker to actually notice and release it.
      lapses_at_epoch="$(date -u -d "$lapses_at" +%s 2>/dev/null || date -u -jf '%Y-%m-%dT%H:%M:%SZ' "$lapses_at" +%s)"
      deadline="$((lapses_at_epoch + 30))"
    elif [[ "$deadline" == 0 ]]; then
      # No lapse time reported: bound the wait ourselves rather than retry forever.
      deadline="$(($(date -u +%s) + 120))"
    fi
    if (($(date -u +%s) >= deadline || $(date -u +%s) >= give_up_at)); then
      echo 'Official handoff preparation still refused after its reported lease(s) should have lapsed' >&2
      exit 1
    fi
    echo 'Waiting for the fork server to finish claimed jobs before retrying official handoff preparation...' >&2
    sleep 2
  done
}

# From a verified fork backfill to the official server running on the handed-over database: the
# destructive storage pass, storage verification, the locked cutover and prepare-official.
handoff_to_official() {
  local expected_assets="$1" cutover_phase="$2" cutover_spec="$3" interrupt="${4:-false}"
  # Steady-state backfills preserve physical deduplication; convert storage to
  # the destructive official form the cutover evidence requires.
  prepare_official_handoff
  admin fork-schema-cutover verify-storage start --database-backup-id "$BACKUP_ID" --media-snapshot-id "$SNAPSHOT_ID"
  if [[ "$interrupt" == true ]]; then
    storage_status="$(admin fork-schema-cutover verify-storage resume --database-backup-id "$BACKUP_ID" --media-snapshot-id "$SNAPSHOT_ID" --batch-size 1)"
    jq -e '.status == "running" and .verifiedCount > 0 and .verifiedCount < .applicableAssetCount' <<<"$storage_status" >/dev/null || exit 1
    interrupt_fork
    start_fork
  fi
  for _ in {1..600}; do
    storage_status="$(admin fork-schema-cutover verify-storage resume --database-backup-id "$BACKUP_ID" --media-snapshot-id "$SNAPSHOT_ID" --batch-size 32)"
    jq -e '.status == "completed"' <<<"$storage_status" >/dev/null && break
  done
  jq -e '.status == "completed" and .verifiedCount == .applicableAssetCount' <<<"$storage_status" >/dev/null || exit 1

  maintenance_output="$(admin enable-maintenance-mode)"
  echo "$maintenance_output"
  grep -q '^Error:' <<<"$maintenance_output" && exit 1
  report_digest="$(admin fork-schema-cutover preflight --database-backup-id "$BACKUP_ID" --media-snapshot-id "$SNAPSHOT_ID" --format digest)"
  [[ "$report_digest" =~ ^[0-9a-f]{64}$ ]] || { echo 'Cutover preflight did not return a digest' >&2; exit 1; }
  cutover_output="$(admin fork-schema-cutover apply --database-backup-id "$BACKUP_ID" --media-snapshot-id "$SNAPSHOT_ID" --report-digest "$report_digest")"
  echo "$cutover_output"
  grep -q '^Error:' <<<"$cutover_output" && exit 1
  phase "$cutover_phase" "$cutover_spec"
  handoff_output="$(admin fork-handoff prepare-official)"
  echo "$handoff_output"
  grep -q '^Error:' <<<"$handoff_output" && exit 1
  jq -e --arg backup "$BACKUP_ID" --arg snapshot "$SNAPSHOT_ID" --argjson assets "$expected_assets" '
    .officialImage == "ghcr.io/immich-app/immich-server:v3.1.0"
    and .databaseBackupId == $backup
    and .mediaSnapshotId == $snapshot
    and (.reportDigest | test("^[0-9a-f]{64}$"))
    and (.storageVerificationDigest | test("^[0-9a-f]{64}$"))
    and .storageVerificationAssetCount == $assets
  ' <<<"$handoff_output" >/dev/null || exit 1
  stop_fork
  set +e
  maintenance_output="$(compose run --rm --no-deps --entrypoint immich-admin fork-server disable-maintenance-mode 2>&1)"
  maintenance_code=$?
  set -e
  echo "$maintenance_output"
  [[ "$maintenance_code" -eq 0 ]] || exit "$maintenance_code"
  grep -q '^Error:' <<<"$maintenance_output" && exit 1
  start_official
}
# From the official server back to the fork: maintenance through the official API, the certified
# return reconciliation and a normal fork boot. The admin token comes from the state file named.
return_to_fork() {
  local token_state="$1"
  official_token="$(jq -r '.admin.accessToken' "$token_state")"
  curl --fail --silent --show-error \
    --request POST \
    --header "Authorization: Bearer $official_token" \
    --header 'Content-Type: application/json' \
    --data '{"action":"start"}' \
    "$API_URL/admin/maintenance"
  for _ in {1..60}; do
    official_maintenance="$(psql_sql -Atc "SELECT coalesce((value->>'isMaintenanceMode')::boolean, false) FROM public.system_metadata WHERE key = 'maintenance-mode'")"
    [[ "$official_maintenance" == t ]] && break
    sleep 0.1
  done
  [[ "${official_maintenance:-f}" == t ]] || { echo 'Official API did not enable maintenance mode' >&2; exit 1; }
  stop_official
  export FORK_IMMICH_ENV=production FORK_DB_SKIP_MIGRATIONS=false FORK_WORKERS_INCLUDE=api,microservices
  # Startup validates the exact official ledger before any provider runs.
  start_fork
  set +e
  fork_return_output="$(admin fork-handoff prepare-fork --batch-size 1)"
  fork_return_code=$?
  set -e
  echo "$fork_return_output"
  [[ "$fork_return_code" -eq 0 ]] || exit "$fork_return_code"
  grep -q '^Error:' <<<"$fork_return_output" && exit 1
  jq -e '
    .active == true
    and .phase == "active"
    and .schemaVersion == "2"
    and .reconciliationStatus == "complete"
    and .verified == true
    and (.progress | length == 7)
    and all(.progress[]; .remaining == 0 and .cursor == null and .lastError == null)
  ' <<<"$fork_return_output" >/dev/null || { echo 'Fork return did not report completed activation' >&2; exit 1; }
  stop_fork
  set +e
  maintenance_output="$(compose run --rm --no-deps --entrypoint immich-admin fork-server disable-maintenance-mode 2>&1)"
  maintenance_code=$?
  set -e
  echo "$maintenance_output"
  [[ "$maintenance_code" -eq 0 ]] || exit "$maintenance_code"
  grep -q '^Error:' <<<"$maintenance_output" && exit 1
  fork_maintenance="$(psql_sql -Atc "SELECT coalesce((value->>'isMaintenanceMode')::boolean, false) FROM public.system_metadata WHERE key = 'maintenance-mode'")"
  [[ "$fork_maintenance" == f ]] || { echo 'Fork return did not leave maintenance mode' >&2; exit 1; }
  start_fork_normal
}
cleanup() {
  if [[ "${FORK_ROUNDTRIP_KEEP_ON_FAILURE:-false}" == true && "${roundtrip_failed:-false}" == true ]]; then
    echo 'Preserving fork-roundtrip containers after failure for diagnosis' >&2
    return
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
on_error() {
  local status="$?"
  roundtrip_failed=true
  echo "Roundtrip failed with status $status at line ${BASH_LINENO[0]}: ${BASH_COMMAND}" >&2
  # An API 500 only says which call failed; the servers' logs say why, and cleanup removes them next.
  compose logs --no-color --tail 300 >&2 || true
  if [[ -n "${candidate_image_id:-}" ]]; then
    write_evidence failed || true
  fi
  exit "$status"
}
trap on_error ERR
trap cleanup EXIT

resolve_candidate_commit
export FORK_ROUNDTRIP_CANDIDATE_SHA="$candidate_commit"
echo "Candidate commit: $candidate_commit (dirty: $candidate_dirty)"

echo "Pulling official image $OFFICIAL_IMMICH_TAG and the pinned Redis dependency"
# The official server is the compatibility target the handoff is certified against, so it is the one
# upstream image this lane pulls. The database is Frameleaf's own image, built below from docker/postgres.
# Registries can rate-limit any remote service when parallel CI lanes pull at once.
pulled=false
for attempt in 1 2 3 4 5; do
  if compose pull official-server redis; then
    pulled=true
    break
  fi
  if [[ "$attempt" -lt 5 ]]; then
    echo "docker pull failed (attempt $attempt/5); retrying in $((attempt * 15))s" >&2
    sleep "$((attempt * 15))"
  fi
done
if [[ "$pulled" != true ]]; then
  echo "docker pull failed after 5 attempts" >&2
  exit 1
fi
official_digest="$(docker image inspect "ghcr.io/immich-app/immich-server:$OFFICIAL_IMMICH_TAG" --format '{{index .RepoDigests 0}}')"
expected_official_digest="ghcr.io/immich-app/immich-server@$manifest_digest"
[[ "$official_digest" == "$expected_official_digest" ]] || {
  echo "Official image digest mismatch: expected $expected_official_digest, received $official_digest" >&2
  exit 1
}
echo "Official image digest: $official_digest"
official_image_id="$(docker image inspect "ghcr.io/immich-app/immich-server:$OFFICIAL_IMMICH_TAG" --format '{{.Id}}')"
[[ "$official_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "Cannot determine the official image id: $official_image_id" >&2
  exit 1
}
official_architecture="$(docker image inspect "ghcr.io/immich-app/immich-server:$OFFICIAL_IMMICH_TAG" --format '{{.Architecture}}')"
expected_official_core_digest="$(node -e '
  const manifest = require(process.argv[1]);
  const architecture = process.argv[2];
  const digest = manifest.certification?.officialCorePluginDigests?.[architecture];
  if (!/^[0-9a-f]{64}$/.test(digest)) process.exit(2);
  process.stdout.write(digest);
' "$ROOT/server/src/fork-schema/supported-versions.json" "$official_architecture")"

compose build database fork-server
resolve_candidate_image
echo "Candidate image: $CANDIDATE_IMAGE $candidate_image_id"
write_evidence running

if [[ "$selected_lane" == all || "$selected_lane" == origin-v3.1.0-to-fork ]]; then
echo 'Lane: origin-v3.1.0-to-fork'
reset_lane
start_official
phase origin-seed src/specs/server/fork-schema-origin-upgrade.e2e-spec.ts
stop_official
# Run the real fork providers but keep plugin import stopped. FL-289: swapping the image is the
# upgrade, so this first boot sets up the isolated fork schema and adopts the official library by
# itself (no maintenance mode, no admin command); the phase below proves the official data survived.
# FL-295: before that, it shows "Getting Ready…" and takes the safety copy (no recent backup here).
export FORK_DB_SKIP_MIGRATIONS=false FORK_WORKERS_INCLUDE=api
start_fork_first_launch taken
phase origin-pre-migrator src/specs/server/fork-schema-origin-upgrade.e2e-spec.ts
stop_fork
export FORK_DB_SKIP_MIGRATIONS=false FORK_WORKERS_INCLUDE=api,microservices
start_fork
phase origin-post-migrator src/specs/server/fork-schema-origin-upgrade.e2e-spec.ts
stop_fork
fi

if [[ "$selected_lane" == all || "$selected_lane" == current-fork-to-official-v3.1.0 || "$selected_lane" == official-v3.1.0-to-fork-return ]]; then
echo 'Lane: current-fork-to-official-v3.1.0'
reset_lane
export FORK_DB_SKIP_MIGRATIONS=false FORK_IMMICH_ENV=development FORK_WORKERS_INCLUDE=api
# A blank database is classified as a fresh install, and fresh installs run
# the full combined legacy provider (see DatabaseService.onBootstrap), so a
# single boot establishes the complete current-fork state: the certified
# upstream schema plus every legacy fork migration — including the colliding
# workflow origin — after which the isolated fork schema classifies the
# database as a legacy installation. Priming any legacy ledger row by hand
# would duplicate what the migrator already recorded, so only assert.
start_fork
psql_sql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum enum_value
    JOIN pg_type enum_type ON enum_type.oid = enum_value.enumtypid
    WHERE enum_type.typname = 'asset_checksum_algorithm_enum' AND enum_value.enumlabel = 'sha256'
  ) THEN
    RAISE EXCEPTION '2100000000030 schema effect is absent';
  END IF;
  IF (SELECT count(*) FROM public.kysely_migrations
      WHERE name = '2100000000030-AddSha256ChecksumAlgorithm') <> 1 THEN
    RAISE EXCEPTION '2100000000030 must appear exactly once in the official ledger';
  END IF;
  IF (SELECT count(*) FROM public.kysely_migrations
      WHERE name = '1779400000000-UpdateWorkflowTables') <> 1 THEN
    RAISE EXCEPTION 'legacy workflow origin is absent from the official ledger';
  END IF;
  -- FL-289: the API worker starts the compatibility backfill by itself at boot. Only the API
  -- worker runs here, so no batch has been claimed yet.
  IF (SELECT phase FROM immich_fork.state WHERE id = 1) IS DISTINCT FROM 'dual-write' THEN
    RAISE EXCEPTION 'fresh fork boot did not start the compatibility backfill automatically';
  END IF;
  IF EXISTS (SELECT 1 FROM immich_fork.backfill_progress) THEN
    RAISE EXCEPTION 'a backfill batch ran without the microservices worker';
  END IF;
END
$$;
SQL
# The certified pause/interrupt/resume proof below drives the backfill by hand from a seeded legacy
# library. An operator pause holds the automatic start: it returns the library to legacy and later
# starts leave it there until `fork-schema start` or `resume`.
admin fork-schema pause
held_phase="$(psql_sql -Atc 'SELECT phase FROM immich_fork.state WHERE id = 1')"
[[ "$held_phase" == legacy ]] || { echo "Operator pause did not hold the automatic backfill: $held_phase" >&2; exit 1; }
official_core_container="$(docker create "ghcr.io/immich-app/immich-server:$OFFICIAL_IMMICH_TAG")"
docker cp "$official_core_container:/build/plugins/immich-plugin-core/dist/plugin.wasm" "$STATE_DIR/immich-plugin-core-v3.1.0.wasm"
docker rm "$official_core_container" >/dev/null
official_core_digest="$(node -e "const fs=require('node:fs'),crypto=require('node:crypto'); process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$STATE_DIR/immich-plugin-core-v3.1.0.wasm")"
[[ "$official_core_digest" == "$expected_official_core_digest" ]] || {
  echo "Unexpected v3.1.0 $official_architecture core plugin digest: expected $expected_official_core_digest, received $official_core_digest" >&2
  exit 1
}
docker cp "$STATE_DIR/immich-plugin-core-v3.1.0.wasm" "$(compose ps -q database):/tmp/immich-plugin-core-v3.1.0.wasm"
phase current-fork-seed src/specs/server/fork-schema-current-fork-cutover.e2e-spec.ts
stop_fork
export FORK_WORKERS_INCLUDE=api,microservices
start_fork
phase current-fork-quiescent src/specs/server/fork-schema-current-fork-cutover.e2e-spec.ts

# Process real one-row batches, pause only after a durable partial checkpoint,
# then hard-stop and resume after restart.
printf 'y\n' | compose exec -T fork-server immich-admin fork-schema start --batch-size 1
for _ in {1..600}; do
  partial_count="$(psql_sql -Atc '
    SELECT count(*) FROM immich_fork.backfill_progress
    WHERE processed > 0 AND remaining > 0
  ')"
  [[ "$partial_count" -gt 0 ]] && break
  sleep 0.1
done
[[ "${partial_count:-0}" -gt 0 ]] || { echo 'No partial backfill checkpoint was observed' >&2; exit 1; }
admin fork-schema pause
paused_phase="$(psql_sql -Atc 'SELECT phase FROM immich_fork.state WHERE id = 1')"
[[ "$paused_phase" == legacy ]] || { echo "Backfill did not pause in legacy phase: $paused_phase" >&2; exit 1; }
for _ in {1..600}; do
  active_claims="$(psql_sql -Atc 'SELECT count(*) FROM immich_fork.backfill_progress WHERE "claimToken" IS NOT NULL')"
  [[ "$active_claims" -eq 0 ]] && break
  sleep 0.1
done
[[ "${active_claims:-1}" -eq 0 ]] || { echo 'Backfill claims did not drain before interruption' >&2; exit 1; }
partial_snapshot="$(psql_sql -Atc "
  SELECT jsonb_agg(jsonb_build_object(
    'kind', kind,
    'processed', processed,
    'remaining', remaining,
    'digest', digest
  ) ORDER BY kind)
  FROM immich_fork.backfill_progress
")"
jq -e 'length == 7
  and all(.[]; (.processed + .remaining) == 256)
  and any(.[]; .processed > 0 and .remaining > 0)' <<<"$partial_snapshot" >/dev/null || exit 1
echo "Backfill partial checkpoint: $partial_snapshot"
interrupt_fork
start_fork
restarted_snapshot="$(psql_sql -Atc "
  SELECT jsonb_agg(jsonb_build_object(
    'kind', kind,
    'processed', processed,
    'remaining', remaining,
    'digest', digest
  ) ORDER BY kind)
  FROM immich_fork.backfill_progress
")"
[[ "$restarted_snapshot" == "$partial_snapshot" ]] || { echo 'Backfill checkpoint changed across restart' >&2; exit 1; }
admin fork-schema resume --batch-size 1
resumed_phase="$(psql_sql -Atc 'SELECT phase FROM immich_fork.state WHERE id = 1')"
[[ "$resumed_phase" == dual-write || "$resumed_phase" == ready ]] || {
  echo "Backfill did not resume: $resumed_phase" >&2
  exit 1
}
for _ in {1..120}; do
  status="$(admin fork-schema verify)"
  grep -q 'Verified: yes' <<<"$status" && break
  sleep 1
done
grep -q 'Verified: yes' <<<"${status:-}" || { echo 'Backfill did not verify' >&2; exit 1; }
handoff_to_official 256 current-fork-cutover src/specs/server/fork-schema-current-fork-cutover.e2e-spec.ts true
phase current-fork-official src/specs/server/fork-schema-current-fork-cutover.e2e-spec.ts

if [[ "$selected_lane" == all || "$selected_lane" == official-v3.1.0-to-fork-return ]]; then

echo 'Lane: official-v3.1.0-to-fork-return'
# The return lane intentionally continues from the certified cutover database.
# Seed the origin state file with the current auth/workflow identifiers used by
# the official API phase.
cp "$STATE_DIR/current-fork-to-official-v3.1.0.json" "$STATE_DIR/origin-v3.1.0-to-fork.json"
phase official-operations-before-restart src/specs/server/fork-schema-roundtrip.e2e-spec.ts
stop_official
start_official
phase official-operations-after-restart src/specs/server/fork-schema-roundtrip.e2e-spec.ts
# FL-180: make this library look as if it had been cut over on a version without
# 2100000000610-AddClassificationRule: its tables and its cutover ledger row go. The return must
# apply it again as a Frameleaf-recorded change and leave the certified official ledger alone.
psql_sql -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DROP TABLE public.classification_match;
DROP TABLE public.classification_rule;
DELETE FROM immich_fork.migration_audit
WHERE name = '2100000000610-AddClassificationRule' AND phase = 'ledger-cutover';
COMMIT;
SQL
return_to_fork "$STATE_DIR/origin-v3.1.0-to-fork.json"
psql_sql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF to_regclass('public.classification_rule') IS NULL OR to_regclass('public.classification_match') IS NULL THEN
    RAISE EXCEPTION 'the return did not apply 2100000000610-AddClassificationRule';
  END IF;
  IF (SELECT count(*) FROM immich_fork.migration_audit
      WHERE name = '2100000000610-AddClassificationRule' AND phase = 'frameleaf-public'
        AND status = 'applied' AND details->>'context' = 'return') <> 1 THEN
    RAISE EXCEPTION 'the return did not record 2100000000610-AddClassificationRule exactly once';
  END IF;
  IF EXISTS (SELECT 1 FROM public.kysely_migrations WHERE name LIKE '2100%') THEN
    RAISE EXCEPTION 'a Frameleaf migration was recorded in the official ledger';
  END IF;
END
$$;
SQL
phase fork-return src/specs/server/fork-schema-roundtrip.e2e-spec.ts
fi
fi

if [[ "$selected_lane" == all || "$selected_lane" == official-v3.1.0-to-fork-to-official-v3.1.0-to-fork ]]; then
echo 'Lane: official-v3.1.0-to-fork-to-official-v3.1.0-to-fork'
# FL-44 (FN-304): the whole chain runs on one isolated volume set, reset once here and never
# between legs, so the fork return certifies the data the official → fork leg produced.
reset_lane
# The terminal deletion phase requires the FileDelete handler's guarded-retention receipt.
export FORK_ROUNDTRIP_LOG_LEVEL=debug
start_official
phase origin-seed src/specs/server/fork-schema-origin-upgrade.e2e-spec.ts
# FL-295: a database backup the official server took just before the swap makes the safety copy
# unnecessary: the first start shows which backup it relies on and copies nothing.
official_backup "$STATE_DIR/origin-v3.1.0-to-fork.json"
stop_official
export FORK_DB_SKIP_MIGRATIONS=false FORK_IMMICH_ENV=production FORK_WORKERS_INCLUDE=api
start_fork_first_launch skipped
phase origin-pre-migrator src/specs/server/fork-schema-origin-upgrade.e2e-spec.ts
stop_fork
export FORK_WORKERS_INCLUDE=api,microservices
start_fork
phase origin-post-migrator src/specs/server/fork-schema-origin-upgrade.e2e-spec.ts
# FL-289: the first Frameleaf boot adopted the official library by itself (FL-44 adoption, inside
# the boot migration lock) and the API worker started the backfill. Let it finish before stopping
# the server only to keep this lane short: a batch killed mid-claim is taken over automatically, but
# only once its 15-minute lease expires (covered by test/medium/specs/fork-schema/backfill-restart.spec.ts).
for _ in {1..600}; do
  status="$(admin fork-schema verify)"
  grep -q 'Verified: yes' <<<"$status" && break
  sleep 1
done
grep -q 'Verified: yes' <<<"${status:-}" || { echo "$status"; echo 'Automatic backfill did not verify' >&2; exit 1; }
# The manual `fork-schema adopt` stays available to operators; on an adopted library it confirms
# and changes nothing.
stop_fork
set +e
adopt_output="$(printf 'y\n' | compose run --rm -T --no-deps --entrypoint immich-admin fork-server fork-schema adopt 2>&1)"
adopt_code=$?
set -e
echo "$adopt_output"
[[ "$adopt_code" -eq 0 ]] || exit "$adopt_code"
grep -q '^Error:' <<<"$adopt_output" && exit 1
# The confirmation prompt leaves terminal control codes on the line before the result.
grep -q 'Adopted: already (nothing changed)' <<<"$adopt_output" || { echo 'Startup did not adopt the official library' >&2; exit 1; }
grep -Eq '^Phase: (dual-write|ready)$' <<<"$adopt_output" || {
  echo 'Startup did not start the backfill of the adopted library' >&2
  exit 1
}
psql_sql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM public.kysely_migrations WHERE name = '1787148183729-ClusterGroups') <> 1 THEN
    RAISE EXCEPTION 'adoption did not apply 1787148183729-ClusterGroups exactly once';
  END IF;
  IF (SELECT count(*) FROM public.kysely_migrations WHERE name = '2100000000570-AddWorkflowDefinitions') <> 1 THEN
    RAISE EXCEPTION 'adoption did not apply the Frameleaf public migrations';
  END IF;
  IF EXISTS (SELECT 1 FROM public.kysely_migrations WHERE name = '1779400000000-UpdateWorkflowTables') THEN
    RAISE EXCEPTION 'adoption ran the Frameleaf copy of the official workflow rewrite';
  END IF;
  IF (SELECT count(*) FROM immich_fork.migration_audit
      WHERE name = 'official-origin-adoption' AND status = 'applied') <> 1 THEN
    RAISE EXCEPTION 'adoption left no audit record';
  END IF;
  IF EXISTS (SELECT 1 FROM public.system_metadata
      WHERE key = 'maintenance-mode' AND (value->>'isMaintenanceMode')::boolean) THEN
    RAISE EXCEPTION 'automatic adoption needed maintenance mode';
  END IF;
END
$$;
SQL
start_fork
phase chain-fork-seed src/specs/server/fork-schema-chained-roundtrip.e2e-spec.ts
# The backfill already started at boot; an explicit start (existing operator scripts) reports the
# status instead of failing, whether the backfill is still running or already ready.
start_output="$(printf 'y\n' | compose exec -T fork-server immich-admin fork-schema start --batch-size 32 2>&1)"
echo "$start_output"
grep -Eq '^Phase: (dual-write|ready)$' <<<"$start_output" || { echo 'Explicit start did not report the status' >&2; exit 1; }
for _ in {1..600}; do
  status="$(admin fork-schema verify)"
  grep -q 'Verified: yes' <<<"$status" && break
  sleep 1
done
grep -q 'Verified: yes' <<<"${status:-}" || { echo 'Chained backfill did not verify' >&2; exit 1; }
chain_assets="$(psql_sql -Atc 'SELECT count(*) FROM public.asset')"
[[ "$chain_assets" =~ ^[0-9]+$ ]] || { echo "Cannot count chained assets: $chain_assets" >&2; exit 1; }
handoff_to_official "$chain_assets" chain-fork-handed-over src/specs/server/fork-schema-chained-roundtrip.e2e-spec.ts
phase chain-official src/specs/server/fork-schema-chained-roundtrip.e2e-spec.ts
return_to_fork "$STATE_DIR/origin-v3.1.0-to-fork.json"
phase chain-fork-return src/specs/server/fork-schema-chained-roundtrip.e2e-spec.ts
delete_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
phase chain-canonical-delete src/specs/server/fork-schema-chained-roundtrip.e2e-spec.ts
deleted_path="$(jq -er '.deletedPath | select(length > 0)' "$STATE_DIR/chain-canonical-delete.json")"
if ! docker logs --since "$delete_started_at" "$(compose ps -q fork-server)" 2>&1 \
  | grep -F "Skipping delete for $deleted_path; " \
  | grep -E '[1-9][0-9]* reference\(s\) remain' >/dev/null; then
  echo "The FileDelete handler did not confirm retaining the shared original: $deleted_path" >&2
  exit 1
fi
phase chain-survivor-check src/specs/server/fork-schema-chained-roundtrip.e2e-spec.ts
fi

write_evidence passed
echo "Local synthetic certification completed for: $selected_lane"
