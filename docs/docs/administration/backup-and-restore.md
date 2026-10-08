# Backup and restore

Frameleaf keeps media files on your storage and their identity, ownership, albums, access controls, settings and job state in one PostgreSQL 19 database. A recoverable installation needs both the database and the matching media files. Back up deployment configuration and connector encryption keys as well: restoring encrypted sessions without their original key cannot recover them.

## What to preserve

- The complete Frameleaf database, including `public.frameleaf_migrations`, import journals, configuration and feature tables.
- Original and external-library media, with a consistent recovery point for database references. Preserve paths and access permissions.
- The complete generated-media tree, including edit artifacts and retained project dependencies. Some artifacts stored beside thumbnails cannot be regenerated.
- Deployment configuration and file-backed secrets, especially encryption keys. Keep secret material out of support bundles.

Database backups do not contain your media. A filesystem copy taken while uploads, moves or deletions continue can disagree with the database snapshot. Stop writers or use a storage snapshot procedure that gives you a consistent recovery point. Keep a second copy outside the server being backed up.

## Manager backups and recovery

In [Frameleaf Manager](/install/manager), open **Backups** and select **Back up database**. Manager stores encrypted Restic snapshots of the database and recovery configuration. Select **Export recovery configuration** and keep the exported key and configuration privately, away from the server. Back up the media separately.

[![Manager Backups page with the backup destination, Back up database action and verified recovery points with Restore controls.](/img/screenshots/manager-backups.jpg)](/img/screenshots/manager-backups.jpg)

*Create a database checkpoint or choose a recovery point to restore. Photos, videos and external-library files need a separate backup. Select the image to enlarge it.*

To restore on an empty Manager installation, choose **Restore a Manager backup**, unlock the repository with the recovery key, select a canonical Frameleaf snapshot and review the preserved library paths. Those media paths must already be available. Choose the host's PostgreSQL appdata folder; Manager allocates a fresh database directory and retains earlier directories.

Manager's source-import recovery checkpoints are for the original source software, not for canonical Frameleaf restore. A database snapshot cannot undo media changes made after cutover. For an interrupted operation, review the recorded step and use **Resume safely**; do not start a second restore against the same files.

## Database backups

Frameleaf's database backup runtime uses PostgreSQL 19 `pg_dump` to write plain SQL compressed with gzip. Backup filenames begin with `frameleaf-db-backup`. Configure and inspect scheduled backups under **Settings → Import & protection** and keep the matching files from your backup storage with your media recovery point.

For an operator-managed backup, use a PostgreSQL 19 client, the configured database user and the database named in `DB_URL` or `DB_DATABASE_NAME`. With the release Compose service names and defaults:

```bash
set -o pipefail
docker compose exec -T database pg_dump --clean --if-exists --no-owner --no-acl --username=postgres --dbname=frameleaf | gzip > frameleaf-db-backup.sql.gz
```

Use shell pipeline failure handling in automated jobs so a failed `pg_dump` cannot leave a misleading successful archive. Do not put passwords in command arguments. Confirm the archive is readable, contains the canonical Frameleaf migration ledger and restores into a disposable destination; an archive's existence alone does not establish recoverability.

## Restore

Stop API, job and upload writers before restoring. Preserve the current database and media recovery point before replacing anything. Frameleaf validates a full backup and refuses a backup without `public.frameleaf_migrations` before destructive restore. Recovery uses `psql` with the PostgreSQL 19 client to load the plain SQL, rather than `pg_restore` or a dump of unrelated databases.

Restore the matching media files, configuration and keys, then restore the database using Frameleaf's recovery interface or your documented PostgreSQL recovery procedure. Use a fresh, isolated database for an operator-managed recovery rehearsal. Do not load a Frameleaf dump into an unrelated database, or drop a live schema as a diagnostic step.

For a rehearsal, use a separate recovery host with the matching release's Compose file and a new `.env`. Set `DB_DATA_LOCATION` to a fresh, empty directory and use separate media paths; do not mount the live installation's database or media directories. Copy the backup archive there, start only the database service, and wait for its healthcheck to report healthy before loading the archive. The following commands use the release defaults; substitute your configured database user and database name if they differ:

```bash
set -o pipefail
docker compose up -d database
# Wait for the database healthcheck to report healthy before continuing.
gzip -dc frameleaf-db-backup.sql.gz | docker compose exec -T database psql --username=postgres --dbname=frameleaf --set=ON_ERROR_STOP=on --single-transaction
```

This tests archive restoration into an isolated database. Keep API, job and upload writers stopped in the rehearsal. Use Frameleaf's recovery interface for an operational restore so backup validation and the transient-state reset below run before writers resume.

During Frameleaf recovery, transient rate counters, upload leases, Socket.IO attachments and worker membership are cleared. Active jobs and pending/waiting jobs whose remote effects cannot be retried safely become `needs_attention`; only jobs on the audited safe retry list remain pending. This avoids automatically repeating a remote effect after restoring an older recovery point. Review these jobs before manually retrying them. Media and permissions remain database-backed and are not reconstructed from transient worker state.

Start the matching Frameleaf release, check database health and migrations, sign in as representative users, and verify original media bytes, albums, locked/hidden access and sharing behavior. An imported destination remains inactive until its importer verification succeeds; restoring a partial journal does not activate it.

## Immich sources

An Immich dump or PostgreSQL volume is not a canonical Frameleaf backup. Use the [offline importer](./import-library.md) against a stopped, read-only supported source with a fresh Frameleaf database and distinct verified media copies. The source database and media remain unchanged.
