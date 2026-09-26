---
title: Frameleaf development and delivery
---

# Frameleaf development and delivery

Frameleaf development lives in [Frameleaf/frameleaf-app](https://github.com/Frameleaf/frameleaf-app), on the literal default branch `fork/main`. Work is tracked in [Jira project FL](https://heroit.atlassian.net/jira/software/c/projects/FL/boards/233/backlog). The [implementation plan](https://heroit.atlassian.net/wiki/spaces/FR/pages/61538319) and the assigned issue define acceptance; infrastructure readiness is separate from application feature parity.

A [Confluence mirror of this guide](https://heroit.atlassian.net/wiki/spaces/FR/pages/61407844) records the setup checkpoint and review links.

## Jira and GitHub

The existing **GitHub for Atlassian** application connects the Frameleaf organization to `heroit.atlassian.net`. On September 19, 2026, its configuration showed one repository with backfill **Finished** and full access. No duplicate installation, new Jira API token, or webhook secret is required by these workflows.

Use the assigned issue key consistently:

| Item               | Example                                   |
| ------------------ | ----------------------------------------- |
| Branch             | `codex/FL-118-frameleaf-delivery`         |
| Commit subject     | `ci: FL-118 configure Frameleaf delivery` |
| Pull request title | `ci: FL-118 configure Frameleaf delivery` |
| Pull request base  | `fork/main` in `Frameleaf/frameleaf-app`  |

GitHub autolinks resolve `FL-123` to `https://heroit.atlassian.net/browse/FL-123`. The **Jira Issue Key** check validates a key in human PR titles; it does not execute Smart Commits, query Jira or establish that an issue exists. Dependabot-authored dependency branches have an explicit exception. The workflow reads event metadata without checking out PR code or granting write access.

Use the [Frameleaf delivery and release skill](https://github.com/Frameleaf/frameleaf-app/blob/fork/main/.agents/skills/frameleaf-deploy-release/SKILL.md), stored at `.agents/skills/frameleaf-deploy-release/SKILL.md`, for commits, PRs and closeout. Delivery commits must contain a real single-line command such as `FL-123 #comment Added the reviewed change; qualification remains pending.` in the Git message. A key in the title or a command pasted into a PR description is insufficient. Verify the resulting Jira comment after pushing and record its commit and comment ID. Only log actual authorized time; discover live transitions and never send a completion command before merge and acceptance.

Squash commits currently use `PR_TITLE` with `COMMIT_MESSAGES`. Before an authorized merge, explicitly prepare the final message so historical Smart Commit commands are not replayed by the new squash SHA. Retain all issue keys and record a fresh merge milestone only where appropriate. These instructions do not authorize merging or changing account privacy/settings. See [Atlassian's Smart Commit syntax](https://support.atlassian.com/jira-software-cloud/docs/process-issues-with-smart-commits/).

The Atlassian app links branches, commits, pull requests and Actions builds using these keys. It does not need a custom workflow to post comments on every issue. After the first issue-linked PR, verify the actual branch, commit and PR in that issue's Development panel; the app's installation alone does not prove event delivery.

`.jira/config.yml` reserves development, testing, staging and production names for future **real deployments**. A deployment workflow must create a GitHub deployment and report its `deployment_status` against the deployed SHA. Building or publishing a container is not a deployment. These workflows do not synthesize successful deployment events or connect a home server.

References: [Atlassian connection setup](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/), [issue linking](https://support.atlassian.com/jira-cloud-administration/docs/use-the-github-for-jira-app/), [build and deployment reporting](https://support.atlassian.com/jira-cloud-administration/docs/link-github-workflows-and-deployments-to-jira-issues/).

## Issue ownership and lifecycle

Use this sequence for Jira-backed implementation. Read-only discovery can precede a claim; implementation and implementation delegation cannot.

1. Read the `FL-` issue, acceptance criteria, dependencies, remote links and relevant Confluence/source specifications. Inspect the current assignee, status, existing PRs and recent work before claiming. If no issue is specified, find the matching Frameleaf issue; do not invent a key or silently reuse an unrelated issue.
2. Write a short implementation outline. Inspect ready sibling issues in the same workstream; batch them only when they are within the user's requested scope and share a coherent change. Claim each included issue and retain separate acceptance evidence. A dependency marked To Do is not satisfied by assumption: verify the actual baseline, or limit work to an independent slice and record the outstanding gate.
3. Assign the issue to the authorized work owner and transition it to **In Progress** before editing or delegating implementation. Discover the available transitions on that issue at runtime; status IDs and transition IDs are different. Assignment may require a separate edit from the transition. Read back both writes. If claiming fails or another task owns the work, pause dependent implementation; continue independent read-only discovery. The same assignee is not proof of ownership when several agents share an account: inspect the linked task/PR and explicitly coordinate.
4. Create a fresh worktree as described below, or continue the explicitly assigned existing PR/worktree. Give each subagent the issue key, relevant specification links, source/base/head, dirty-state caveat, acceptance criteria, owned files and outstanding gates. One owner integrates shared-file changes and monitors CI.
5. Implement a reviewable slice, apply the risk-based review contract, and open a ready PR. Use a draft for unfinished scope or when requested, recording what remains. Include the exact acceptance evidence, migrations/rollback implications and unresolved requirements; a draft is not a substitute for reporting CI failures.
6. Read review findings already present and own failing checks through resolution. Keep Jira In Progress while the PR is reviewed or awaiting merge. If review requires changes, remain In Progress and update the same PR rather than claiming a second delivery.
7. Once the required current-candidate checks pass and blocking findings are resolved, verify merge authorization, including the publication consequences below. Prepare the concrete result before requesting any missing authorization. Do not merge merely to transition an issue.
8. After an authorized merge, verify GitHub reports `MERGED` into `fork/main`, record the merge SHA, check/run links, acceptance evidence and documentation mirrors. Transition the issue to **Done** only when its own required acceptance is satisfied. Close child tasks independently; do not close an epic because one PR mentions its key. Keep any unqualified release, device, media or deployment acceptance open.

On September 19, 2026, FL-118 exposed **To Do**, **In Progress** and **Done** only. There was no **Needs Review** transition. Use the ready PR as the review signal and leave Jira In Progress; do not invent a status, copy HeroNet's transition IDs, or modify the project workflow as part of an implementation task. Re-discover transitions if the workflow changes.

For reconciliation, an issue key in another PR's description, a closed-but-unmerged PR, or a green historical run is insufficient. Verify the issue's own change and acceptance against its actual merged PR/commit. Non-code documentation tasks may complete on verified document delivery when that is their acceptance; they do not require a fabricated application release. Preserve existing issue descriptions and other contributors' evidence when recording progress. Do not add unsolicited comment spam or change global workflow/automation settings.

## Baseline and worktree

Read root `AGENTS.md`. Verify both remote URLs and GitHub's default branch before writing to a remote. Do not push to `origin`, the old account, or upstream. An explicitly verified `frameleaf` remote is used for this transition. Preserve uncommitted application work; an isolated worktree starts with committed state only.

Use author and committer `AJ Taylor <aj@ajtaylor.net>` with no co-author trailers. Include reproducible validation and outstanding acceptance criteria in the PR. Do not mark a Jira issue complete just because a PR exists.

Immediately before creating a new task worktree, inspect these facts and fetch the exact default branch:

```sh
git status --short
git remote -v
gh repo view Frameleaf/frameleaf-app --json nameWithOwner,defaultBranchRef,url
git remote get-url frameleaf
git remote get-url --push frameleaf
# Only after both URLs resolve directly to Frameleaf/frameleaf-app:
git fetch --prune frameleaf refs/heads/fork/main
git rev-parse FETCH_HEAD
```

Record the returned full SHA and supply that literal SHA to `git worktree add -b codex/FL-123-description <new-path> <recorded-SHA>`, replacing the example issue/path placeholders. Do not base new work on stale local `fork/main`, another feature branch, or a redirect from the former owner. If the named remote is missing, configure an explicit Frameleaf remote within the user's existing repository authorization, then verify it; never fall back to pushing `origin`.

Read-only audits, continuation of an explicitly assigned existing PR/worktree, and cleanup of the owning worktree do not require a new branch. For a continuation, record its current head and inspect its divergence from the verified default branch. Do not rebase or copy dirty application work merely to make the baseline look current. If implementation requires uncommitted sources from another checkout, resolve and review that dependency before distributing work.

## Review contract

Use one independent reviewer when a change affects authorization or sensitive-media/privacy boundaries, migrations/data integrity, concurrency/locking/idempotency, cloud charges or usage accounting, or release credentials and publication authority. Give the reviewer the exact base/head SHA pair, issue/specification links, diff and relevant callers. Perform this review before the first push of a new risk-bearing change; an already published PR still needs review of newly added risks before merge.

Require severity-ranked actionable findings or an explicit statement that none were found. Resolve P0/P1/P2 before proceeding. Track valid P3 follow-ups without reducing the issue's required acceptance. Recheck substantive production/risk changes with the same reviewer; a replacement reviews the complete candidate and the delta from the last clearance. Record the reviewed SHA pair. Pure documentation/formatting or mechanical fixture corrections do not require another full review unless they weaken acceptance or alter a risk boundary.

Search reverse dependencies with `rg` when an API, exported type, handler registration, enum, permission or configuration identity is removed or narrowed. Check service consumers, SDK/native counterparts, compatibility scripts and deployment references, not only the changed files. Do not assume HeroNet-only analysis tools or hooks are installed.

Read bot findings already available on the PR, but do not request, poll, or wait for optional review bots. Their silence is not approval. Use GitHub's GraphQL `reviewThreads` connection for inline threads; `gh pr view --json reviewThreads` is not supported. Ordinary copy, documentation and low-risk mechanical changes use focused consistency checks and applicable Actions rather than unnecessary independent full audits. The owner, not the reviewer, owns the check queue, Jira state and cleanup.

## Validation policy

GitHub Actions results for the current candidate are the merge authority. Read `.github/workflows` and the current required-check configuration instead of assuming a helper or historical result proves qualification. Focused local tests, generators and visual checks remain available when needed for development, using pinned toolchains and isolated fixtures. They are diagnostic/implementation evidence, not substitutes for hosted checks. Prefer Actions for broad builds and full integration/round-trip suites; do not have multiple agents repeat full suites or emulate CI on a home server. HeroNet's local execution ban and memory estimates are not Frameleaf requirements.

After relevant checks pass, repeat or broaden them only for changed code, a new failure, an unresolved concern or a required qualification gate. Never use a personal photo library, live database or production credentials as a test fixture. Hardware/browser/physical-device qualification must name the actual environment and remains outstanding when unavailable.

PR workflows use GitHub-hosted runners and read-only tokens, including contributions from other repositories. They do not require inherited GitHub App credentials or mobile signing secrets. Retained branch-protection contexts are:

- Test & Lint Server
- Test Web
- Lint Web
- Medium Tests (Server)
- Unit Test Mobile
- Unit Test CLI
- Run Dart Code Analysis
- SQL Schema Checks
- ShellCheck
- Docs Build
- OpenAPI Clients

The Actions test commands remain the source of truth. Do not replace a required test with a passing placeholder or relax branch protection to hide a failure. The API comparison uses the PR's exact base revision; `api-breaking-approved` remains the existing explicit exception for intentional changes.

Monitor the actual candidate head and, where GitHub tests a synthetic merge commit, record both the PR head and tested merge SHA. A push invalidates claims about the previous head; check the replacement runs. For failures, inspect the failed job/step and raw logs with `gh api repos/Frameleaf/frameleaf-app/actions/jobs/<job-id>/logs`. A shortened rendered log or missing tail alone does not prove an OOM. Classify repository failures, setup failures and external outages; repair the relevant cause without suppressing checks. Keep useful run URLs and conclusions in the PR evidence. Do not repeatedly rerun unchanged failures or dispatch a publishing workflow to test a PR.

Inherited workflows that wrote to unowned npm, Docker Hub, Cloudflare, F-Droid, translation, mobile-store or release destinations are disabled. Re-enabling one requires an owned destination, scoped credentials and qualification. Source SDK generation and application tests remain active; transfer does not convey ownership of `@immich/sdk`.

CodeQL analyzes PRs with read-only permissions and retains reports as workflow artifacts. A separate upload-only job reports trusted mainline results to GitHub's Security tab. It does not check out or execute PR code with write permissions.

## Confluence synchronization

Repository Markdown is authoritative; Confluence space **FR** is the readable mirror. The user has requested mirroring for this project, so synchronize changed Frameleaf specifications and process instructions in the same work pass. This standing request covers those documentation pages, not unrelated spaces, permissions, project workflows or messages to other people.

1. Find the existing source-to-page mapping in `docs/docs/developer/frameleaf-plan/confluence-mirror.json` when present, or the document's mirror link. The delivery guide is page `61407844`, agent execution is `61407516`, and the implementation-plan parent is `61538319`. Search before creating a page; preserve its ID and hierarchy.
2. Read the current remote page before writing. Compare it with the last mirrored source/hash. Preserve independently authored content and resolve conflicting specification edits rather than overwriting them blindly. Keep dated setup evidence distinct from current instructions.
3. Update the corresponding page's actual content, not just a local "synced" flag or comment. Include the repository-relative source path, SHA-256 of the source bytes and a GitHub source/PR backlink. Label uncommitted/worktree sources honestly; never link them as if already merged into the default branch. Retain Jira and parent-plan links. Keep credentials and sensitive operational data out of mirrors.
4. Read back the published page, verify its content and returned version, then update the local mapping with the source hash/bytes, page ID/URL/version and verification result. Update only entries actually synchronized. If the map is absent from an isolated checkout, record the receipt with the owning planning checkout rather than fabricating a new implementation baseline.
5. Report any synchronization failure or unresolved conflict as outstanding; do not claim documentation is mirrored. Do not treat publication of a plan as implementation acceptance or auto-complete its Jira issues.

Use available Jira/Confluence connectors or authenticated APIs. Discover their current tool names and issue transitions instead of embedding session-specific MCP names or tokens in instructions. Full-page replacement is appropriate only for a reviewed source-owned mirror; use the provider's supported concurrency/snapshot mechanism for partial edits where available.

## Container names and compatibility

| Artifact         | Frameleaf destination                          |
| ---------------- | ---------------------------------------------- |
| Server           | `ghcr.io/frameleaf/frameleaf-server`           |
| Machine learning | `ghcr.io/frameleaf/frameleaf-machine-learning` |
| CLI              | `ghcr.io/frameleaf/frameleaf-cli`              |
| PostgreSQL       | `ghcr.io/frameleaf/frameleaf-postgres`         |

Frameleaf builds and pulls only its own images. The server and development Dockerfiles build their base (Node, the PostgreSQL clients, jellyfin-ffmpeg, and libvips, ImageMagick, libheif, libjxl, jpegli and LibRaw compiled from pinned revisions) inside the Dockerfile, between the `frameleaf-server-base` markers, from the scripts, version pins and patches in `server/base-image`. They reproduce the former upstream base images of the same revision, and no separate base image is published. `docker/postgres` builds the database image with PostgreSQL 14, VectorChord 0.4.3, pgvector 0.8.1 and pgvecto.rs 0.2.0, the exact versions of the image it replaces, verifying each extension package's checksum. The **Postgres Image** workflow builds and tests it on both architectures for pull requests; publishing requires the repository variable `FRAMELEAF_ENABLE_POSTGRES_PUBLISH=true` and a published release or a manual dispatch on the exact current `fork/main`, like the CLI. Development, local production, end-to-end, medium, SQL-schema and certification runs build the database from `docker/postgres` rather than pulling it. Release Compose files reference `ghcr.io/frameleaf/frameleaf-postgres:14-vectorchord0.4.3-pgvectors0.2.0`, which must be published (and made public) before those files resolve for users.

The one exception is the compatibility target. The official-container certification lanes (`.github/workflows/fork-roundtrip.yml`, `e2e/docker-compose.fork-roundtrip.yml` and `scripts/test-fork-roundtrip.sh` with its test) pull the exact official server image named in `server/src/fork-schema/supported-versions.json`, because they certify the handoff to it. The handoff command and its administration pages name the same image as the target an operator switches to. Frameleaf never ships or runs that image itself. Dated evidence and historical plans (`docs/docs/developer/evidence`, `docs/superpowers`, `.superpowers`) record the images used when they were written and are not rewritten; the source comments in `docker/postgres/Dockerfile` and the base block name the upstream image and revision they reproduce.

Registry names are explicitly lowercase. Server and ML images carry source metadata for `Frameleaf/frameleaf-app`. The ML hardware suffixes are `-cuda`, `-openvino`, `-armnn`, `-rknn` and `-rocm`; CPU has no hardware suffix. Architecture support is declared in the build matrix. Every ML build selects `prod`.

CLI builds are read-only by default. Publication additionally requires the repository variable `FRAMELEAF_ENABLE_CLI_PUBLISH=true`. [Release events created with `GITHUB_TOKEN` do not trigger another release workflow](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), so the container release workflow cannot be assumed to trigger CLI publication. The **CLI Build** manual dispatch provides an explicit fallback: select `fork/main` and request publication; it verifies the exact current commit and publishes its SHA tag. It does not turn a manual build into a stable release. This variable is not enabled during setup.

Compose's visible container names use Frameleaf. Existing service keys, project/volume identities, mount paths, database settings, environment variables and internal ML DNS remain compatible. Updating image references must not allocate a new empty database or detach an existing upload directory. Third-party dependencies such as Valkey and the Node and pgvector base images keep their own names; the compatibility-target image above keeps its upstream name. See [Docker installation and migration](https://github.com/Frameleaf/frameleaf-app/blob/fork/main/docker/README.md).

Cloud processing is Frameleaf Cloud (see [Workers and Endpoints](/administration/workers-and-endpoints#frameleaf-cloud)); no machine-learning image variant is built for it.

## Build and release flow

An implementation request authorizes preparing the change; it does not by itself authorize merge, registry publication, runtime deployment or store submission. Reuse explicit authorization already given in the session within its scope. Prepare the candidate, review and CI evidence before asking for a missing approval. In this pipeline a merge to `fork/main` can cause container publication and stable promotion automatically: include that consequence in the merge decision. Do not copy HeroNet's automatic-merge rule or assume it only deploys on a separate manual dispatch.

1. A reviewed change reaches `fork/main`. **Deploy** runs the integration and official handoff/round-trip qualification workflows before publication.
2. The publisher builds changed server/ML images, including hardware variants. Unchanged images may reuse only an immutable digest recorded in a published Frameleaf release manifest whose same-repository Deploy run succeeded. It verifies the original build source is an ancestor and compares all tracked Docker inputs and build-policy files against the current SHA. It never uses a rolling image tag or only the previous push as reuse evidence. Missing evidence, changed inputs or failed verification selects a build; manual Deploy dispatch builds all images only for a source revision with no existing candidate tags, checked before scheduling image builds. Native architecture runners publish manifest lists.
3. Candidate publication owns `commit-<full-SHA>` and `edge` tags, with corresponding ML hardware suffixes. These are development artifacts, not an application feature qualification or installation instruction to deploy automatically.
4. The release workflow verifies a successful Deploy run for that exact SHA and the current default-branch head. It preflights every candidate's expected platforms, original source labels and content digests. Reused candidates retain original build labels and carry separate qualification annotations; promotion rechecks the published evidence, ancestry and unchanged inputs. Release manifest schema 2 records current qualified `sourceCommit` separately from original `buildSourceCommit` and `buildDigest`. Existing schema 1 releases remain eligible only when their exact original source and digest verify.
5. The release promoter alone owns `latest`, `release`, and versioned `frameleaf-v<version>-<sequence>` tags. Releases include matching Compose, environment-example and hardware configuration files. The former competing Unraid publisher no longer writes overlapping tags.

Manual release requests pass the same provenance checks. Reuse preserves original embedded build IDs and source links. External package repositories can change independently of tracked source; dependency refresh requires a new source revision that changes the dependency or build-policy inputs. Manual Deploy dispatch cannot refresh an already published source SHA: it rejects both existing fresh and reused candidates before scheduling builds. Retry failed jobs from the original run for interrupted publication recovery; commit and version tags are never overwritten. A build-policy change requires a new build before reuse resumes. Failed, stale, foreign-repository or incomplete builds must not promote stable tags. Tags are mutable registry references; they are not a cryptographic provenance claim. The release manifest and source revision record what was qualified. Publication across several registry tags is not transactional; rerun recovery must preflight all candidates before advancing the remaining tags.

Runtime API versions still come from `server/package.json`; a Frameleaf release sequence is separate from SemVer. Automatic application update checks remain disabled in the current application. Enabling Frameleaf updates later requires a structured base version, release sequence and source revision, rather than parsing `frameleaf-v3.2.0-1` as SemVer. The existing About version link still targets upstream and belongs to the application identity migration; build/source metadata now identifies Frameleaf. Official-client APK links remain unchanged until separately signed Frameleaf downloads exist.

GHCR publishing uses the repository `GITHUB_TOKEN` with job-scoped package write permission; no Docker Hub credentials are required. New GHCR packages may initially be private. After an authorized first publication, an organization administrator must confirm package visibility and repository access before advertising anonymous installation. No image publication, home-server upgrade or production deployment is performed by preparing this infrastructure PR.

Keep distinct evidence for (1) merged source and current checks, (2) complete image manifests/digests and release assets, (3) the actual deployed revision and health, and (4) application/media acceptance. A registry tag or healthy HTTP response proves only its own step. Record previous image digests and migration compatibility before an authorized upgrade; reverting containers does not undo database migrations. Compose, Unraid/rootless installations, local/LAN workers and optional Frameleaf Cloud processing remain valid Frameleaf targets. There is no implied Kubernetes/Argo, Ubicloud, Infisical or HeroNet production endpoint requirement.

Use Frameleaf's existing release sequence and runtime-version contract. Do not create HeroNet-style Jira Versions or adopt another repository's tag format. If release tracking is later added to Jira, explicitly map it to the qualified Frameleaf artifacts without substituting it for release evidence.

## Validation and activation

Offline checks include workflow YAML/action validation, trigger/admission fixtures, release provenance and manifest fixtures, Jira policy fixtures, and Compose/image metadata checks. Run the checked-in helpers with the repository's configured Node runtime and installed workspace dependencies:

```sh
node .github/check-runners.cjs
node .github/check-release.cjs
node .github/check-jira.cjs
node --test scripts/frameleaf-workflows.test.mjs .github/frameleaf-release.test.cjs
node --test docker/frameleaf-delivery.test.mjs
```

These checks cannot certify a build of every image, public GHCR access, signing, or official round-trip execution. The PR must run its real hosted checks before merging. Once merged under separate authorization, inspect the Docker and release workflows' actual results before using stable containers. No release gate should be reported as qualified from a static fixture alone.

Repository settings observed during setup: Actions enabled, default token permission **read**, workflow PR approval disabled, no self-hosted runners, and no repository Actions secrets or variables. Existing branch protection was retained. Mobile signing, npm publication, production deployment targets and store identities remain separate release configuration.

## Closeout evidence

Use this compact receipt in the PR and authorized issue/document updates. Keep acceptance-specific detail in the linked evidence rather than copying complete CI logs.

```text
Issue key(s) and acceptance covered:
Repository, default branch, source baseline and candidate SHA:
PR URL, state, reviewed base/head and unresolved findings:
Required Actions run URLs, tested revision and results:
Production/native/worker/media acceptance and remaining gates:
Documentation sources, FR page IDs/versions and synchronization results:
Merge authorization and verified merge SHA (if merged):
Image/release provenance and deployment evidence (if in scope):
Rollback/migration implications:
Issue status and next owner/action:
```

After verified completion, remove only your own clean worktree/branch where appropriate. A squash merge changes commit ancestry: verify the merged PR and preserved work before deleting the task branch. Never use cleanup to discard uncommitted work or delete another task's checkout. A completed documentation slice does not close an infrastructure issue with remaining build, release or compatibility acceptance.
