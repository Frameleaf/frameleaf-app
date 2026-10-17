# Standalone PostgreSQL

Frameleaf uses one PostgreSQL 19 database with pgvector 0.8.7 and HNSW indexes. The owned database image is `ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7@sha256:c599a95a6697dcd2f33b35dfde9c5e3728e2fdcdc55971a19daec1f75f13994d`. Use the digest in the Frameleaf release manifest for deployment. PostgreSQL 19 beta 4 is the current development baseline; an image build or source review does not establish production readiness.

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

## Schema ownership

Frameleaf creates its own baseline and records subsequent changes in `public.frameleaf_migrations`, with `public.frameleaf_migrations_lock` coordinating migration execution. Do not copy source migration rows, extension indexes or operational queues into this database. See [Database migrations](../developer/database-migrations.md).

## Backup and recovery

Backups are plain SQL produced by `pg_dump` and compressed with gzip. Recovery uses `psql` against a stopped Frameleaf installation after the backup's canonical ledger has been checked. Keep media, settings and connector encryption keys together with the matching database recovery point. See [Backup and restore](./backup-and-restore.md).
