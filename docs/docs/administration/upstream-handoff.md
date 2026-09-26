# Certified upstream handoff and fork return

This procedure applies only to a compatibility-certified fork database whose
supported official release is listed in
`server/src/fork-schema/supported-versions.json`. The currently certified image
is exactly `ghcr.io/immich-app/immich-server:v3.1.0`. Never replace that tag
with `latest`, `release`, or another floating tag.

The return mechanism is supported for the certified 3.0 release line and later
certified 3.x releases only. A pre-3.0 fork, an uncertified official version, or
a database without a completed compatibility cutover must be restored from its
database and media checkpoints instead.

:::danger Mandatory release gate
The synthetic container certification in the repository does not certify your
installation. Before release, repeat the complete sequence against a sanitized,
production-shaped clone. Interrupt and resume every backfill and storage
verification job, compare final row and file digests, and boot exact official
`v3.1.0`. This external gate cannot be claimed by a local test run.
:::

## Data ownership and markers

Workflow and plugin tables remain ordinary upstream tables. The fork does not
create a workflow sidecar, copy workflow rows into `immich_fork`, translate
steps, or replay a workflow-specific backfill.

The legacy fork migration
`1779400000000-UpdateWorkflowTables` ran SQL equivalent to official migration
`1778614946174-UpdateWorkflowTables`. During the locked cutover, a current-fork
database aliases only that ledger name and preserves its timestamp. The
workflow/plugin schema fingerprint, counts, and row digests must remain exact.
An original-Immich database already containing `1778614946174` is not aliased.

The command refuses to continue if both markers exist, neither marker exists
while workflow tables exist, or the marker and exact schema fingerprint
disagree. Do not repair these cases by manually editing the ledger.

## Adopting a library created by the official server

A library the official v3.1.0 server created stays certified-upstream when Frameleaf
first starts on it. Startup adds only the `immich_fork` schema, leaves the state
`inactive` with schema version `1`, and warns that the library has not been adopted
yet. Frameleaf features such as people groups, media operations, Studio projects, Takeout
imports and preservation packages remain unavailable until adoption. Until then, the
official server can still start on the library with no handoff.

Adoption is an explicit, one-way step. Afterwards, the library can go back to the
official server only through the certified handoff described below. It also changes
existing official data, as listed below. Take database and media checkpoints first.
Adoption refuses to run unless maintenance mode is on. It also refuses when another
database client holds a transaction, is running a query, or connects from a different
address than the admin process. It cannot detect an idle server that connects from the
admin process's own address, for example over the same Unix socket, through a
connection pooler, or when the command runs through `docker exec` inside a server
container. Maintenance mode is required for that reason, and stopping every server is
the operator's responsibility. Stop every server container, then run these commands from
one-shot admin processes that use the Frameleaf image:

```bash
immich-admin enable-maintenance-mode
immich-admin fork-schema adopt
immich-admin fork-schema status
immich-admin disable-maintenance-mode
```

Adoption runs in one transaction. It applies the upstream migrations newer than the
certified tag (for example `1787148183729-ClusterGroups`) and every Frameleaf
public-schema migration in name order. It never runs the Frameleaf copy of the workflow
rewrite, because the official `1778614946174-UpdateWorkflowTables` already ran. It then
completes the Frameleaf steps that depend on those tables and sets the phase to `legacy`.
Workflow, plugin and method rows are checked unchanged. An `official-origin-adoption`
audit row records the applied migrations. For each step below, `details.steps` holds
table counts taken right before and right after that step, inside the transaction. A
count reads `null` while its tables do not exist yet. The counts are totals, not
per-row change records, so a difference is exact only where the step can move the count
in one direction. The ownerless albums, cross-owner memory links, Locked-folder assets
and OCR sync counts are exact. `albumsWithoutCover` and `peopleWithoutThumbnail` also
include rows that already had no cover or thumbnail. The `locked…` reference counts
(album covers, featured faces, shared-space person covers and pet covers that point at a
Locked asset) show how many references the repair released, but not whether each one got
a replacement or was cleared. `2100000000290` and `2100000000300` count references to
Locked-folder assets. `2100000000320` creates the lock records. Before it runs, its
counts cover the assets it is about to lock in an official library: the Locked folder,
the other members of those stacks, and the video parts of those live photos. After it
runs, they cover assets with a lock record.

### Changes adoption makes to existing official data

- **Locked folder (`2100000000320-AddAssetLock`).** Every asset in the official Locked
  folder gets a Frameleaf lock record, and its stored visibility becomes `timeline`
  (`hidden` for the video part of a live photo). Stacks and live photos lock as a whole:
  every other member of a stack with a Locked member, and the video part of a Locked live
  photo, is locked too. After a later handoff, the official app therefore shows those
  stack members and live-photo videos as Locked as well.
- **Covers and face thumbnails (`2100000000290-ClearLockedAlbumCovers`,
  `2100000000300-ClearLockedCoverReferences` and the same repair in `2100000000320`).** An
  album whose cover is a Locked photo gets its newest photo that is not Locked as its
  cover, or no cover. A person whose featured face is on a Locked photo gets another face,
  or none, and its thumbnail is cleared so it is generated again.
- **Ownerless albums (`1786385711807-AlbumOwnerDeleteTrigger`).** Albums without an owner
  are deleted, and from then on an album is deleted when its last owner leaves.
- **Memories (`1787148183730-DeleteMismatchedMemoryAssets`).** Links from a memory to
  another user's photo are deleted.
- **OCR sync (`1786972746372-AssetOcrSyncReset`).** The mobile apps' OCR sync checkpoints
  are deleted, so the next sync sends every OCR result again.
- **People (`1787148183729-ClusterGroups`).** Each user gets a cluster group, and each person
  becomes a member of a person group that keeps the person's ID. Faces and person history
  point at the group instead of the person.
- **Shared-link passwords (`2100000000660-HashSharedLinkPasswords`).** Every shared-link
  password is replaced by its bcrypt hash, and an empty password is removed. Each link keeps
  working with the same password in Frameleaf. The official server compares passwords as
  plaintext, so after a later handoff every password-protected link stays locked there (it never
  opens without a password) until its password is set again in the official app. The audit row
  counts them as `passwordProtectedLinks` and, before the step, `plaintextPasswordLinks`; both
  are exact.
- **Removed faces.** Faces the owner removed in the official app are recorded as the
  owner's own `remove` decisions in the face correction history (the audit row counts
  them as `faceDecisionsCarriedOver`).

If adoption fails, nothing is applied and the command can be run again. The command refuses a
ledger that is not the exact certified `v3.1.0` ledger. For a library from an older
official release, upgrade it with the official server to `v3.1.0` first. The command also
refuses a library that already holds Frameleaf tables and one that has been handed over.
Running it again after success changes nothing.

Leave maintenance mode and start the server normally. The adopted library now follows the
same sequence as any other Frameleaf library: `fork-schema start` for the compatibility
backfill, then the exact operator sequence below for a certified handoff and return.

## Checkpoints and destructive boundary

Take immutable, mutually consistent checkpoints of both PostgreSQL and every
media root. Record their real identifiers. Storage verification requires the
media snapshot ID; a blank, inferred, or newly substituted identifier blocks
preflight. Keep both checkpoints until the fork has returned and passed final
validation.

The ledger alias and compatibility activation commit atomically. A failure
before that commit leaves the old ledger authoritative. Any official migration
failure after the cutover commit requires restoring **both** the database and
media checkpoints. Do not retry by editing released migrations or ledger rows.

## Exact operator sequence

Enter maintenance mode and stop all other API, microservices, and worker
containers before running these commands. Substitute the two immutable IDs from
your checkpoint system.

```bash
export DATABASE_BACKUP_ID='backup-immutable-id'
export MEDIA_SNAPSHOT_ID='media-snapshot-immutable-id'

immich-admin fork-schema status
immich-admin fork-schema start
# Interrupt the worker once, restart it, and then:
immich-admin fork-schema resume
immich-admin fork-schema verify

immich-admin fork-schema-cutover verify-storage start \
  --database-backup-id "$DATABASE_BACKUP_ID" \
  --media-snapshot-id "$MEDIA_SNAPSHOT_ID"
# Interrupt verification once, restart it, and then:
immich-admin fork-schema-cutover verify-storage resume \
  --database-backup-id "$DATABASE_BACKUP_ID" \
  --media-snapshot-id "$MEDIA_SNAPSHOT_ID"

REPORT_DIGEST="$(immich-admin fork-schema-cutover preflight \
  --database-backup-id "$DATABASE_BACKUP_ID" \
  --media-snapshot-id "$MEDIA_SNAPSHOT_ID" \
  --format digest)"

immich-admin fork-schema-cutover apply \
  --database-backup-id "$DATABASE_BACKUP_ID" \
  --media-snapshot-id "$MEDIA_SNAPSHOT_ID" \
  --report-digest "$REPORT_DIGEST"

immich-admin fork-handoff prepare-official
```

`prepare-official` first counts the password-protected shared links. Frameleaf
stores their passwords as bcrypt hashes, which the official server cannot check,
so each of those links stays locked on the official server (it never opens
without a password) until you set its password again in the official app. With
any such link, `prepare-official` stops and says how many; run it again as
`immich-admin fork-handoff prepare-official --acknowledge-shared-link-passwords`
once you have planned to reset those passwords. It then prints the number on
standard error. After the return, the passwords you set on the official server
keep working in Frameleaf: a plaintext password is hashed on its first correct
use.

Save the canonical JSON printed by `prepare-official`. It names exact image
`ghcr.io/immich-app/immich-server:v3.1.0`. Keep maintenance enabled while
capturing that checkpoint, then stop the fork server. From a one-shot admin
process using the same fork image, run `immich-admin disable-maintenance-mode`
and immediately start the exact official image without changing the tag. This
normal official boot applies every pending certified migration; verify the
public ledger is the full `v3.1.0` manifest before API operations. Upstream
migrations the fork bundles beyond the certified tag (the post-certified
residue) are exactly reverted and removed from the ledger during cutover, and
the fork return re-applies them automatically.

Authenticate, list and execute an existing workflow, create a new workflow,
and upload, download, and delete a disposable asset. Confirm database counts
and media bytes after each operation.

## Return to the compatible fork

Re-enter maintenance mode and stop the official container. Before fork startup,
inspect `public.kysely_migrations` and compare it with the exact certified
manifest. Fork startup validates this official ledger before it runs the normal
official provider and then the isolated fork provider.

```bash
immich-admin fork-handoff prepare-fork --batch-size 100
# Stop the maintenance-only fork process. From a one-shot admin process using
# the same compatible fork image, leave maintenance mode:
immich-admin disable-maintenance-mode
# Start the compatible fork normally with API and microservices workers, then:
immich-admin fork-schema status
```

Return reconciliation archives and removes only orphaned non-workflow
sidecars, seeds defaults for new upstream IDs, rebuilds derived fork indexes,
and activates fork reads in the final transaction. It must not mutate
`plugin`, `plugin_method`, `workflow`, or `workflow_step`. Verify that workflows
which existed before handoff and workflows created by official Immich are both
still readable and executable as upstream data. A successful return is not
established by the maintenance worker's ping: maintenance must be false, the
normal authenticated API and microservices workers must be healthy, and both
workflows must execute on a new asset after the normal fork restart.

If exact ledger validation, sidecar reconciliation, workflow digest comparison,
or final activation fails, leave maintenance mode enabled and restore the
database and media checkpoints together.

## Frameleaf schema changes released after the cutover

The cutover removes Frameleaf's own schema changes from the official migration
ledger and records them in `immich_fork.migration_audit`. A Frameleaf version
released after your library's cutover can bring new ones. They are applied as
follows and recorded in `immich_fork.migration_audit` with phase
`frameleaf-public`. The official ledger never changes.

- While the library is handed over, Frameleaf applies none of them, so the
  official server starts on exactly the schema the cutover checked.
- `prepare-fork` applies them in one transaction, after the upstream
  migrations newer than the certified tag and before any reconciliation. If one
  fails, nothing is applied and the return stops before reconciliation. Leave
  maintenance mode enabled, correct the cause, and run `prepare-fork` again.
- Once the library is active again, startup applies any released since then
  in the same way, before the rest of the schema setup.

Frameleaf refuses to start on a library that recorded a Frameleaf schema change
this version does not include. That means a newer version already ran on it,
and downgrades are not supported.
