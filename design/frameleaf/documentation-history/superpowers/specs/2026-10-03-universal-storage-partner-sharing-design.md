# Universal Storage and Partner Sharing v2 — Design

Date: 2026-10-03 · Status: approved in brainstorming, awaiting written-spec review · Base: `master/frameleaf-implementation` @ 1c06ddf2df

## 1. Goal

Two linked changes:

1. **Universal storage (system-wide, independent of partners).** The server stores one file per content hash. Every library that holds that content points at the same file. Storage is server-level, not account-level (the GFS model). A file only leaves disk when no library references it _and_ an admin empties it from the file trash.
2. **Partner sharing v2.** Partner A → B shares, one way, A's assets, A-owned albums, tags, people, descriptions and locked items. B receives **their own copies**. These are ordinary B-owned rows that are indistinguishable in B's library. B can edit, favorite, album and delete them without affecting A. This restores the pre-Frameleaf fork behavior, including "Universal people" from the Noodle Gallery fork.

## 2. Owner decisions (2026-10-03)

| Topic              | Decision                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage scope      | One file per hash, server-wide, for every upload. On by default. It doesn't depend on partner sharing.                                                                                               |
| Last copy          | When nothing references a file, the original goes to a **file trash in Library Care**. Only an admin can delete it permanently.                                                                      |
| Sync model         | **Live until edited.** B's copy follows A's copy until B edits a given field or item. From then on that piece is B's.                                                                                |
| A deletes          | B keeps their copy.                                                                                                                                                                                  |
| A stops sharing    | B keeps everything already received. Following and new copies stop.                                                                                                                                  |
| Transitive         | A→B→C: C receives everything in B's library, including B's copies of A's items.                                                                                                                      |
| Loops / duplicates | **One copy per library.** An item is never added to a library that already holds the same content. A↔B mutual shares never show A's own items back to A.                                             |
| Re-upload by A     | Duplicate checks are **per library**. If A's copy is in trash, it's restored. If A's copy was purged, A gets a new asset linked to the existing file and a normal success response, not "duplicate". |
| Quota              | Every library is charged the full file size. Dedup savings only show up as server disk space.                                                                                                        |
| People             | Matching people are auto-merged by face similarity (recognition threshold). Undo is via correction history. B can fully edit imported people (name, cover photo, …).                                 |
| Location           | Always shared. The FL-146 `shareLocation` toggle is removed.                                                                                                                                         |
| Timeline toggle    | `inTimeline` is removed. Shared items are part of B's library.                                                                                                                                       |
| Locked             | Locked state is copied metadata: Locked folder, sensitive flag, and Locked tag/person rules. B's own PIN unlocks it. If B has no PIN, the items stay hidden until B sets one.                        |
| Partner indicator  | A small "from partner" icon on copied albums and in the info panel.                                                                                                                                  |
| Upgrade migration  | A step in the first-run **Getting Ready** wizard, with a meaningful progress bar so the admin lets it finish.                                                                                        |

### Superseded decisions

- **FL-137 (2026-09-29), "partner sync keeps sending Locked items marked `locked` with metadata blanked":** replaced by copied locked state behind B's PIN.
- **FL-146 `shareLocation`:** removed.
- **Master-user physical deduplication** (`physicalDeduplication.enabled` / `masterUserId`, plan/apply screens): replaced by universal storage. Its history and verification views move to Library Care.

## 3. Part 1: Universal storage

### 3.1 What already exists (integration branch)

- `physical_file` (`schema/tables/physical-file.table.ts`) has `type` (original | thumbnail | preview | fullsize | encoded_video), `checksum`, `sizeInBytes`, a unique `path`, and `canonicalAssetId`. It is referenced by `asset.physicalOriginalFileId` and `asset_file.physicalFileId`.
- `deleteUnreferencedPath` (`physical-file.repository.ts:1199`) counts references across assets, asset files, versions and fork mappings while holding the path lock. FileDelete, asset delete, trash empty, user delete, upload cleanup and thumbnail regeneration already route through it.
- `saveMovedPath` (`asset.repository.ts:1890`) repoints every row that names a moved path.
- Upload linking exists (`asset-media.service.ts:674-698`), but only against a configured master user.

### 3.2 Rules

- **Unit of sharing:** originals and generated files (thumbnail, preview, fullsize, encoded_video), matched on SHA-256 plus size.
- **Never shared:**
  - External-library files. They stay where their library put them and are never linked or moved.
  - Sidecars (XMP). They are per-asset owner metadata.
- **Primary asset (`canonicalAssetId`):** the file lives at the path its primary asset's storage template produces. If the primary asset is deleted, the oldest remaining referencing asset becomes primary, and a storage-template move is queued so the file follows its new owner. Today `canonicalAssetId` is just cleared.

### 3.3 Upload

1. Hash the incoming file, as today.
2. Same content already in **this** library:
   - live → the usual duplicate response
   - in trash → restore it
3. Same content anywhere **else on the server**, including the file trash:
   - link the new asset to the existing `physical_file`
   - delete the temp upload
   - pull the file out of the file trash if it was there
   - return a normal success response
4. Otherwise, store the file as today and register a `physical_file` with the new asset as primary.

Remove the master-user check. `getMasterOriginalCandidate` becomes "any active, non-external original with the same checksum and size, lowest asset id first".

### 3.4 Storage jobs

| Job                                                                              | Change                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage-template migration (`storage-template.service.ts:307-346`)               | Unchanged: only the primary asset moves the file, and every row follows. **Fix:** non-primary assets currently move their sidecar to `${newPath}.xmp`. They must move it to their own template path instead.                       |
| Generated-file migration (`storage.core.ts:182-201`, via `media.service.ts:262`) | **Add the primary-only check.** A non-primary asset must not move a shared derivative into its own owner's folder.                                                                                                                 |
| Thumbnail regeneration (`media.service.ts:2557-2642`)                            | Already swaps to the canonical file. Keep it, and add a test.                                                                                                                                                                      |
| `copySidecar` (`asset.service.ts:553-575`)                                       | **Fix:** for a non-primary target, `${originalPath}.xmp` resolves to the primary owner's sidecar. Write to `upload/<owner>/<assetId>.xmp` instead, the same as `metadata.service.ts:577-600`.                                      |
| Integrity cleanup (`integrity.service.ts:250, 871`)                              | **Fix:** route deletes through the reference-counted guard instead of `getTrackedPaths`.                                                                                                                                           |
| FileDelete (`storage.service.ts:140-170`)                                        | When the reference count reaches zero: an **original** moves to the file trash (§3.5); **generated** files are deleted outright.                                                                                                   |
| Fork storage normalization                                                       | No change in normal mode (it verifies in place).                                                                                                                                                                                   |
| Return to upstream                                                               | The existing split gives each non-primary asset its own copy (hardlink, then reflink, then full copy). **Add a free-space pre-check** that refuses with the bytes required, because universal sharing makes the split much larger. |
| Media health / backup restore                                                    | Audit them during implementation. Any unlink or move must go through the reference-counted guard.                                                                                                                                  |

### 3.5 File trash (Library Care)

- Location: `<media>/file-trash/<physicalFileId>/<original filename>`.
- New fork table `immich_fork.physical_file_trash`:
  - `physicalFileId`, `path`, `checksum`, `sizeInBytes`
  - `lastOwnerId`, `lastAssetId`, `trashedAt`
- The move uses the existing path lock and publish-via-temp pattern.
- Admin actions in **Library Care → File trash**:
  - list (size, last owner, date) with the total size held
  - **Restore**: re-imports the file as a new asset for the last owner, with metadata re-read from the file
  - **Delete permanently**: confirmation dialog
- A re-upload or partner copy of trashed content takes the file back out of the trash (§3.3).
- Never deleted automatically.

### 3.6 One-time upgrade migration

- Reuses the existing plan/apply worker (`physical-deduplication-plan.service.ts`), but with no master user. The oldest asset in each hash and size group becomes primary.
- Duplicate copies go to the **file trash**, not deletion.
- Checkpointed after each batch and resumable after a restart.
- Runs automatically after the fork schema starts, and is surfaced in Getting Ready (§5.1).
- Files that can't be read or verified are skipped and listed, never linked.
- **Relinking missing originals.** When the "checking files" stage finds an asset whose original is missing on disk, it attempts a relink:
  1. **In-group copy:** another non-external asset with the same checksum and size has a verified file on disk. Link the missing asset to that `physical_file`. Under universal storage this is simply the normal link.
  2. **Search managed storage:** otherwise, run the FL-69 media-health managed-storage locate (`locateManagedCandidates`) for that checksum. Exactly one verified exact match → register it as a `physical_file` and link it, re-reading the file to confirm the checksum, the same as `relinkOne`.
  3. **Otherwise:** zero matches or several conflicting candidates → leave it unlinked and record a media-health Missing finding (with candidates, if any) for review in Library Care. Never guess.
  - Only exact checksum and size matches are ever relinked automatically. External-library assets go to step 3 and are never relinked from managed storage.
  - Every automatic relink is recorded in media-health history and can be reviewed there.

## 4. Part 2: Partner sharing v2

### 4.1 Approach

**Changes are pushed forward when they happen (write-time propagation).**

- B's copies are ordinary B-owned rows, so every existing query (timeline, search, map, People, Studio, albums) works unchanged.
- Each copy records its source and the fields its owner has changed.
- When the source changes, a job pushes the change to the copy, skipping any field the copy's owner has changed.

Rejected alternatives:

- **Read-time inheritance:** every query would need to look up the original, which means hundreds of query changes and slower reads.
- **An overlay on A's rows:** it can't satisfy "B keeps the copy after A deletes", and A→B→C becomes messy.

### 4.2 Data model (new `immich_fork` tables)

- `asset_origin`
  - `assetId` (PK, B's copy) and `sourceAssetId` (FK, set null on delete)
  - `rootOwnerId`: the original uploader, used for the icon label
  - `partnerSharedById`
  - `overriddenFields text[]`
  - `following boolean`
- `album_origin`
  - `albumId`, `sourceAlbumId`, `rootOwnerId`, `partnerSharedById`
  - `overriddenFields text[]`: `title`, `description`, `membership`, `cover`
  - `following`
- `person_origin`
  - `personId`, `sourcePersonId`, `rootOwnerId`, `partnerSharedById`
  - `overriddenFields text[]`: `name`, `birthDate`, `cover`, `hidden`, `favorite`, …
  - `following`
- `partner` gains `backfillCursor`, `backfillState`, and `backfillTotal`/`backfillDone` for progress.
- `partner` drops `inTimeline` and `shareLocation`. Keep the columns but stop reading them until the next fork-schema cleanup; the API stops exposing them.

**Tracked asset fields:**

- `description`, `location` (latitude/longitude/city/state/country), `dateTimeOriginal`/timezone, `rating`
- `tags` (the whole set)
- `faces` (the whole set)
- `visibility` (locked/archive/timeline), `sensitive`
- `isFavorite` and trash are **always B's**. They are never copied after the first copy and never followed.

**Fork-schema obligations:** new migrations mean updating `fork-v2-catalog.json` and the migration-ledgers spec, and making sure the return-to-upstream flow drops these tables cleanly. See the fork-schema catalog certification memory.

### 4.3 Copying an asset to B

For one source asset S into library L:

1. **One-copy rule.** Skip if L already holds content with S's checksum, whether live or trashed, or if L's owner is S's `rootOwnerId`.
2. Create a B-owned `asset` pointing at S's `physical_file` (original and generated files).
3. Copy B-side rows from S, with no ML re-run:
   - exif
   - smart-search embedding and OCR
   - faces, with embeddings, mapped to L's people (§4.5)
   - tags, matched by name, reusing L's existing tag with that name (09-27 decision)
   - visibility and sensitive state
4. Insert `asset_origin` with `following = true`.
5. **Quota:** charged at full size. Copying never fails because of quota. If L is over quota, L's own new uploads are blocked, which is the existing over-quota behavior.

### 4.4 Albums

- Only albums **A owns** are copied. Shared albums and Spaces that B can already see are left alone, so they never show up twice.
- B's album copy follows A's title, description, cover and membership until B edits that field.
- **Membership following:**
  - an asset added to A's album → B's copy of it is added to B's album
  - removed → removed from B's album
- Once B adds or removes something in the album themselves, `membership` counts as changed and stops following.

### 4.5 People ("Universal people")

- For each of A's people with faces in copied assets, look for B's person by face similarity, using the same threshold recognition uses.
  - **Match:** map A's person to B's person and log the auto-merge in correction history, which has undo.
  - **No match:** create B's person with `person_origin`.
- B can edit everything: name, cover photo, birth date, hidden, merge and split. Each edit adds that field to `overriddenFields`.
- A renaming the person updates B's person only while `name` is still being followed.

### 4.6 Following a source (propagation)

- Fired by asset, album and person update events on rows that have downstream copies (any `*_origin.source* = id` where `following`).
- Job `PartnerPropagate { kind, sourceId, fields }`:
  - writes the non-overridden fields to each following copy
  - then re-queues for that copy's own followers (A→B→C)
  - is idempotent and batched per source
- **Edits by the copy's owner:** the update service adds the touched field to `overriddenFields` in the same transaction as the edit.
- **New assets/albums from A:** queued as copies to every partner of A that is following, and onward through each of those partners.
- **Source deleted:** `sourceAssetId` is set to null, and the copy stays and keeps its last values. The trash and purge of the copy are B's own.

### 4.7 Partnership lifecycle

- **Create:** queue `PartnerBackfill { sharedById, sharedWithId }`. It works in batches by asset id cursor:
  - assets first, then albums, then people merging
  - progress is shown on the partner card
  - resumes after a restart
- **Remove:** stop the backfill, set `following = false` on every origin row where `partnerSharedById` is A and the copy is owned by B, and stop new copies. B keeps everything.
- **Existing partnerships at upgrade:** run the backfill once after the storage migration.

### 4.8 Retiring partner-based access

Every item B sees is now B's own row, so:

- Partner-based asset access checks in `access.repository.ts` are removed. B never reads A's rows.
- Timeline, search and map inclusion of partners (`withPartners`, partner timeline buckets) is removed. **This is required to avoid showing A's item and B's copy twice.**
- Partner sync stream types (partner assets, exif, faces, deletes) stop emitting rows. The endpoints stay so older clients keep working. B's copies arrive through B's own asset streams.
- Native apps regenerate from OpenAPI. Clients drop the partner toggles.

### 4.9 Locked items

- Copied locked state: the Locked folder (`visibility = locked`), the sensitive flag, and Locked tag/person rules through the copied tags and people.
- B's Locked view and B's PIN gate them like any of B's own locked items.
- If B has no PIN, the items stay hidden and B gets a one-time notice offering to set one.
- A locking or unlocking later carries through while `visibility`/`sensitive` is still being followed.

## 5. UI

Screens go into `design/frameleaf/template` first, since the prototype is authoritative. They're new screens, so the hash-locked READMEs aren't touched. Production follows.

### 5.1 Getting Ready: "Combining duplicate files"

- Placed after the FL-295 safety backup on the first start of an Immich-created library. Fresh installs skip it.
- **Progress in stages, each showing X of Y:**
  - checking files
  - relinking missing files (shows "N relinked, M to review")
  - linking duplicate groups
  - moving extra copies to the file trash
- Also shows space freed so far and an estimated time left from the measured rate.
- Resumable. Reopening the app returns to this step.
- No Continue button until it finishes. A secondary "Run in background instead" link opens a confirmation explaining that the extra copies aren't freed until it completes. Progress then shows in Library Care.
- Ends either "Done" or "Finished with N files to review in Library Care".

### 5.2 Partner sharing

- **Partner card:**
  - drops the timeline and location toggles
  - lists what's shared (photos, albums, tags, people, descriptions, locked items)
  - shows backfill progress
- **"From partner" icon:**
  - on copied album cards
  - in the info panel details as "From {rootOwner}'s library"
  - It stays after edits, because it records where the item came from.
- **People:** imported people look native. Auto-merges are listed in correction history with undo.

### 5.3 Library Care

- **File trash:** list, total size, Restore, Delete permanently (admin only).
- **Storage migration status** and the dedup history and verification views, moved here from the retired master-user screens.

## 6. Error handling

- **Never unlink on a mismatch:** linking requires a checksum and size match, and the target file must exist on disk. This is the existing guard in the dedup worker.
- **Concurrency:**
  - Every file move or trash operation takes the path lock and the row lock (`assetRepository.moveFile`).
  - Propagation and backfill jobs are idempotent, keyed on `(sourceId, targetLibrary)`.
- **Races:** if two uploads of the same new content arrive at once, the unique `physical_file.path` plus a per-checksum advisory lock serialize them.
- **Return to upstream:** refused up front if there isn't enough disk space for the split.

## 7. Testing

- **Server unit tests:**
  - upload linking: same library live/trashed, another library, file trash
  - primary-asset handover and re-storage
  - each fixed storage path: sidecar move, generated-file migration, `copySidecar`, integrity
  - the reference-count guard on every delete path
  - propagation skipping changed fields
  - the one-copy rule on A↔B and A→B→C→A
  - people auto-merge and undo
  - locked copy with and without a PIN
- **Medium tests (Postgres):**
  - the upgrade migration on a seeded library: run, interrupt, resume
  - missing-original relink: in-group copy, single managed-storage match, several candidates → finding, external never relinked
  - file trash restore and purge
  - return to upstream, including the free-space refusal
  - fork catalog and ledger certification
- **E2E:**
  - A shares → B sees the items
  - B edits → A unchanged
  - A edits → B's unedited copy follows
  - A deletes → B keeps
  - A re-uploads → linked, not "duplicate"
  - unshare → B keeps
  - locked items behind B's PIN
- **Web:** Getting Ready step states, partner card, the "from partner" icon, Library Care file trash.

## 8. Suggested build order

1. Universal storage: upload linking, primary-asset handover, storage-job fixes, file trash.
2. Upgrade migration and the Getting Ready step.
3. Origin tables, the copy engine, backfill and propagation for assets and tags. This step also retires partner access and timeline/search/map inclusion (§4.8) in the same change, otherwise A's items appear twice. Locked items are skipped until step 6.
4. Albums.
5. Universal people.
6. Locked sharing.
7. Partner card and toggle removal, the "from partner" icons, and sync-stream cleanup.

Each step can ship on its own behind the previous ones.

## 9. Defaults chosen (not explicitly asked)

- Favorites and trash state are always per library and never followed.
- Generated files are deleted when unreferenced. Only originals use the file trash.
- Copying ignores quota. Over-quota only blocks the recipient's own uploads.
- Partner sync endpoints stay for compatibility and return no partner rows.
