---
title: FL-34 sensitive projection evidence
---

# FL-34 sensitive projection

[FL-34](https://heroit.atlassian.net/browse/FL-34) remains In Progress. This is a bounded server repair, not complete Locked UI, derivative, native, release or deployment qualification. Mobile work is explicitly deferred by the user.

## Reproduction and repair

Baseline: `5acd172436a0c8b68d93e51527c5461812511310` from the verified `Frameleaf/frameleaf-app` default branch `fork/main`.

An isolated PostgreSQL medium test called `ImageEnrichmentService.updateAssetEnrichment` with `MarkNsfw`, then queried through the production `withoutNsfwAssets` filter. Before the fix, the call succeeded but the supposedly hidden asset remained visible. The active writer saved `asset_enrichment.provenance` without updating `asset_privacy`, while subsequent reads trusted the unchanged privacy row and overlaid its value back onto enrichment.

The shared enrichment writer now persists the effective classification and review suppression in the existing privacy row inside the same per-asset advisory-lock transaction as enrichment. Missing privacy rows fail closed for reads and model writes. An owner-authorized explicit mark/safe action can repair its own missing privacy row using the new manual decision, without reconstructing it from stale legacy metadata. Undefined detector classifications retain the existing privacy flag. Detection success/failure and description-assisted detection retain manual review; visible detector bookkeeping uses the reviewed effective result.

This changes no schema, migration, API, generated client, album membership, asset visibility or original path. Legacy and dual-write authority paths remain in place. Rolling back code restores the old writer behavior; already recorded privacy decisions remain in their sidecars.

## Focused local evidence

Node `24.21.0`, Vitest `4.1.11`, isolated Testcontainers PostgreSQL image `ghcr.io/immich-app/postgres:14-vectorchord0.4.3`. No user library or live database was used.

From `server/`:

```sh
node node_modules/vitest/vitest.mjs --config test/vitest.config.medium.mjs --run test/medium/specs/services/image-enrichment.service.spec.ts
node node_modules/vitest/vitest.mjs --config test/vitest.config.mjs --run src/services/image-enrichment.service.spec.ts
node_modules/.bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/repositories/fork-privacy.repository.ts src/services/image-enrichment.service.ts test/medium/specs/services/image-enrichment.service.spec.ts
```

- Nine PostgreSQL cases: mark→query→safe for timeline/archive/legacy Locked; idempotent mark retry; missing privacy row with manual-only repair; rollback when projection fails; both manual decisions against in-flight model completion and subsequent model failure; elevated administrator cross-owner denial; independent tag/person suppression after marking safe.
- Existing image-enrichment unit suite: 34 passing tests.
- Server typecheck and changed-file lint passed.
- GitNexus upstream impact ran before edits. The new method belongs to a high-risk privacy repository (10 direct users); the changed enrichment writer has four direct callers. Explicit-worktree change detection was run before committing. Its stale line mapping reported nearby backfill/read methods as touched; source diff confirms their bodies were not changed.

These are local implementation checks. Hosted exact-candidate Actions, independent privacy review and Jira Smart Commit ingestion must be recorded separately before delivery is considered verified.

## Remaining FL-34 acceptance

The current Locked production route still selects legacy `visibility=locked`. Sensitive classification and tag/person suppression have separate source semantics. A future sensitive-only Locked timeline must retain legacy compatibility explicitly and avoid converting classification into relocation. The existing `suppressedOnly` query also includes configured tag/person suppression and must not silently be reused as an exact sensitive-only query.

Cross-tab/device locking, remote revocation, PIN expiry/reset, open viewers/search/Trash, downloads/exports, names/facets/counts and derivative source restrictions still require production integration and end-to-end qualification. The named historical `docs/library-privacy-audit.md` and derivative-privacy source are absent from this clean baseline; their historical Confluence mirrors are evidence, not proof of delivered implementation. No UI or broad privacy-completion claim is made by this server slice.
