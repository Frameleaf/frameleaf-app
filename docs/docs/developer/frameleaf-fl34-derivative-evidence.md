---
title: FL-34 derivative source authorization evidence
---

# FL-34 derivative source authorization

[FL-34](https://heroit.atlassian.net/browse/FL-34) remains In Progress. This local continuation is based on reviewed Locked candidate `aabef632a6f1b1c5390a86a6a4cae265e634778e`. Mobile implementation remains deferred. No GitHub, merge or deployment evidence is claimed for this packet.

## Defect and correction

An asset-file ID remembered while elevated could retrieve derivative metadata, download its file or delete it after the source asset became sensitive and the session locked. The source-keyed search correctly denied the same request. `AssetFileAccess.checkOwnerAccess` joined the source asset but checked only ownership and legacy Locked visibility; it omitted current hidden-content restrictions.

The existing asset-file Read, Download and Delete permission branches now forward the authenticated privacy context to that same owner query. The query applies the existing source hidden-content predicate, including authoritative sensitive classification, tag/person rules, legacy classification before cutover and fail-closed missing active privacy rows. It preserves owner-only access and legacy Locked elevation. No file paths, album membership, asset visibility or classifications are changed by authorization.

## Local PostgreSQL regression evidence

`server/test/medium/specs/services/asset-file-privacy.service.spec.ts` exercises the production service, access repository and asset-file repository against disposable PostgreSQL databases. Only job dispatch and logging are mocked. The unchanged baseline produced **six failures and four passes**; the corrected implementation passes **all ten cases**.

Coverage includes remembered file IDs for Read/Download/Delete after source classification and lock; elevated owner read/download/delete for ordinary and edited previews; hiding-disabled compatibility; legacy Locked denial; foreign administrators with partner and shared-album relationships; public shared links; missing active privacy rows; tag/person suppression; and pre-cutover legacy source classification. Denied deletes retain the file row and never queue file deletion. These tests authorize synthetic paths; they do not read or delete physical media.

Server TypeScript `tsc --noEmit` and ESLint on both modified production files and the regression file pass. This is local regression evidence, not Actions or deployed browser qualification.

## Source relationship audit and remaining boundary

The reviewed combined checkout `805ab4c36f64348c3bcec59e23b62b9ff48388f7` was inspected read-only. `asset_file.assetId` binds ordinary and edited files to the current source. Existing original downloads, thumbnails and video playback authorize source IDs. Saved video-version downloads authorize the source and bind stored versions to owner, source path and checksum. Existing video-version PostgreSQL coverage establishes publication and source-identity fencing, but does not establish every source-privacy transition through saved-version HTTP endpoints.

No independent cross-asset pixel-derived provenance relationship was found. The fork derived-results sidecars represent scoring, health and duplicate-frame results, not a general child-asset authorization graph. Therefore this packet closes the concrete asset-file bypass; it does not claim complete authorization coverage for a future independent derived-asset model. The historical `docs/library-privacy-audit.md` was absent and has not been invented or restored.

## Scope and review

Two existing production symbols change: `AssetFileAccess.checkOwnerAccess` and `checkOtherAccess`. GitNexus upstream impact reported LOW for each: one direct caller each, three and two total upstream symbols respectively, with no indexed execution processes. The canonical index is older than the continuation; PostgreSQL behavior and source tracing supplement that graph. No API schemas, migrations, mobile code or shared delivery ledgers change. Independent exact-candidate privacy review remains required before integration or publication.

## Shared E2E diagnostic prerequisite

PR131 at `4dacf2af999d1795621cb5f1cbf1ce7f6de39458` encountered an ARM server/CLI E2E failure in run `35604085348`, job `106346849447`. Asset deletion event waits timed out before later requests received connection refusal. Existing Compose logs did not establish a container exit cause. The shared diagnostic change from FL-41 commit `82e588e1ffc243494f9750a50cd9241110b69c23` is integrated here without the unrelated FL-41 evidence document or runtime work.

The workflow now captures timestamped Compose logs and only container Name, State and RestartCount immediately after API/CLI tests, before maintenance can change state. A separate diagnostic file complements the later Compose logs. Collection runs after failure and does not weaken test outcomes. No full container configuration, environment or host/kernel inventory is collected. This is diagnostic instrumentation, not a server fix or evidence of OOM. The narrow contract verifies ordering, selected fields, artifact retention and continued absence of mobile CI.

## Delayed timeline mounting after privacy verification

Exact-head web job `106357086521` in run `35606264839` recorded three test failures before cancellation. Album content after reload and an authenticated shared-link album heading stayed hidden. The downloaded Playwright snapshots showed visible navigation controls but invisible timeline content. Timeline starts invisible and ordinarily reveals itself in `afterNavigate`; the root privacy gate can mount it after that event. The installed SvelteKit implementation registers the callback on mount without replaying a completed navigation.

Timeline now uses its existing scroll-target initialization when a routed instance mounts before receiving any navigation callback. This preserves the fail-closed root gate and invokes the same scroll restoration path before revealing content. A component regression fails on the unchanged baseline and passes with the fix. Chromium 151.0.7922.34 independently reproduced hidden versus visible computed visibility using the production Timeline component mounted after a delay with router callbacks stubbed; both runs had no page errors. This isolates late-mount behavior and is not full application qualification. All 14 existing privacy-guard tests still pass alongside the new regression.

The third recorded failure was a User Management assertion matching both the intended visible title and Svelte's live navigation announcer. Its existing text assertion now requires exact text, preserving the intended title check and accessibility announcement. No album/shared-link E2E expectations were weakened. Hosted E2E rerun remains required after independent review of this candidate.
