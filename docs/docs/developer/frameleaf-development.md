# Frameleaf development and delivery

Frameleaf owns its application schema, PostgreSQL job processing, database image, schema tooling and releases. Start with [setup](./setup.md), the [canonical database migration rules](./database-migrations.md) and [job recovery behavior](../administration/jobs-workers.md). The [offline importer](../administration/import-immich.md) is a one-way entry point into a fresh database. Source attribution and frozen import fixtures remain; ongoing upstream tracking and database switch-back are outside the architecture.

## Baseline and worktree

Use the `Frameleaf/frameleaf-app` repository and verify the `frameleaf` remote URL before remote writes. The default branch is literally `fork/main`. Fetch it immediately before starting new independent work and record the exact baseline commit. Use an isolated worktree and preserve other tasks' uncommitted files.

When continuing an explicitly assigned PR or implementation branch, use its current head and integration target. For the PostgreSQL hard cut, the target is PR #140's `master/frameleaf-implementation` branch. Integration there does not authorize merging that PR into `fork/main` or publishing the application.

Use the active task's branch convention and commit as `AJ Taylor <aj@ajtaylor.net>` without coauthor trailers. Record source changes, hosted validation, integration, publication and deployment as separate outcomes.

## Issue ownership and lifecycle

Read the assigned issue and acceptance criteria, claim it, and verify its In Progress state before implementation. Keep one owner for issue state, PR delivery and each external operation. Give implementation and review agents bounded ownership, an exact baseline, acceptance criteria and the applicable repository constraints. Agents do not duplicate the parent's CI monitoring.

Use the [delivery skill](https://github.com/Frameleaf/frameleaf-app/blob/fork/main/.agents/skills/frameleaf-deploy-release/SKILL.md) for Smart Commit commands and verify their actual issue activity after push. An issue key alone establishes a link, not a transition or completed delivery. Keep the issue In Progress while acceptance or the authorized integration remains outstanding. A source review, generated artifact or passing subset of tests does not close a larger architecture change.

Review data integrity, privacy, migration, concurrency, replay and release-authority changes independently. Resolve actionable findings before integrating. Preserve clear distinctions between tests authored, tests executed, runtime behavior observed and platform acceptance.

## Validation policy

GitHub Actions is the authority for the current commit. Do not run full tests, builds, bundlers, generators or parallel Node processes on the operator's Mac. Task constraints may be stricter. Use source inspection and individual syntax/format checks for immediate feedback, then collect hosted results for the exact head.

The ordinary **Test** workflow covers the server, web, CLI, ML, generated APIs, canonical SQL, workflow contracts and end-to-end behavior. [Development validation](./fork-integration.md#manual-development-artifacts) can capture generated files and independent diagnostics while repairing the branch. It does not replace the ordinary suite. Check each generator's recorded outcome before applying an artifact; a copied file may be unchanged input when its generator failed.

Database tests use the owned PostgreSQL 19 image, one `public` schema, the immutable Frameleaf baseline and the `frameleaf_migrations` ledger. Refresh desired schema provenance after reviewed model changes; do not rewrite the frozen baseline to hide drift. Source import tests must exercise the frozen supported schemas, source admission, resumability, file mapping and permission preservation.

Large-run acceptance includes the 15,000-item manifest, bounded scheduling, durable stage outcomes, actual worker/native-process interruption, inference response-body timeouts, missed notifications and execution-pool pressure. A synthetic stage handler proves scheduling/accounting only; real media, provider and product tests establish their respective behavior. Recovery must stop or fence an old attempt, retry safe work only within its budget, and expose work needing attention.

Use one watcher per external operation and the active task's polling circuit breaker. Do not poll unchanged runs from multiple agents or repeatedly rerun failed checks without diagnosing the exact failure. At an integration boundary, reconcile the live PR state, fetched code ancestry, exact-head required checks and issue state.

## Build and release flow

The **Deploy** workflow on `fork/main` builds owned application archives, runs integration and fresh-install deployment checks, and publishes the tested image artifacts. The separate **Deploy production** workflow resolves an exact candidate, verifies its build identity and manifests, tests that candidate, then promotes, signs and publishes within its protected release flow. Run either publishing flow only with explicit task authorization. An implementation-branch validation run does not publish a release.

Preserve source revisions, architecture digests, signatures, SBOMs, checksums and release attestations. Release and NAS manifest version 3 consumers use build identity and artifact provenance. There are no certification or qualification receipts, official-container round trips, reverse-normalization checks or upstream migration tracking dependencies.

The owned `frameleaf-postgres` image contains PostgreSQL 19 beta 4 and pgvector 0.8.7, pinned by digest for AMD64 and ARM64. Its public visibility allows anonymous pulls. Every distribution creates a new PostgreSQL 19 data volume mounted at `/var/lib/postgresql`; it must not adopt an older PostgreSQL data directory. The canonical database name defaults to `frameleaf`.

Compose and [NAS packaging](https://github.com/Frameleaf/frameleaf-app/blob/fork/main/packaging/nas/README.md) consume the matching release artifacts. Hosted packaging, lifecycle and render tests do not establish physical DSM/TrueNAS/Unraid installation or store approval. Preserve those acceptance boundaries instead of treating a generated package as a deployed product.

Before an authorized merge, verify the destination, exact candidate checks and merge message. Avoid replaying historical Smart Commit commands through a concatenated squash message. After integration, read back the branch ancestry and PR state. Verify publication and deployment independently when they are part of the authorized task, and close the issue only when its own acceptance is satisfied.

## Memory sync visibility

`MemoriesV1` and `MemoryToAssetsV1` keep their V1 payloads and use the session delivery journal. A memory and all its associations are hidden whenever any source is hidden from that session, matching `GET /memories`. Source lock/unlock and PIN elevation changes produce replayable removals/regrants without relying on a memory revision change. A delete contains only identifiers previously delivered to that session; a fresh session does not learn a never-delivered deleted memory. Generation from Locked items remains enabled.

Memory event ACKs are opaque strings ending in `|memory-journal-v1`. A session with any older memory checkpoint receives the existing `SyncResetV1`: the client must clear its mirror and request `reset: true`, then rebuild only currently authorized content. Late unmarked memory ACKs are ignored after reset. Existing reset and ACK-deletion operations clear the memory delivery journal too.
