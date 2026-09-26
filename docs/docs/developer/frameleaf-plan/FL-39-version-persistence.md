# FL-39 edited video versions and publication

## Shared authenticated UI fixture repair (FL-34 / FL-41, 2026-09-21)

PR133 head `7d004a138cf9633c8357ac71dcd741307fddce76` timed out in both web UI jobs at the asset-viewer thumbnail wait. The URL assertion was correct. The shared UI fixture mocked the authenticated cookie, user and preferences but omitted `GET /api/auth/status`; the production privacy guard therefore received an unauthorized response and correctly withheld protected content. The relevant guard, base fixture and thumbnail helper are byte-identical between that failed head and reviewed integration base `9a729f04e2103010c68615516be644bb503a6698`.

The fixture now supplies the typed non-elevated status of its synthetic signed-in user. No production guard, media URL, visibility assertion, retry count, timeout, API/schema, native application or image-build workflow changes. Manual caller tracing covers timeline, search, memory, direct asset-viewer tests and the shared asset-viewer fixture used by OCR, face, stack and broken-asset tests. GitNexus does not resolve these test-hook callback edges; its low indexed impact is not a zero-caller claim.

On the integration base, the original next-button test reproduced the exact 30-second timeout and asset URL before the repair, then passed in 2.6 seconds after it. Four unchanged next/previous button/keyboard navigation tests pass. Three browser regressions verify non-elevated status and a visible viewer, an unauthorized status retaining the hidden viewer, and absence of the authentication cookie redirecting to login. A request outside browser route interception still receives HTTP 401: the fixture does not create backend authority.

This bounded reproduction used fresh worktree-local frozen dependencies (Node 24.21.0, pnpm 11.24.0), Chromium, the real Vite application and existing synthetic UI routes, with an isolated localhost HTTP 401 responder for unmocked requests. It is fixture/guard/navigation evidence, not a fresh production server or full 104-test CI run. The original CI head was compared at the relevant source boundary, not rebuilt as a second complete application. Prior authenticated video lifecycle evidence and its HDR, hardware/device, native and deployment limits remain unchanged. No GitHub rerun, push or polling was performed for this repair.

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

Except for the qualified metadata-only rotation path below, the master uses software H.264 or HEVC, CRF 18 and the original raster independent of playback resolution, bitrate, hardware acceleration and tone-mapping settings. The policy preserves qualified YUV 4:2:0, 4:2:2 or 4:4:4 precision at 8/10/12 bits. Color intent is set on filter frames and validated from the rendered output. Unchanged audio is copied; edited audio does not force a stereo downmix. Dolby Vision and unsupported pixel formats fail closed before publication.

A playback proxy is generated from the validated master using configured playback policy. This packet does not qualify hardware proxy fallback, every HDR codec/device combination, or photographic correctness of every existing effect on HDR material. Metadata-only rotation is qualified only for the constrained source matrix below. Configurable delivery export profiles belong to STU-306 (FL-105), rather than the explicit VID-101 (FL-39) acceptance. End-to-end deployment acceptance remains unqualified. This document is not an issue-completion claim.

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

A component regression begins with a 640×360, five-second edited asset and its saved crop/trim recipe, then composes a 25-second trim and portrait crop against the original 1920×1080, 30-second bounds. Server tests verify rotated original dimensions and reject missing streams, invalid duration and invalid raster. The PostgreSQL regression reads original bounds after shorter publication and saves a larger crop/longer trim. The delivery checkout passes this regression together with the cutover-evidence suite: 36 tests in two isolated PostgreSQL suites. The earlier unavailable-Docker validation gap is closed. Local focused results are 70 asset-service tests and 15 editor/history tests passing; server/web TypeScript and Svelte diagnostics are checked separately. OpenAPI and TypeScript clients are regenerated; native/mobile generation remains deferred.

This is a local review candidate. The prior persistence and web-control mirrors remain historical receipts at their exact source hashes; this continuation needs its own mirror and independent review. No GitHub publication, merge, deployment or full FL-39 completion is claimed.

## Metadata-only rotation follow-on

This bounded continuation starts from reviewed original-bounds candidate `6cd128decbd9ef66f6b43c195ac3bbb582882559`. A saved or exported recipe containing only one 90, 180 or 270 degree clockwise rotation now stream-copies eligible original video and audio packets into its unique private MP4 master. The source must be MP4/MOV with exactly one H.264 8-bit YUV 4:2:0 video stream, BT.709 or unspecified SDR color tags, no Dolby Vision, and at most one AAC audio stream. Admission also requires a freshly probed absence of an inherited display matrix and zero source rotation.

FFmpeg's counter-clockwise display rotation receives the opposite sign from the clockwise editor recipe. Validation checks the expected orientation, resulting display dimensions, source pixel format and color intent before proxy generation or publication. The existing default validator still requires baked outputs to have zero rotation. Every new revision reads the captured original, not a preceding master or playback proxy. The version transaction, source identity check, stale publication guard, reference retention, private download and cleanup boundaries are unchanged.

An inherited display matrix may contain reflection or shear that the existing scalar rotation probe does not describe. Such inputs deliberately retain the baked path, including metadata-oriented portraits. Physical portrait rasters and already-baked portrait originals qualify for copying. Crop, mixed recipes, multiple tracks, other containers/codecs, high precision and HDR retain the existing baked-master policy and its explicit Dolby/pixel-format rejection. A failed remux or validation fails the version and keeps the current selection; it does not silently claim a lossy retry is packet-preserving.

The playback proxy remains independently encoded from the validated master under playback resolution/codec/bitrate policy. Thumbnails use that same oriented master, and publication records display geometry rather than the unchanged coded raster. No playback setting caps the copied master.

### Reproducible local qualification

On September 21, 2026, macOS arm64 with Homebrew FFmpeg/ffprobe **8.1.1** and Apple clang **21.0.0** passed the following checks. Synthetic fixtures are created in isolated temporary directories and removed after the tests; no user media or database is involved.

```sh
cd server
FRAMELEAF_FFMPEG_QUALIFY=1 pnpm exec vitest run --config test/vitest.config.mjs src/utils/video-edit.spec.ts src/utils/video-edit.ffmpeg.spec.ts src/services/media.service.spec.ts
pnpm exec vitest run --config test/vitest.config.mjs src/repositories/media.repository.spec.ts
pnpm exec tsc --noEmit
```

The first command passes **248 tests**, including two opt-in real-media cases. The second passes **13 tests**. Changed-file ESLint and Prettier checks pass. The real-media cases exercise the production `MediaRepository.probe` and `transcode` methods and the production rotation plan:

- 3840×2160 H.264/AAC original, clockwise 90/180/270/90 recipes each derived anew from the original. Every selected video/audio packet has exactly equal SHA-256 payload hash, PTS, DTS and duration before and after remux. Decoded frame hashes equal the corresponding explicit clockwise transpose of the original, detecting sign mistakes and double rotation.
- Independent 480-pixel-short-side playback proxies bake rotation, report zero rotation metadata and retain the expected portrait/landscape aspect. Copied masters retain their 4K coded raster.
- A physically baked 200×300 portrait original rotates through metadata only, preserves packets and matches the reference decoded frames. A source carrying the resulting display matrix is rejected from copy admission.
- Unit guards retain mixed crop/rotate rendering and reject copying unqualified codec, HDR, audio, matrix and multitrack combinations. Version-publication regressions cover both copied and baked masters, rejected display geometry, stale publication cleanup, original source use and separate master/proxy identities.

The real-media tests are opt-in because the ordinary unit runner does not guarantee a native FFmpeg installation. They are reproducible qualification evidence, not a replacement for required hosted checks. The parent owns PostgreSQL and browser qualification; this packet does not repeat the full database suite. Hardware proxies, metadata-oriented-source packet copying, HDR packet copying, device/browser display compatibility and deployed end-to-end acceptance remain unqualified. Independent review is required before push; no push, merge or deployment is claimed.

### Rotated-master hardware proxy correction

Independent review of `a467bef673256c317dfc8cb7da83b630a3c6902d` found that NVENC, QSV, VAAPI and RKMPP hardware decoding disable FFmpeg autorotation. The version renderer now uses software decoding whenever its master has nonzero display rotation, while preserving the configured hardware encoder. Already-baked zero-rotation masters retain the existing hardware-decode policy. This applies to the shared proxy generation path for save and export.

The publication regression now spans software and all four supported hardware configurations, copied and baked masters, accepted/stale publication and invalid geometry. With clockwise 90-degree recipes it verifies portrait publication geometry, original-derived masters, enabled autorotation, absence of hardware decoding and preservation of each hardware encoder. Before the correction eight cases failed on `-noautorotate`; all 30 publication cases pass after the one-line policy change. The complete media-service suite passes **255 tests**, and changed-file ESLint, Prettier and server TypeScript pass. The earlier real-media packet/frame qualification remains unchanged. These are command-plan tests for hardware configurations, not physical GPU qualification; the same reviewer must recheck this correction before push.

## PR132 delivery integration

The delivery branch preserves the reviewed persistence, web controls, original-metadata bounds, metadata-only rotation and hardware-proxy correction through `fd9c4b7d39ca7b9ab3b551dc901288aa30808c2e`. It merges the current default `ad690ddaec4b47733fc84ea8d047849a6d490129` without rewriting those commits. Workflow/documentation conflicts retain the accepted contracts; no runtime-code conflict is introduced.

Exact-head failure logs for the older published `ba23d8d47449b85dcd80e1da0efbffe2cdc34afe` confirmed the already-corrected generated enum aliases and documentation source-path digest. They also exposed an obsolete cutover lock-count assertion. Migration 0100 adds exactly `immich_fork.video_edit_version` and `immich_fork.video_edit_selection`, so the assertion is updated from 98 to 100 while the exact sorted table-name equality remains intact. The focused delivery checks pass 36 PostgreSQL tests and 22 workflow/documentation contract tests. The strict source-path digest remains `03be7c7319ff60c700d0a12f855e2f7bb799486dfd86a57e94f06637e7b3ddbb`; its 517 anchors, 71 page receipts and validator are preserved.

Hosted checks on the updated PR head remain a separate publication gate. No merge or deployment is authorized or claimed, and the remaining qualification limitations above still apply.

## Multi-audio preservation admission

A multi-track original cannot safely use the current single-track baked-master pipeline. Save and export now fail the attempted version before rendering when the fresh original probe contains more than one audio stream. The current selection, original and all retained files remain untouched; no candidate paths are registered or deleted. Revert to the untouched original remains available because it requires no rendering. No implicit track selection, downmix, or track-dropping fallback is introduced.

The save and explicit-export service regressions both failed before this guard: rendering proceeded to a master probe. They now pass, and a positive regression preserves original reversion with multiple tracks. All 258 media-service tests and 10 isolated PostgreSQL version tests pass, including current-selection retention through a failed attempt. This bounded admission policy rejects all multiple-audio masters until preservation or an explicit selection contract is qualified; single-track codec compatibility and broader HDR/device/deployment qualification are unchanged. Independent exact-candidate review is required before push.

## Authenticated browser qualification and timeline-handle correction

This distinct receipt qualifies synthetic local browser-to-API-to-worker behavior. Server source `97688f7926f635c2aa7bebe139e80aa893e460d6` was freshly built with Node 24.21.0 and ran both API and microservices against new disposable PostgreSQL 14 VectorChord and Valkey 9 instances. The fixed browser source is `f774372537468e848d4ae15bd79a2c8accdc261d`, directly based on that server source with no server changes, served by Vite 8.2.2 and driven through Chromium. This is development-browser qualification, not a production web build or deployment claim. Only synthetic accounts and a generated 30-second 1280×720 SDR H.264/AAC video were used; playback resolution was configured to 480p.

The original browser run reproduced a pre-existing trim bug: dragging the end handle to two-thirds of the 30-second timeline submitted a 100 ms trim. `startTimelineDrag` measured the narrow handle instead of the track. The correction resolves the existing `.timeline-track` ancestor for trim, speed-segment and text-timing handles. Two coordinate regressions failed before correction; all 11 editor tests pass afterward, covering start/end movement, nonzero track offset and bounds. Existing test geometry now models the track separately from the handle. Changed-file ESLint, Prettier and web TypeScript pass. Independent reviewer `fl41` approved exact `f774372537468e848d4ae15bd79a2c8accdc261d` with no P0–P2 findings after tracing all pointer callers. That reviewer's separate Vitest attempt was blocked by local SDK `@oazapfts/runtime` resolution; it does not replace the owner's passing test evidence.

Actual browser actions on the fixed implementation saved a 20-second version, then a 5-second version, and restored the longer history entry. The viewer updated to 20 seconds without reloading. An additional run on the exact committed browser head submitted a 20-second recipe, closed the editor after queueing and reached a ready version through the worker. Browser Export master reached ready without replacing current selection, and the authenticated browser downloaded the retained master. Browser Revert restored original 30-second playback without reloading. Original SHA-256 remained identical to the generated input after these operations; retained masters were 1280×720 while separate playback proxies were 854×480.

Guest history and master-download requests were denied with 401. Another authenticated owner was denied history with 400 and master download with 404; no unauthorized history or media payload was returned. Pruning has no control in this editor, so its evidence is explicitly API-only: current/requested ready-version pruning was rejected, an unselected export was pruned and selection remained unchanged. Pending races and shared-reference retention retain their prior PostgreSQL evidence; this browser pass does not newly qualify those cases or imply a pruning UI.

Homebrew FFmpeg 8.1.1 lacked the WebP encoder and initially prevented thumbnail setup. Actual media commands subsequently ran through cached `immich-fork-roundtrip:local`, immutable image ID `sha256:f4e4c4993cbb2a1ff03b20755ad1f0627baf962b798be9e9df9dac38bdcc3f26`, using FFmpeg `7.1.4-Jellyfin` built with GCC 14 on Debian. The wrapper disabled container networking and mounted only the disposable fixture directory; native ffprobe inspected results. Cached image geodata initialized the real metadata worker. Nonfatal MJPEG range warnings occurred during thumbnail scoring; publication and the recorded lifecycle completed. No API responses or service hooks were mocked.

Reproducible drivers, red/green regression logs, sanitized JSON receipts, screenshots, container identity and the downloaded synthetic export are retained locally in `/Users/adamtaylor/.codex/worktrees/frameleaf-fl39-browser-evidence/`, with instructions in its `README.md`. Disposable session files and media were removed, named PostgreSQL/Valkey containers stopped and removed, owned API/worker/Vite processes stopped, and ports 12285, 13002, 15441 and 16391 verified free. No live user library, external deployment, GitHub operation or mobile implementation was part of this qualification.

Broad HDR fidelity, physical devices, cross-browser behavior, production deployment and native applications remain unqualified. Multi-audio/HDR fail-closed behavior was not exercised through this browser pass. This receipt does not mark the whole FL-39 issue complete or expand configurable delivery profiles beyond STU-306 / FL-105.
