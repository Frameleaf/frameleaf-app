# Upgrading Frameleaf

Frameleaf releases use the canonical PostgreSQL 19 database with pgvector 0.8.7 and HNSW. The database, server and optional workers come from Frameleaf-owned release assets. Keep the Compose bundle and release manifest together; the manifest records immutable image digests and ordinary build provenance.

## Before updating

1. Read the Frameleaf release notes and supported architecture requirements.
2. Create a [database and media backup](../administration/backup-and-restore.md), including connector encryption keys and deployment configuration. Check a recovery copy before discarding your previous recovery point.
3. Stop uploads and other writers for changes that require a maintenance window. Preserve shared mounts and use the same database URL for every process.
4. Download the matching Frameleaf release bundle into a separate folder and review configuration changes. Keep your own secrets and storage paths; do not overwrite them with examples.
5. If the new bundle changes the application service name to `frameleaf-server`, run `docker compose down` with your **current Compose file before replacing it**. Do not use `--volumes` or `-v`. This removes the old service container while retaining persistent volumes and host folders. Preserve the project name, `.env`, database and media paths; update custom overrides, proxy targets and scripts to use `frameleaf-server`.
6. Replace the Compose files, run `docker compose config`, pull the digest-pinned images and start the installation using that release's bundle. Confirm database health, migration completion, API access and representative media behavior. A service-name change does not bypass database upgrade requirements.

Automatic schema migration uses `public.frameleaf_migrations`. Do not rename or remove its rows to force an upgrade. If migration fails, keep the logs and backup, stop writers and diagnose the failure before trying another version.

## Fresh canonical installations and source import

Do not replace an Immich server image with Frameleaf while pointing it at the original Immich database. Create a separate, empty PostgreSQL 19 database and distinct media copies, then follow the [one-time offline import](../administration/import-immich.md). The importer reads supported stable Immich 3.x through 3.2.4, preserves content and access controls, and requires verification before activation.

An older PostgreSQL data directory cannot be opened merely by changing its image to PostgreSQL 19. Frameleaf has no in-place legacy vector-extension conversion or database handoff/return mode. A Frameleaf backup must contain the canonical ledger to be restored as a Frameleaf database.

## Recovery

Rollback means restoring the matched database and media recovery point with the matching Frameleaf release. Downgrading an image against a schema already changed by a newer release is not a recovery procedure. See [Backup and restore](../administration/backup-and-restore.md).
