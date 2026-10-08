# Standalone PostgreSQL

The upcoming release uses one PostgreSQL 19 database with pgvector 0.8.7 and HNSW indexes. Read the [release availability notice](/install/docker-compose) before deploying it. Use the database image supplied in the matching Compose bundle; application `:latest` images from the preceding release are not compatible with this layout.

The manual Compose deployment includes the compatible database. Use an external PostgreSQL service only if you administer its extensions, access, updates and recovery yourself.

All Frameleaf content, configuration, jobs, import journals and shared coordination tables live in the canonical `public` schema. Every API and job worker must connect to this same database. There is no separate cache or queue service to configure. Do not attach an Immich database or an older PostgreSQL data directory to this installation; use the [offline import](./import-library.md) to copy supported source content into a fresh destination.

## Requirements

- PostgreSQL 19 and the pgvector 0.8.7 extension installed on the database server.
- A dedicated database, normally named `frameleaf`, with permissions for the Frameleaf role to create and update the canonical schema.
- The `vector` extension enabled in that database. Have the database administrator install it if the application role cannot create extensions.
- Reliable access from every API and worker process, including PostgreSQL LISTEN/NOTIFY connections for Socket.IO broadcasts. Transaction-pooling proxies cannot substitute for the persistent listener connection.
- A tested database and media backup, with PostgreSQL 19 `pg_dump` and `psql` clients.

For an external database, set `DB_URL` to its connection URL or configure the `DB_HOSTNAME`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` and `DB_DATABASE_NAME` variables. Protect credentials in deployment secrets and do not place them in support logs. TLS options are part of the PostgreSQL connection URL; use the trust policy required by your database administrator.

The release Compose file mounts the database parent directory at `/var/lib/postgresql`. The owned image writes its versioned cluster beneath that directory. A PostgreSQL 14/15/16/17/18 cluster is not a PostgreSQL 19 volume; changing an image tag is not a major-version migration.

## Schema ownership

Frameleaf manages its own database schema and records applied migrations. Let the server complete its migrations during startup. Do not copy migration records, extension indexes or operational queues from a different application, or change these records to force an upgrade.

## Backup and recovery

Backups are plain SQL produced by `pg_dump` and compressed with gzip. Recovery uses `psql` against a stopped Frameleaf installation after the backup's canonical ledger has been checked. Keep media, settings and connector encryption keys together with the matching database recovery point. See [Backup and restore](./backup-and-restore.md).
