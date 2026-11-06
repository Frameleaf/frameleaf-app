# Standalone PostgreSQL

Frameleaf uses one PostgreSQL 19 database with pgvector 0.8.7 and HNSW indexes. The owned database image is `ghcr.io/frameleaf/frameleaf-postgres:19rc1-pgvector0.8.7`. Use the digest pinned in the Frameleaf release's Compose file and manifest for deployment. PostgreSQL 19 RC 1 is the current baseline; an image build or source review does not establish production readiness.

The PostgreSQL image is public and supports AMD64 and ARM64. Pulling this image does not require a GitHub account or registry credentials.

All Frameleaf content, configuration, jobs, import journals and shared coordination tables live in the canonical `public` schema. Every API and job worker must connect to this same database. There is no separate cache or queue service to configure. Do not attach an Immich database or an older PostgreSQL data directory to this installation; use the [offline import](./import-immich.md) to copy supported source content into a fresh destination.

## Requirements

- PostgreSQL 19 and the pgvector 0.8.7 extension installed on the database server.
- A dedicated database, normally named `frameleaf`, with permissions for the Frameleaf role to create and update the canonical schema.
- The `vector` extension enabled in that database. Have the database administrator install it if the application role cannot create extensions.
- Reliable access from every API and worker process, including PostgreSQL LISTEN/NOTIFY connections for Socket.IO broadcasts. Transaction-pooling proxies cannot substitute for the persistent listener connection.
- A tested database and media backup, with PostgreSQL 19 `pg_dump` and `psql` clients.

For an external database, set `DB_URL` to its connection URL or configure the `DB_HOSTNAME`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` and `DB_DATABASE_NAME` variables. Protect credentials in deployment secrets and do not place them in support logs. TLS options are part of the PostgreSQL connection URL; use the trust policy required by your database administrator.

The release Compose file mounts the database parent directory at `/var/lib/postgresql`. The owned image writes its versioned cluster beneath that directory. A PostgreSQL 14/15/16/17/18 cluster is not a PostgreSQL 19 volume; changing an image tag is not a major-version migration.

## Moving to a new PostgreSQL build

Some releases change the PostgreSQL build in a way that cannot open the existing database folder, for example PostgreSQL 19 beta 4 to 19 RC 1. The new database refuses the old folder ("database files are incompatible with server"), so the database is copied across with a dump and restore into a new, empty folder. The old folder is kept as it is, so you can go back.

Frameleaf Manager does this for you when you update: it copies the database into a new folder beside the current one, checks every table, then starts the new release. If anything fails, it puts the previous release back on the old folder. Make sure the database drive has free space for a second copy of the database.

Move by hand only when you update to a release whose `docker-compose.yml` names a different database image from the one you run now, for example `frameleaf-postgres:19rc1-…` instead of `19beta4-…`. If the new file still names your current image, keep your database folder and update normally: a restore with the same image only creates another copy that the next build still cannot open.

For a plain Docker Compose installation, run these commands in the folder with your `docker-compose.yml` and `.env`:

1. Note the images you run now with `docker compose images` (you need them only if you go back and your Compose file uses `latest` tags). Stop Frameleaf, leaving the database running, and save a dump outside the database folder:

   ```bash
   docker compose stop frameleaf-server frameleaf-machine-learning
   docker compose exec -T database sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > frameleaf-move.dump &&
     docker compose down
   ```

   Do not pass `-v` or `--volumes` to `down`. If the dump command fails, stop here: Frameleaf's database is unchanged, so start it again with `docker compose up -d`. Check that `frameleaf-move.dump` is not empty.

2. Replace `docker-compose.yml` with the new release's file (keep a copy of the old one). In `.env`, point `DB_DATA_LOCATION` at a new, empty folder, for example `./postgres19rc1`. Leave the old folder untouched. Then run `docker compose config` and check two things under the `database` service: `image` is the new release's database image, and `volumes` mounts the new, empty folder. If an override file still names the old image or folder, keep a copy of that file, then update it before you continue.

3. Start only the new database, wait until `docker compose ps database` shows it healthy, then restore the dump:

   ```bash
   docker compose up -d --wait database
   docker compose exec -T database sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error --single-transaction --no-owner --no-acl' < frameleaf-move.dump
   ```

4. If the restore fails, stop here and go back (below). If it succeeds, start Frameleaf with `docker compose up -d` and check your library.

To go back, run `docker compose down`, restore the old `docker-compose.yml`, any override file you changed and the old `DB_DATA_LOCATION`, set the images you noted in step 1 if your Compose file uses `latest` tags, and run `docker compose up -d`. Going back after Frameleaf has run on the new database loses everything it changed since step 4 (new uploads stay on disk but are no longer in the library), so go back straight away or not at all, and keep the new folder until you are sure. Delete the old folder and the dump only once you are happy with the new release.

On Unraid or TrueNAS templates the steps are the same: stop the Frameleaf server and machine learning containers, save the dump by running the same `pg_dump` command with `docker exec -i` against the database container (for example `frameleaf-postgres`), then set that container's image to the new release's and its data folder to a new, empty folder. Start it, restore the dump with the same `pg_restore` command, and start Frameleaf.

## Schema ownership

Frameleaf creates its own baseline and records subsequent changes in `public.frameleaf_migrations`, with `public.frameleaf_migrations_lock` coordinating migration execution. Do not copy source migration rows, extension indexes or operational queues into this database. See [Database migrations](../developer/database-migrations.md).

## Backup and recovery

Backups are plain SQL produced by `pg_dump` and compressed with gzip. Recovery uses `psql` against a stopped Frameleaf installation after the backup's canonical ledger has been checked. Keep media, settings and connector encryption keys together with the matching database recovery point. See [Backup and restore](./backup-and-restore.md).
