---
slug: /administration/import-library
---

# One-time offline Immich import

The importer copies content from a stopped Immich installation into a fresh canonical Frameleaf PostgreSQL 19 database. Supported sources are stable Immich 3.x through 3.2.4; prereleases and later versions are rejected. This is a one-way data import. Keep the original source database and media as a recovery point.

## Use Manager for guided import

[Frameleaf Manager](/install/manager) detects supported source installations, reviews their mounts and recovery checkpoint, stops source writers, and imports into a fresh PostgreSQL directory. It preserves the existing media locations, so create an independent media backup before cutover. Source database recovery does not roll back later changes to those media files.

After verification, sign in with the imported administrator and review processing settings. Manager releases background regeneration when first setup is ready; check its progress separately from application startup.

[![Manager library and settings review showing preserved media paths and access modes, settings needing attention and the import summary.](/img/screenshots/manager-import-review.jpg)](/img/screenshots/manager-import-review.jpg)

*Review the media paths and folder access, then check any settings marked **Review needed** before reviewing the cutover. Select the image to enlarge it.*

The remaining instructions are for administrators running the importer directly. They require independent verified media copies and explicit read-only source credentials.

## Prepare the source and destination

Stop every source writer: API servers, workers, upload clients and maintenance jobs. Keep them stopped through final verification. Use a dedicated source role with SELECT-only privileges and read access to `pg_control_system()` for cluster identity. The role must not own source objects, have write privileges, superuser/BYPASSRLS access or be able to assume a role with those powers. Set its default transaction policy to read-only.

Give this dedicated role effective `pg_read_all_stats` access so preflight can distinguish PostgreSQL autovacuum workers from client sessions. This grants **cluster-wide read-only statistics visibility, including other sessions' activity text**; it is not limited to the imported database. It grants no content-writing authority. Manager provisions this access automatically. For a newly created CLI import role, set `INHERIT` before granting membership (compatible with PostgreSQL 14 and later):

```sql
ALTER ROLE frameleaf_import_reader INHERIT;
GRANT pg_read_all_stats TO frameleaf_import_reader;
```

Use your actual dedicated role name. Verify effective access with `SELECT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')` on its connection. If an existing PostgreSQL 16+ membership was granted without inheritance, revoke that membership and grant it again after setting `INHERIT`. Client sessions and unknown backend types still block admission; do not disable autovacuum or retry past the refusal. Revoke the statistics membership or disable the dedicated reader when no further import or resume is needed. Manager disables its reader's login after import or cancellation.

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
frameleaf-admin import-immich preflight --config /path/config.json
frameleaf-admin import-immich run --config /path/config.json
frameleaf-admin import-immich status
frameleaf-admin import-immich resume --config /path/config.json
frameleaf-admin import-immich verify --config /path/config.json
```

Import-changing commands must run with the same destination URL, read-only source URL and configuration. `status` reads the destination journal without source access. `run` refuses an existing journal; `resume` requires the exact original source identity and configuration. Batch rows and checkpoints commit in the same transaction, so interruption does not justify clearing the journal or overwriting destination rows.

The importer preserves source IDs, ownership, password/PIN hashes, locked/hidden and soft-deleted state, albums and roles, partners, shared links, tags, memories, edits and media relationships. It does not copy source migration history, extension indexes, sessions, API keys, server configuration, plugin credentials, temporary streams or job queues. Workflow/plugin definitions, audit/sync history and notifications are outside this content import.

Embedding reuse requires finite values, matching source and destination dimensions, and evidence of the model that produced each stored vector. The supported source schemas do not record that producer identity, so these imports record durable regeneration work for search and face embeddings. Selected model names and optional `embeddings` configuration fields do not establish producer identity. Content and media relationships still import. The fresh Frameleaf baseline uses 768-dimensional search vectors and 512-dimensional face vectors, with its own pgvector HNSW indexes.

`verify` checks mapped rows, permissions, foreign keys, original-file checksums and bytes, the source fingerprint, derived-work journal and index rebuilds before activating the destination. Keep API and worker writers stopped until activation is confirmed. A successful copy phase is not an activated installation.

For an import performed by Frameleaf Manager, offline verification prepares a durable regeneration run for imported metadata, thumbnails, search and face data, including person thumbnails. The first Manager setup releases that run once an application administrator and processing settings are ready. Manager shows its progress and work that needs attention. Processing continues in the background: finishing setup does not mean regeneration is complete. Restarts reuse the same run and its saved progress; canonical Manager recovery retains the original run and recorded import lineage. Failed or cancelled work is not automatically retried just because setup or the server restarts, and unsafe external work is not automatically replayed on recovery. A standalone `import-immich` CLI import does not require Manager setup.

A changed source or configuration requires diagnosis, not forcing a checkpoint. Abandoning an import permanently marks that destination inactive. Preserve the journal for diagnosis; dispose of the partial destination explicitly and bootstrap another fresh one if starting over. Source files and database remain unchanged throughout.
