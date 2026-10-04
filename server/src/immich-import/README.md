# One-time offline Immich import

This is a frozen reader for stable Immich 3.0.0, 3.0.1, 3.0.2, 3.0.3, 3.1.0,
3.2.0, 3.2.1, 3.2.2, 3.2.3 and 3.2.4. It is not an upgrade path, compatibility
mode, migration runner or upstream synchronization service. Future releases and
release candidates are rejected. Frameleaf requires its own fresh PostgreSQL 19
canonical public schema and pgvector HNSW indexes.

## Before starting

1. Stop every source Immich API, worker, upload client and maintenance writer.
   Keep them stopped until verification completes. The importer rejects other
   source database client sessions at each preflight, but the operator must also
   prevent reconnects. The `writersStopped` configuration is an explicit offline
   attestation, not a substitute for stopping services.
2. Use a dedicated source role with SELECT on source public tables, no ownership,
   write privileges, superuser/BYPASSRLS membership, or ability to assume such a
   role. Grant that role read access to `pg_control_system()` so the source cluster
   identity can be bound to the journal. Connections additionally enforce
   `default_transaction_read_only=on`. The importer never runs source writes or DDL.
3. Bootstrap a fresh Frameleaf destination. The migration owner installs
   `IMMICH_IMPORT_SCHEMA_SQL`; this command does not adopt an existing library.
   Every content and operational table must be empty. Only the canonical migration
   ledger, seeded queue configuration, import journal and documented reference
   tables may already exist. Start neither the API nor workers during import.
4. Make original files available read-only at the source roots. Independently copy
   or bind the corresponding files into the intended Frameleaf media roots. The
   importer checks source and destination bytes, original SHA-1/SHA-256 checksums,
   and resolved symlink containment. It never moves, renames, deduplicates, deletes,
   or rewrites files. Library paths need explicit mappings too.
5. Inject source credentials as `FRAMELEAF_IMPORT_SOURCE_URL` and destination
   credentials as `DB_URL` through the process environment. Do not put URLs in
   command-line arguments or configuration JSON. This command emits only bounded
   status and classified failures, never raw database errors or source records.

Example configuration (write it to a private file):

```json
{
  "version": "3.2.4",
  "sourceId": "my-offline-library-2026-10",
  "writersStopped": true,
  "mediaRoots": [
    { "source": "/offline/immich/upload", "target": "/frameleaf/upload" },
    { "source": "/offline/external", "target": "/frameleaf/external" }
  ],
  "embeddings": {
    "sourceClipModel": "ViT-B-32__openai",
    "targetClipModel": "ViT-B-32__openai",
    "sourceFaceModel": "buffalo_l",
    "targetFaceModel": "buffalo_l"
  }
}
```

Omit `embeddings` unless the exact source and destination model identifiers are
known. Embeddings transfer only as 512 finite numeric values with identical model
identifiers; otherwise durable regeneration requests are recorded. No source
extension, index, sessions, API keys, migration history, server configuration,
plugin credentials, temporary stream state, or queues are copied. User password
and PIN hashes, IDs, ownership, locked/hidden state, soft deletion, albums and
album roles, partner permissions, shared links, tags, memories, edits and media
metadata are preserved. Instance-level plugin/workflow definitions, notification
history and source audit/sync history are outside this content import.

## Commands

Run these through the Frameleaf administration CLI with the offline importer
command module registered:

```text
import-immich preflight --config /private/import.json
import-immich run --config /private/import.json
import-immich status
import-immich resume --config /private/import.json
import-immich verify --config /private/import.json
```

`preflight` binds the frozen stable version, exact migration-name set, complete
public table/column/type shape, source system/database identities, mapped content,
and import configuration. Nullability and full constraint definitions are included
in the restart fingerprint. They are not independently qualified against a frozen
upstream database dump; the checked-in fixtures were extracted from tag source
without running upstream databases. Hosted full-schema fixture qualification
remains necessary before broad operational use.

`run` refuses any existing journal; `resume` requires one and refuses a different
source or changed configuration. Each batch commits rows and its last source key
in the same transaction. A process crash rolls back the active batch. Previously
committed batches are skipped, and deferred nullable cyclic relationships are
restored after their endpoints have been imported. No conflict clause overwrites
existing target content.

`verify` rereads mapped rows and checks exact content/permission values, row
counts, canonical foreign-key relationships, original checksums and mapped file
bytes. It checks the source fingerprint again, persists missing derived work,
drains that journal transactionally into the PostgreSQL queue facade, and rebuilds
the destination HNSW indexes. It activates only when every gate has passed; derived
jobs need to be durably queued, not already executed. Worker/API startup must call
`assertImmichImportActivated()` so partial or abandoned imports stay inaccessible.
The integration owner must also keep the CLI bootstrap from starting normal
workers or ordinary user-registration logic.

`import-immich abandon --config /private/import.json` marks a partial destination
permanently inactive. It does not remove content or touch source files. Reclaim an
abandoned destination through an explicit operator database disposal and a fresh
canonical bootstrap; never clear the journal to reuse partial content.

## Frozen provenance and tests

`fixtures/frozen-sources.json` records upstream commit IDs for every accepted tag,
deduplicated source table declarations (including multiple tables declared in one
file), explicit column/key/type maps, and exact migration filename sets. The
adapter imports only the `CONTENT_TABLES` allowlist and only each table's frozen
columns. Older people become deterministic owner-scoped cluster groups; person
IDs become person-group IDs and face references are remapped accordingly.

Unit tests cover frozen version bounds, legacy conversion, vector model/dimension
checks, read-only admission, schema drift, file checksum and symlink failures.
`test/medium/specs/immich-import/restart.spec.ts` uses hosted PostgreSQL to exercise
real uniqueness failures, transaction rollback, durable checkpoint recovery and
the inactive/abandoned gate. No tests or builds were run on the operator's Mac.
