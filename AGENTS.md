# Local Tests and CI Validation

All CI tests and validation commands for this repository are allowed to run on
this machine, including unit, integration, and end-to-end tests, linting,
typechecking, builds, and CI workflow emulation. This authorization also applies
to this repository's worktrees.

This supersedes any earlier guidance that prohibits local tests or requires
validation to run exclusively in GitHub Actions. Agents may run these checks
locally without additional permission.

# Frameleaf agent instructions

This file routes repository work. Read the linked detail relevant to the task rather than loading every workstream. The user's current instructions take precedence over older planning notes.

## Repository and baseline

- Work only in `Frameleaf/frameleaf-app`. Never push, open PRs, or merge against upstream repositories, including `immich-app/immich`.
- The default branch is literally `fork/main`, not remote `fork` plus branch `main`. Verify repository metadata and remote URLs before every remote write. Never push to a remote named `origin`; use an explicitly verified `frameleaf` remote. Historical `fork` URLs may still point to the former owner.
- Before creating a task branch/worktree, claim the Jira issue, fetch the verified Frameleaf default branch, and start from that exact fetched SHA. See the [baseline procedure](developer-documentation/frameleaf-development.md#baseline-and-worktree). Continuing an explicitly assigned existing PR/worktree and read-only audits are exceptions to creating a new worktree.
- Preserve uncommitted work. Do not reset, clean, stash, or overwrite another task's changes. A worktree contains committed state only; it must not silently omit an uncommitted dependency. Establish a reviewed baseline before delegating dependent implementation.
- Use author and committer `AJ Taylor <aj@ajtaylor.net>` for every created commit. Verify both identities; never add co-author trailers.

## Jira-backed delivery

- Use the [Frameleaf delivery and release skill](.agents/skills/frameleaf-deploy-release/SKILL.md) when starting work that will ship by PR, committing, opening/updating a PR, resolving CI, or handling Jira closeout, merge or release. Include actual Jira Smart Commit commands in delivery commits and verify their result in Jira; issue keys alone only link activity. Follow the skill's squash-message check to avoid replaying commands.
- Read the assigned `FL-` issue, dependencies, linked Confluence specifications and relevant source inventories before implementation. Claim ownership and transition to **In Progress** before edits or implementation delegation; verify both writes. Do not take over another active task or reopen completed work implicitly.
- Use `codex/FL-123-description` branches, include the real issue key in commit subjects and PR titles, and target `fork/main`. Batch closely related assigned issues only when scope and ownership remain clear.
- Discover transitions on the actual issue. Frameleaf currently has **To Do**, **In Progress**, and **Done**; it has no review transition. Keep a ready PR's issue In Progress until acceptance and authorized merge are verified. Do not copy transition IDs from another project.
- One owner coordinates implementation, PR checks, issue state and closeout. Give subagents bounded file ownership, acceptance criteria, baseline/head, dependencies and review scope; a reviewer is not a second CI monitor.
- Follow the [delivery lifecycle](developer-documentation/frameleaf-development.md#issue-ownership-and-lifecycle). A PR, a linked key, a mock control or generated SDK does not establish completion.

## Review and CI

- Use one independent review agent for changes to authorization/privacy, data integrity or migrations, concurrency/idempotency, cloud cost accounting, or release credentials/publication authority. Review the exact candidate and its callers before pushing a new risk-bearing change. Fix P0/P1/P2 findings and recheck substantive deltas. Routine documentation/copy changes need a focused consistency review, not a redundant full audit.
- When removing or narrowing an API, permission, handler, enum or configuration identity, search its callers and deployment references with `rg`. Do not limit review to changed lines.
- Read existing bot feedback and act on valid findings; do not wait for optional bot output or treat silence as approval. Discover actual installed checks rather than assuming HeroNet's bots/tools exist here.
- Do not run builds, full test suites, bundlers or parallel Node processes on the operator's Mac (7 GB RAM); it crashes the session. Push a branch and let GitHub Actions run every check. Local verification is limited to reading code, single-file syntax checks and one light dev server for previews.
- GitHub Actions is authoritative for merge gates on the current candidate. Focused local checks remain available under the [validation policy](developer-documentation/frameleaf-development.md#validation-policy); they never replace hosted checks, media qualification or physical-device evidence. Do not run duplicate full suites across agents.
- Open ready PRs for reviewable completed slices; use drafts for explicitly requested drafts or genuinely unfinished work and state the missing gates. Own CI failures and report exact-head evidence. Never weaken required tests or branch protection to obtain green checks.

## Documentation and implementation contracts

- Before any web or native UI work, read the authorized private design requirements and [design instructions](design/AGENTS.md). Use the [runnable template](design/frameleaf/template/README.md), [reference screens](design/frameleaf/references/README.md), and supplied SVGs in `design/frameleaf/brand-kit/` as the approved design reference. Adapt the reference to production Svelte while preserving feature parity; simulated prototype behavior is not production implementation.
- The inherited Flutter app (`mobile/`), its Dart client generator and the F-Droid `fastlane/` link have been removed; Frameleaf is building its own native iOS and Android apps. Do not restore them, and do not add mobile parity work to web or server stories. Server APIs the future native apps will use (including sync) remain in scope and stay unchanged for installed mobile clients; record protocol changes for the native apps.
- The September 22, 2026 prototype in `design/frameleaf/template/src` is authoritative for product design. Production screens, navigation, labels, controls, states and flows must match it; do not report a difference from the prototype as an open question, fix it. Only behaviour the prototype does not cover is a product question. Its React code is a specification, not code to mount: port the design and behaviour into production Svelte and NestJS.
- Keep Frameleaf plans and plan mappings private. Use the assigned Jira issue and authorized private planning source for implementation acceptance.
- Screen/action/settings/native/Freecut inventories are preservation contracts. Keep production workflows until replacements pass action-level checks. Prototype tests, route links and generated clients do not prove parity.
- Preserve original media, ownership/access boundaries and existing Frameleaf API and storage contracts. The canonical PostgreSQL 19 database is Frameleaf-owned; the frozen one-time import is the only source-database compatibility boundary. Do not restore switch-back machinery, source migration ledgers or ongoing upstream tracking. Preserve source attribution and intentional package/API identifiers instead of globally replacing `immich` strings. Duplicate review remains actor-only; sensitive classification preserves album membership; cloud processing is explicit.

## Merge, publication and deployment

- Do not merge, publish, dispatch publishing workflows, deploy, or submit mobile applications unless the user has authorized that operation. Existing session authorization remains valid within its scope; do not ask twice. Prepare a concrete reviewed candidate before seeking any missing approval.
- Merging into `fork/main` can trigger automatic Docker publication and stable promotion. Account for that consequence before merge. A ready PR does not authorize publication, and a published image does not prove a deployed or qualified application.
- Use the [Frameleaf release flow](developer-documentation/frameleaf-development.md#build-and-release-flow), owned GHCR destinations and exact-SHA provenance gates. Do not import HeroNet's Kubernetes, Ubicloud, secret-store or versioning assumptions; Compose/Unraid and local/LAN workers remain supported here.
- After an authorized merge, verify GitHub reports **MERGED**, confirm the issue's own acceptance evidence, synchronize documentation and only then mark the corresponding issue Done. Keep release/deployment acceptance open when still unqualified. Clean up only owned, clean branches/worktrees; preserve unrelated work.
