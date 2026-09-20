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

GitHub autolinks resolve `FL-123` to `https://heroit.atlassian.net/browse/FL-123`. Squash commits default to the PR title, retaining the issue key. The **Jira Issue Key** check requires a valid-looking uppercase key in human PR titles; it does not query Jira or establish that an issue exists. Dependabot-authored dependency branches have an explicit exception. The workflow reads event metadata without checking out PR code or granting write access.

The Atlassian app links branches, commits, pull requests and Actions builds using these keys. It does not need a custom workflow to post comments on every issue. After the first issue-linked PR, verify the actual branch, commit and PR in that issue's Development panel; the app's installation alone does not prove event delivery.

`.jira/config.yml` reserves development, testing, staging and production names for future **real deployments**. A deployment workflow must create a GitHub deployment and report its `deployment_status` against the deployed SHA. Building or publishing a container is not a deployment. These workflows do not synthesize successful deployment events or connect a home server.

References: [Atlassian connection setup](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/), [issue linking](https://support.atlassian.com/jira-cloud-administration/docs/use-the-github-for-jira-app/), [build and deployment reporting](https://support.atlassian.com/jira-cloud-administration/docs/link-github-workflows-and-deployments-to-jira-issues/).

## Local work and pull requests

Read root `AGENTS.md`. Verify both remote URLs and GitHub's default branch before writing to a remote. Do not push to `origin`, the old account, or upstream. An explicitly verified `frameleaf` remote is used for this transition. Preserve uncommitted application work; an isolated worktree starts with committed state only.

Use author and committer `AJ Taylor <aj@ajtaylor.net>` with no co-author trailers. Include reproducible validation and outstanding acceptance criteria in the PR. Do not mark a Jira issue complete just because a PR exists.

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

Inherited workflows that wrote to unowned npm, Docker Hub, Cloudflare, F-Droid, translation, mobile-store or release destinations are disabled. Re-enabling one requires an owned destination, scoped credentials and qualification. Source SDK generation and application tests remain active; transfer does not convey ownership of `@immich/sdk`.

CodeQL analyzes PRs with read-only permissions and retains reports as workflow artifacts. A separate upload-only job reports trusted mainline results to GitHub's Security tab. It does not check out or execute PR code with write permissions.

## Container names and compatibility

| Artifact         | Frameleaf destination                          |
| ---------------- | ---------------------------------------------- |
| Server           | `ghcr.io/frameleaf/frameleaf-server`           |
| Machine learning | `ghcr.io/frameleaf/frameleaf-machine-learning` |
| CLI              | `ghcr.io/frameleaf/frameleaf-cli`              |

Registry names are explicitly lowercase. Server and ML images carry source metadata for `Frameleaf/frameleaf-app`. The ML hardware suffixes are `-cuda`, `-cuda-runpod`, `-openvino`, `-armnn`, `-rknn` and `-rocm`; CPU has no hardware suffix. Architecture support is declared in the build matrix. Regular ML builds select `prod`; only the RunPod variant selects `prod-runpod`.

CLI builds are read-only by default. Publication additionally requires the repository variable `FRAMELEAF_ENABLE_CLI_PUBLISH=true`. [Release events created with `GITHUB_TOKEN` do not trigger another release workflow](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), so the container release workflow cannot be assumed to trigger CLI publication. The **CLI Build** manual dispatch provides an explicit fallback: select `fork/main` and request publication; it verifies the exact current commit and publishes its SHA tag. It does not turn a manual build into a stable release. This variable is not enabled during setup.

Compose's visible container names use Frameleaf. Existing service keys, project/volume identities, mount paths, database settings, environment variables and internal ML DNS remain compatible. Updating image references must not allocate a new empty database or detach an existing upload directory. Official dependencies and compatibility-test images retain their upstream names. See [Docker installation and migration](https://github.com/Frameleaf/frameleaf-app/blob/fork/main/docker/README.md).

The RunPod default points to the Frameleaf CUDA RunPod image. Explicitly configured custom images remain unchanged. Existing provider resource names and adoption identifiers stay intact so renaming the application does not strand an existing pod.

## Build and release flow

1. A reviewed change reaches `fork/main`. **Docker** runs the integration and official handoff/round-trip qualification workflows before publication.
2. The publisher builds every server/ML candidate from the exact SHA, including hardware variants, rather than retagging an unrelated mutable branch image. Native architecture runners publish manifest lists.
3. Candidate publication owns `commit-<full-SHA>` and `edge` tags, with corresponding ML hardware suffixes. These are development artifacts, not an application feature qualification or installation instruction to deploy automatically.
4. The release workflow verifies a successful Docker run for that exact SHA and the current default-branch head. It preflights every candidate's expected platforms and source revision before promoting stable tags.
5. The release promoter alone owns `latest`, `release`, and versioned `frameleaf-v<version>-<sequence>` tags. Releases include matching Compose, environment-example and hardware configuration files. The former competing Unraid publisher no longer writes overlapping tags.

Manual release requests pass the same provenance checks. Failed, stale, foreign-repository or incomplete builds must not promote stable tags. Tags are mutable registry references; they are not a cryptographic provenance claim. The release manifest and source revision record what was qualified. Publication across several registry tags is not transactional; rerun recovery must preflight all candidates before advancing the remaining tags.

Runtime API versions still come from `server/package.json`; a Frameleaf release sequence is separate from SemVer. Automatic application update checks remain disabled in the current application. Enabling Frameleaf updates later requires a structured base version, release sequence and source revision, rather than parsing `frameleaf-v3.2.0-1` as SemVer. The existing About version link still targets upstream and belongs to the application identity migration; build/source metadata now identifies Frameleaf. Official-client APK links remain unchanged until separately signed Frameleaf downloads exist.

GHCR publishing uses the repository `GITHUB_TOKEN` with job-scoped package write permission; no Docker Hub credentials are required. New GHCR packages may initially be private. After an authorized first publication, an organization administrator must confirm package visibility and repository access before advertising anonymous installation. No image publication, home-server upgrade or production deployment is performed by preparing this infrastructure PR.

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
