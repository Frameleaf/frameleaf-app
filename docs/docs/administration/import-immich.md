# One-time offline Immich import

The importer copies content from a stopped Immich installation into a fresh canonical Frameleaf PostgreSQL 19 database. Supported sources are stable Immich 3.x through 3.2.4; prereleases and later versions are rejected. This is a one-way data import. Keep the original source database and media as a recovery point.

## Prepare the source and destination

Stop every source writer: API servers, workers, upload clients and maintenance jobs. Keep them stopped through final verification. Use a dedicated source role with SELECT-only privileges and read access to `pg_control_system()` for cluster identity. The role must not own source objects, have write privileges, superuser/BYPASSRLS access or be able to assume a privileged role. Set its default transaction policy to read-only.

Create a fresh Frameleaf PostgreSQL 19 database with the canonical baseline. Do not run destination API or job workers during import. Content tables must be empty; seeded configuration, queue, import-journal and reference tables are handled by the importer.

Pre-copy original and external-library media to distinct destination roots. Target files must be independent verified copies, not aliases or hardlinks to source files. The importer verifies paths, bytes and hashes and does not move, delete, rename or rewrite source media. Make source roots read-only and keep them available until verification completes.

Credentials belong in environment variables, not configuration files, command arguments or support logs:

- `DB_URL`: fresh Frameleaf destination.
- `FRAMELEAF_IMPORT_SOURCE_URL`: stopped Immich source using the read-only role.

A configuration file identifies the immutable source version, operator source ID, stopped-writer assertion and root mappings:

```json
{
  "version": "3.2.4",
  "sourceId": "offline-library-2026-10",
  "writersStopped": true,
  "mediaRoots": [
    { "source": "/read-only-source/upload", "target": "/frameleaf-copy/upload" },
    { "source": "/read-only-source/external", "target": "/frameleaf-copy/external" }
  ]
}
```

`writersStopped` records your assertion; it does not shut down a source server. Preflight also checks version, migration/catalog shape and a source fingerprint. Restore the source's normal access only after deciding that no further import/resume is needed.

## Run and verify

The current admin CLI exposes:

```sh
immich-admin import-immich preflight --config /path/config.json
immich-admin import-immich run --config /path/config.json
immich-admin import-immich status
immich-admin import-immich resume --config /path/config.json
immich-admin import-immich verify --config /path/config.json
```

The command name is an existing admin CLI compatibility alias. Import-changing commands must run with the same destination URL, read-only source URL and configuration. `status` reads the destination journal without source access. `run` refuses an existing journal; `resume` requires the exact original source identity and configuration. Batch rows and checkpoints commit in the same transaction, so interruption does not justify clearing the journal or overwriting destination rows.

The importer preserves source IDs, ownership, password/PIN hashes, locked/hidden and soft-deleted state, albums and roles, partners, shared links, tags, memories, edits and media relationships. It does not copy source migration history, extension indexes, sessions, API keys, server configuration, plugin credentials, temporary streams or job queues. Workflow/plugin definitions, audit/sync history and notifications are outside this content import.

Embedding reuse requires finite values, matching source and destination dimensions, and evidence of the model that produced each stored vector. The frozen Immich 3.x schemas do not record that producer identity, so these imports record durable regeneration work for search and face embeddings. Selected model names and optional `embeddings` configuration fields do not establish producer identity. Content and media relationships still import. The fresh Frameleaf baseline uses 768-dimensional search vectors and 512-dimensional face vectors, with its own pgvector HNSW indexes.

`verify` checks mapped rows, permissions, foreign keys, original-file checksums and bytes, the source fingerprint, derived-work journal and index rebuilds before activating the destination. Keep API and worker writers stopped until activation is confirmed. A successful copy phase is not an activated installation.

A changed source or configuration requires diagnosis, not forcing a checkpoint. Abandoning an import permanently marks that destination inactive. Preserve the journal for diagnosis; dispose of the partial destination explicitly and bootstrap another fresh one if starting over. Source files and database remain unchanged throughout.
