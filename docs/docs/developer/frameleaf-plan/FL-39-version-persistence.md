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

A playback proxy is generated from the validated master using configured playback policy. This packet does not qualify hardware proxy fallback, every HDR codec/device combination, or photographic correctness of every existing effect on HDR material. Metadata-only rotation, web Save Version/Export/Revert controls, configurable export profiles, and end-to-end deployment acceptance remain open FL-39 work. This document is not an issue-completion claim.

## Local evidence

Validation uses disposable synthetic media and isolated PostgreSQL Testcontainers; it does not touch a user library.

- Focused unit suites cover existing editing/playback behavior, master/proxy separation, stale-render cleanup, API access and master downloads, quality rejection and catalog locking.
- PostgreSQL tests cover migration up/down and exact private catalog, original identity guards, concurrent saves, compare-and-swap publication, failed-attempt retry, independent exports, current/requested flags, pruning, shared deletion protection and archived references. Regression tests exercise permanent deletion with another asset retaining a master, account teardown, and restoring a 20-second version after publishing a 5-second edit of a 30-second original.
- Existing physical-file and fork return/migration-ledger suites run alongside the new persistence tests.
- Six real FFmpeg 8.1.1 outputs verify 4K rotation under low playback targets, even crop geometry, 10-bit PQ color/raster preservation and 5.1 audio copy/edit behavior. Copied AAC packets match their source hashes. These fixtures validate master output, not all playback hardware paths.
- SQL generation runs against a disposable database in the same public-schema-only shape used by the schema-reset CI stage. Only the expected asset-edit query artifact changes.

Independent exact-candidate review and remote CI remain distinct gates. No merge or deployment is authorized by this document.
