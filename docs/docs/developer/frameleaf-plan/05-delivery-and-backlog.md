# Delivery and backlog preservation contract

Status: reviewed planning contract, not implementation, qualification, release, or deployment evidence.

This guide turns the canonical [backlog](backlog.json) and [Jira map](jira-map.json) into safe dispatch decisions. It does not start any dependent issue, infer acceptance from workflow state, or replace the issue-specific acceptance criteria.

Read the [implementation plan](00-implementation-plan.md), [agent execution guide](01-agent-execution.md), assigned Jira issue, and the relevant restored workstream contract before implementation. The [library and administration contract](02-library-and-administration.md), [Studio, rendering and restoration contract](03-studio-rendering-and-restoration.md), [native and release contract](04-native-and-release.md), and [brand-assets contract](06-brand-assets.md) are present in the delivery integration baseline. The preserved feature-ownership narrative and route map remain unaccepted; page `61538800` is not accepted evidence. FL-26 owns action- and requirement-level preservation coverage and ownership. Their absence does not reduce scope or make an issue ready.

## Authoritative records

- `backlog.json` is the only executable local dependency graph: **162 items**, comprising **28 epics** and **134 stories**, with **434 declared dependency edges**.
- `jira-map.json` maps every Plan ID to one canonical Jira ID, key, and URL. Its **298 Blocks links** are the transitive reduction of the declared graph; the reduction preserves reachability but never removes a prerequisite from the backlog.
- `delivery-backlog-evidence.json` is a dated read-only observation of live Jira identities, statuses, and link counts. Its structured query receipts and normalized snapshot digest make the observation reviewable; it is deliberately not an execution-status database.
- Jira remains authoritative for current workflow state. Re-read an issue immediately before dispatch; a dated snapshot can become stale.

Run `node scripts/frameleaf-delivery-backlog-contracts.mjs` before relying on these records. It rejects duplicate JSON keys, identity drift, missing or contradictory dependency edges, cycles, invalid status claims, and invented release/deployment evidence.

## Reviewed checkpoint

The evidence snapshot was read from live Jira on 2026-09-25 (after the `cloud` workstream was registered). It observed:

- 79 issues in **To Do**;
- 54 issues in **In Progress**, including `FL-153` / `CLD-000` (this registration);
- 29 issues in **Done**, including `FL-25` / `FN-101` and `FL-118` / `REL-201`;
- 298 live Blocks links matching the canonical transitive reduction.

The earlier checkpoint of 2026-09-20 (140 To Do, `FL-25` In Progress, `FL-118` Done, 275 links) remains in history; the workstream `cloud` (Plan IDs `CLD-*`, Jira FL-149 to FL-168) was added on 2026-09-25 with its own guide, `15-frameleaf-cloud-integration.md`.

Workflow status is not technical acceptance. `REL-201` is locally recorded as `delivered-with-open-qualification-gaps`; every other backlog item remains `planned-not-qualified`. Its exact exception receipt retains its `FN-101` dependency and separately enumerates administrator-review bypass, merge-committer identity, GHCR visibility, and runtime/application qualification gaps. No item is `qualified`, `released`, or `deployed` by this contract.

The preserved dirty checkout remains read-only evidence. Its historical HEAD `91d5dfe0f829d15d122c1a8b2bbc474fc195dbaf` does not include its uncommitted work. The live Jira observation was made against the clean candidate's original `Frameleaf/frameleaf-app` literal `fork/main` base `b934907b9a53e8367174e3822b119d99584bcbe6`; delivery integrates onto freshly fetched `fork/main` `7941bd6bc6dfbbb0f4c19fb570128d75432414b6`, which contains the separately reviewed Studio, native and brand contracts. Neither SHA converts dirty application work into accepted source, and the newer integration base does not alter the dated Jira observation.

## Dependency readiness

A story is executable only when all of the following are true:

1. Every declared dependency has issue-specific accepted evidence for the contract being consumed. Jira Done alone is insufficient.
2. Current source paths and preserved dirty evidence have been inspected without silently importing unreviewed files.
3. One owner has claimed the implementation issue, named the files they will edit and verified the issue remains available for work. Raw-path Jira routing is not an FL-25 acceptance prerequisite; FL-26 establishes behavior-level preservation ownership before dependent implementation dispatch.
4. Required fixtures, rollback path, authorization boundaries, and practical validation environment are named.
5. External hardware, credentials, licenses, publication, or deployment inputs are either present and authorized or retained as explicit blockers.

At this checkpoint `FN-101` is the only story without declared prerequisites. It is already In Progress; deterministic preservation and classification of all 3,520 paths is its acceptance boundary, while preserved-only source remains unaccepted and forbidden from bulk copy. The 1,603 paths without exact source-backed routing are an informational triage statistic, not an FL-25 acceptance gap. This candidate does not close FL-25 or unblock `FN-102`; merge, hosted verification, and Jira closeout remain required. `REL-201` being Done does not satisfy `FN-101`, and it does not unlock dependents whose other prerequisites lack accepted evidence. Do not start the dependency-blocked first-wave stories (`FN-102`, `FN-301`, `LIB-002`, `STU-101`, or `VID-101`) from this document.

Read-only investigation may proceed without claiming that a dependency is accepted. Production edits, implementation delegation, and Jira transitions remain governed by root `AGENTS.md` and the development lifecycle.

## Dispatch contract

Every implementation assignment must state:

- Plan ID and canonical Jira key from `jira-map.json`;
- freshly fetched exact `fork/main` SHA and isolated worktree;
- accepted prerequisite evidence, not only issue statuses;
- owned files and read-only/shared areas;
- source behavior, privacy/media/data boundaries, rollback, and fixtures;
- focused validation plus unavailable browser/device/hardware gates;
- implementation, qualification, release, and deployment states separately.

Central backlog, Jira-map, generated SDK, schema, shared route/session, global native, and release files require a named single writer. Parallel agents should return bounded modules, tests, or read-only findings to that owner rather than racing shared outputs.

## Evidence semantics

Keep these states separate:

| State                  | Evidence required                                              | Does not imply                                   |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| Planned/owned          | Requirement, owner, dependencies, acceptance                   | Implementation or testing                        |
| Source implemented     | Reviewed production code for an exact candidate                | Browser, device, media, or release qualification |
| Locally tested         | Named command, fixture, environment, result                    | Hosted CI or unsupported environments            |
| Qualified within scope | Complete issue-specific gate matrix                            | Unrelated surfaces or deployment                 |
| Released/published     | Exact authorized artifact identity and destination             | Deployment or runtime correctness                |
| Deployed               | Exact environment, revision, deployment event, health evidence | Product/media qualification                      |

Never infer implementation from a Jira mapping, a dependency link, a prototype control, generated SDK output, a published document, a container build, or a prior candidate's green run. Never add release or deployment evidence without exact artifact/environment identifiers and the separately authorized action that produced them.

## Jira and Confluence maintenance

Stable Plan IDs remain the join key. Before changing Jira, read the issue, assignee, status, dependencies, comments, and linked work. Discover transitions on that issue. Do not transition dependency-blocked issues, duplicate tickets, or overwrite user-authored evidence.

Repository Markdown is authoritative. The existing Confluence delivery page is page `61407624`. Publish this independently reviewed contract through the authorized mirror procedure, read the page back, and update `confluence-mirror.json` only with the actual source hash, byte count, page version, and verification result. Confluence publication is documentation synchronization, not implementation or qualification evidence.

## Completion boundary

This planning slice is complete when its local graph, identities, status snapshot, and evidence semantics validate deterministically. FL-25 accepts preservation and classification evidence, not dirty application source or raw-path ownership. FL-26 owns action- and requirement-level coverage, gap ownership, and completeness. FL-25 remains In Progress until this acceptance-alignment candidate is merged, hosted checks are verified, and Jira closeout is performed; only then may FL-26 dependency readiness be reconsidered. No product feature implementation, browser/device/media/hardware parity, release, registry publication, deployment, native submission, GPU/Dolby qualification, or application parity is claimed here.
