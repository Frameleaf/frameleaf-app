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
