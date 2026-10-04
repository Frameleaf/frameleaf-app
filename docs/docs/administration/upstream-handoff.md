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
An original upstream database already containing `1778614946174` is not aliased.

The command refuses to continue if both markers exist, neither marker exists
while workflow tables exist, or the marker and exact schema fingerprint
disagree. Do not repair these cases by manually editing the ledger.

## Upgrading a library created by the official server

To move a library from the official v3.1.0 server to Frameleaf, change the server
container image to the Frameleaf image and start it. Nothing else is needed: the first
start makes a [safety copy of the database](#pre-upgrade-copy), adopts the library and
starts the compatibility backfill by itself. Still take your own database and media
checkpoints before you swap the image, because adoption is one-way. Afterwards,
the library can go back to the official server only through the certified handoff
described below. Adoption also changes existing official data, as listed below.

### Safety copy before the first start {#pre-upgrade-copy}

Before that first start changes anything, Frameleaf makes a safety copy of the library
database. While it does, the web address shows a **Getting Ready…** screen that explains
what is happening. Every other page shows the same screen, and API requests (including
the mobile apps and `/api/server/ping`) get `503 Service Unavailable` with a `Retry-After`
header. When the copy is saved, Frameleaf starts normally, and the screen moves on to
sign-in by itself.

The container's health check (`frameleaf-healthcheck`, under either of its names) reports **healthy** for the whole of this step, however long the
copy takes on a large library, so Docker, Kubernetes liveness probes and NAS app
supervisors do not restart the container in the middle of it. It also reports healthy
when the copy failed and the error screen is showing: restarting only tries the copy
again, and the database is not touched either way. Anything that needs the API itself
should wait for `/api/server/ping` to answer, which it does only once Frameleaf has
started normally.

- **What it is.** A full `pg_dump` of the database, made the same way as the scheduled
  database backups. It is written to a temporary `.tmp` file, checked (not empty, a
  complete gzip file, and ending the way a finished dump ends), then renamed.
- **Where it is.** In the same backups folder as the official server's own backups,
  `<media location>/backups` (for example `/data/backups`), named
  `immich-db-backup-<date>T<time>-pre-upgrade-v<version>-pg<version>.sql.gz`. The name
  keeps the shape the existing backup tools expect, so the official server and Frameleaf
  both list it, and it can be restored from **Administration > Maintenance**
  like any other backup (see [Restoring a Database Backup](./backup-and-restore.md#restoring-a-database-backup)).
- **How long it is kept.** It is never removed by the backup retention setting (keep the
  last _n_ backups), on Frameleaf or on the official server. It stays until an
  administrator deletes it.
- **When it is skipped.** When the newest database backup in that folder was taken less
  than 24 hours ago and is a complete dump, Frameleaf uses it instead. The time comes
  from the backup's name (or the file's modification time when the name has none). The
  log names that backup, and the screen shows it for a few seconds. So if you trigger a
  database backup on the official server just before you swap the image (**Job Queues >
  Create job > Create Database Dump**), the first start does not copy again.
- **When it fails.** Frameleaf first checks there is room for the copy. When there is not,
  or the copy fails, Frameleaf does not upgrade anything: the screen says what went wrong
  and what to do, the database stays exactly as the official server left it, and the next
  start tries again. Free up space (or fix what the log reports) and restart the
  container.
- **More than one server.** Only one process makes the copy, under the startup migration
  lock. Any other Frameleaf container started at the same time waits, then finds the
  fresh copy and goes on. A start that is interrupted in the middle of the copy removes
  the unfinished file next time and starts over.

The copy covers the database only. Keep your own copy of the media files as well, as
recommended above.

At that first start, Frameleaf adds its `immich_fork` schema and then adopts the library
while it holds the startup migration lock. That is before the API accepts requests and
before any background job runs. Like every startup migration, adoption needs no
maintenance mode. It refuses to run, and the library stays exactly as the official server
left it, when another server is still connected to the database. For example, an official
server container that is still running, or any other client that holds a transaction or is
running a query. A Frameleaf process that only waits for the startup migration lock does
not count. When adoption is refused, startup logs a warning that names the connected
clients and continues without Frameleaf features such as people groups, media operations,
Studio projects, Takeout imports and preservation packages. Until it succeeds, the official
server can still start on the library with no handoff. Stop the other server; adoption is
tried again at every start.

Once the library is adopted, the API server starts the compatibility backfill, which runs
in the background. `frameleaf-admin fork-schema status` shows where it is.

You can still adopt by hand, for example before the first start. The manual command also
requires maintenance mode, because it cannot tell an idle server that connects from its
own address (the same Unix socket, a connection pooler, or `docker exec` inside a server
container) from its own connections. Stop every server container, then run these
commands from one-shot admin processes that use the Frameleaf image:

```bash
frameleaf-admin enable-maintenance-mode
frameleaf-admin fork-schema adopt
frameleaf-admin fork-schema status
frameleaf-admin disable-maintenance-mode
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

If adoption fails, nothing is applied and it is tried again at the next start (or run the
command again). Adoption refuses a ledger that is not the exact certified `v3.1.0` ledger.
For a library from an older official release, upgrade it with the official server to
`v3.1.0` first. It also refuses a library that already holds Frameleaf tables and one that
has been handed over. Running it again after success changes nothing.

The adopted library now follows the same sequence as any other Frameleaf library: the
compatibility backfill, which starts by itself, then the exact operator sequence below for
a certified handoff and return.

## Compatibility backfill

A fresh install and an adopted library both start the compatibility backfill at the API
server's first start; no command is needed. It runs in the background, and the library
moves from `legacy` through `dual-write` to `ready` once every kind is verified.

Restarting the server during the backfill is safe and needs no command: every start
queues the backfill again. A batch that was running when the server stopped is taken
over once its 15-minute claim expires.

`pause` and `resume` are optional operator controls. `frameleaf-admin fork-schema pause`
returns the library to `legacy` after the running batches finish, and later starts leave
it paused. Pausing before the backfill has started also holds it. `frameleaf-admin
fork-schema resume` (or `start`) continues it. `start` and `resume` on a library whose
backfill is already `ready` (or `active`) only print the status, so existing scripts keep
working.

A kind whose last batch failed is not retried automatically. Startup logs the kind and
the error; fix the cause and run `frameleaf-admin fork-schema resume` to retry it.

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

frameleaf-admin fork-schema status
# The backfill started by itself; on a ready library these two only print the status.
frameleaf-admin fork-schema start
# Interrupt the worker once, restart it, and then:
frameleaf-admin fork-schema resume
frameleaf-admin fork-schema verify

frameleaf-admin fork-schema-cutover verify-storage start \
  --database-backup-id "$DATABASE_BACKUP_ID" \
  --media-snapshot-id "$MEDIA_SNAPSHOT_ID"
# Interrupt verification once, restart it, and then:
frameleaf-admin fork-schema-cutover verify-storage resume \
  --database-backup-id "$DATABASE_BACKUP_ID" \
  --media-snapshot-id "$MEDIA_SNAPSHOT_ID"

REPORT_DIGEST="$(frameleaf-admin fork-schema-cutover preflight \
  --database-backup-id "$DATABASE_BACKUP_ID" \
  --media-snapshot-id "$MEDIA_SNAPSHOT_ID" \
  --format digest)"

frameleaf-admin fork-schema-cutover apply \
  --database-backup-id "$DATABASE_BACKUP_ID" \
  --media-snapshot-id "$MEDIA_SNAPSHOT_ID" \
  --report-digest "$REPORT_DIGEST"

frameleaf-admin fork-handoff prepare-official
```

`prepare-official` first counts the password-protected shared links, inside the
same read-only transaction that prepares the checkpoint. Frameleaf stores their
passwords as bcrypt hashes, which the official server cannot check, so each of
those links stays locked on the official server (it never opens without a
password) until you set its password again in the official app. With any such
link, `prepare-official` stops and says how many; run it again as
`frameleaf-admin fork-handoff prepare-official --acknowledge-shared-link-passwords`
once you have planned to reset those passwords. It then prints the number on
standard error. Links whose password was set on the official server and not yet
used in Frameleaf still hold that password as it was typed; they keep working
on the official server, need no acknowledgement and are counted separately. After the return, the passwords you set on the official server
keep working in Frameleaf: a plaintext password is hashed on its first correct
use.

Save the canonical JSON printed by `prepare-official`. It names exact image
`ghcr.io/immich-app/immich-server:v3.1.0`. Keep maintenance enabled while
capturing that checkpoint, then stop the fork server. From a one-shot admin
process using the same fork image, run `frameleaf-admin disable-maintenance-mode`
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
frameleaf-admin fork-handoff prepare-fork --batch-size 100
# Stop the maintenance-only fork process. From a one-shot admin process using
# the same compatible fork image, leave maintenance mode:
frameleaf-admin disable-maintenance-mode
# Start the compatible fork normally with API and microservices workers, then:
frameleaf-admin fork-schema status
```

Return reconciliation archives and removes only orphaned non-workflow
sidecars, seeds defaults for new upstream IDs, rebuilds derived fork indexes,
and activates fork reads in the final transaction. It must not mutate
`plugin`, `plugin_method`, `workflow`, or `workflow_step`. Verify that workflows
which existed before handoff and workflows created by the official upstream server are both
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
