# Documentation and Jira reproducibility contract

Status: deterministic governance validation, not product implementation, qualification, release, or deployment evidence.

This contract joins the implementation backlog, Jira identity/link map, Confluence mirror receipts, preserved working-tree reconciliation, and action-preservation ledger. Run it before dispatching work from these records:

```sh
node scripts/frameleaf-documentation-coverage.mjs
node --test scripts/frameleaf-documentation-coverage.test.mjs
```

The validator also invokes the delivery/backlog validator. It rejects duplicate JSON keys and work IDs, missing acceptance or test contracts, invalid parents, dependency cycles, noncanonical Jira identities, a Blocks graph that differs from the dependency DAG's transitive reduction, and source anchors that exist in neither accepted `fork/main` nor the immutable FL-25 preservation receipt.

## Source and requirement evidence

An accepted-main path must be tracked by the exact candidate `HEAD` tree, exist in the checkout, and resolve inside the repository; neither an untracked file nor a staged-only file becomes evidence merely because the working tree or index contains it. Candidate-tree directories resolve through their committed children. A preserved-only path must resolve to one or more exact paths in `fl25-working-tree-reconciliation.json`, including byte counts and SHA-256 hashes; it remains unaccepted and cannot be copied into production merely because the plan cites it. Absolute paths, parent traversal, absent tracked paths, and symlink escapes are rejected.

Every action-preservation source row must reverse-map to one canonical requirement, and that requirement must list the row in `sourceRowIds`; validation is bidirectional so removing either side fails. Every source, new-UI, API, native, and test axis requires a nonblank status and a nonempty array of nonblank evidence strings. Every requirement must retain source rows, a nonblank qualification state, and a primary story owner whose Jira ID, key, and URL exactly match `jira-map.json`. Shared entrypoints do not merge distinct behavior unless the reviewed ledger explicitly aliases them.

## Jira contract

Stable Plan IDs are the local join key. Each epic has no parent; each story has a valid backlog epic and canonical Jira identity. The local Blocks links must equal the transitive reduction of the declared dependency DAG, while reachability retains all declared prerequisites. The dated normalized live snapshot in `delivery-backlog-evidence.json` proves only the recorded identity/status/link observation. Jira remains authoritative for current workflow state, so an owner must re-read the actual issue immediately before dispatch or transition.

## Confluence contract

Every mirror row retains an exact numeric page ID, page URL, repository-relative source, byte count, SHA-256, version, and category. A source receipt is valid only when those bytes match either the current checkout or the preserved FL-25 reconciliation entry. A **Historical source receipt** is evidence of the preserved source version, not permission to treat a newer same-path file as mirrored, accepted, or current. Historical Planning and Handoffs remains a visibly historical destination, and historical checkmarks never become implementation or release evidence.

For every Confluence update, read the remote page before every write, compare it with the recorded source/version, and preserve user-authored additions. Do not replace independently authored content with repository Markdown. Resolve conflicts explicitly; otherwise leave the page unchanged and report the synchronization blocker. After a successful write, read back the full published content and record the returned version, exact source hash/bytes, verification time, and a statement containing “read back” or “readback”. The six source files intentionally combined on page `61539021` retain one shared page identity and version; no other duplicate page ID is accepted.

The intended mirror inventory is exactly 73 source receipts: 37 current and 36 historical. The current verified set is exactly the 31 paths in `REQUIRED_READBACK_SOURCES` in `frameleaf-documentation-coverage.mjs`, including the FL-27 high-risk workflow decisions, the September 22, 2026 prototype-to-production plan and the September 22, 2026 agent handoff. Every required row must match current source bytes and carry all three fields: `verified: true`, a nonblank `verification` statement containing “read back” or “readback”, and an ISO-like `verifiedAt`. Removing all three still fails because membership is fixed independently of those fields. The six current-source rows outside the required readback set are `server-migration.md`, `fork-integration.md`, `duplicates-utility.md`, `preservation.md`, `switching-between-fork-and-official.md`, and `revert-to-upstream.md`; historical preserved-source receipts also carry no current verification claim. No other mixture of current, historical, verified, or unverified state is accepted.

Repository Markdown remains authoritative for source-owned specifications. Confluence is a readable mirror, not a qualification gate. Live Confluence reads and writes stay outside this offline validator; the committed receipt makes drift and incomplete readback metadata fail closed in review and CI.

## Completion boundary

This gate establishes reproducible planning identities, source provenance, ownership, and evidence relationships. It does not prove any feature implemented, any workflow qualified, any image published, or any environment deployed. Update the relevant source, Jira mapping, ledger evidence, mirror receipt, tests, and this contract together when their schema or ownership changes.
