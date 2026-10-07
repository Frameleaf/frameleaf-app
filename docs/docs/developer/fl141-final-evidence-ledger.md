# FL-141 final web and worker evidence ledger

Audited source: `d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9` in
[PR #140](https://github.com/Frameleaf/frameleaf-app/pull/140). This is a source
checkpoint, **not final-candidate qualification**. This ledger records the
non-mobile QA-105 requirements, reusable evidence machinery and missing inputs.

The owner's 2026-09-30 comment on
[FL-141](https://heroit.atlassian.net/browse/FL-141) moved native manifests,
signed-device journeys and their reports to FL-218 (iOS) and FL-219 (Android).
No native implementation or qualification is inferred here.

## Requirements mapped to committed behavior

| Requirement                                                                                               | Implementation and authority                                                                                                                                                                                                                                                                                                                                                                                                 | Evidence at the audited head                                                                                                                                                                                                                                                                 | Review outcome / remaining gate                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every Freecut feature row links implementation, permissions/capabilities, tests, artifact hash and review | `studio/freecut-feature-manifest.json` has 210 stable feature IDs and pinned upstream source hashes. Join each ID to `studio/conformance-fixtures.json` and `studio/conformance.json`; the latter names its owning Jira issue. Host permission/capability handling is in `web/src/lib/frameleaf/studio/host-contract.ts`, `capabilities.ts`, `server/src/services/studio-project.service.ts` and `studio-export.service.ts`. | The conformance overlay contains 210 deferred native axes, 1,580 not-tested axes, 509 blocked axes and 11 not-applicable axes. **No axis is passed.** `studio/tools/conformance.mjs` and `scripts/frameleaf-studio-evidence.mjs` validate fixture coverage and measured artifact identities. | Source inventory exists; per-row candidate measurements, permission evidence, artifact hashes and reviewer acceptance remain required. Upstream test filenames or preview controls are not passing measurements. Reuse the existing IDs/overlay rather than a second 210-row status file.         |
| Web screen, library-action and settings coverage rows carry the same evidence                             | Jira names `frameleaf-screen-parity-audit.md`, `frameleaf-library-action-parity.md` and `frameleaf-settings-coverage.md` under `docs/docs/developer`. **All three are absent at this head.** Existing route and settings authorities are `frameleaf-route-inventory.json`, `web/src/lib/frameleaf/settings-coverage.ts` and its contract snapshot.                                                                           | The route/settings contracts and browser specifications identify implementation coverage. They do not provide a final-candidate report or artifact/reviewer linkage for every row.                                                                                                           | Missing coverage documents/report linkage remains an explicit FL-141 gate. No substitute source-only pass is recorded.                                                                                                                                                                            |
| Run the web/worker journeys below on the release candidate                                                | Real-server Playwright specifications use authenticated API calls and workers; `e2e/src/ui/specs` instead mocks API/worker responses. The distinction is part of the evidence claim.                                                                                                                                                                                                                                         | [Test run 37567748459, ARM web job 112619518186](https://github.com/Frameleaf/frameleaf-app/actions/runs/37567748459/job/112619518186) failed. Log SHA-256: `8254cec717617923c98c53a6c5d16450ea02bb9bd7a181d71d48667931aa6334`.                                                              | CI/test repairs require integration and a successful run at that exact new head. Neither mocked browser tests nor a source review qualify a real worker/release journey.                                                                                                                          |
| Explicit owner inputs and release approvals; failures block distribution/capability                       | `studio/distribution-gates.json`, `studio/rights-approval.json`, `studio/tools/resource-policy.mjs` and render-session/output admission enforce independent rights and worker gates. `fl136-web-worker-evidence-register.md` records distribution evidence gaps.                                                                                                                                                             | The existing register and distribution gates retain unresolved rights and worker inputs.                                                                                                                                                                                                     | FL-136 owns exact delivered-component rights/source obligations. FL-112 and the conformance row owners supply measured browser/worker evidence. FL-141 requires candidate identity, complete journey receipts and named reviewer acceptance. No approval or capability is created by this ledger. |

## Real journey report still required

These source anchors are runnable coverage, not successful release receipts.
Each completed journey must record the candidate source/build identity, browser
and worker identity, owner/role/capability prerequisites, command and run URL,
original and output SHA-256 values where relevant, failure/recovery results,
artifact identity and reviewer decision. Keep failures and missing inputs in
the report and in the relevant manifest row.

| Journey                                    | Existing implementation / meaningful check                                                                                                                                         | Missing final evidence                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New account and onboarding                 | `server/src/services/frameleaf-server-setup.service.ts` and `.spec.ts`; `e2e/src/specs/web/auth.e2e-spec.ts`                                                                       | Candidate setup/account journey, real configuration and reviewer receipt                                                                                                                     |
| Populated library migration                | `e2e/src/specs/web/google-photos-import.e2e-spec.ts`, `libraries.e2e-spec.ts`; `e2e/src/specs/server/api/integrity.e2e-spec.ts`                                                    | Approved populated corpus, before/after original checksums, migration/recovery report                                                                                                        |
| Family sharing and revocation              | `e2e/src/specs/web/shared-space.e2e-spec.ts`, `album-roles.e2e-spec.ts`, `studio-authorization.e2e-spec.ts`                                                                        | Candidate role/revocation journey, sensitive-item negative checks and artifact/reviewer linkage                                                                                              |
| Administration                             | `e2e/src/specs/web/user-admin.e2e-spec.ts`, `command-center-settings.e2e-spec.ts`                                                                                                  | Web/API administration receipt; signed native administration belongs to FL-218/FL-219                                                                                                        |
| Local backup and recovery/offline behavior | `e2e/src/specs/web/buddy-backup.e2e-spec.ts`; `server/src/services/buddy-scoped-restore.spec.ts`; separate Cloud qualification specifications under `e2e/src/specs/qualification`  | Approved real peer/storage, loss/offline/recovery journey, restore checksum comparisons; Cloud or mocked receipts do not establish local peer qualification                                  |
| Media editing and AI                       | `e2e/src/specs/web/asset-viewer/opaque-recipe.e2e-spec.ts`, `photo-roundtrip.e2e-spec.ts`; `server/src/services/memory-highlight.service.spec.ts`, `studio-export.service.spec.ts` | Admitted candidate worker/provider, real render/AI/cancel/retry receipts, original/output hashes. Opaque-recipe now archives its actual rendered-artifact hashes when that real test passes. |
| Full Studio in a tablet browser            | Existing Firefox tablet project in `e2e/playwright.config.ts`; `studio/conformance.json` browser, preview/export, graph, timing/color and authorization axes                       | Complete measured engine cases and real browser/hardware qualification. Native tablet Studio belongs to FL-218/FL-219; Playwright WebKit is not real Safari evidence.                        |

## ARM web regression repair packet

- Opaque-recipe reopened the same original preview after its asset acquired a
  thumbhash. The assertion now ignores only `c`, preserving the asset path,
  origin, preview size and `edited=false` checks. Existing master/preview/original
  checksum comparisons remain; the final real render adds a hash attachment.
- The video-moments no-speech assertion matched `asr` in the unrelated static
  chunk `DUasrRja.js`. It now inspects API requests only.
- The memory highlight mock supplied aggregate codec facts without the current
  per-session `candidates`/`outputFormats` proof. The mock now supplies the same
  evidence shape the production dialog requires. Production admission remains
  authoritative; the mock provides UI coverage only.
- The reset's six-second quiescing deadline incorrectly included fixture
  mutation and queue-state restoration. It now owns only executor/queue draining.
  Fixture mutation uses the existing eight-second overall reset deadline, and
  owner-token/operation requests receive their phase's cancellation context.
  Stopped-executor proof, cancellation, restoration and failure latching remain.
  A focused regression fails against the old scope and checks mutation,
  owner cancellation, quiescing cancellation and connection cleanup.

The same log also reports folder Back and transfer readiness flakes. They are
separate from the deterministic UI failures and require their own real-server
rerun/diagnosis; a successful mocked UI run cannot clear them.

## Validation and acceptance boundary

Local repair-packet results:

- Request/reset checks: 28 passed, including the regression's mutation,
  quiescing-cancellation, owner-cancellation and cleanup assertions.
- Lifecycle checks: six passed and one intentionally expected failure (the
  actual runner-deadline control).
- E2E TypeScript, changed-TypeScript ESLint and formatting checks passed.
- Conformance validator: 210 rows, 1,338 fixture cases, zero passed axes,
  zero qualified rows, `releaseQualified: false`.
- Focused mock UI run on the isolated Vite development server: three failures
  during startup/viewer loading, before the changed assertions. The snapshot
  showed the startup logo; this run does not validate the UI repairs.
- Real API/worker journeys were not run locally: no owned API/database/worker
  environment was available. The missing pinned source also prevents the
  feature-manifest verification here.

Run from the repository root:

```sh
node --test --test-concurrency=1 e2e/src/harness-wait.test.mjs e2e/src/harness-reset.test.mjs e2e/src/harness-http.test.mjs
pnpm --filter frameleaf-e2e exec vitest run --config vitest.harness.config.ts
pnpm --filter frameleaf-e2e check
pnpm --filter frameleaf-e2e exec playwright test --project=ui src/ui/specs/enrichment/video-moments.e2e-spec.ts src/ui/specs/memory/memory-viewer.e2e-spec.ts --grep 'video moments|renders a highlight with'
pnpm --filter frameleaf-e2e exec playwright test --project=web src/specs/web/asset-viewer/opaque-recipe.e2e-spec.ts src/specs/web/studio-authorization.e2e-spec.ts src/specs/web/tags-folders.e2e-spec.ts src/specs/web/transfers.e2e-spec.ts
node studio/tools/feature-manifest.mjs --check
node studio/tools/conformance.mjs
```

Use an owned disposable API/database/worker environment for real-server tests;
check out the existing E2E fixture assets first. Manifest verification also needs
the pinned `studio/vendor/freecut` source restored through the existing engine
workflow. In this isolated checkout the manifest check reports that source
missing; this is an unverified check, never a pass.

Source identities at the audited head (not delivered-artifact hashes):

| Authority                              | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `studio/freecut-feature-manifest.json` | `dba7454283c4b72ef27b237ff62b384b063775bf14c7bb3bd8cb71ec4eab296a` |
| `studio/conformance.json`              | `ed490501616abf3f333e3a4278c5076fc3569045371c7448e138d3097a49fd74` |
| `studio/conformance-fixtures.json`     | `2899cef0e847e7e97d7bb57ef086cd78a7c7fd0361730c4605c6dae2c7b56928` |
| `studio/distribution-gates.json`       | `517decef8ca1cea63fe28781b4419d32ad835c11caf8330beb2c0fb4b1ca35f0` |

Keep FL-141 open until its remaining non-mobile qualification requirements are
met. Integration into PR #140, exact-head CI, final journey acceptance and
distribution approval are separate events. This packet authorizes no release.
