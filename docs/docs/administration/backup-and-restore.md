# Backup and restore

Frameleaf keeps media files on your storage and their identity, ownership, albums, access controls, settings and job state in one PostgreSQL 19 database. A recoverable installation needs both the database and the matching media files. Back up deployment configuration and connector encryption keys as well: restoring encrypted sessions without their original key cannot recover them.

Keep identity keys and recovery material on [private backup storage](./private-backup-storage.md). That guide covers server-only mounts, NAS ACL verification and migration that preserves existing keys.

## What to preserve

- The complete Frameleaf database, including `public.frameleaf_migrations`, import journals, configuration and feature tables.
- Original and external-library media, with a consistent recovery point for database references. Preserve paths and access permissions.
- Generated media if you want to avoid regenerating thumbnails or transcodes after recovery.
- Deployment configuration and file-backed secrets, especially encryption keys. Keep secret material out of support bundles.

Database backups do not contain your media. A filesystem copy taken while uploads, moves or deletions continue can disagree with the database snapshot. Stop writers or use a storage snapshot procedure that gives you a consistent recovery point. Keep a second copy outside the server being backed up.

For cloud backups, also preserve the separate [backup key and recovery kit](./cloud-backup-keys.md). That guide covers keys held only in memory, application worker access and restart recovery.

## Backup secrets and diagnostic logs

Request diagnostics mask passphrases, recovery codes, keys, keyrings and wrapping secrets, including nested fields and separator/case variants. Cloud backup setup, bucket checks, key and escrow routes, Buddy recovery key routes, and credential replacement routes exclude their entire request body, including failed requests. Method, path, status, duration and client address remain available at debug level. Unexpected route errors record a fixed failure category rather than the request, error text or stack. **Download diagnostics** excludes credential values and recovery material from settings; it does not collect request logs or recovery kits.

For installations that previously enabled verbose request logging, assess historical records before sharing diagnostics:

1. Establish the installed version, logging levels and time window when backup setup, escrow, key import or verification was used. Verbose logs may contain request bodies; debug logs may contain query parameters. Check locally retained logs, rotated copies, log collectors and support attachments under restricted access. Do not paste secret values into shell arguments, online searches or support tickets.
2. Review the relevant route names and field names, including `passphrase`, `recoveryCode`, `keys`, `keyring` and generic credential `value` fields. Record times, routes and affected credential types without copying their contents. Logging being enabled alone does not establish that a secret was exposed.
3. If exposure is confirmed, restrict access to every affected log copy and stop verbose logging while investigating. Preserve restricted incident evidence according to your retention process; share only a reviewed, sanitized extract. Updating Frameleaf protects future request diagnostics and does not sanitize historical logs or attachments.
4. Replace affected access credentials and rewrap affected escrow packages using your incident recovery procedure. A changed passphrase does not revoke an older escrow copy. An exposed backup key can still decrypt older backups encrypted with that key; rotating a current key alone does not protect those copies. Verify recovery with protected historical keys before retiring any key, log or backup. Keep an independent recovery kit available throughout this work.

## Database backups

Frameleaf's database backup runtime uses PostgreSQL 19 `pg_dump` to write plain SQL compressed with gzip. Backup filenames begin with `frameleaf-db-backup`. Configure and inspect scheduled backups under **Administration > Settings > Backup** and keep the matching files from your backup storage with your media recovery point.

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

## Managed cloud transfers

Managed backups request temporary storage sessions for upload, restore or cleanup. Verification and cleanup previews use restore access. Sessions renew during long operations; credentials stay in memory, while the operation records multipart receipts and verified download offsets so the same operation can resume after a worker restart. Keep the server's backup state and temporary transfer files until it finishes.

When Cloud temporarily cannot renew a session, the operation waits and retains its progress. A refused or revoked operation stops. Read-only storage cannot gain upload or cleanup permission through renewal; retained restores still require Cloud to authorize restore access. Previously issued sessions can remain valid until provider expiry, bounded to 15 minutes; an already accepted request may finish afterward. Native provider qualification is required before enabling these sessions in a managed rollout.

User-provided S3 credentials and independent offline recovery continue to use their existing configuration and recovery keys.

## Immich sources

An Immich dump or PostgreSQL volume is not a canonical Frameleaf backup. Use the [offline importer](./import-immich.md) against a stopped, read-only supported source with a fresh Frameleaf database and distinct verified media copies. The source database and media remain unchanged.
