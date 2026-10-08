# FL-296 On-demand iCloud Identity Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. No additional agents or local runtime checks are authorized for this packet.

**Goal:** Authenticated owners can request a durable, fresh-source SHA-256 audit of named iCloud resources; matching bytes publish current proof, while mismatches preserve the original and import a separate managed source copy for review.

**Architecture:** Extend the existing fork-owned iCloud resource reservation with a nullable audit request binding. Existing ICloudSync media-operation workers dispatch a typed audit snapshot through a focused audit service. The existing private staging/session/transport and recovery transaction remain the byte and publication authorities; an audit-specific database guard joins the request, operation, source generation, identity and current privacy state before any recovery commit or proof publication.

**Tech Stack:** NestJS, existing nestjs-zod DTO conventions, Kysely/PostgreSQL, existing MediaOperationKind.ICloudSync workers, Node streams and existing MediaIntegrityService.

**Spec:** FL-296, server contract sections 1, 3, 7 and 8; https://heronet.atlassian.net/browse/FL-296. Reviewed source base 753beb793e7203f3e3c80d03b574fed69db8ee4b. Parent owns review, hosted CI, push, Jira, merge and deployment.

## Global Constraints

- No local runtime, tests, builds, typechecking, generation, installation, CI reads, push, Jira writes or deployed storage access.
- Migration reservation is 0000000000216-ICloudIdentityAudit. 0215 belongs to PhotographyWorkflow in separate owner worktrees. Preserve it when assembling fresh integration later.
- Preserve current originals, existing source identities, import receipts, source removal semantics, private staging permissions, managed-copy policy and whole-item claims.
- No queue-only endpoint, mapped-file-only verification, fabricated provider descriptor/fingerprint, reusable stale proof, or audit-triggered metadata/album/stack changes.
- Weekly 1% sampling, identity reuse/adoption, edit-owner handover, native FL-297 and live Apple/Optimize Storage qualification are outside this packet.
- AJ Taylor <aj@ajtaylor.net> must author and commit; DCO and a factual FL-296 #comment are required on the implemented candidate. Do not commit an empty or plan-only delivery milestone.
- Run impact for each edited symbol and detect_changes before implementation commit. Current identity symbols are missing from GitNexus; class-level LOW results omit DI flows and do not establish low risk. Coverage is UNKNOWN with manual caller tracing required.

## Review Focus

- An old complete staging file must not satisfy a new request: distinguish a new audit download from a crash resume of that same request.
- A cancellation, source deletion/revision, original replacement, disconnect or privacy change during preparation must defeat final publication, including a mismatch import.
- A worker dying after filesystem promotion or database commit must resume through the same reservation/outbox without importing twice or replacing the original.
- Session expiry, relock or disconnect after a committed mismatch must not strand its existing outbox or staging receipt: housekeeping has separate, narrower authority and cannot certify new work.
- Successful match publication has its own durable staging receipt: cleanup failure or a crash must not strand private bytes after the session/source/connection authority changes, nor permit housekeeping to recertify the match.
- Ordinary sync must not consume audit work, publish audit identities, reset audit reservations on rescan, count an audit as a scheduled sync run, or apply albums/metadata/stack changes to a mismatch copy.
- A caller's expired/revoked session or PIN elevation must not survive as a serialized boolean in worker authority; current authenticated owner privacy predicates decide.

## Source Facts and File Map

Existing entry points: ICloudIdentityController at server/src/controllers/icloud-identity.controller.ts, ICloudIdentityService at server/src/services/icloud-identity.service.ts, ICloudIdentityRepository at server/src/repositories/icloud-identity.repository.ts. Existing download authority: ICloudStagingService.download(connection, resource), ICloudSyncRepository.withSession(id, ownerId, callback), ICloudTransportRepository.download(input, signal). Existing publication authority: MediaRecoveryRepository.getResource/lockResource/reserve/commit and MediaRecoveryService.reconcile(input). Existing durable dispatch: MediaOperationRepository.createWithin(bind, after), ICloudSyncService.drain/run and MediaOperationKind.ICloudSync.

Create:

- server/src/fork-schema/migrations/0000000000216-ICloudIdentityAudit.ts: request/authority binding and independent reservation uniqueness.
- server/src/repositories/icloud-audit.repository.ts: request resolution, idempotency, request-bound lease, current authority, proof/result CAS and recovery guard.
- server/src/services/icloud-audit.service.ts: the fresh-source worker; no new scheduler or transport framework.
- server/src/services/icloud-audit.service.spec.ts: real staged-byte worker fixtures with recording/suspended transport seams.
- server/test/medium/specs/repositories/icloud-audit.repository.spec.ts: real PostgreSQL schema, race, privacy and publication tests.

Modify:

- server/src/dtos/icloud-identity.dto.ts and server/src/controllers/icloud-identity.controller.ts: validated endpoint and result DTO.
- server/src/services/icloud-identity.service.ts: authenticated submission delegation; preserve all existing lookup/attach/claim behavior.
- server/src/repositories/icloud-identity.repository.ts: exclude audit resources from backfill/pending roles; expose mismatch as review in lookup through the current identity result.
- server/src/repositories/icloud-sync.repository.ts: ICloudResource.auditRequestId, explicit ordinary-query exclusions, partial-index conflict predicate, audit-aware removal/finalization boundaries.
- server/src/repositories/icloud-{album,metadata,relations}.repository.ts: exclude audit resources from source-to-destination mappings and every resource-derived sibling/history selector.
- server/src/services/icloud-sync.service.ts: typed snapshot dispatch before ordinary run startup; preserve normal run behavior.
- server/src/services/icloud-staging.service.ts: audit authority heartbeat/final checks and request-bound complete-file behavior, preserving normal download behavior.
- server/src/repositories/media-recovery.repository.ts and server/src/services/media-recovery.service.ts: optional audit authority, final guarded mismatch import and atomic result publication. No broad recovery rewrite.
- server/src/repositories/index.ts and server/src/services/index.ts: existing provider arrays only.
- server/src/fork-schema/manifests/fork-migration-order.json and existing migration manifest/isolated-migration specs: add 0216 without allocating or modifying 0215.
- Existing icloud-sync, identity, staging and recovery specs: pin ordinary-path preservation and query exclusions.

## Task 1: Durable Request and Independent Audit Reservation

**Interfaces:** New ICloudAuditRepository resolves one authenticated owner's named item into an exact current source descriptor. Proposed DTO is one connectionId, requestKey UUID and 1–100 items containing caller correlation id, assetId, cloudIdentifier, role and optional editVersion. No client SHA-256, provider URL, descriptor or owner ID authorizes work. Each request item records server-resolved identity ID/digest, actual asset original identity, connection/library, CPLAsset and CPLMaster IDs/revisions, exact provider resource ID/key/fingerprint/size, current scope/config digest, requester session ID, operation ID, result and mismatch-copy asset ID. Reject ambiguous source-role/version mappings as unavailable. Device identities with unknown library can resolve only against a unique current owned in-scope inventory descriptor; do not guess a historical edit version.

- [ ] Author migration and real-PG tests first: existing finalized resources survive unchanged; an ordinary row and an audit row with the same real descriptor coexist; two ordinary rows still conflict; one request owns only one audit transfer; request deletion does not silently lose unfinished promoted/outbox work.
- [ ] Add immich_fork.icloud_identity_audit (one item row), nullable icloud_resource.auditRequestId with fork-local FK, and unique auditRequestId on resource rows. Store expectedSha256 as a 32-byte checked bytea; states queued/running/match/mismatch/stale/cancelled/failed and nullable resultAssetId, error, verifiedAt. Operation/session/asset references are validated joins, with no FK into the official public schema.
- [ ] Discover the existing generated ordinary UNIQUE constraint name through PostgreSQL metadata in the migration rather than assuming its truncated auto-name. Replace it with:

```sql
CREATE UNIQUE INDEX icloud_resource_ordinary_identity_key
ON immich_fork.icloud_resource
  ("connectionId", "libraryKey", "sourceAssetId", "resourceKey", fingerprint)
WHERE "auditRequestId" IS NULL;
CREATE UNIQUE INDEX icloud_resource_audit_request_key
ON immich_fork.icloud_resource ("auditRequestId")
WHERE "auditRequestId" IS NOT NULL;
```

- [ ] Update materialize's ordinary ON CONFLICT with WHERE "auditRequestId" IS NULL; preserve existing source/_sync merge behavior.
- [ ] Define safe down behavior: refuse rollback while any audit request/resource exists, rather than deleting receipts or silently collapsing duplicate descriptors; empty audit schema can restore original ordinary uniqueness then remove new columns/table/indexes.
- [ ] Register 0216 in manifest, migration-order and official-container round-trip expectations. Do not insert a fictional 0215 file into this base. Parent revalidates fresh integration before assembly/shipping.

## Task 2: Exact Ordinary-Path Exclusions and Shared Cleanup

- [ ] Add auditRequestId IS NULL to ordinary resource candidate/claim selection; rescan reset; retryFailures; current/superseded materialization updates; pending counts/roles; reuse/provenance/backfill; original/live-motion/RAW/edit family selection; album membership destination selection; metadata previous-source history; relation event selection; ordinary finalization identity recording.
- [ ] Ordinary scheduled-run dueConnections/latestOperation/queueOperation counts exclude snapshots where task = 'identity-audit'. Removal's busy query explicitly includes both ordinary and audit operations. Audit completion must not completeRun/startRun, modify ordinary checkpoint cursors or suppress the connection's next scheduled run.
- [ ] Physical resource allocation totals MUST include both ordinary and audit reservedBytes/active leases for per-connection and global capacity limits. Display/ordinary resource progress counts exclude audits. Connection disconnect/config invalidation/removal and staging cleanup MUST include audits; do not blanket-exclude them from lifecycle safety.
- [ ] Add parameterized real-PG fixtures proving an audit row cannot influence ordinary pending roles, relation pair/stack selection, album membership, metadata source preference, backfill or rescan; preserve ordinary tests unchanged.

## Task 3: Authenticated Submission and Idempotent Dispatch

- [ ] Add verifyICloudIdentities endpoint with AssetRead authorization and no shared-link access. Because this work can import a mismatch copy, additionally require AssetUpload permission for API-key callers; no source credentials accepted. For the initial bounded worker authority use real owner sessions, consistent with connection private authentication, and return a clear session-required error for API keys rather than retaining an unrevocable key snapshot. Review this explicit contract limitation before implementation.
- [ ] Resolve owned connection, current in-scope source descriptor and active caller-owned asset using IntegrityRepository.getSafetyQuery(auth). Locked motion of a Locked still follows the same predicate. Unknown, other-owner, hidden, out-of-scope and digest-inconsistent items all answer unavailable with no source metadata leakage.
- [ ] Use MediaOperationRepository.createWithin(bind, after) to commit one batch operation and its audit rows together. Snapshot shape is typed:

```ts
type ICloudAuditSnapshot = {
  task: 'identity-audit';
  connectionId: string;
  requestKey: string;
  input: ICloudAuditInputItem[];
  auditIds: string[];
};
```

- [ ] Serialize repeated owner/requestKey submissions under one advisory transaction lock. Identical normalized input returns the existing operation/items; a different input with the same key is rejected. No queue-before-request or request-before-operation crash gap.
- [ ] Persist the COMPLETE normalized batch input in the immutable operation snapshot, including correlation IDs and unavailable members; persist each initial queued/unavailable outcome in the operation result in the same createWithin transaction. The auditIds array is only a dispatch index, not the idempotency comparison. Normalize by validated DTO defaults, parsed canonical identifier/role/version representation and deterministic item order; reject duplicate correlation IDs. Preserve a normalized submitted identifier when parsing fails so two different invalid identifiers cannot collapse to one unavailable value. Do not store provider/session secrets. Compare canonical JSON of the full normalized input BEFORE re-resolving identity availability on a repeat. An exact repeat returns the stored original outcomes even if inventory/permission availability changed; changed unavailable members also cause an explicit request-key conflict.

```ts
type ICloudAuditInputItem = {
  id: string;
  assetId: string;
  cloudIdentifier: string;
  role: ICloudIdentityRole;
  editVersion: string;
};
type ICloudAuditSnapshot = {
  task: 'identity-audit';
  connectionId: string;
  requestKey: string;
  input: ICloudAuditInputItem[];
  auditIds: string[];
};
type ICloudAuditInitialOutcome =
  { id: string; state: 'unavailable' } | { id: string; state: 'queued'; auditRequestId: string };
// operation.result.items contains ALL initial outcomes; unavailable rows have no fake
// expected digest/descriptor and do not enter icloud_identity_audit or icloud_resource.
```

- [ ] Keep the stored result private: owner-scoped operation responses retain current privacy redaction; repeated submissions return only correlation IDs, queued/unavailable states and the existing operation ID. They do not expose stale asset/source names or descriptors. A batch with zero resolvable items still stores the canonical input and unavailable outcomes in a completed no-work operation, without queueing a worker or allocating an audit resource. This is a genuine idempotency receipt, not a verification result.
- [ ] Return caller correlation IDs with queued/unavailable and operationId; no passed audit timestamp appears from submission. Preserve existing lookup DTOs; auditVerifiedAt continues to derive only from lastAuditResult === 'match'. Make current mismatches answer review rather than on-server, even if device digest comparison would otherwise produce exact.

## Task 4: Current Privacy, Claim and Source-Generation Authority

**Interfaces:** Proposed AuditAuthority extends RecoveryAuthority with auditRequestId, operationId and operationClaimToken. ICloudAuditRepository.lockAuthority(trx, authority) returns the request only if every current predicate below holds. RecoveryRepository invokes this shared guard in its own transaction before reservation and again at final commit; a worker precheck alone is insufficient.

- [ ] Preserve the actual recovery prefix: MediaRecoveryRepository.lockAuthority takes fork-state FOR SHARE and handover check, then the content-digest advisory lock, then public.user FOR UPDATE. reserve/commit next take resource FOR UPDATE with connection FOR SHARE; commit then takes promoted-path advisory lock, target path/asset FOR UPDATE, physical mapping FOR UPDATE and candidate/privacy locks. Do not invoke a separate operation-first transaction around recovery: it would invert this prefix and nested transactions would not share publication locks.
- [ ] For audit publication, extend that prefix INSIDE the SAME recovery transaction: fork/handover -> digest advisory lock -> owner user FOR UPDATE -> connection FOR SHARE -> operation FOR UPDATE -> audit request FOR UPDATE -> source records (deterministic IDs) -> identity FOR SHARE -> audit resource FOR UPDATE -> promoted/target path advisory locks -> target/original assets (deterministic IDs) and physical mappings -> current preference/session locks. Audit connection is explicitly locked before its resource; do not rely on the executor order of the existing joint resource/connection query. Recheck time-sensitive authority after final file-validation awaits immediately before writes. The same order applies to audit reserve, match-only publication and mismatch commit; ordinary recovery retains its current order. Owner user lock serializes recovery publications of one owner before audit-specific asset locks.
- [ ] Trace competing writers before edits: MediaOperationRepository.requestCancel/claim recovery/pause update the operation row only after the fork write guard; audit never holds operation then waits for connection/user. ICloudSyncRepository.update/disconnect/claim/remove lock or update connection before resources; their audit lifecycle extensions must keep connection-before-resource, and must not update an operation while holding resource/identity/asset locks. queueOperation locks connection then inserts/selects ordinary operations; audit submission locks its request-key advisory lock, owner/connection, then inserts operation/request/resource, with no waits on an existing audit operation after holding a resource. configure/stop service calls must finish connection transactions before cancel-operation transactions. Source savePage/materialize updates must not add an operation-lock wait after holding source/resource rows. Identity attachment/asset and preference/session writers must be checked against the actual recovery prefix; report any required change rather than asserting low risk. Author two-connection lock-order fixtures that exercise cancel, configure/disconnect and concurrent normal recovery versus audit final commit; no arbitrary retry loop masks a deadlock.
- [ ] Check operation owner/kind/snapshot task/request membership, actual claim token, claim expiry > clock_timestamp(), active worker status, cancelRequestedAt IS NULL and pauseRequestedAt IS NULL. A stale worker never mutates request/resource/result.
- [ ] Check connection owner, connected state, encrypted session presence, not owner_removed, unchanged captured scope/config digest, library selection, source hidden consent and album-membership selection. Source CPLAsset/CPLMaster must still exist, not be deleted, retain captured revisions and still normalize to the exact descriptor/role/edit version. Invalid/missing revision or ambiguous descriptor cannot produce match.
- [ ] Check current identity ID/asset owner/role/edit version/expected digest and current asset originalPath/checksum/algorithm/updateId. Re-run the equivalent IntegrityRepository safety predicates inside the publishing transaction, not with a stale AuthDto. Reconstruct current suppression from UserRepository metadata/getPreferences using the same tag/person/pet/scope predicates as AuthService. Lock metadata rows through publication to prevent suppression edits racing this check.
- [ ] Bind requester session ID to current user, expiry and current PIN expiry, with current user not deleted. Store no token/credential or hasElevatedPermission boolean. Locked/suppressed media requires that same session to remain elevated at final publication; otherwise stale/unavailable. Session deletion, relock and PIN expiry defeat the guard. The final query must use current session predicate even after earlier awaits.
- [ ] Acquire the existing whole-item claim using holder icloud-sync:audit:<operationId>, so ordinary sync and device claims wait. Renew within existing four-hour maximum; expiry cannot certify work. Persist actual claim ID and check it through final publication. Do not use the normal connection holder, which would allow simultaneous ordinary sync ownership.
- [ ] Add real-PG races with two independent connections for cancellation, lost operation claim, source revision/deletion, session deletion/relock, suppressed entity added, digest replacement, disconnect and config change before final CAS. Assert proof and mismatch import are absent.

## Task 5: Fresh Bytes, Match Publication and Separate Mismatch Recovery

- [ ] ICloudSyncService.run validates/discriminates snapshot before any normal startRun/enumeration; audit snapshot delegates to ICloudAuditService.run(operation, claimToken). Unknown task values fail closed. Normal snapshots retain the existing code path.
- [ ] Audit repository creates/leases a dedicated resource with auditRequestId, real descriptor and no mapped assetId/expectedTarget/old SHA hashes. Reserve bytes against existing global/connection budgets including ordinary work. A retry of the SAME audit resumes that row; a NEW request gets a distinct staging directory and cannot consume any ordinary complete file.
- [ ] Staging checks request/operation/whole-item authority before opening transport, during heartbeat and after the stream completes. Continue existing private root/symlink/mode/owner/free-space checks, session rotation, exact response fingerprint/size and bounded stream behavior. Cancellation aborts transport but final database guard remains authoritative.
- [ ] Validate/hash downloaded original bytes with MediaIntegrityService, not verifyMapped. SHA-256 equals the captured identity digest only if it also equals the current authoritative asset digest. A changed transport fingerprint/size refreshes source inventory and produces stale/retry, never mismatch or match for the wrong generation.
- [ ] For a match, atomically guard and set lastVerifiedAt/lastAuditResult='match', request result match, and a durable match staging receipt on the dedicated audit resource; use the downloaded content SHA, not a boolean transport result. The receipt binds exact auditRequestId/resourceId/ownerId, complete stagingPath, downloaded SHA-256 and size, with resource status committed and pendingJobs empty. It has NO mismatch resultAssetId/expectedTarget/promotedPath requirement and must not repurpose the original asset as a recovery target. Retain reservedBytes until cleanup succeeds. Never change existing asset bytes or source identity SHA. Cleanup private staging after durable proof; cleanup failure/crash remains retryable through this receipt without recertifying a changed generation.
- [ ] For a mismatch, call existing recovery reconcile using the audit resource and optional AuditAuthority. It must never map/update the original target. Existing managed-copy validation/reservation/exclusive promotion/final-file validation remain mandatory. If source content already has an exact valid managed match, reuse that distinct asset safely; ambiguity yields review without mutating originals. Hidden/Locked state inherits appropriate original/source privacy at creation.
- [ ] In final recovery commit transaction, repeat audit guard, publish the separate resource asset/outbox receipt, set original identity lastAuditResult='mismatch' and clear lastVerifiedAt, and persist request resultAssetId. Do NOT recordSyncIdentity for the audit copy or apply normal album/metadata/stack reconciliation. Mark the durable audit result as review without clearing the committed outbox state needed after a crash.
- [ ] Split publication and housekeeping authority explicitly. PublicationAuthority requires all current session/PIN/source/config/identity/operation/claim predicates above and can certify or import. CommittedReceiptAuthority can ONLY finish exact already-committed outbox and staging cleanup; it must NOT call reconcile/verifyMapped, publish a timestamp/audit result, mutate source identity, import/repair media, restore an asset, or delete original/promoted committed media. Session expiry, source changes, disconnected state, terminal/cancelled original operation and deleted original asset do NOT invalidate housekeeping authority.
- [ ] Define TWO committed receipt variants at their original publication transaction boundaries. MismatchReceipt binds request result=mismatch/resultAssetId, committed resource auditRequestId/owner/connection, expectedTarget.assetId, verification digest, promotedPath and actual pendingJobs. MatchStagingReceipt binds request result=match, committed dedicated resource auditRequestId/resourceId/owner/connection, exact stagingPath and verification downloaded SHA-256/size; no resultAssetId, target asset or outbox is required. Its verification receipt records kind='audit-match-staging' so a copied ordinary or mismatch receipt cannot qualify. Both select terminal publication states independently of worker eligibility, current source identity and requester session. Housekeeping validates the durable bindings, not current original/source data. For a match it may ONLY retire that exact request's private staging file/reservation and mark its resource finalized; no asset read, job queue, audit timestamp/result mutation or proof re-publication is permitted.
- [ ] For mismatch housekeeping, additionally validate ownership of the result asset and exact known outbox job types/IDs. Queue only stored AssetExtractMetadata/AssetGenerateThumbnails jobs for that exact receipt asset, not names/IDs from a new source snapshot. If the result asset was removed or the binding was corrupted, do not target a replacement; durably retire/flag the unavailable receipt under its exact ID and clear only obsolete known jobs, leaving media untouched and private staging cleanup eligible. Both variants verify that stagingPath equals the canonical private staging root/resourceId/complete, reject symlink/foreign paths, and only unlink that resource's private complete/partial files. No promoted path or original media path is eligible for deletion. Receipt cleanup does not depend on lookup visibility or current session credentials.
- [ ] Add a bounded committed-audit housekeeping pass to existing ICloudSyncService.drain before normal operation claims, using a request-bound cleanup lease. Select a bounded candidate page without row locks, then lock fork/owner/connection/request in publication-compatible order, and ONLY THEN take the candidate resource FOR UPDATE SKIP LOCKED and revalidate its exact receipt. Do not claim resource-first and subsequently wait on the owner/connection. It runs from existing bootstrap/tick lanes even when transport is disabled and no operation is runnable. No new manager/scheduler. It joins owned connection irrespective of connected/disconnected state and never fetches provider bytes. Per-operation processing may use the same helper after commit. Do not reacquire operation/source/session locks because cleanup does not publish. Removal's existing in-flight check continues to retain the connection while committed outbox work exists; after housekeeping drains it, removal can finish. Never make a disconnected connection eligible for new transfer.
- [ ] Select committed audit resources whose persisted request result is EITHER match or mismatch and whose matching receipt variant passes. Do not filter on nonterminal request state, active original operation, mismatch resultAssetId or nonempty pendingJobs: that would strand terminal matches and drained mismatch receipts. Acquire the same request/resource cleanup lease for both variants; current resource status/receipt CAS prevents concurrent finalization. Match branch has no outbox and runs only exact private staging cleanup; mismatch branch drains and conditionally clears its stored outbox before the same cleanup. Preserve failed cleanup's durable receipt for bounded retry, and account reservedBytes until cleanup succeeds. Audit-aware finalization skips recordSyncIdentity/release of unrelated item claims and never writes request result/verifiedAt or source identity proof. Persist housekeeping lease/backoff through existing resource fields; no session-bound receipt or separate cleanup framework.
- [ ] Reconcile lifecycle with both receipt variants: disconnect revokes only uncommitted audit transfer leases and keeps committed match/mismatch cleanup receipts available; configuration/source invalidation cannot downgrade or erase a committed receipt. Removal retains a connection while either variant has committed staging/outbox/reserved bytes, then permits removal after exact receipt finalization. Removal/cleanup must not require a runnable operation or live requester session and must never re-open a terminal match to regain authority. Ordinary disconnect/removal behavior stays intact.
- [ ] Recover crashes after promotion, after commit before outbox, and after outbox before cleanup by the same request/reservation. Before commit, lost authority prohibits import/proof. AFTER commit, housekeeping continues despite revoked session/PIN/disconnect/cancel without replaying publication. Stale/cancelled work must preserve already-accounted promoted files/receipts and cannot revive proof. Cleanup/removal never deletes the original or separate committed asset.

## Task 6: Authored Regression Matrix and Review Handoff

Write meaningful fixtures in the existing worker/staging/recovery suites and new real-PG audit suite; execute only through parent-owned hosted CI after independent review.

| Fixture                                                                                | Required observation                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old ordinary complete file plus source bytes B                                         | Transport is called; digest comes from B, never old complete bytes A                                                                                                                                                    |
| Source bytes A equal current identity/asset A                                          | Durable request match; fresh timestamp; lookup auditVerifiedAt                                                                                                                                                          |
| Source B differs from original A                                                       | A's asset/file/identity SHA unchanged; separate managed B receipt; durable mismatch/review; no auditVerifiedAt                                                                                                          |
| Two retry workers / crash after promotion                                              | One reserved target and one committed source copy; stale lease cannot publish                                                                                                                                           |
| Cancel while transport or final validation suspended                                   | No match/import after cancellation wins database lock                                                                                                                                                                   |
| Source revision changes while download suspended                                       | No stale proof or mismatch import against the old generation                                                                                                                                                            |
| Identity digest changes during final validation                                        | c62 invalidation stays cleared; late worker cannot restore proof                                                                                                                                                        |
| Disconnect/remove/config change while suspended                                        | Guard refuses; no source credentials logged; retained reservations remain accounted                                                                                                                                     |
| Other owner/partner/shared link/Locked/suppressed                                      | Unavailable or session-required; no provider read or leaked descriptor                                                                                                                                                  |
| Current session expires/relocks while preparing                                        | Final proof/import denied despite original elevated request                                                                                                                                                             |
| Repeated requestKey, same/different input                                              | Same operation for same request; explicit conflict for altered input                                                                                                                                                    |
| Repeated key with changed unavailable member / all unavailable                         | Full stored canonical input detects alteration; identical repeats return original complete outcomes without allocating fake resolved rows                                                                               |
| Audit and ordinary row same provider descriptor                                        | Independent reservation; ordinary uniqueness/query behavior unchanged                                                                                                                                                   |
| Import committed, outbox/cleanup fails once                                            | Receipt survives; restart completes once without deleting/replacing originals                                                                                                                                           |
| Crash after mismatch commit, session revoked/PIN relocked, connection disconnected     | Fresh worker drains exact receipt/outbox and staging without source reads, new publication or original deletion; removal then becomes eligible                                                                          |
| Match publishes, cleanup fails/crashes, then session revoked/source changes/disconnect | Terminal match staging receipt remains selectable; fresh worker retires only its private staging/reservation, does not read changed source/original or update any proof timestamp/result; removal then becomes eligible |
| Terminal match receipt lacks resultAssetId/outbox / repeated cleanup workers           | Cleanup succeeds from exact request/resource/path/downloaded digest binding alone; lease/CAS allows one finalization and does not recertify proof                                                                       |
| Committed result asset gone / receipt ID or digest altered                             | No job targets replacement asset; exact stale jobs retired or corruption reported; safe staging cleanup does not certify anything                                                                                       |
| Concurrent cancel/config/disconnect and ordinary recovery publication                  | Consistent lock order; winner determines publication; no deadlock hidden by retries                                                                                                                                     |
| Manifest migration/rollback fixtures                                                   | 0216 classified and ordered; populated rollback refuses; no 0215 collision                                                                                                                                              |

- [ ] Impact each edited symbol; report UNKNOWN/incomplete index coverage and actual callers. Perform git diff --check and static source/manifest review only locally.
- [ ] detect_changes against the exact approved base and edited worktree before commit; manually reconcile schema and DI exclusions omitted by index.
- [ ] Commit implemented source/tests/plan using message file with real newlines, AJ author+committer/DCO, factual FL-296 #comment with hosted qualification pending. Return exact head/tree, changed files, schema effects and authored-vs-executed evidence to parent.
- [ ] Parent obtains independent substantive review before push; parent alone runs hosted real-PG/worker checks and reconciles live integration/migration reservations before shipping. Never infer live Apple qualification or full FL-296 acceptance from source approval.

## Plan Review Gate

This plan is the initial design-review artifact; no shared schema, recovery, staging or worker symbols have been edited. Review particularly the partial uniqueness/query exclusions, same-transaction cancellation and privacy authority, audit holder exclusivity, preservation of mismatch identity/outbox receipts, and safe rollback. Resolve design findings in this file before implementation.
