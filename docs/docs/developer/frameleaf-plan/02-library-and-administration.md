# Library and administration preservation contract

Status: reviewed planning contract, not production implementation or release evidence.

This workstream preserves the existing Svelte library and administration behavior while Frameleaf adopts the approved design. It does not authorize replacing production routes with the React prototype, and it does not cover Studio, Freecut, native, release, or deployment work.

## Authoritative execution sources

Use the consolidated [backlog](backlog.json) and [Jira map](jira-map.json). The backlog currently contains eight library-workstream epics and 45 stories (`LIB-*`, `REC-*`, `IMP-*`, and `ADM-*`), all marked `planned-not-qualified`. Their complete dependency lists are authoritative.

The dirty checkout also contains `library-backlog.json`, but that fragment omits 22 dependency edges affecting 15 stories already recorded in the consolidated backlog. It is therefore not restored as a second executable graph. Do not schedule from that fragment.

Read these preservation records before changing a covered surface:

- [Web route inventory](../frameleaf-route-inventory.json) — the exact 80 committed production routes (the 70 at reviewed baseline `7cfa62336f394189c0450533c30618c66366d868` plus 10 added by FL stories, implemented in code and not qualified), plus 12 dirty-only routes recorded as absent and unreviewed.
- [Library action parity](../frameleaf-library-action-parity.md) — source action families and the evidence required before replacing them.
- [Settings and administration inventory](../frameleaf-settings-inventory.md) — current admin routes, settings composition, account boundaries, and known API gaps.

Run `node scripts/frameleaf-library-admin-contracts.mjs` to fail on production route drift, missing source paths, backlog/Jira drift, or settings-section drift. The validator does not inspect or import the dirty checkout.

## Reviewed starting point

- Clean `fork/main` has **70** Svelte page routes. Route presence is not action qualification.
- The preserved dirty checkout adds 14 page routes: classification, culling, discovery, documents, enrichment, face review, Library Care, pets, photo tools, preservation, Spaces (index/detail), Studio, and Takeout. Their application code and supporting route registry are absent from this baseline and remain **unreviewed dirty evidence**.
- `web/src/lib/frameleaf/library-session.ts` is also dirty-only. Until separately reviewed and delivered, current production routes retain their own managers/loaders; backlog items that name the shared session are not ready merely because the dirty file exists.
- The clean admin settings page composes 20 sections, and personal settings compose 14 accordions (one OAuth section remains capability-conditional). These are current source controls, not proof of a new command-center implementation.
- Prototype behavior and prior prototype test totals remain design evidence only. No prototype path is needed to validate this contract.

## Non-negotiable preservation rules

1. Keep production Svelte routes and their loaders available until replacement actions pass authorization, persistence, failure, accessibility, and rollback checks.
2. Preserve query scope, selection, open asset, playback position, and navigation context across library layouts. A dirty-only shared-session implementation is not accepted by this document.
3. Preserve original media, album membership, ownership, and access boundaries. Mark Sensitive changes classification; it must not become a move-to-Locked operation.
4. Duplicate review and aggregate evidence remain actor-only. Recheck access for reads, writes, queued work, exports, caches, and in-flight results.
5. Account feature preferences and sidebar visibility are not module ACLs. Do not describe hidden navigation as server enforcement.
6. Administrator actions retain admin authorization and resource-specific rules. Other-user session revocation and create-time PIN handling remain explicit gaps described in the settings inventory.
7. External libraries retain immutable ownership and current path/exclusion/scan semantics. A redesigned page cannot broaden filesystem access.
8. Generated clients and route links are not completion evidence. Keep every item `planned-not-qualified` until its own production acceptance is demonstrated.

## First bounded investigation wave

No library story is implementation-ready from this slice: every story is still `planned-not-qualified`, and its foundation/library dependencies remain unresolved in the canonical backlog. The safe first wave is therefore read-only or test-design investigation, not production edits or dirty implementation import:

- `LIB-002`: after `FN-101` establishes an accepted baseline, reproduce the sensitive-classification projection behavior in an isolated database before changing Locked integration.
- `ADM-003`: document the create-time PIN failing case, but do not implement it until `ADM-001` and its foundation dependencies are accepted.
- `LIB-001`, `LIB-101`, `ADM-001`: remain blocked on review of their named dirty-only shared session/query/settings-draft sources or an independently designed clean implementation.

Before starting any story, read its complete consolidated backlog record and mapped Jira issue, verify every dependency, and inspect each named production path. Missing dirty-only paths must stay recorded as missing; do not recreate them from titles or prototype screenshots.

## Completion evidence

A route or settings migration is complete only with:

- the exact production action and access contexts preserved or an explicitly approved replacement;
- loading, empty, forbidden, stale, offline, partial-success, retry, cancellation, and destructive confirmation behavior as applicable;
- keyboard, focus, screen-reader, narrow/wide, and production-sized paging evidence;
- current API/database/browser tests using disposable fixtures;
- updated preservation rows that cite the tested candidate, not historical prototype totals.

This slice ran only deterministic source/plan validation. It did not execute application tests, a live database, browser qualification, Jira transitions, or Confluence synchronization.
