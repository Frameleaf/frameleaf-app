# Action-level preservation ownership

Status: ownership-complete, implementation not qualified. Baseline: `84d32454ec558abf35f1cfe44694c1754b2cbbbf` on literal default branch `fork/main`.

This page is the readable contract for [action-preservation-ledger.json](action-preservation-ledger.json). The machine ledger is authoritative for row-level mappings; [preservation-source-evidence.json](preservation-source-evidence.json) records the normalized evidence used to generate it. Source or route presence never means implemented, authorized, tested, or release-qualified.

## Coverage

The ledger reverse-maps every accepted inventory row exactly once:

| Inventory      | Source rows | Qualification                                                                                    |
| -------------- | ----------: | ------------------------------------------------------------------------------------------------ |
| Web routes     |          92 | 80 committed routes plus 12 preserved dirty-only routes; route presence is not action parity     |
| Settings       |         535 | 530 accepted-main mappings plus 5 candidate-only mappings kept explicitly unaccepted             |
| Pinned Freecut |         210 | Source/command/render/test states remain independently unqualified                               |
| Native         |         227 | 211 committed entries plus 16 preserved dirty-only requirements; no device qualification implied |

The detailed web audit contributes another 153 action rows. They decompose shared viewer, Info/people, quick-edit, album, timeline/bulk, and search/discovery behaviors without duplicating those behaviors at each route entrypoint.

The 1,217 total source rows resolve to 1,197 canonical requirements. The only collapsed rows are 20 reviewed aliases between queue concurrency controls and their matching `system:job.<queue>.concurrency` schema leaves. A shared file, module, route loader, or target is not enough to merge requirements. Positional account/library setting IDs are retained as aliases behind semantic stable IDs, and all raw inventory IDs have a reverse mapping.

## Per-row contract

Every source row records:

- A namespaced, Jira-independent stable ID and canonical requirement ID. The 153 detailed web actions are frozen in [action-id-registry.json](action-id-registry.json); wording changes require an explicit registry migration and retained alias rather than regenerating IDs from prose or row order.
- Every known entrypoint and any reviewed legacy alias.
- A story Plan ID owner resolved to the canonical Jira key through `jira-map.json`; epics provide scope but cannot own a row.
- Explicit source, new UI, API, native, and test mapping states. Missing evidence is recorded as unqualified or not designed, never inferred from a route, prototype, generated client, or upstream test.
- One of the independent dispositions: retained production route, legacy fallback until qualified, intentional product change, or not yet designed.
- An issue-backed audit gap when the detailed audit reports missing, partial, or presentation-only behavior.

The 15 settings gaps retain specific owners. Five settings mappings are candidate-only: the Frameleaf mobile OAuth redirect field and the Takeout, preservation, enrichment, and Library Care controller-backed roadmap rows. They stay `candidate-unaccepted` until their sources land and pass their own implementation gates.

## Shared and compatibility boundaries

- A root or public loader does not authorize an asset, album, share, project, or administrator operation. Page and resource checks remain authoritative.
- Marking or unmarking Sensitive changes classification and preserves album membership. Legacy locked visibility remains a readable fallback; the new action does not relocate originals.
- Duplicate rows, counts, history, thumbnails, exports, and actions are actor-only.
- OAuth client secret, SMTP password, RunPod API key, Hugging Face token, and video-worker token use ephemeral write-only input, retain configured-state only, and are excluded from history, export, and telemetry. The video-worker token remains explicitly not designed in the source settings inventory.
- The pinned Freecut source remains a source contract. Upstream tests, commands, or render paths do not qualify Frameleaf web, native, preview, export, HDR, Dolby Vision, or distribution behavior.

## Validation

Run:

```sh
node scripts/frameleaf-preservation-ledger.mjs --check
node --test scripts/frameleaf-preservation-ledger.test.mjs
node --test scripts/frameleaf-route-inventory.test.mjs
python3 scripts/frameleaf-mobile-inventory.py --check
node --test scripts/frameleaf-studio-contracts.test.mjs
```

The fail-closed validator rejects duplicate JSON keys or IDs, unknown fields/statuses/owners, missing or extra source rows, stale source hashes or counts, broken reverse mappings, orphan entrypoints, empty mapping/test evidence, and qualification inflation. Mutation tests also prove that distinct behaviors sharing a source module do not merge without an explicit reviewed alias.

The preserved issue text also names `pnpm --dir studio verify`. That command was attempted on the fresh baseline, but `studio/package.json` and the Freecut working source remain preserved dirty-only inputs rather than accepted `fork/main` files. The committed clean-baseline Studio contract test above validates the pinned manifest, provenance, counts, ownership map, and explicitly unqualified states without importing that unreviewed tree. This does not qualify the engine build or replace the future engine verification gate.

When a requirement ships, update its source row mapping and evidence, regenerate this ledger, run the complete validation set, and preserve the legacy fallback until the replacement passes its action-level authorization and recovery checks.

## High-risk interaction decisions

[FL-27's interaction-design receipt](high-risk-workflow-design-evidence.json) adds bounded design evidence for album lifecycle/sharing, People correction, bulk recovery, Studio conflicts and native tablet adaptation. The matching requirement rows cite that receipt under their new-UI mapping and the deterministic evidence test under their test mapping. Every row remains `planned-not-qualified`: the receipt closes interaction decisions only and does not establish production Svelte, backend authorization, native Flutter, renderer, physical-device or release acceptance. The readable decisions and current-run screenshot audit are in [08-high-risk-workflow-designs.md](08-high-risk-workflow-designs.md).
