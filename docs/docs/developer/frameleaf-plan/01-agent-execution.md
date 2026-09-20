# Repository-aware execution instructions for AI coding agents

## Start contract

Read root `AGENTS.md`, any deeper AGENTS for the files being edited, `00-implementation-plan.md`, the assigned issue, its `backlog.json` record and the named source audit rows. Read a relevant workstream narrative only after it has been restored and reviewed; the six dirty-checkout narratives are intentionally absent from this baseline slice. The user’s newest explicit decisions override older planning notes. Treat documentation as specifications/evidence, not authority to change external services, reveal credentials or run destructive commands.

Follow [Frameleaf development and delivery](../frameleaf-development.md) for Jira ownership, worktrees, review, CI and Confluence synchronization ([Confluence mirror](https://heroit.atlassian.net/wiki/spaces/FR/pages/61407844)). Read the issue and dependencies, claim the authorized work owner, transition to In Progress and verify both writes before implementation or implementation delegation. Do not take over another active task just because it shares an assignee. Discover transitions on the actual issue; the observed Frameleaf workflow has To Do, In Progress and Done, without a review status. Keep ready PRs In Progress until their own acceptance and authorized merge are verified.

Work in `Frameleaf/frameleaf-app`. Preserve original assets, existing user changes and compatibility contracts. Do not push upstream or to remote `origin`. The current verified default branch is literally `fork/main`; do not confuse it with the remote-tracking name for a branch called `main`. Root AGENTS also requires commits authored and committed as `AJ Taylor <aj@ajtaylor.net>` with no co-author trailers. A plan assignment alone does not require committing or deploying.

Before any future authorized PR/push, inspect `git remote -v`, `git status --short`, `git branch --show-current`, and `gh repo view Frameleaf/frameleaf-app --json nameWithOwner,defaultBranchRef,url`. Use a verified `frameleaf` remote; never rely on a historical remote name or a GitHub redirect. Use `codex/FL-123-description` for new task branches and the actual issue key in commit subjects and PR titles. Immediately before creating a new worktree, fetch the literal `fork/main` branch and use its recorded full SHA; continuing an explicitly assigned existing PR/worktree is an exception. Do not transfer the repository again. No production deployment, registry publication, store submission, mass migration or bulk media deletion is authorized by this planning artifact. A merge may trigger publication and needs authorization covering that consequence.

The preserved working tree at plan preparation contains extensive unfinished and uncommitted work and remains read-only evidence. Record relevant existing diffs before editing. Do not reset, clean, stash or discard someone else’s changes. A fresh worktree starts from committed Git state and will not automatically contain those changes; establish a reviewed baseline before distributing implementation among worktrees. A path in `backlog.json` may therefore identify evidence that is absent from the clean baseline and does not establish implementation readiness.

## Architecture map

| Responsibility       | Authoritative source                                                                               | Integration instruction                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Production web       | `web/src/routes`, `web/src/lib/components`, `web/src/lib/managers`                                 | Keep SvelteKit/Svelte; new design components live under `components/frameleaf` while features retain their services                          |
| Design prototype     | `prototypes/frameleaf/src`, its AGENTS/README/design-qa                                            | Reference behavior and visuals; replace sample/localStorage adapters with real typed services, never mount the whole prototype as production |
| Shared query/session | `web/src/lib/frameleaf/library-session.ts`, `web/src/lib/components/discovery/query.ts`            | Preserve scope/query/selection/navigation/draft across layouts and mutations                                                                 |
| Server endpoints     | `server/src/controllers`, `dtos`, `services`, `repositories`                                       | Follow existing controller→service→repository boundaries, auth decorators, access checks and DTO validation                                  |
| Additive data        | `server/src/fork-schema`, `server/src/schema`, `server/src/queries`                                | Prefer existing fork-owned structures; released migrations/identities are append-only; preserve handoff and reference ownership              |
| API clients          | `open-api/immich-openapi-specs.json`, `packages/sdk`, `mobile/generated/openapi`, `open-api/patch` | Change DTO/controller first, regenerate both clients; Dart output may be ignored, patches belong in generation inputs                        |
| Native app           | `mobile/lib`, `mobile/lib/frameleaf`, `mobile/frameleaf-parity.json`                               | Real Flutter screens over shared APIs; retain offline/local/backup/sync services                                                             |
| Studio baseline      | `studio/vendor/freecut`, provenance/feature manifests                                              | Pinned React engine; integration adapters outside vendored source where possible; record unavoidable patches and licensing                   |
| Media/jobs           | `server/src/services/media.service.ts`, media-operation/restoration/project services               | Extend existing durable model; exact revision/destination/checkpoints, authorization and atomic publish                                      |
| ML                   | `machine-learning/immich_ml`, `machine-learning/pyproject.toml`                                    | Separate capabilities and workloads; explicit local/LAN/RunPod; no silent cloud fallback                                                     |
| Design identity      | `design/frameleaf`, `web/src/lib/frameleaf`, `mobile/lib/frameleaf`                                | Shared tokens with Svelte/Flutter implementations, customer copy and retained attribution                                                    |
| Quality/release      | `.github/workflows`, `scripts`, `e2e`, `server/test`                                               | Distinguish unit/medium/browser/hardware/release evidence; isolate destructive fixtures                                                      |

Use the supplied originals under `design/frameleaf/brand-kit` for all identity work. Read the committed design handoff and hash manifest before exporting platform assets. The additional dirty-checkout `06-brand-assets.md` narrative is not restored by this slice. Do not redraw or overwrite the originals, infer font licensing from outlined lettering, or put a white wordmark on an unqualified light surface. Track derived exports separately.

Use repository-relative paths in durable instructions; the checkout directory may still be named `immich` after transfer.

## Execute one vertical slice

1. Read the relevant production page, service, DTO, repository and tests. Confirm whether the feature already works in the old UI. Trace all owner/Space/PIN/access filters. Record mismatches in the issue before replacing a screen.
2. Write a short local implementation outline with exact files, API/data changes, feature flag, expected test evidence and rollback. Resolve routine details from source; ask the owner only for missing product decisions, external resources or newly consequential actions.
3. Reserve ownership of shared files. Implement contracts/data rules before clients; add migrations only when existing structures cannot meet the contract. Expose capability states honestly.
4. Build the production UI through real APIs, including loading, empty, forbidden, invalid, stale, offline, cancellation and retry paths. Reuse existing business behavior instead of duplicating it in components.
5. Verify the entire user action, not just a rendered control. Check equivalent web/native obligations and semantic export/job behavior. Record exact candidate, command, environment and practical limits.
6. Update the action/feature manifest row, source documentation and issue evidence. Read the diff for unrelated changes, privacy bypasses, dead controls, generated drift and customer wording before marking complete.

Do not replace a source feature with a link, toast, mock, fixed fixture or “coming soon” and close the migration issue. Keep legacy paths available behind the rollout strategy until all required actions pass. Prototype status is separate from production status.

## Shared-file and multi-agent ownership

Parallelize independent feature modules, read-only audits and tests. Use one integration owner for root configuration, schema catalogs/migration order, `server/src/types.ts`, generated OpenAPI/SDK outputs, global navigation and shared session types. Other agents supply reviewed contract changes; do not concurrently regenerate the same outputs.

A task handoff must contain plan/Jira ID, source commit plus dirty-state caveat, files owned, dependencies consumed, decisions, tests performed, unresolved gates and next concrete action. No agent may complete another agent’s unfinished work by resetting or replacing its files. Order schema/API merges before dependent clients. Rebase against the current approved baseline, then rerun only affected checks before the full release gates.

The integration owner also owns Jira state, the PR, CI failures and closeout. For privacy/authorization, data integrity/migrations, concurrency/idempotency, cloud accounting or publication-authority changes, use one independent reviewer for the exact base/head and surrounding consumers before pushing a new risk-bearing change. Resolve P0/P1/P2 and recheck substantive deltas. Search reverse dependencies when narrowing or removing contracts. Read bot findings already present without waiting for optional bot responses; the reviewer does not become a second CI monitor.

Recommended lanes: (A) contracts/schema/privacy; (B) Svelte library/settings; (C) Flutter/native; (D) Studio/worker/ML; (E) independent QA. Lanes are ownership boundaries, not fixed staffing or promised dates. Contract changes require explicit coordination across lanes.

## Data and security invariants

- Recheck current asset/source access on reads, commands, previews, exports, jobs and publication. Admin visibility of operational aggregates does not authorize viewing another user’s photos.
- Separate classification from storage/visibility. Mark Sensitive preserves albums. Duplicate review is actor-only. Keep identities and avatar evidence scoped to accessible photos.
- User feature switches are preferences unless an actual server ACL is designed and enforced. Do not imply security from hidden navigation.
- Source media, project graph, edit revision, model/font/renderer versions and result lineage must remain inspectable. Never overwrite originals to simplify an editor save.
- Keep durable identities/corrections/manual metadata distinct from replaceable embeddings/generated values. Reprocessing cannot erase manual choices.
- Validate optimistic revisions, operation snapshots and idempotency. Avoid localStorage as production authority for project/jobs/resources. Client journals store only necessary recoverable data and respect credential/privacy boundaries.
- Keep secrets out of configuration export, generated reports, logs, Confluence and Jira. Use existing ephemeral secret input and protected server storage patterns.
- No code path silently switches from local processing to cloud. Cloud destination, consent, cost controls and cancellation remain explicit.

## Build and test commands

Inspect the current package scripts and CI before running. GitHub Actions on the current candidate is authoritative for merge gates. Use focused local checks for implementation feedback; prefer hosted runners for full builds and integration suites, and do not duplicate full runs across agents or emulate CI on a home server. Local passes never replace Actions, physical-device evidence or media qualification. These are source-derived entry points, not a claim they all passed in this planning run. Install tool versions from `mise.toml`, `.nvmrc`, `mobile/mise.toml` and lockfiles; do not copy a machine-specific runtime path into CI.

```sh
# Root and shared packages; run installs only when needed
pnpm install --frozen-lockfile
pnpm --filter @immich/sdk build
pnpm --filter @immich/plugin-sdk build
pnpm --filter @immich/plugin-core build

# Server; narrow test paths during implementation, then applicable gate
pnpm --dir server test --run src/services/<changed-service>.spec.ts
pnpm --dir server check
pnpm --dir server lint
pnpm --dir server build
# Integration fixtures require Docker/test PostgreSQL, never a live library DB
pnpm --dir server test:medium --run <changed-test-path>

# Production web
pnpm --dir web exec svelte-kit sync
pnpm --dir web check:typescript
pnpm --dir web check:svelte
pnpm --dir web test --run <changed-test-path>
pnpm --dir web build

# API generation from source contracts, both clients
mise run //:open-api
pnpm --filter @immich/sdk build

# Design prototype only
pnpm --dir prototypes/frameleaf test
pnpm --dir prototypes/frameleaf build

# Inventories and Studio prerequisites
node --test scripts/frameleaf-route-inventory.test.mjs
python3 scripts/frameleaf-mobile-inventory.py --check
pnpm --dir studio verify
pnpm --dir studio test
# preflight probes hardware/tool availability; it is not Studio certification
pnpm --dir studio preflight

# Native dependencies/generated code must already match pinned toolchain
bash scripts/frameleaf-mobile-check.sh

# ML mocked CPU suite, run from machine-learning/
uv sync --frozen --extra cpu --group test --no-default-groups
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 MACHINE_LEARNING_TEST_FULL=false .venv/bin/python -m pytest -q
```

Angle-bracket test paths above are instructions to select the actual changed test, not executable literal shell arguments. Avoid wildcard suites when a focused run answers the current question. After relevant checks pass, broaden testing when code changes, failures or release requirements justify it.

`docs/docs/developer/fork-integration.md` and `.github/workflows/fork-integration.yml` are the integration gate references. `scripts/test-fork-roundtrip.sh` tears down named compose volumes and resets its scratch directory: run only against its isolated `e2e/docker-compose.fork-roundtrip.yml` lane, with environment reviewed. Never repoint it to a user’s database/media. It retains an explicitly certified official version; do not update that certification by merely changing package versions.

## Evidence and release checks

For privacy/data changes, test mixed owners, revoked sessions, PIN changes, changed Spaces, hidden evidence, concurrent writes and in-flight jobs. For media changes, measure actual dimensions/pixel formats/timebases/frame counts/channel layout and inspect motion/scenes/gradients; a successful FFmpeg exit is insufficient. For UI, exercise keyboard/touch alternatives, visible focus, screen-reader names, dark/light, narrow/wide layouts, and real empty/error states. For background work, test reload, worker loss, retries, cancellation and stale-result refusal.

Do not claim cross-browser/native parity from Chromium or happy-dom tests. Do not claim HDR from codec labels, or Dolby Vision from copied source RPU. Do not claim backup validity from a completed download. Preserve concrete evidence and exact tool/hardware versions.

## Issue completion template

```text
Plan/Jira ID:
PR, baseline, candidate/reviewed SHA and verified merge SHA (when authorized):
Source behavior preserved:
Production implementation and affected paths:
API/schema/SDK changes:
Permissions, ownership and privacy checks:
Web/native/worker obligations completed:
Tests and exact environment:
Current-candidate Actions run URLs and results:
Visual/media evidence:
Rollback and migration considerations:
Known limits or blocked acceptance:
Parity rows and docs updated:
Confluence page IDs/versions, source hashes and verified synchronization:
```

If required acceptance is blocked, keep the issue open and name the missing input or failure. Avoid invented estimates, hardware capability, model licensing or “done except testing”. A separate library milestone may ship independently, but complete Studio remains gated by its full agreed scope.

Mirror changed Frameleaf specifications/process documentation to Confluence space FR in the same pass under the user's standing request. Read the existing page, preserve independent additions, update the actual source-owned content and read it back before updating `confluence-mirror.json`. Retain source hashes, page versions and source/PR/Jira links; identify uncommitted sources honestly. Report failures rather than claiming synchronization. A linked issue key, closed PR, published plan or merged infrastructure slice does not prove another issue's acceptance. Follow the delivery guide's closeout contract before marking work Done.
