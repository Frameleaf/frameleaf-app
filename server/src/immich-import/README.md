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
   the corresponding files into separate Frameleaf media roots. Writable bind
   mounts, identical resolved paths, overlapping source/destination trees, and
   hardlinked destination files are refused with
   `DESTINATION_MEDIA_MUST_BE_INDEPENDENT_COPY`. The importer checks every file
   using device/inode identity, link count, resolved containment, complete content
   hashes, and nanosecond modification/change times before and after reading. It never moves, renames, deduplicates, deletes,
   or rewrites files. Library paths need explicit mappings too. Keep destination
   files and root mappings unchanged while importing and verifying; never replace
   them with source bind mounts or hardlinks after activation. Subsequent managed
   storage operations may move or trash destination files, so independent copies
   are required to preserve the offline source as a recovery copy.
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
  ]
}
```

The optional legacy `embeddings` configuration is accepted for restart compatibility
but cannot authorize transfer. Each preflight inspects actual source/destination
vector dimensions and stored selected CLIP/face model names. Stable Immich 3.0–3.2.4
rows do not record their producing model, and selected configuration can differ
from those rows or be overridden by a configuration file. The importer therefore
skips all source CLIP/face vectors and records durable regeneration work, reporting
`SOURCE_PRODUCER_MODEL_UNRECORDED`. This also avoids inserting 512-dimensional CLIP
vectors into a destination configured for 768 dimensions. Face vectors are rebuilt
under the destination's current model too. No source
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

`preflight` compares the pinned release and exact migration-name set with the
frozen public table/column/type, nullability, default, identity/generated-column,
enum, primary-key, foreign-key, check and unique-index catalog. It rejects dropped,
added or changed structure with `UNKNOWN_SOURCE_SCHEMA`. The one explicit variable
shape is CLIP vector dimension: upstream changes that typmod when its configured
model changes; the actual dimension is inspected and bound to the restart
fingerprint. Vector values still require independent producer evidence to transfer.
Bookkeeping ledgers are checked separately, and only their catalog definitions
are excluded from structural equality. Physical index fillfactor does not alter
constraint semantics and is ignored. Source instance identities, content rows,
structural catalogs and the import configuration are bound to every restart.

The fixtures retain the existing exact-tag 3.1.0 PostgreSQL dump, pinned upstream
migration text and hashes, extracted structural SQL and three complete catalogs.
3.0.x reverses the sole session-column difference; 3.2.x applies the pinned column,
nullability/default and relationship migrations. Hosted PostgreSQL 19 tests restore
this immutable DDL and compare the resulting catalogs for all ten accepted pins.
These tests are authored but were not run locally; their hosted result is required
before claiming qualification.

`run` refuses any existing journal; `resume` requires one and refuses a different
source or changed configuration. Each batch commits rows and its last source key
in the same transaction. A process crash rolls back the active batch. Previously
committed batches are skipped, and deferred nullable cyclic relationships are
restored after their endpoints have been imported. No conflict clause overwrites
existing target content.

`verify` rereads mapped rows and checks exact content/permission values, row
counts, canonical foreign-key relationships, original checksums and mapped file
bytes and independent destination file identities. External `sha1-path` values are
verified against the original source path, then recalculated using the mapped
destination path; the external/library classification stays intact. It checks the source fingerprint again, persists missing derived work,
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
file), explicit column/key/type maps, structural-catalog selectors and exact migration
filename sets. `fixtures/structure/provenance.json` records the base dump, immutable
migration commits and content hashes. No source DDL executes during an import. The
adapter imports only the `CONTENT_TABLES` allowlist and only each table's frozen
columns. Older people become deterministic owner-scoped cluster groups; person
IDs become person-group IDs and face references are remapped accordingly.

Unit tests cover frozen version bounds, legacy conversion, vector model/dimension
checks, read-only admission, schema drift, checksum/path-hash remapping and independent
file/symlink/hardlink failures. `source-schema.spec.ts` qualifies the real PostgreSQL
catalog and rejects constraint/default/nullability mutations.
`test/medium/specs/immich-import/restart.spec.ts` uses hosted PostgreSQL to exercise
real uniqueness failures, transaction rollback, durable checkpoint recovery and
the inactive/abandoned gate. No tests or builds were run on the operator's Mac.
