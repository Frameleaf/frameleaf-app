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
   identity can be bound to the journal. It also needs effective `pg_read_all_stats`
   access to distinguish autovacuum from client sessions. This is cluster-wide
   read-only statistics visibility, including session activity text, not a grant
   limited to the source database. For a new dedicated role, set `INHERIT` before
   `GRANT pg_read_all_stats TO role_name` (PostgreSQL 14 compatible), and verify
   `pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')` on its connection.
   Existing non-inheriting memberships on PostgreSQL 16+ must be revoked and
   regranted after setting `INHERIT`. Unknown/client sessions still block import;
   do not disable autovacuum to bypass the check. Revoke membership or disable the
   reader when no further resume is needed. Manager provisions this access and
   disables its reader's login after import or cancellation. Connections enforce
   `default_transaction_read_only=on`. The importer never runs source writes or DDL.
3. Bootstrap a fresh Frameleaf destination. The migration owner installs
   `IMMICH_IMPORT_SCHEMA_SQL`; this command does not adopt an existing library.
   Every content and operational table must be empty. Only the canonical migration
   ledger, seeded queue configuration, import journal and documented reference
   tables may already exist. Start neither the API nor workers during import.
4. Choose the media policy below. For unmanaged imports, make original files
   available read-only at the source roots. Independently copy
   the corresponding files into separate Frameleaf media roots. Read-only source
   mounts are an operator prerequisite; the importer does not inspect mount flags.
   Identical resolved paths, overlapping source/destination trees, and
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

Default and explicit `independent-copy` imports validate every media root before
preflight and again before activation, even with no current media rows. Roots must
be absolute normalized directory paths with unambiguous mappings. Resolved source
and destination trees must be disjoint across all mappings; symlink aliases and
nesting are refused. Existing per-file checksum and independent-inode checks remain.
The separate Manager policy below retains same-path and nested-mount behavior.

## Manager-authoritative in-place imports

Manager uses the same frozen source reader and canonical destination bootstrap.
Its configuration includes `media: {"mode":"manager-in-place", "authority":"frameleaf-manager",
"operationId":"<stable import operation>", "deploymentId":"<managed deployment>"}`.
Every `mediaRoots` entry must use exactly the same absolute normalized `source`
and `target` path. Nested Manager roots select the most specific mount, matching
Docker mount precedence; duplicate destinations are refused. Manager mounts the existing media at those exact container
paths, read-only during import; it does not copy or back up media. Root mappings,
media mode, deployment and operation identity are included in the existing
configuration fingerprint. They cannot change on resume or verification.

Manager must fence all source and destination writers, close its source admin
connection before import, and retain the fence across interrupted operations.
Set `FRAMELEAF_IMPORT_MANAGER_OPERATION_ID` to the same operation identity in the
one-shot importer container. This is an explicit orchestration contract, not a
credential or proof that fencing occurred. Source database read-only-role,
session, structure and content checks still apply unchanged.

In-place verification requires identical resolved paths and device/inode identity,
checks containment, regular-file type, complete content hashes, original checksums
and before/after file metadata. The source fingerprint additionally includes the
SHA-256 of every present referenced media file, including legacy path-checksummed
external originals. Changed media therefore invalidates a resumed operation.
Missing regenerable files are recorded consistently; originals cannot be missing.
The importer never writes media. After activation Frameleaf becomes the media
writer; restarting Immich against these originals is not a safe rollback.

Invoke `frameleaf-admin import-immich preflight --config /private/import.json`,
then `run` (or `resume` for a partial journal), then `verify`, in the offline
container. The existing admin module initializes the canonical PostgreSQL 19
schema with inactive imports allowed, without starting ordinary API/workers.
Verification retains all five derived-work snapshots and activates the journal before
Manager starts the app. In a Manager `new_import`, all five snapshots commit held in
`enumerating` state, including empty snapshots. Their stable fingerprint-derived run
records `selection.managerSetup` with installation and operation identity,
`preparedAt` after the complete manifest audit, and `startedAt: null`. No worker can
admit this retained work before first setup explicitly releases it. The setup service
requires an admin, the chosen and validated initial ML settings, the matching activated
journal, and all five captured stages; it stamps `startedAt` and releases the held
snapshots atomically. A resumed import preserves that start and never revives cancelled
or attention-required stages.

The importer additionally requires `FRAMELEAF_MANAGER_ORIGIN=new_import`,
`FRAMELEAF_MANAGER_INSTALLATION` matching the 12-hex-character deployment identity,
and `FRAMELEAF_IMPORT_MANAGER_OPERATION_ID` matching the validated config. The
configuration digest must match the import journal. Environment markers alone cannot
authorize a Manager hold or retrofit one onto previously admitted work. `status` requires only `DB_URL` and reports the
journal state for restart reconciliation. An omitted media policy or explicit
`{"mode":"independent-copy"}` preserves the unmanaged independent-copy contract.

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

This is a regenerate-only production path for all frozen releases, not compatible
vector-value transfer. Their `smart_search` rows contain only `assetId, embedding`,
and `face_search` rows only `faceId, embedding`. A compatible dimensionality or
selected model name cannot establish which model produced an old row. Transferring
those values would require independently verifiable provenance tied to the actual
rows and source snapshot; the current frozen sources supply none.

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

Destination admission separately compares the complete live public catalog with
the pinned Frameleaf desired schema, using the owned reader with overrides disabled.
It also independently checks exact PostgreSQL constraint and trigger definitions.
Missing artifacts, reader warnings, missing or extra application objects, and
constraint/trigger drift fail closed with `DESTINATION_SCHEMA_NOT_CANONICAL` even
when the Frameleaf ledger is intact. The check never repairs the destination and
runs again immediately before activation.

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
transfers that journal into one durable run with frozen per-stage selections, and rebuilds
the destination HNSW indexes. `status` reports the retained `derivedRunId`. Journal acknowledgements
are bounded to 250 rows per transaction and require matching retained memberships; a restart
reuses the same run and snapshots, including empty stages. Legacy acknowledgements without
that proof fail closed. Verification creates no hot queue executions and does not wait for workers.
Missing person thumbnails have their own persisted stage, keyed by owner and person
group, alongside the four asset stages. It reuses the canonical thumbnail selector,
retains its selected face and asset root, and verifies that payload on handoff resume.
Ineligible faces remain excluded, and the ordinary thumbnail worker retains its
featured-face, protected-content and publication checks. An empty person stage does
not prevent the run completing. This handoff promises durable repair ownership, not
that rendering has already finished.
After activation, the coordinator admits manifest work in batches of 250 up to 1,000 live
jobs per queue, refilling when that queue reaches 500. It activates only when every gate has passed;
derived jobs need to be durably retained, not already executed. Worker/API startup must call
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
`test/medium/specs/immich-import/restart.spec.ts` replays the pinned baseline and
ORDER-listed migrations into fresh hosted PG19 databases. Its ten-pin adapter
matrix checks passwords/PINs, album roles, partner and shared-link permissions,
locked/soft-deleted ownership, legacy/current people mappings and independently
copied media. It also exercises a real PostgreSQL transaction failure, durable
checkpoint recovery, inactive/abandoned gates and missing FK/trigger refusal with
the ledger intact, including drift during dispatch. The matrix uses deterministic
source transport/fingerprints and a dispatcher acknowledgement stand-in; it does
not prove real source-role admission, production queue dispatch, password login or
completed ML regeneration. Separate source catalog/admission tests remain required.
These tests require the reviewed frozen artifact bundle and PostgreSQL 19. Source
coverage is distinct from executed validation; retain exact-candidate test results
under the repository validation policy.
