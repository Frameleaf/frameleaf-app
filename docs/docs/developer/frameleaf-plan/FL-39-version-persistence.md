# FL-39 edited video versions and publication

This packet adds the server persistence and API boundary for Save Version, master Export, and Revert. It continues the reviewed geometry change at `357453c747c96ac244b9252870354ed4a518dcd3` and incorporates the approved mobile-CI retirement at `a3b0cae7e785e31339353ad9b0a55cfb10d03f56` and its workflow-contract correction. The separate `65266cf4db954f8f516684b9d640cd1ef514a646` quality experiment remains an unpushed recovery checkpoint; its unsafe playback identity is not carried forward.

## Persistence and file ownership

Fork migration `0000000000100-VideoEditVersions` creates `immich_fork.video_edit_version` and `immich_fork.video_edit_selection`. Each version records the owning asset/user, original path and checksum, immutable recipe, purpose, status, and its master/proxy/thumbnail paths. Private composite foreign keys tie current/requested selections to a version of the same asset and owner. No foreign key attaches the private schema to public tables.

Recipe validation and rendering probe the original file for its timeline duration; the published `asset.duration` is display metadata and cannot limit a later save or restore.

The existing edit endpoint saves a recipe and requests a version within one database transaction. It leaves the last successfully published playback files in place while the new render runs. A render reads the original captured by the version, creates unique files for that attempt, and publishes only if the source identity and requested version still match. A stale or duplicate completion cannot overwrite current playback. Failed attempts retain the current selection and can retry their immutable recipe.

The current `EncodedVideo/isEdited` asset-file contract remains a playback proxy. The separate master is retained by the version record. Publication updates current selection, proxy/thumbnail projection, dimensions, duration and thumbnail hash atomically. It does not delete prior versions' files. Reverting to the original removes the edited projection and restores the original dimensions and thumbnail hash; restoring a prior saved recipe creates a new version derived from the original.

Pruning rejects requested/current versions. It removes an eligible version and queues only paths that have no remaining version or public-file reference. The shared deletion worker independently counts retained versions and handoff-archived version payloads, using its existing path-lock mechanism. Version publication takes those same path locks. Queue failure after pruning may leave unused files on disk; it cannot remove a retained file. Durable orphan reclamation is not introduced by this packet.

Permanent asset removal deletes its private selection/version records in the same transaction as the public asset and returns all retained derived paths to the reference-safe FileDelete queue. Library unlink removal queues these paths too; account asset teardown releases the same private references before its existing owner-folder cleanup. Another asset or version can still retain a shared path. Matching archived version records are removed on explicit asset deletion.

Writes take the fork-phase share lock and reject a running handoff or return reconciliation. Handoff orphan reconciliation archives selection rows before version rows. Archived master/source references continue to protect media from deletion.

## Callable API

All routes use existing asset permissions and additionally constrain history to the asset owner. Responses omit internal filesystem paths.

- `GET /assets/:id/edit-versions` lists versions, render status and explicit current/requested flags.
- `POST /assets/:id/edit-versions/export` with `{ "profile": "master" }` records and queues a separate export of the current successful recipe. It does not select the export for playback.
- `GET /assets/:id/edit-versions/:versionId/download` serves a ready retained master with private caching.
- `POST /assets/:id/edit-versions/:versionId/restore` applies the selected ready recipe as a new revert version.
- `DELETE /assets/:id/edit-versions/:versionId` prunes an unselected version with reference checks.

The OpenAPI specification and TypeScript client are generated from these controllers/DTOs. Mobile application work and mobile CI remain deferred/retired as directed.

## Master and proxy policy

The master uses software H.264 or HEVC, CRF 18 and the original raster independent of playback resolution, bitrate, hardware acceleration and tone-mapping settings. The policy preserves qualified YUV 4:2:0, 4:2:2 or 4:4:4 precision at 8/10/12 bits. Color intent is set on filter frames and validated from the rendered output. Unchanged audio is copied; edited audio does not force a stereo downmix. Dolby Vision and unsupported pixel formats fail closed before publication.

A playback proxy is generated from the validated master using configured playback policy. This packet does not qualify hardware proxy fallback, every HDR codec/device combination, or photographic correctness of every existing effect on HDR material. Metadata-only rotation, configurable export profiles, and end-to-end deployment acceptance remain open FL-39 work. This document is not an issue-completion claim.

## Local evidence

Validation uses disposable synthetic media and isolated PostgreSQL Testcontainers; it does not touch a user library.

- Focused unit suites cover existing editing/playback behavior, master/proxy separation, stale-render cleanup, API access and master downloads, quality rejection and catalog locking.
- PostgreSQL tests cover migration up/down and exact private catalog, original identity guards, concurrent saves, compare-and-swap publication, failed-attempt retry, independent exports, current/requested flags, pruning, shared deletion protection and archived references. Regression tests exercise permanent deletion with another asset retaining a master, account teardown, and restoring a 20-second version after publishing a 5-second edit of a 30-second original.
- Existing physical-file and fork return/migration-ledger suites run alongside the new persistence tests.
- Six real FFmpeg 8.1.1 outputs verify 4K rotation under low playback targets, even crop geometry, 10-bit PQ color/raster preservation and 5.1 audio copy/edit behavior. Copied AAC packets match their source hashes. These fixtures validate master output, not all playback hardware paths.
- SQL generation runs against a disposable database in the same public-schema-only shape used by the schema-reset CI stage. Only the expected asset-edit query artifact changes.

Independent exact-candidate review and remote CI remain distinct gates. No merge or deployment is authorized by this document.


## Web version controls follow-on

The existing quick video editor now labels its save action **Save version**. Saving queues the immutable recipe and closes the editor with an accurate queued notification; it does not mistake an asset-only completion event from a separate export for completion of that save. The current successfully rendered video remains available while rendering runs.

A compact Versions section lists current, pending, failed and ready history. **Export master** queues a separate export of the current saved recipe and is unavailable while there are unsaved edits or a requested render/export in progress. A ready master downloads through the authenticated streaming endpoint without buffering the entire video in browser memory. Exports never select a new playback version. Manual refresh and asset-scoped completion events update the list; no background polling loop is introduced.

**Revert to original** and **Restore** of ready saved history call the corresponding server endpoints. Restoring confirms before discarding a dirty local draft. An unsuccessful history request disables mutations and exposes a retry through Refresh. Unmounting releases the event subscription and ignores obsolete list responses.

This packet connects the existing editor to the reviewed persistence API; it does not replace the original design or claim full Studio implementation. The original-metadata follow-on described below replaces the displayed-asset bounds for new trim/crop composition. Restoring an existing longer historical recipe already works through the server endpoint. Browser/device visual qualification, localization beyond English and deployed end-to-end acceptance remain open. Native applications remain deferred.

Focused component tests cover queued save/close behavior, export versus restore separation, unsaved/pending export guards, history restoration, dirty-draft cancellation, read-error recovery and event subscription ownership. Web TypeScript, Svelte diagnostics and changed-file lint are checked independently. The generated SDK enum-number shift is reflected in the existing image-enrichment fixture. The approved OpenAPI CI command correction from `83100cdaa` is applied as the exact two-file patch so mobile Dart generation remains retired without importing unrelated FL-41 changes.


### Completion after editor close

Review of web candidate `17a843e52765c598d1b9c13b2c1e45bc6c36337b` found that the editor-owned history listener disappeared on queued close, leaving the main viewer on its pre-publication asset response. The correction keeps queued close and emits the existing application-wide `on_asset_update` notification when a ready save or revert finishes. Its payload is the actual current asset projection. The global websocket subscriber already forwards this to the matching viewer and invalidates the shared asset cache; neither depends on the editor remaining mounted.

Export-only, stale pending and removed versions retain history notification behavior but do not emit a playback update. No new websocket contract, polling loop, or native-client change is needed. Job-service regressions cover publication gating. Viewer regressions close and unmount the editor before delivering the global socket event, then verify both the matching viewer callback and a fresh cache read for edited/original states; an unrelated asset event cannot update that viewer. The focused result is 37 job tests and 16 web tests passing, with one pre-existing skipped favorite-action test. Server/web TypeScript and changed-file lint pass. Independent re-review and hosted CI remain pending.


## Original metadata bounds follow-on

This bounded continuation starts from reviewed web candidate `48020f438e1430e89326534689aace4ab329021b`. The edit-read response now includes optional `originalVideo` width, height and duration in milliseconds for video assets. These bounds come from probing the asset's original path, with quarter-turn display orientation matching the render pipeline. The same metadata authority validates video crop and timeline recipes at save time; image behavior and all master/proxy/export identities remain unchanged.

The web editor waits for valid original bounds before initializing the saved recipe. It no longer clamps a stored crop or timeline to the current edited asset's dimensions/duration. Missing or invalid original metadata, or an unsuccessful read, displays an actionable error and disables save and version mutations. The save handler also rejects keyboard submission while metadata is unavailable. It does not guess bounds from the current render.

A component regression begins with a 640×360, five-second edited asset and its saved crop/trim recipe, then composes a 25-second trim and portrait crop against the original 1920×1080, 30-second bounds. Server tests verify rotated original dimensions and reject missing streams, invalid duration and invalid raster. An existing PostgreSQL regression is extended to read original bounds after shorter publication and save a larger crop/longer trim; this run remains **unverified** because the local Docker daemon socket was unavailable. No container-runtime changes were made. Local focused results are 70 asset-service tests and 15 editor/history tests passing; server/web TypeScript and Svelte diagnostics are checked separately. OpenAPI and TypeScript clients are regenerated; native/mobile generation remains deferred.

This is a local review candidate. The prior persistence and web-control mirrors remain historical receipts at their exact source hashes; this continuation needs its own mirror and independent review. No GitHub publication, merge, deployment or full FL-39 completion is claimed.
