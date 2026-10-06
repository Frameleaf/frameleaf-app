# Universal Storage and Partner Sharing v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD: write the failing test, run it red, implement, run it green, commit, for every task.

**Goal:** One stored file per content hash server-wide, a file trash for last copies, a self-relinking upgrade migration, and partner sharing that gives the recipient their own copy-on-write copies (assets, albums, tags, people, descriptions, locked items).

**Architecture:** Build on the existing `physical_file` / primary asset (`canonicalAssetId`) model and the `deleteUnreferencedPath` reference-count guard. Partner copies are ordinary rows owned by the recipient. New `immich_fork` origin tables track each copy's source and the fields its owner has changed, and a propagation job pushes source edits downstream.

**Tech Stack:** NestJS + Kysely (server), Postgres `immich_fork` schema migrations, Svelte 5 (web), React prototype (`design/frameleaf/template`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-universal-storage-partner-sharing-design.md`. Read it fully before starting; spec section numbers are cited below.

## Global Constraints

- Base branch: `master/frameleaf-implementation`. Never touch `mobile/`. Never merge or auto-merge PR #140.
- Product name is Frameleaf: new env vars, UI copy and docs use Frameleaf naming, never "Immich".
- Fork-schema migration numbers are reserved: **0000000000219** = storage-core (file trash), **0000000000220** = partner-core (origin tables + partner backfill columns), **0000000000221** = partner-people-locked (only if needed). Each migration: new file in `server/src/fork-schema/migrations/`, append to `server/src/fork-schema/manifests/fork-v2-catalog.json` `forkMigrations` plus index/constraint entries, update `server/test/medium/specs/fork-schema/migration-ledgers.spec.ts`, and make sure the return-to-upstream flow drops the new tables.
- Only exact SHA-256 checksum + size matches are ever linked or relinked. External-library files are never linked, moved or relinked from managed storage.
- An original is never unlinked from disk by any job: the last copy goes to the file trash (spec §3.5). Generated files may be deleted when unreferenced.
- Every unlink or move goes through the path lock + `deleteUnreferencedPath` / `assetRepository.moveFile`.
- Prototype first: new screens go in `design/frameleaf/template/src` before Svelte. Never edit hash-locked `design/frameleaf/**/README.md` or `source-manifest.json`.
- Commands:
  - Server unit: `cd server && pnpm exec vitest run --config test/vitest.config.mjs <spec>`
  - Server typecheck: `pnpm --filter @frameleaf/plugin-sdk build && cd server && pnpm exec tsc --noEmit`
  - Medium tests (Postgres via testcontainers): prefix `PATH=/Applications/Docker.app/Contents/Resources/bin:$PATH`, then `cd server && pnpm exec vitest run --config test/vitest.config.medium.mjs <spec>`. Docker is shared and has 8 GB: run one medium file at a time.
  - **Do not run e2e locally:** the e2e stack is shared across sessions. CI runs it.
  - OpenAPI/SDK after DTO changes: build the server, then `mise run //server:sync-open-api` and `mise run open-api-typescript`. Run these **from your own worktree's paths, never via `mise run //:` from a .claude worktree**, since that regenerates the main checkout.
  - Web: `cd web && pnpm run check:svelte && pnpm run check:typescript && pnpm exec vitest run <spec>`. Run `pnpm exec prettier --write` on touched files.
  - Before reporting done: server `tsc --noEmit`, lint on touched files (`pnpm exec eslint <files>`), and all touched specs green.

## Review Focus

1. **Concurrent uploads of identical new content by two users.** Expect exactly one `physical_file`, both assets linked, and no orphaned temp file. → test in Task 1.
2. **The primary asset is deleted while a storage-template move is queued for it.** Expect the next primary to own the file at a valid path, with no row pointing at a missing path. → test in Task 2.
3. **A partner copy of content that is in the file trash.** Expect the file to be restored from the trash and linked, never duplicated. → test in Task 4 and Task 9.
4. **A↔B mutual share plus B→C→A cycle with the same photo uploaded independently by C.** Expect each library to hold one copy and no propagation loop. → test in Task 10.
5. **The migration is interrupted mid-batch, then the server restarts.** Expect it to resume without double-trashing or double-linking, and the progress totals to stay monotonic. → test in Task 6.

---

## Workstream S1: storage-core (agent `storage-core`)

### Task 1: Universal upload linking

**Files:** Modify `server/src/services/asset-media.service.ts` (`getPhysicalDeduplicationCandidate` ~674, `ensureMasterPhysicalOriginal`, callers ~256-270); `server/src/repositories/physical-file.repository.ts` (`getMasterOriginalCandidate` :131 → `getServerOriginalCandidate(checksum, size)`); spec `server/src/services/asset-media.service.spec.ts`.
**Interfaces produced:**

- `PhysicalFileRepository.getServerOriginalCandidate(checksum: Buffer, sizeInBytes: number): Promise<{ id: string } | undefined>`: any active, non-external, non-offline asset with an original on disk, lowest id first.
- Every upload registers its own `physical_file` with itself as primary when no candidate exists.
- [ ] Failing tests:
  - (a) a user uploads content another user already has → new asset linked to the existing physical file, temp upload queued for FileDelete, response status `created`, not `duplicate`
  - (b) content already in the same library → existing duplicate response unchanged
  - (c) content in the same library's trash → restore (existing behavior) unchanged
  - (d) external-library candidate is ignored
  - (e) Review Focus 1: two concurrent uploads → one physical file. Use a per-checksum advisory lock (`DatabaseLock` + checksum hash) around candidate lookup and registration.
- [ ] Implement. Delete the master-user condition. Leave the config fields readable, since they're removed in Task 5.
- [ ] Green, typecheck, commit `feat(storage): FL universal upload linking`.

### Task 2: Primary-asset handover

**Files:** `physical-file.repository.ts` (new `electNextCanonical(physicalFileId)`), `server/src/services/asset.service.ts` (delete flow ~672), `storage.service.ts` FileDelete; specs.
**Interfaces produced:** `PhysicalFileRepository.electNextCanonical(physicalFileId: string): Promise<{ assetId: string } | undefined>`. It sets `canonicalAssetId` to the oldest remaining referencing asset. The caller then queues `JobName.StorageTemplateMigrationSingle` for that asset.

- [ ] Failing tests:
  - deleting the primary asset of a file shared by 3 → the oldest remaining becomes primary and a move is queued
  - deleting a non-primary asset → no change
  - Review Focus 2: the primary is deleted while its move is queued → the queued move for a deleted asset is a no-op; the new primary's move runs
- [ ] Implement, green, commit.

### Task 3: Storage job fixes

**Files:**

- `server/src/services/storage-template.service.ts:307-346`: non-primary sidecar goes to its own template path
- `server/src/cores/storage.core.ts:182-201`: primary-only check for generated-file moves
- `server/src/services/asset.service.ts:553-575` (`copySidecar`): non-primary target writes `upload/<owner>/<assetId>.xmp`, matching `metadata.service.ts:577-600`
- `server/src/services/integrity.service.ts:250, 871`: deletes go through `deleteUnreferencedPath`
- Audit `media-health.service.ts` and backup restore for raw unlinks/moves and route them through the guard

**Tests:** one failing test per fix, asserting the shared file and the other owner's sidecar are untouched. Also add a thumbnail-regeneration test (`media.service.ts:2557`) that keeps the canonical file.

- [ ] Red, implement, green, commit per fix.

### Task 4: File trash (spec §3.5)

**Files:**

- Create: `server/src/fork-schema/migrations/0000000000219-PhysicalFileTrash.ts`, `server/src/repositories/physical-file-trash.repository.ts`, `server/src/services/physical-file-trash.service.ts`, `server/src/controllers/physical-file-trash.controller.ts`, `server/src/dtos/physical-file-trash.dto.ts`
- Register them in the `index.ts` arrays and add `endpointTags`
- Modify `storage.service.ts` FileDelete
- Prototype: `design/frameleaf/template/src/` Library Care file trash panel
- Web: Library Care route component

**Table:** `immich_fork.physical_file_trash(id uuid pk, physicalFileId uuid, path text unique, checksum bytea, sizeInBytes bigint, lastOwnerId uuid, lastAssetId uuid, originalFileName text, trashedAt timestamptz default now())`.

**Interfaces produced:**

- `PhysicalFileTrashRepository.trash(input): Promise<TrashEntry>` (moves the file to `<media>/file-trash/<physicalFileId>/<originalFileName>` under the path lock; publish via temp)
- `findByChecksum(checksum, size): Promise<TrashEntry | undefined>`
- `untrash(id, targetPath): Promise<string>`
- `list(page)`
- `purge(id)`

**API (admin only):**

- `GET /admin/file-trash` (list + `totalBytes`)
- `POST /admin/file-trash/:id/restore` (re-import as a new asset for `lastOwnerId`, with metadata re-read)
- `DELETE /admin/file-trash/:id` (permanent)

**Steps:**

- [ ] Failing tests:
  - the last reference removed for an original → the file is moved, not unlinked, and a row is created
  - generated files are still deleted
  - Task 1's upload linking checks `findByChecksum` → untrash + link (Review Focus 3)
  - restore creates an asset for the last owner
  - purge unlinks and deletes the row
  - non-admin → 403
- [ ] Migration + catalog + ledger. Medium test for the repository move under lock.
- [ ] Prototype screen, then the Svelte screen (list, total size, Restore, Delete-permanently confirm dialog), with web spec.
- [ ] Regenerate OpenAPI/SDK. Commit.

### Task 5: Retire master-user config; return-to-upstream space check

**Files:**

- `server/src/config.ts`, `dtos/system-config.dto.ts`: drop `physicalDeduplication.enabled/masterUserId` from config and DTO, keeping the config-file loader tolerant of the old keys
- Plan/apply screens: move the history and verification views under Library Care, and remove the master-user picker
- `user.service.ts:454`: the master-account delete refusal goes away
- The return-to-upstream split in `fork-storage-normalization.service.ts` / `physical-file.repository.ts` claim flow: add a pre-check `requiredBytes = Σ size of non-primary originals` against `statfs` free space, and refuse with `{ requiredBytes, availableBytes }`

**Steps:**

- [ ] Failing tests: an old config with master keys still loads; the return refuses when free space < required; it proceeds when enough.
- [ ] Implement, regenerate SDK, commit.
- [ ] **Hand-off:** `SendMessage` to `storage-migration`: "S1 Tasks 1-5 done at <sha> on branch <branch>; file-trash interfaces as in plan". Then report to the lead.

## Workstream S2: storage-migration (agent `storage-migration`)

Start with Task 7's prototype and UI and Task 6's relink module, which have no dependency on S1. Rebase onto `storage-core`'s branch when it messages you, before wiring in the file trash.

### Task 6: One-time upgrade migration with relink (spec §3.6)

**Files:**

- Modify `server/src/services/physical-deduplication-plan.service.ts` and `physical-deduplication.service.ts` (the master-less plan: group by checksum+size, oldest asset primary, duplicates → `PhysicalFileTrashRepository.trash`)
- Create `server/src/services/storage-migration.service.ts` (orchestrator + state in `SystemMetadataKey.UniversalStorageMigration`)
- Reuse `media-health.service.ts` `locateManagedCandidates` / `relinkOne` validation

**Stages** (persisted state `{ stage, checked, total, relinked, toReview, groupsLinked, groupsTotal, trashed, trashTotal, bytesFreed, startedAt, rate }`):

1. `checking` (verify each original exists and matches its checksum)
2. `relinking` (spec §3.6 relink rules 1-3)
3. `linking`
4. `trashing`
5. `done`

Checkpoint after every batch of 500. Auto-queue after the fork schema starts if the state is not `done`.

**API:** `GET /server/storage-migration` (status), `POST /server/storage-migration/background` (admin: acknowledge running in background).

- [ ] Failing tests:
  - a missing original with an in-group copy → relinked
  - exactly one managed-storage match → relinked after re-read
  - two candidates → media-health Missing finding, not relinked
  - an external asset → finding, never relinked
  - a duplicate group → one primary, the others linked, their files trashed (not unlinked)
  - Review Focus 5: interrupt after batch N, then resume → no double trash or link, totals monotonic
  - an unreadable file → skipped and listed
- [ ] Medium test on a seeded library (run / interrupt / resume).
- [ ] Commit.

### Task 7: Getting Ready step (spec §5.1)

**Files:** prototype `design/frameleaf/template/src/FirstRunSetup.jsx` (or the Getting Ready component) adds the "Combining duplicate files" step after the safety backup; `web/src/lib/frameleaf/getting-ready.ts` + route component; web specs.
**Behavior:**

- Staged progress (X of Y per stage), "N relinked, M to review", space freed, time left from the measured rate.
- No Continue button until `done`. A "Run in background instead" link opens a confirmation dialog, then the status appears in Library Care.
- The end state is "Done" or "Finished with N files to review in Library Care".
- Fresh installs skip the step.
- Library Care gets a migration status card (same stages, shown while it runs in the background, plus the review list link).
- Survives reload: reopening returns to this step while the migration isn't done.

**Steps:**

- [ ] Failing web tests for each state, then implement, check:svelte, check:typescript, prettier, and commit.
- [ ] Report to the lead with branch + sha.

## Workstream P1: partner-core (agent `partner-core`)

### Task 8: Origin tables and partner columns

**Files:** `server/src/fork-schema/migrations/0000000000220-PartnerOrigins.ts`, catalog, ledger, Kysely DB types for the fork schema, `server/src/repositories/partner-origin.repository.ts`.

**Tables** (spec §4.2):

- `immich_fork.asset_origin(assetId pk fk→asset cascade, sourceAssetId fk→asset set null, rootOwnerId uuid, partnerSharedById uuid, overriddenFields text[] default '{}', following bool default true)`, with an index on `(sourceAssetId) where following`.
- `album_origin` and `person_origin`: same shape, keyed `albumId/sourceAlbumId` and `personId/sourcePersonId`.
- `immich_fork.partner_backfill(sharedById, sharedWithId pk, state text, cursor uuid, total int, done int, updatedAt)`.

**Interfaces produced:** `PartnerOriginRepository` with:

- `createAssetOrigin`, `getFollowers(kind, sourceId)`
- `markOverridden(kind, id, fields: string[])`
- `stopFollowing(partnerSharedById, ownerId)`
- `getOrigin(kind, id)`
- `libraryHasChecksum(ownerId, checksum): Promise<boolean>` (live or trashed)

**Steps:**

- [ ] Medium test for the migration + repository.
- [ ] Commit.

### Task 9: Copy engine + backfill (spec §4.3, §4.7)

**Files:** create `server/src/services/partner-copy.service.ts`; `JobName.PartnerBackfill`, `JobName.PartnerCopyAsset`; modify `partner.service.ts` create/remove.
**Interfaces produced:** `PartnerCopyService.copyAsset(sourceAssetId: string, targetOwnerId: string, partnerSharedById: string): Promise<string | undefined>`. It returns the new asset id, or undefined when skipped by the one-copy rule or because the target is the root owner. It:

- links to the source's `physical_file` (original + generated), untrashing via `findByChecksum` if needed
- copies exif, smart_search, OCR, tags (by name, reusing the target's tag) and visibility/sensitive state
- **skips assets with `visibility = locked` or sensitive until Task 13**

**Steps:**

- [ ] Failing tests:
  - copy creates a B-owned asset with the same physical file and no ML jobs queued
  - the one-copy rule skips content B already has (live or trashed)
  - root owner skip
  - quota is ignored
  - backfill batches resume from the cursor
  - unshare sets `following = false` and B keeps the rows
  - existing partnerships at upgrade: once the storage migration reaches `done` (or at boot if it already has), a backfill is queued once per existing partnership, tracked in `partner_backfill`
- [ ] Commit.

### Task 10: Propagation (spec §4.6)

**Files:** `JobName.PartnerPropagate`; event listeners on asset/exif/tag/album updates; edit paths in `asset.service.ts`, `tag.service.ts`, `album.service.ts` call `markOverridden` in the same transaction when the editing user owns a row with an origin.

- [ ] Failing tests:
  - A edits a description → B's unedited copy updates, and C's copy of B's copy updates
  - after B edits the description, A's next edit doesn't reach B, but A's location edit still does
  - favorites and trash are never propagated
  - A's new upload → copied to following partners transitively
  - Review Focus 4: A↔B, B→C, C→A plus C's independent upload → one copy per library, and the job terminates
- [ ] Commit.

### Task 11: Albums + retire partner access (spec §4.4, §4.8)

**Files:**

- `partner-copy.service.ts`: `copyAlbum` for albums A owns only; membership follows
- `server/src/repositories/access.repository.ts`: remove partner asset access
- Timeline/search/map repositories and services: remove `withPartners` partner inclusion
- Sync stream partner types: emit nothing
- `partner.dto.ts`: drop `inTimeline`/`shareLocation` from create/update/response

**Steps:**

- [ ] Failing tests:
  - A's album is copied, and adding/removing an asset in A's album mirrors it in B's while membership is followed
  - B's own album edit stops following
  - shared albums/Spaces are not copied
  - B's timeline no longer includes A's rows (no double display)
  - B cannot read A's asset by id through partner access
- [ ] Regenerate the SDK. Fix the web compile errors from the removed fields (remove the toggles from the partner settings UI).
- [ ] Commit.
- [ ] **Hand-off:** `SendMessage` to `partner-people-locked` with branch + sha. Report to the lead.

## Workstream P2: partner-people-locked (agent `partner-people-locked`)

Start with prototype work for Task 14, which has no dependency. Rebase onto `partner-core`'s branch when it messages you.

### Task 12: Universal people (spec §4.5)

**Files:** `partner-copy.service.ts` (`mapPeople`), `person.service.ts` (edits call `markOverridden` with `name|birthDate|cover|hidden|favorite`), and the correction-history writer for auto-merges.

- [ ] Failing tests:
  - A's person whose faces match B's person above the recognition threshold → B's faces map to B's person, and an auto-merge correction-history entry is created with working undo
  - no match → a new B person with `person_origin`
  - A renames → B follows until B renames
  - B changes the cover → A is unaffected
- [ ] Commit.

### Task 13: Locked sharing (spec §4.9)

**Files:** `partner-copy.service.ts` (remove the Task 9 skip; copy `visibility`/sensitive and Locked tag/person rules through tags/people); the notice when B has no PIN (server flag + web banner); remove the FL-137 blanked-metadata partner sync path.

- [ ] Failing tests:
  - A's locked asset → B's copy is locked and only visible with B's elevated session (B's PIN)
  - B has no PIN → the item is hidden and the notice flag is set
  - A unlocks → B's followed copy unlocks
  - B's override stops following
- [ ] Commit.

### Task 14: Partner UI (spec §5.2)

**Files:**

- prototype `SharingAccess.jsx`: card with what's shared + backfill progress, toggles removed
- prototype album card + info panel: "From {rootOwner}'s library" icon
- Svelte equivalents: partner settings, album card, asset detail panel
- server: `AlbumResponseDto.origin?` and `AssetResponseDto.origin?` `{ rootOwnerId, rootOwnerName }`, and partner `backfill { state, total, done }`

**Steps:**

- [ ] Failing web + server DTO tests.
- [ ] Implement, regenerate the SDK, run check:svelte/typescript/prettier.
- [ ] Commit, report to the lead.

## Integration (lead session)

1. Merge `storage-core` → `storage-migration` → `partner-core` → `partner-people-locked` branches into `aj/partner-sharing-metadata-dedup-3bb4d8`, resolving conflicts.
2. Full checks: server tsc + full unit suite, the touched medium specs, and web check:svelte/check:typescript/vitest/lint.
3. Whole-branch review (superpowers:requesting-code-review). Fix the findings.
4. Re-fetch `master/frameleaf-implementation`, merge it in, re-run the checks, and push to `master/frameleaf-implementation` in a single push (pushing cancels the in-flight CI). CI covers e2e.
