# Upgrading Frameleaf

The following workflows describe the upcoming Manager-based release and its PostgreSQL 19 database. Read the [release availability notice](/install/docker-compose) first. Existing published `:latest` application images belong to the preceding release; use that release's own instructions and matching Compose bundle until a compatible upgrade is published.

Keep the application's deployment files, database image, settings and backup together. Updating an image tag alone does not migrate a PostgreSQL major version.

## Update with Manager

For a Manager installation, open **Overview → Updates**, select an eligible release and choose **Verify and review update**. Review the recovery guidance, then select **Update Frameleaf**. Manager obtains the compatible images and makes a database checkpoint before applying the release. Keep a separate matching media backup.

Use **Resume safely** after a failed or interrupted operation. Before release application begins, **Cancel update and restart** can return to the prior release. Once the update may have changed the database or media, recovery moves forward or restores a matched recovery point; it does not simply downgrade an image.

## Manual container update

### Before updating

1. Read the Frameleaf release notes and supported architecture requirements.
2. Create a [database and media backup](../administration/backup-and-restore.md), including connector encryption keys and deployment configuration. Check a recovery copy before discarding your previous recovery point.
3. Stop uploads and other writers for changes that require a maintenance window. Preserve shared mounts and use the same database URL for every process.
4. Download the matching Frameleaf release bundle into a separate folder and review configuration changes. Keep your own secrets and storage paths; do not overwrite them with examples.
5. If the bundle changes the application service name to `frameleaf-server`, run `docker compose down` **with the current Compose file before replacing it**. Do not use `--volumes` or `-v`; retain your media, database and named volumes. Keep the project name and `.env`, and update custom overrides, proxy targets and scripts to use `frameleaf-server`.
6. Replace the Compose files. Use `FRAMELEAF_VERSION=latest` with the matching release's deployment files, then run `docker compose pull` and `docker compose up -d`. Keep the database image supplied in that bundle. Confirm database health, migration completion, API access and representative media behavior.

Automatic schema migration uses `public.frameleaf_migrations`. Do not rename or remove its rows to force an upgrade. If migration fails, keep the logs and backup, stop writers and diagnose the failure before trying another version.

## Fresh canonical installations and source import

Do not replace an Immich server image with Frameleaf while pointing it at the original Immich database. For a manual import, create a separate, empty PostgreSQL 19 database and distinct media copies, then follow the [one-time offline import](../administration/import-library.md). The importer reads supported stable Immich 3.x through 3.2.4, preserves content and access controls, and requires verification before activation.

An older PostgreSQL data directory cannot be opened merely by changing its image to PostgreSQL 19. Frameleaf has no in-place legacy vector-extension conversion or database handoff/return mode. A Frameleaf backup must contain the canonical ledger to be restored as a Frameleaf database.

## Recovery

Rollback means restoring the matched database and media recovery point with the matching Frameleaf release. Downgrading an image against a schema already changed by a newer release is not a recovery procedure. See [Backup and restore](../administration/backup-and-restore.md).
