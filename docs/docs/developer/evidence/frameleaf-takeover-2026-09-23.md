# Frameleaf recovery checkpoint — 2026-09-23

This is execution evidence, not a specification or a claim of release readiness. The September 22 prototype remains the UI authority. The original [agent handoff](../frameleaf-plan/12-agent-handoff-2026-09-23.md) remains historical; this checkpoint records the subsequent recovery. No default-branch merge, container publication, deployment, or complete prototype acceptance is claimed.

## Reconciled sources

The takeover inspected 80 local worktree entries and 45 remote branches, including branches with no PR. Dirty worktrees were preserved. Recovery started from `frameleaf/claude/frameleaf-implementation` at `2fb1c3ae5e973d30dd12e83e643a54ec49099e25`; the freshly observed default `fork/main` was `1303c1e702f1dcaf7be3b8e7d4e38a4240c99498`. The existing integration PR is [#137](https://github.com/Frameleaf/frameleaf-app/pull/137), still draft at this checkpoint.

Only the `frameleaf` remote is a publication target. The local integration branch is `aj/frameleaf-takeover-20260923`. The following candidates were independently reviewed, repaired where needed, and integrated locally:

| Work                             | Accepted candidate                         | Important repairs                                                                                                                  |
| -------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| FL-75 migration operator flow    | `5bb33e13bb734156f6ad306a54beafc1e13a596d` | Prototype storage placement, operator wording, migration guide and mirror receipt                                                  |
| FL-106 project derivatives       | `6b0579bec064903b0283b6b74cc376ebb08722ed` | Claim and publication fencing, Locked inheritance, descendant traversal and stale publication races                                |
| FL-41 server recovery            | `cacb1da589b23e1bc3e4ba468dc1b8890b494769` | Preserve manual sensitive-content review when new detection results arrive                                                         |
| FL-41 web recovery               | `ecf59f386dbb55fe3ababca3dcab1396f881429d` | Quick-editor copy/paste and draft rebasing, Studio cleanup, person action callbacks                                                |
| FL-79 scoped analytics           | `e0537ae0d319cc9f2a68e43ad37c2be6505d3e77` | Locked counts, failed-report clearing and CSV formula neutralization                                                               |
| FL-60 classification rules       | `62f8719d0679c3ba46f4a3b86e1cce9173592402` | Owner-only manual decisions, Locked counts, archive provenance, transaction locks and current-rule fences                          |
| FL-78 external libraries         | `c14c95596a689a1536f3ec3340c32381eef21ff0` | Scan claim/lease and lifecycle fencing, empty-root protection, Locked statistics and raw path validation                           |
| FL-82 workflows and applications | `31422494769ce14b90bbec0725e8de5b662829ae` | Credential-path validation, stable step identities, retry definition fencing, dirty-close guards and retryable application loading |

Additional integration repairs include the initial library router-ready guard and removal of inactive pagination (`7ac32b88ed`), reconciled catalog and migration unions, verified documentation receipts, and core-plugin test dependency wiring (`9d6bca3730`). The catalog contains 170 tables: 137 public and 33 fork-owned.

## Verified local evidence

The combined application source through `230dafff30` passed 244 server unit files / 5,663 tests and 222 web unit files / 2,438 tests, with two web tests skipped. The web run printed local fetch/abort warnings but exited successfully. Core-plugin WASM was then built with the repository-pinned Extism 1.7.0 and Binaryen 124 toolchain. All 27 core-plugin PostgreSQL checks passed after the test fixture was updated at `9d6bca3730` to supply the real classification repository and explicit retry queue mock. Earlier combined workflow repository/service/write checks passed 19 tests.

Other completed checks:

- Server and SDK builds, regenerated OpenAPI and TypeScript client with no generated differences, and web TypeScript checks after generating SvelteKit route types.
- 127 PostgreSQL checks across classification, albums, external libraries and migration ledgers. Three initial library failures were missing pinned test assets; all passed after initializing `e2e/test-assets` at `6742055402de1aa48f93d12ded7d18f4057f9d1f`.
- The browser regression for initial library view persistence passed against a disposable local server.
- All ten documentation-coverage mutation checks passed. The current inventory is 517 source anchors, 73 Confluence receipts (37 current, 36 historical), 1,199 requirements and 1,219 ledger rows.
- Reproducibility documentation was mirrored to Confluence page `61440795`, version 7, and fully read back. Its source SHA-256 is `61c790669a0788ccbb497d1f7fdd263d9f59277e585eda2085609aec836d69ef`.

These are local results, not current-head GitHub Actions results. The complete PostgreSQL suite at `9d6bca3730` passed all 1,483 tests across 121 files, and server type checking passed. The initial fresh catalog comparison preceded normal geodata import and had two expected geodata-index shape differences; it is not full catalog certification. Smart Commit ingestion for the pushed FL-75 update remained unverified after bounded checks; no Jira completion is claimed.

## Active work and remaining acceptance

FL-83 privacy and conformance work remains outside the integration branch. Independent review of `41cec1edb1993ac5c7683e892a71f981df291d00` requested repairs for cached portal dialogs reappearing after lock and native modal state blocking the lock shield's Retry button. Offscreen selection and per-asset memory operation results were accepted. The owner is repairing those remaining findings before another review.

FL-69 candidate `0b723a1768cb4f5bab694fa0213de272574394cd` was independently approved and integrated at `b6ec8a00a1`. Utilities now use the prototype Command Center directory and tool sections, with account-appropriate access and legacy URL redirects. Repairs cover accordion teardown navigation, geolocation actions respecting the visible selection, and verified Live Photo outcomes retained for the loaded review. Outcome history is not persisted across reloads. The integration passed 22 focused utility tests, 17 route/ledger checks, TypeScript and Svelte checks with zero errors or warnings. Four moved backlog anchors were updated at `6b09791780`; all ten documentation-coverage checks pass with source digest `079e756405c87945bf1809377799cb764973e1559de5803cb05125afa2267fd3`.

FL-80 is porting login, first-admin registration, forced password change and PIN screens from the prototype. The real session-cookie/OAuth contract was independently approved at `ea0f67d624f119050884b24807ca550cfc422eca` and integrated at `66e9246bfa`. An explicit false value omits persistence only on authentication cookies; omitted or true retains the existing lifetime. All 135 focused authentication and cookie-controller checks passed. Web wiring, OAuth continuation and forced-password handling remain under implementation. Full onboarding, maintenance and supporter screens remain separate work.

The broader conformance backlog remains open: full Command Center structure, workflow All accounts administration, remaining library/viewer/editor/people/queue flows, complete browser journeys, SDK qualification and release gates. Native/mobile and the dependent Studio editor remain parked as recorded in the original handoff. Hardware and rights checks remain explicit acceptance dependencies. No issue is marked Done merely because a candidate passed review or local tests.

## Hosted qualification after the recovery push

PR #137 was updated to `d8031e062c2d4c5cf8fb216f1815b84c54e9013b` on September 23 at 18:26 UTC. At 18:41 UTC, 28 checks had succeeded; fork integration and both web E2E jobs were still running. This is a dated snapshot, not a claim about the current PR head.

Exact failed-job logs identified these repairs:

- Docs build job `107321950937`: inherited handoff formatting, repaired at `43c267a787`. Full local documentation format and build passed; two existing broken-anchor warnings remain.
- CLI unit job `107321951435`: the migration report test imported the web TypeScript parser through a build path requiring generated SvelteKit state. Commit `4b101d5a5f` loads the same parser through Node's TypeScript transform. All 69 CLI tests, type checking and scoped lint/format passed.
- Server/CLI E2E ARM job `107321951693`: six failures remain assigned for repair—three album response expectations missing the new smart-album fields and three offline-library fixtures rejected by strict import-root validation. The run recorded 413 server tests passed, six failed and 14 skipped; all 20 CLI E2E checks passed. The x64 sibling was cancelled.

The cookie, Utilities and local hosted-failure repairs described above are newer than the pushed `d8031e062c` checkpoint. They require another combined push and hosted qualification.
