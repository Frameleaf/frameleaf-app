# Implement iCloud Photos Web Sync with Health-Aware Recovery

Implement this feature in `adamtaylor152/immich`, on the current `fork/main` checkout. Deliver working backend, web UI, transport, migrations, deployment configuration, documentation, and tests—not only a design or scaffold.

## 1. Scope and non-negotiable behavior

Build a native, web-managed, one-way **iCloud Photos → Immich** synchronization feature using **Rclone's iCloud Photos implementation**. “Web” means configuration, authentication challenges, selection, progress, and recovery controls are in Immich's web app; server workers transfer the media. The browser must not relay library media or remain open for synchronization to continue.

This is **Rclone**, not rsync. Do not implement a Mac agent, PhotoKit/osxphotos exporter, mobile-app workflow, browser automation/scraping, FUSE-mounted cloud library, or destructive `rclone sync` folder mirror. Do not write back to or delete from iCloud.

Preserve original files, available current Apple-edited renditions, Live Photo components, RAW alternatives, album memberships, and nested album organization. Large libraries must synchronize incrementally and recover from restarts and expired authentication.

**Critical requirement: a checksum match is not sufficient to skip an import.** If the matching Immich asset is marked missing/corrupt, is offline, or its actual required file is missing/unreadable/damaged, use the validated staged iCloud resource to recover it. For managed assets, preserve the existing asset ID and relationships. Clear its applicable active missing/corrupt findings only after verified recovery. Never discard the only good staged copy because a broken database record has the same checksum.

## 2. Inspect the real fork before editing

Read applicable repository instructions and inspect current HEAD. These integration points were reviewed on September 18, 2026; recheck their current behavior rather than treating this prompt as an immutable API specification:

- `server/src/services/asset-media.service.ts`: `getUploadAssetIdByChecksum`, `bulkUploadCheck`, `uploadAsset`, `getPhysicalDeduplicationCandidate`, `ensureMasterPhysicalOriginal`.
- `server/src/dtos/asset-media.dto.ts`: upload DTOs and accepted checksum encodings.
- `server/src/services/media-health.service.ts`: `validateAssetIntegrity`, `validateReadableAssetIntegrity`, `validateImage`, `validateVideo`, `validateManagedCandidate`, `relinkMissing`, `handleDeleteCorrupt`, `queueRelinkJobs`.
- `server/src/repositories/media-health.repository.ts`: `getAssetChecksums`, `relinkManagedAsset`, `relinkExternalAsset`, `markResolvedCategories`, findings/candidates, and phase-aware writes.
- `server/src/dtos/media-health.dto.ts`, `server/src/utils/media-health.ts`, `server/src/schema/tables/asset-health.table.ts`, and the health/checksum enums in `server/src/enum.ts`.
- `server/src/repositories/physical-file.repository.ts`: canonical-master selection, physical-file associations, and normalization reservations.
- `server/src/repositories/fork-schema.repository.ts` and `server/src/repositories/fork-derived-results.ts`: checksum translation/recording and fork schema phases.
- `server/src/services/album.service.ts`: `create`, `update`, `addAssets`, `validateAndReparent`; inspect its repository and DTOs.
- `server/src/services/asset.service.ts`: metadata, Live Photo updates, `getAssetEdits`, `editAsset`; inspect `asset-edit.repository.ts`, editing DTOs, and derivative-generation consumers.
- `server/src/services/live-photo.service.ts`, `media.service.ts`, `physical-deduplication.service.ts`, `storage-template.service.ts`, and `server/src/utils/asset.util.ts`.
- `server/src/repositories/crypto.repository.ts`, `storage.repository.ts`, and `asset.repository.ts` for dual hashing, actual file operations, and checksum queries.
- Existing controller/repository/service registration, job definitions and queue registration, API generation, web settings/navigation, and neighboring tests. `server/src/services/index.ts` is one registration point.
- `README.md` and the fork/official switching documentation. Inspect any existing resumable server-import/migration implementation actually present in this checkout before inventing another framework.

Important existing-code traps:

1. `bulkUploadCheck` rejects matching stored checksums without establishing file health. Do not use it alone as the importer's final decision.
2. `uploadAsset` currently queues incoming files for deletion before its checksum-constraint duplicate return. Route recovery before that cleanup; handle concurrent duplicate races without deleting the recovery source.
3. `validateAssetIntegrity` currently returns `null` when the original is absent/unreadable as well as when no corruption is detected. **Null is not proof of existence or health.** Refactor/extract an explicit typed validator rather than calling private methods through casts.
4. `relinkManagedAsset` currently requires a Missing/Found finding and one approved candidate. It is a transactional pattern, not an existing generic “restore staged corruption” API. Do not fabricate candidate findings to force a new recovery through it.
5. External assets can use `ChecksumAlgorithm.sha1Path`; a 20-byte path hash is not a content SHA-1. Consult `checksumAlgorithm` and verified content sidecars, not digest length alone.
6. `getMasterOriginalCandidate` filters database state including `isOffline`, but that does not verify physical readability/content or corruption findings.
7. `editAsset` stores supported edit instructions and queues rendering. It is not an arbitrary Apple-rendered-file import endpoint. Do not invent fake edit operations to represent an imported rendition.

Preserve ordinary upload API compatibility and existing privacy rules. Add focused internal services/repository operations where needed instead of changing every client's duplicate protocol.

## 3. Transport: a pinned Rclone-derived service

Keep orchestration/domain logic in TypeScript. Implement a small Go bridge using a pinned, tested Rclone iCloud Photos implementation. The inspected baseline is Rclone `v1.75.1`; verify and pin the exact compatible version/commit used. Retain upstream license notices and document any minimal patch set.

Inspect these upstream sources:

- `backend/iclouddrive/icloudphotos.go`
- `backend/iclouddrive/api/photos.go` and `photos_test.go`
- Authentication/session code in `backend/iclouddrive/api/`
- https://rclone.org/iclouddrive/

Expose a narrow, versioned internal protocol for authentication, library/album inventory, paged resource enumeration, changes where supported, downloads, cancellation, and capabilities. Do not expose an unrestricted Rclone RC server or shell command execution to users.

Stock directory listings are not the domain model. Expose stable source library/zone IDs, asset IDs, master IDs and their relationship, resource roles/keys, resource revision/fingerprint where available, album IDs/parent IDs/memberships, and supported metadata. Do not assume `lsjson` supplies all these fields or infer identities from filenames. Extend the bridge at the upstream API layer when necessary.

The bridge must really perform authenticated iCloud operations; mocks are for tests, not the only implementation. Bound transport memory too: a streaming TypeScript consumer does not solve a Go implementation that first materializes the entire library.

Report capability gaps explicitly. Do not treat Shared Photo Library, Shared Albums, Smart Albums, sharing permissions, or every special Apple edit type as equivalent supported features. Import supported resources and surface unsupported cases without inventing data.

## 4. Authentication, ADP, and credential security

Implement web-managed Apple-account authentication, 2FA submission, and trusted-device/PCS approval handling. The direct connector must support ADP with iCloud web access enabled; it must not require disabling ADP or promise operation when Apple refuses web access. Do not substitute app-specific passwords or a fictional Photos OAuth grant.

Persist safe connection states such as connected, authenticating, awaiting-2FA, awaiting-device-approval, reauthentication-required, paused, and error. On expiry, stop repeated unauthorized requests, checkpoint work, notify the owner, and resume after successful reauthorization. Do not promise perpetual unattended authorization.

Encrypt retained credentials/session material at rest using a properly configured server secret/key; fail closed without required key configuration. Rclone-obscured configuration alone is not sufficient protection. Persist only what the connector needs, never 2FA codes. Use restricted per-connection cache/config permissions, authenticated internal transport, TLS for the web session, log redaction, and bounded authentication attempts.

Keep passwords, cookies, signed URLs, and tokens out of command arguments, browser persistence, job payloads, progress events, ordinary logs, and diagnostics exports. Jobs should carry connection/resource identifiers, not secrets. Disconnect must stop new work and remove local credential/session material without deleting imported media.

## 5. Persistent manifest and job architecture

Use the fork's database/repository and queue conventions. Put new feature-owned state in the appropriate fork-owned schema and preserve official/fork handoff compatibility. Respect migration/cutover locks and existing phase-aware health/checksum/physical-file writes. Do not move official plugin/workflow data or add unrelated public-table changes.

Persist connections, runs, source logical assets, resource versions, destination mappings, source albums, membership provenance, checkpoints, and recovery/commit state. These are conceptual entities; choose concrete names and normalized schemas to fit the repository.

Namespace source identity by owner, connection/account, and library/zone. Distinguish logical asset identity, resource identity/role, source revision, and local byte hashes. Store verified SHA-256 and content SHA-1 where needed, expected size, destination asset/resource IDs, retry state, and source metadata provenance. Never use filename or album path as the unique key.

Use database-backed idempotency and leases/locks. Commit enumerated records and their work durably before advancing a source change checkpoint. Track transfer completion separately. Apply album removals only after a complete authoritative membership snapshot, never after a failed page or expired session.

Support initial inventory, incremental source changes when available, periodic reconciliation, and explicit rescan. A newest-first scan that stops at the first existing photo is not sufficient: it misses edits and membership changes to old photos. Handle invalidated tokens and changes during enumeration without silently skipping records.

No iCloud deletion mirroring in this release. Record source disappearance but preserve destination media. Connection deletion must not delete imported assets. Album membership changes must not become asset deletions.

## 6. Staging and large-library behavior

Design and test for at least 500,000 logical assets, multiple resources per asset, many albums, and multi-terabyte libraries. This is a test target, not a claim that a live library was tested.

Use bounded paginated inventory, database joins/batches, configurable transfer concurrency, durable progress, and separate limits for network transfer and expensive validation. Start conservatively; do not queue the entire library into RAM or decode every video concurrently.

Reserve staging capacity per in-flight resource, honor a configured staging byte limit and disk-free watermark, and fail/pause clearly for a single resource larger than available capacity. Use retry/backoff/jitter, cancellation, and source-URL refresh. Resume partial downloads only when the source version and server range behavior make that safe; otherwise restart that resource.

Use private generated paths, `.partial` files, durable completion markers, and atomic promotion where supported. Keep staging outside every scanned external-library root and the managed-library recovery crawler's search roots. Do not let `restoreUntrackedFiles` import half-finished or uncommitted staging/recovery files.

Hash the complete staged bytes with the fork's dual-digest machinery. Validate size, media type, and required integrity checks; reject HTML/auth error bodies, truncated transfers, and unexpected resource versions. Never rewrite originals to embed metadata or transcode before exact-byte deduplication.

Staging cleanup must be lease/reference-aware and crash-safe. Retain the last validated recovery copy until durable finalization. Bound orphan/quarantine retention; report retained recovery files rather than silently exhausting disk.

Use rootless containers with configured runtime UID/GID and writable volume ownership. Do not require privileged containers, a Docker socket, or recursive ownership changes to existing libraries.

## 7. Health-aware matching: mandatory decision service

Implement a reusable internal resolver returning explicit decisions, for example: import-new, reuse-healthy, repair-existing, preserve-trashed, needs-review, and retry. Final outcomes should separately distinguish imported, reused, repaired, deferred, and failed.

For each staged resource:

1. Verify the staged candidate and calculate SHA-256 plus content SHA-1 for legacy matching.
2. Resolve prior source mappings and all relevant same-owner exact-content matches using current checksums, checksum translation, and `immich_fork.asset_checksum` where appropriate. Do not expose other users' records or mistake `sha1Path` for file content.
3. Inspect destination lifecycle state, `isOffline`, relevant Missing/Corrupt findings, required resource paths, and physical-file associations. Inspect health internally by asset/resource identity; an empty UI-filtered list is not proof of health. Dismissal is not repair.
4. Independently establish that the required target is a readable regular file, has expected size, and has matching verified content. At initial staged reconciliation, hash existing candidates for comparison. Incremental reuse may use documented verification evidence only while the file identity/stat evidence is unchanged; invalidate it on health findings or file changes and retain periodic deeper verification.
5. A thumbnail/preview does not substitute for a missing original. Verify the correct role: original, edited rendition, RAW alternate, or Live Photo motion asset.
6. Healthy exact matches may be reused, but still reconcile metadata, source mappings, and album membership. A missing/corrupt/offline match must enter recovery, not “duplicate skipped.”

Apply this rule to **every skip path**, including existing source mappings before download and unchanged iCloud fingerprints. An unchanged iCloud resource whose destination became damaged must be downloaded/recovered again.

Use saved expected content hashes to identify a damaged original. Its currently corrupted bytes may naturally hash differently. Never select a recovery target using only filename, timestamp, dimensions, or perceptual similarity. If identity cannot be established safely, preserve the source import and report a review candidate without claiming the unrelated damaged asset is repaired.

Provider fingerprints are opaque until validated. Do not equate an iCloud checksum/ETag with Immich SHA-256/SHA-1 or promise zero-download deduplication against an unrelated existing library. Retain verified mappings so subsequent unchanged healthy resources avoid repeat transfers.

## 8. Transactional same-asset recovery

Implement a dedicated staged-resource recovery service and repository transaction, extracting shared validation/finalization helpers where appropriate. Do not delete/recreate an ordinary managed asset just to evade its checksum uniqueness constraint.

Required sequence:

1. Reserve the recovery and capture the expected target state/version. Validate incoming bytes and exact-resource identity before changing destination state.
2. Allocate a new safe managed file path through the existing storage abstraction. Never truncate or overwrite a shared/hard-linked canonical path in place. Copy/promote the complete candidate, flush as appropriate, and verify the final bytes.
3. Under suitable owner/content/asset locks, re-read the target, health state, lifecycle, paths, source mapping, and physical-file references. Use compare-and-swap/version checks; retry or reconcile a concurrent change instead of overwriting it.
4. Atomically update the existing asset/resource reference, physical-file accounting, SHA-256 algorithm/content checksum, content SHA-1 sidecar, verified paths/evidence, and affected size/accounting fields. Clear `isOffline` only when justified. Preserve the asset ID, ownership, capture dates, metadata locks, favourites, tags, faces, albums, stacks, Live Photo links, and independent edit history.
5. Resolve applicable Missing and Corrupt findings using the fork's phase-aware semantics, with `resolvedAt`, informational severity, recovery provenance, and previous-path/error audit information. Invalidate stale recovery candidates. Only clear the findings for the resource actually repaired.
6. Persist required follow-up jobs/outbox or an equivalent recoverable pending-work marker with the commit. Rebuild appropriate thumbnails/transcodes/metadata indexes and emit existing-compatible update events without erasing user-edited or locked metadata.
7. Remove staging/obsolete files only after durable finalization and safe reference checks. A crash after promotion but before database commit must leave recoverable state, not a dangling success or a missing recovery file.

“Clear missing/corrupt entries” means remove them from active health problems and update counts while preserving resolved audit history. Do not simply dismiss or delete findings, and do not clear an original-file warning because only an edited rendition was imported.

Refactor validation to distinguish healthy, missing/unreadable, confirmed corruption, unsupported format, timeout, and transient infrastructure failure. Reuse existing RAW/LibRaw handling, but do not label unsupported RAW or a decoder timeout as confirmed corrupt—or call an unvalidated resource repaired. For confirmed-corrupt recovery, use validation adequate to the reported damage; merely decoding an embedded RAW preview is not proof of full RAW integrity. Document verification scope and retain unresolved uncertainty.

If the staged iCloud file is also bad, fails identity verification, or cannot be committed, leave the original findings active and report the failure. Retrying the same resource version must be bounded; avoid permanent redownload loops.

Protect against stale health scans and queued corrupt-media trash jobs. The current `handleDeleteCorrupt` validates before a later bulk update, so revalidation alone is not enough to exclude a recovery race. Coordinate destructive commits and repair using locked/version-checked state, including stale scan result writes. Never resurrect intentionally trashed/deleted assets automatically.

## 9. Physical deduplication, external assets, and permissions

Do not link new imports to a canonical master that is missing or corrupt and then delete the good upload. Health-check the actual chosen physical bytes as well as database eligibility. Preserve the deterministic master-selection rules; skip unhealthy candidates or retain a new healthy managed copy.

A current user's recovery must not silently mutate another user's metadata or clear another user's findings. Safely detach/repoint to new verified bytes when shared storage cannot be recovered within authorized boundaries. Update the fork's applicable public/sidecar physical mappings and reference accounting consistently; never free a still-referenced file.

Handle external-library matches explicitly. Do not overwrite read-only external paths, silently change library ownership, or clear a finding merely because a separate managed copy now exists. Provide an explicit owner-authorized `recoverExternalAsManaged` policy, disabled until opted in, that safely converts/repoints a provably matching damaged external asset through supported lifecycle/accounting operations while preserving its identity and associations. Without that authorization, retain/report the healthy imported resource and the outstanding external repair requirement separately.

Respect locked/hidden media and source visibility. Background jobs need narrow owner-scoped authorization, not forged admin/elevated sessions. Do not expose hidden asset IDs, names, thumbnails, paths, or matches in public progress/errors. Do not store the nil UUID from a privacy-filtered duplicate response as a source mapping. Require appropriate consent/authorization for hidden-media import; never reduce existing destination privacy automatically.

Charge logical quota correctly: recovery of an existing same-sized asset is not a second independent upload. Separately enforce real temporary/free-space limits.

## 10. Originals, edits, and Live Photos

Represent one logical source photo with explicitly related resources. Originals remain immutable; store the current available Apple rendition as a source-owned derivative or associated resource with provenance. Preserve raw adjustment sidecars when exposed, but do not claim Apple edit instructions are portable Immich operations.

Implement real integration with the fork's media serving/download and derivative-generation paths. Do not merely save an unused edited file, fake edit operations, or let scheduled thumbnail/edit jobs overwrite imported Apple renders. Show the imported current edit when appropriate, retain original download, and expose the source relationship.

Keep local Immich edits separate. A later iCloud edit or revert must not replace local edit instructions or delete the original. Preserve replaced source renditions according to a documented bounded retention policy; never delete the only recoverable version. An Apple revert removes its current-edit preference, not independent Immich work.

Preserve and link Live Photo still/motion resources using source identities and existing link hooks. Recover a missing motion component without replacing the healthy still. Preserve RAW alternatives, original file types, orientation, colour/HDR information, and source metadata when available; do not substitute a JPEG preview for an original HEIC/RAW.

Two iCloud logical photos can share original bytes while having different edits/memberships. Deduplicate storage without silently merging their distinct source rendition/provenance relationships. Explicitly test that case. Surface special-format/edited-Live-Photo/slow-motion fidelity gaps rather than claiming universal edit support.

## 11. Albums and metadata

Map source album IDs and parent IDs to destination albums using the existing nested-album services, cycle guards, and permissions. Default to a connection-owned “iCloud” container; keep multiple connections distinguishable.

Preserve nesting, names, memberships, and ordering/cover metadata only where the connector exposes reliable values. Album renames/moves must update existing mappings. Import a resource once regardless of how many albums contain it. Healthy pre-existing/repaired assets must receive their source memberships too.

Track source-managed membership provenance so complete authoritative removals do not remove independent/manual memberships. Preserve locally created albums and do not reproduce Apple sharing permissions automatically. Treat source album deletion non-destructively in this release.

Apply supported captions, dates/timezones, location, favourites, and visibility through existing metadata services, not in-place EXIF modification. Respect metadata locks and user overrides; use provenance/three-way comparison where needed. Absent source data must not erase known destination values.

## 12. Web UI and deployment

Add a discoverable “iCloud Photos Sync” entry using the current web app's settings/import/utilities conventions. Use existing components, accessibility, translations, authentication, SDK generation, and event/polling patterns.

Provide connection setup, authentication/approval challenges, library/album selection, originals-plus-edits policy, schedule, concurrency/staging controls within admin limits, run/pause/resume/cancel, retry failures, and reconcile/rescan. Show clear ADP/web-access requirements and the separate external-recovery policy.

Display persisted counts for logical assets and resources separately: discovered, staged, imported, healthy-reused, repaired-missing, repaired-corrupt, metadata/album-updated, awaiting-auth, unsupported, failed, and requiring review. Explain that initially determining exact duplicates may require an iCloud download. Never count authentication failure, partial inventory, or deferred repair as complete.

Progress and safe diagnostics must survive browser closure and server/sidecar restart. Link authorized repaired items to their normal asset view and resolved health history. Changes in health state should disappear from active health screens without waiting for a full library scan.

Package the transport with pinned build dependencies and documented Docker/Compose deployment, persistent encrypted auth/cache state, staging volume, rootless permissions, resource limits, readiness/version checks, and disconnect/backup/restore procedures. Avoid a mandatory platform-specific dependency or global host Rclone installation.

Validate path containment, symlink races, MIME/resource bounds, and source URL/redirect destinations. Prevent SSRF to internal/metadata endpoints and arbitrary shell/path access through the connector. No secrets in support bundles.

## 13. Required tests and acceptance gates

Add meaningful tests beside the relevant existing suites, plus transport fixtures and end-to-end API/web tests. Use synthetic media and redacted protocol fixtures; never require real Apple credentials in CI.

At minimum cover:

- Original, edited rendition, RAW pair, and Live Photo import; repeat import is idempotent.
- Nested album rename/move, same photo in multiple albums, existing-asset album attachment, and partial membership listing with no destructive reconciliation.
- New edit/revert on an old photo; local Immich edits remain intact; equal original bytes with distinct source edits remain distinguishable.
- Healthy SHA-256 and legacy content-SHA-1 reuse; `sha1Path` is never treated as a content match.
- Matching stored checksum with missing file, corrupt file, unreadable file, `isOffline`, or dismissed-but-unresolved damage enters recovery.
- Damaged current bytes differ from the saved expected checksum, but the validated iCloud original matches and repairs the same asset ID.
- Recovery resolves applicable findings and active counts, clears offline state, and preserves all associations, privacy and metadata locks.
- Recovering only an edited rendition or Live Photo component does not falsely resolve a different missing resource.
- Invalid/truncated source, wrong variant, unsupported RAW, decoder timeout, quota/disk failure, and hash mismatch never produce false repair success.
- Previously mapped unchanged source is re-fetched when its destination later becomes missing/corrupt.
- Corrupt/missing physical master is never reused; shared physical recovery cannot damage or expose another user's assets.
- External paths remain untouched without authorization; opted-in managed recovery correctly preserves identity and accounting.
- Intentionally trashed assets are not automatically restored; queued corrupt-trash/stale-scan races cannot delete or reflag a successfully repaired new generation.
- Concurrent uploads/repairs and checksum-constraint races preserve exactly one intended logical outcome and the good staged bytes.
- Crash after staging, validation, promotion, database commit, and before follow-up dispatch/cleanup; each is resumable without losing bytes or duplicating work.
- ADP approval required, expired sessions/download URLs, invalid change token, rate limit, multi-page failure, and restart recovery.
- Locked-media/nil-UUID handling, cross-owner access rejection, credential/log redaction, path traversal/symlink attacks, and URL/redirect restrictions.
- Bounded resource usage with a synthetic 500,000-asset inventory and multiple memberships/resources; no mandatory full-library media staging.
- Applicable schema-phase writes, migration reruns, and fork/official compatibility regression tests.

The central end-to-end acceptance test must demonstrate: a valid staged original matches a broken existing managed asset; the same asset ID now serves verified healthy bytes; albums/edits/metadata remain; Missing/Corrupt findings are resolved and disappear from active results; a second run reuses the healthy resource without reimporting it.

## 14. Delivery

Implement the feature end-to-end in reviewable changes. Add a feature guide under the actual `docs` structure and update README navigation. Include setup, ADP reauthorization, source fidelity limits, initial-download deduplication limits, recovery semantics, external-library policy, and troubleshooting.

Run the relevant repository-discovered formatting, lint, typecheck, unit, integration, transport, SDK-generation, migration, and web tests. Report exact commands and results. Clearly distinguish mocked/fixture tests from live iCloud verification; do not claim a live sync without performing one.

Finish with changed files, schema/deployment changes, behavior demonstrated, test results, and any concrete unsupported cases. Do not silently weaken the missing/corrupt recovery requirement to make duplicate tests pass, leave the transport mocked, or mark the feature complete with core paths stubbed out.