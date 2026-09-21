# FL-32 selected-asset background archive

Status: bounded production candidate, not full FL-32 acceptance. FL-32 remains In Progress; native/mobile are deferred. Base: reviewed `9a729f04e2103010c68615516be644bb503a6698`, layered on freshly fetched Frameleaf `fork/main` `0116d4778d7ce34e9bc41a7d1fed46a4cd88a466`. Root owns publication, Jira and hosted checks.

## Delivered scope

The existing timeline Archive action opens a production Svelte dialog with a copied, deduplicated explicit owned selection and visible count. The dialog captures the selection and request key before loading anything. Filter/selection changes cannot rewrite that request. The server accepts at most 10,000 explicitly selected IDs per operation; this is not “all matching.” Existing unarchive, keyboard shortcuts and other synchronous API callers retain their established paths.

`POST /archive-operations` persists the selection, owner, initiating session, request key and per-item records atomically in two fork-owned tables. Reusing a request key with different selection/scope fails. The background queue receives only the durable operation ID; no token, serialized privileged AuthDto, browser query or global UI store is authority. Pending database rows recover an enqueue failure or worker interruption through the existing queue infrastructure's one-minute drain and startup drain. A delivery processes at most 100 items before yielding; duplicate deliveries serialize at the operation row and skip completed items.

Each item's publication transaction locks the operation, current user/session, current preferences, asset and existing privacy projection. It reconstructs current elevation/privacy using existing preference helpers and transaction-bound `AccessRepository`/`checkAccess`. The final asset update includes current session/PIN expiry and the shared hidden-content SQL predicate. A missing/revoked/expired session or inaccessible asset produces a revoked outcome; deleted or already non-Timeline assets are skipped. The archive and its receipt commit together. A per-item SQL failure rolls the asset change back to a savepoint and records an error. Originals, album membership and sensitive classification are not changed. The existing sidecar writer does not serialize visibility, so this archive-only operation does not enqueue unrelated metadata writes.

Cancellation takes the same operation lock and stops remaining items, retaining completed results. Retry uses the same durable set, rebinds authority to the requesting current session and retries only pending/error/revoked work; successes are not reapplied. Undo records the prior visibility and post-archive asset update ID. It restores only successful items that remain archived with the same update ID; any intervening asset update produces a conflict. Undo never overwrites another change. Cancel or finish a running archive before Undo.

Owned status/list APIs return aggregate outcomes, never retained asset identities or private query text. History is obtained from the server in one aggregate query, including older unfinished work. The current small implementation returns all of the owner's operation receipts; pagination is a future performance change if operation history becomes large. The selection toolbar's **Recent archives** opens reloadable history. The dialog offers manual refresh, cancel, retry, Undo and explicit library reload; a toast or stale selection is not reported as the authoritative completed result. Access restriction/account change/logout closes the dialog, aborts requests and retires late responses. There is one batch dialog, never per-item confirmation.

## Production source and tests

- Web: `ArchiveAction.svelte`, `AssetSelectControlBar.svelte`, `ArchiveOperationsModal.svelte`; English source strings are translated through the existing i18n path.
- API: `archive-operation.controller.ts` and DTOs; generated OpenAPI and JavaScript SDK. No native generation.
- Persistence/worker: `archive-operation.repository.ts`, `archive-operation.service.ts`, one additive ArchiveOperation queue type and deduplication case.
- Focused PostgreSQL: `server/test/medium/specs/archive-operation.spec.ts` uses the existing disposable PostgreSQL 14 VectorChord harness and actual production migrations/repository/transactions, not a personal database.
- Focused UI: `ArchiveOperationsModal.spec.ts` and actual `ArchiveAction.spec.ts`; API transport is mocked, production Svelte logic is mounted.
- Dispatch recovery: `archive-operation.service.spec.ts`; existing queue repository and fork catalog tests cover affected shared infrastructure.

The PostgreSQL checks cover frozen/deduplicated IDs, request-key conflicts, duplicate workers, partial cancellation, fresh repository reload, retry, mixed owners, sensitive assets, missing/expired sessions, an observed session-row lock during revocation, guarded Undo after intervening edits, rollback after an injected receipt-write failure, and migration down/up with unchanged public schema objects and originals. UI checks cover the real Archive wiring, preserved unarchive, immutable selection across replacement, uncertain-submit retry identity, reloaded partial outcomes and late private response retirement.

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

GitNexus indexed the owned worktree. The additive job-options case has HIGH upstream reach (one direct queueAll caller; 122 reachable symbols) and was reported before editing. Svelte local handlers/control components were unresolved/UNKNOWN and manually traced through real timeline routes. Exact-candidate independent privacy, concurrency/idempotency and migration review remains required before publication. Root owns that review and all lifecycle actions.
