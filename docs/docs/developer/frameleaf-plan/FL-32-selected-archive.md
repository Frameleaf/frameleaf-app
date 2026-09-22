# FL-32 selected-asset background archive

Status: bounded production candidate, not full FL-32 acceptance. FL-32 remains In Progress; native/mobile are deferred. Base: reviewed `9a729f04e2103010c68615516be644bb503a6698`, layered on freshly fetched Frameleaf `fork/main` `0116d4778d7ce34e9bc41a7d1fed46a4cd88a466`. Root owns publication, Jira and hosted checks.

## Delivered scope

The existing timeline Archive action opens a production Svelte dialog with a copied, deduplicated explicit owned selection and visible count. The dialog captures the selection and request key before loading anything. Filter/selection changes cannot rewrite that request. The server accepts at most 10,000 explicitly selected IDs per operation; this is not “all matching.” Existing unarchive, keyboard shortcuts and other synchronous API callers retain their established paths.

`POST /archive-operations` persists the selection, owner, initiating session, request key and per-item records atomically in two fork-owned tables. Reusing a request key with different selection/scope fails. The committed operation/item rows are the durable work queue; no token, serialized privileged AuthDto, browser query or global UI store is authority. A microservices-only startup and one-second scheduled drain processes at most 100 item attempts total per tick, round-robin across up to 100 pending operations. An in-flight guard prevents overlapping local ticks. Each worker still serializes publication at the operation row and skips completed items. One failing operation does not prevent other receipts from progressing; the next tick retries its durable work. Shutdown stops the scheduler and waits for the current item before leaving remaining work for restart. API create/retry/Undo only commit durable state; no ArchiveOperation BullMQ job is produced or exposed through the existing admin queue API.

Each item's publication transaction locks the operation, current user/session, current preferences, asset and existing privacy projection. It reconstructs current elevation/privacy using existing preference helpers and transaction-bound `AccessRepository`/`checkAccess`. The final asset update includes current session/PIN expiry and the shared hidden-content SQL predicate. A missing/revoked/expired session or inaccessible asset produces a revoked outcome; deleted or already non-Timeline assets are skipped. The archive and its receipt commit together. A per-item SQL failure rolls the asset change back to a savepoint and records an error. Originals, album membership and sensitive classification are not changed. The existing sidecar writer does not serialize visibility, so this archive-only operation does not enqueue unrelated metadata writes.

Cancellation takes the same operation lock and stops remaining items, retaining completed results. Retry uses the same durable set, rebinds authority to the requesting current session and retries only pending/error/revoked work; successes are not reapplied. Undo records the prior visibility and post-archive asset update ID. It restores only successful items that remain archived with the same update ID; any intervening asset update produces a conflict. When Undo starts after partial cancellation, never-published pending items become skipped; only published successes enter the restore queue. Undo never overwrites another change. Cancel or finish a running archive before Undo.

Owned status/list APIs return aggregate outcomes, never retained asset identities or private query text. History is obtained from the server in one aggregate query, including older unfinished work. The current small implementation returns all of the owner's operation receipts; pagination is a future performance change if operation history becomes large. The selection toolbar's **Recent archives** opens reloadable history. The dialog offers manual refresh, cancel, retry, Undo and explicit library reload; a toast or stale selection is not reported as the authoritative completed result. Access restriction/account change/logout closes the dialog, aborts requests and retires late responses. There is one batch dialog, never per-item confirmation.

## Production source and tests

- Web: `ArchiveAction.svelte`, `AssetSelectControlBar.svelte`, `ArchiveOperationsModal.svelte`; English source strings are translated through the existing i18n path.
- API: `archive-operation.controller.ts` and DTOs; generated OpenAPI and JavaScript SDK. No native generation.
- Persistence/worker: `archive-operation.repository.ts`, `archive-operation.service.ts`, the bounded private outbox drain without a new public queue job type.
- Focused PostgreSQL: `server/test/medium/specs/archive-operation.spec.ts` uses the existing disposable PostgreSQL 14 VectorChord harness and actual production migrations/repository/transactions, not a personal database.
- Focused UI: `ArchiveOperationsModal.spec.ts` and actual `ArchiveAction.spec.ts`; API transport is mocked, production Svelte logic is mounted.
- Dispatch recovery: `archive-operation.service.spec.ts`; existing queue repository and fork catalog tests cover affected shared infrastructure.

The PostgreSQL checks cover frozen/deduplicated IDs, request-key conflicts, duplicate workers, partial cancellation and Undo of only the published subset, fresh repository reload, retry, mixed owners, sensitive assets, missing/expired sessions, an observed session-row lock during revocation, guarded Undo after intervening edits, rollback after an injected receipt-write failure, and migration down/up with unchanged public schema objects and originals. UI checks cover the real Archive wiring, preserved unarchive, immutable selection across replacement, uncertain-submit retry identity, reloaded partial outcomes and late private response retirement.

Reproduce with pinned Node 24.21.0 and pnpm 11.24.0, an isolated frozen-lockfile install, locally built SDK/plugin SDK and Docker for disposable PostgreSQL:

```sh
pnpm --dir server test:medium --run test/medium/specs/archive-operation.spec.ts
pnpm --dir server test --run src/services/archive-operation.service.spec.ts src/fork-schema/catalog.spec.ts src/repositories/job.repository.spec.ts
pnpm --dir web exec vitest run src/lib/modals/ArchiveOperationsModal.spec.ts src/lib/components/timeline/actions/ArchiveAction.spec.ts
pnpm --dir server exec tsc --noEmit
pnpm --dir web exec tsc --noEmit
```

Focused lint/format apply to changed files. OpenAPI is generated from a fresh server build and JavaScript SDK from that specification. The broader Svelte diagnostic command also reports existing FL-31 search-variable ordering and detail-test wrapper typing diagnostics; those unchanged files are outside this packet. No hosted checks, authenticated browser/visual qualification or native acceptance is claimed.

## Migration and rollback

`0000000000110-ArchiveOperations.ts` is a new fork migration; released official and fork migration bytes are unchanged. No constraints attach to public tables. The fork catalog receipt adds exactly two tables and their columns/constraints/indexes plus the new migration identity; affected lock-set expectations include them. Writes share the established fork-state/handoff guard and fail closed during official handoff or unsupported fork phases.

Operational rollback first stops archive workers, preserves receipts if recovery/Undo is required, and reverts the application slice. Leaving the private tables in place preserves completed-operation evidence. The explicit down migration drops only these two receipt tables; it never reverses already committed archive changes or removes media. Dropping receipts intentionally removes future operation Undo/recovery, so it is not an implicit deployment rollback step. The PostgreSQL down/up check validates schema scope, not production rollback authorization.

## Remaining acceptance and review

Full server-materialized select-all-matching, shared cross-view scope/query contracts, semantic/Ask result-set semantics, cross-layout continuity, other bulk actions and native clients remain open under FL-31/FL-32 and their existing owners. Loaded pages/months are not substituted for that contract. The broad action-ledger row remains planned-not-qualified; this packet adds bounded implementation evidence only.

GitNexus indexed the owned worktree. The additive job-options case has HIGH upstream reach (one direct queueAll caller; 122 reachable symbols) and was reported before editing. Svelte local handlers/control components were unresolved/UNKNOWN and manually traced through real timeline routes. Independent review found a partial-cancel Undo outcome bug; its exact two-item PostgreSQL regression reproduced one false conflict before the repair and now expects one restored item, one skipped item and no pending work. The repair requires the same reviewer’s exact-candidate recheck. The bounded authenticated browser attempt stopped at worker startup because the local build lacked geodata; no authenticated browser qualification is claimed. Owned temporary services and database were removed. GitNexus refresh subsequently failed with an internal UTF-8 error; its final change-summary metadata is unreliable. Exact-candidate independent privacy, concurrency/idempotency and migration review remains required before publication. Root owns that review and all lifecycle actions.

## Reviewed browser qualification — September 21, 2026

Independent review approved `57cec47081a0e811c192ac765f120427fc4e53a0` after reproducing and repairing partial-cancel Undo: pending items never published by Archive now become skipped, while successful items are restored and genuine intervening edits remain conflicts. Eight actual archive PostgreSQL tests pass. The earlier browser startup limitation is resolved: the disposable build-data directory used real packaged geodata copied from the cached official `v3.1.0` image, without a production source hook or fake geodata.

The exact frozen candidate then passed authenticated Chromium qualification with its freshly built server, actual PostgreSQL, Valkey, microservices worker and three synthetic uploads. Real thumbnail selection and Archive produced durable worker success; reload removed the asset; Recent archives recovered its receipt; Undo restored its visibility and persisted result. A paused owned worker allowed cancellation/reload/retry of the same operation, then resumed to success. An intervening favorite edit correctly prevented Undo from overwriting the later change. The real Frameleaf navigation preference was enabled through Settings and retained receipt access on Timeline. No page errors were recorded.

Reproducible drivers, screenshots, `proof.json`, `recovery-proof.json`, `shell-proof.json` and cleanup details are in `/Users/adamtaylor/.codex/worktrees/frameleaf-fl32-browser-evidence-20260921/README.md`. All owned services, containers, authentication state, media and build fixtures were removed; source remained clean. Root integrated the reviewed candidate without changing its runtime files. Hosted checks for the integration, all-matching scope snapshots, other bulk actions, exhaustive privacy journeys and full FN204 acceptance remain open. Native/mobile work stays deferred; keep FL-32 In Progress.

## Queue response compatibility repair — 2026-09-21

Exact-head CI evidence supplied by root for `ea4a057e009d6c8cf203ded5c6c7b75f1ae13cf9` identified the unreleased ArchiveOperation value as a breaking addition to the public `GET /queues/{name}/jobs` response enum. The repair removes the job enum/type/queue-options case and executes the existing durable PostgreSQL outbox through the bounded microservices drain described above. Existing admin queue listing, statistics, names and controls are unchanged; there is no runtime filtering, renamed job, schema deception or relaxed compatibility gate. Migration110 bytes and per-item authorization/publication transactions are unchanged.

Thirty-nine focused service/job-repository/admin-queue tests pass, including nine drain regressions for API persistence without execution, startup recovery, duplicate bootstrap, overlapping ticks, round-robin bounds, per-operation and lookup failure continuation, receipt commands and shutdown. The teardown test uses the actual CronRepository/SchedulerRegistry and verifies the job stops and late ticks cannot execute. Server TypeScript/build and scoped lint pass. Generated OpenAPI and JavaScript SDK remove exactly the unreleased enum member; the queue jobs operation, response DTO and complete JobName schema exactly match fresh-default `0116d4778d7ce34e9bc41a7d1fed46a4cd88a466`. Independent review and real runtime qualification of this changed drain remain pending. Earlier browser receipts attest to their stated pre-repair runtimes only. Native/mobile and full FN204 remain open.

## Qualified compatible drain — September 22, 2026

Independent review approved exact runtime `23c31d81db3d126336984de004640cfbf2a0fc6a`. Authenticated Chromium qualification then created a durable receipt while microservices was fully stopped; a newly started worker recovered and published it. Reload/history/Undo restored the asset. Cancellation survived reload, retry completed the same receipt, and an intervening favorite edit produced a truthful Undo conflict. Both page-error arrays were empty. The actual administrator API returned all 24 queues with no ArchiveOperation job and only pre-existing job names.

The driver and proof are retained in `/Users/adamtaylor/.codex/worktrees/frameleaf-fl32-drain-browser-evidence-20260921/README.md`; all owned services, containers, authentication, media and build fixtures were removed. The subsequent [matching Archive packet](FL-32-matching-archive.md) combines this reviewed drain with server-prepared membership and has its own exact-runtime browser receipt. These are local runtime results; hosted integration and full FN204 remain open.
