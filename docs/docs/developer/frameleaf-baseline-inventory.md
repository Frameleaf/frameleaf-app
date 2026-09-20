---
title: Frameleaf working-tree baseline inventory
---

# Frameleaf working-tree baseline inventory

FL-25 preserves the original application checkout without treating its uncommitted contents as part of `fork/main`. The inventory generator records every reviewable modified or untracked path, its working-tree bytes, Git state, workstream, and conservative review state.

The original isolated FL-25 inventory checkout was created from fetched `frameleaf/fork/main` commit `2cdd7f016ccfe08a2fa10804c6da1c7c04d281d0`. Before that inventory slice made any edits, read-only checks returned the same commit and an empty status payload:

```text
git rev-parse HEAD
2cdd7f016ccfe08a2fa10804c6da1c7c04d281d0

git status --porcelain=v1 -z | wc -c
0
```

The commit's tree is `5d61c46a46918a602b5bd9f59ea20876873b2876`. This proves the isolated checkout initially contained only the merged baseline. It does not accept or reproduce anything from the preserved dirty checkout.

## Reproduce the inventory

Run from a clean review checkout. The source checkout is read-only input:

```sh
frameleaf_dirty_checkout=/path/to/preserved/frameleaf-checkout
node scripts/frameleaf-baseline-inventory.mjs \
  --source-repository "$frameleaf_dirty_checkout" \
  --accepted-baseline 2cdd7f016ccfe08a2fa10804c6da1c7c04d281d0 \
  --output-json docs/docs/developer/evidence/fl25-working-tree-baseline.json \
  --output-markdown docs/docs/developer/evidence/fl25-working-tree-baseline.md
```

Generation fails if Git status, repository identity, remotes, or any twice-hashed path changes during the snapshot window, or if a rename record is incomplete. Dirty gitlinks record their index commit, checkout commit, nested porcelain status, binary diff, and untracked-content digest instead of reading the submodule directory as a file. Output order and summaries are deterministic for identical Git and filesystem state.

Remote configuration is stored only as normalized identity. URL user information, query strings, and fragments are discarded; SCP-like user information is removed; unsupported credential-bearing transports are replaced rather than copied into evidence.

The generator formats both outputs through the repository's pinned Prettier and recursive JSON-sort plugin before writing. Run it from a checkout with the locked root development dependencies installed.

The generated JSON is the path-level evidence. The generated Markdown is a review summary. Neither file authorizes copying local application code into another worktree.

## Exact-main reconciliation receipt

The deterministic [reconciliation receipt](evidence/fl25-working-tree-reconciliation.json) compares all **3,520** preserved paths and hashes with freshly fetched literal `fork/main` commit `7eab5558e612b44e519052b5bf4da0c628f9093f` (tree `a8719fc6b2f6f5f0082f87ae4fd58967c0d5c6d1`). It does not read or import preserved source bytes. It records:

- **164 already represented** paths whose preserved SHA-256 is byte-identical to the blob at that exact main commit;
- **3,356 preserved-only, unaccepted** paths, comprising 192 paths whose main blob differs and 3,164 paths absent from that main tree;
- source-backed Plan ID, Jira key, issue type, and workstream routing only where the current backlog, native ownership map, or pinned Freecut map names the exact path. The receipt contains 44 epic references spanning 36 paths and 17 unique epic IDs; those references describe scope routing, not actionable implementation owners.

The earlier **3,518 unreviewed** wording describes the inventory's review-state labels: 3,518 `unreviewed-local-change` paths plus two `local-evidence` paths. It is not a count of paths absent from current main, and it is not an acceptance disposition. All 3,356 preserved-only paths remain unaccepted; the two local-evidence paths remain unaccepted too.

Reproduce or check the receipt without making the dirty checkout an input:

```sh
node scripts/frameleaf-baseline-reconciliation.mjs \
  --current-main 7eab5558e612b44e519052b5bf4da0c628f9093f
node scripts/frameleaf-baseline-reconciliation.mjs \
  --check \
  --current-main 7eab5558e612b44e519052b5bf4da0c628f9093f
node --test scripts/frameleaf-baseline-reconciliation.test.mjs
```

The validator rejects duplicate JSON keys, non-canonical output, any path/hash/order or disposition drift from the authoritative inventory, main-blob relation drift, routing-count drift, and count drift. Routing metadata is not proof that a path is implemented, reviewed, accepted, qualified, ready to copy, or owned by an agent.

## FL-25 acceptance matrix

FL-25 accepts the deterministic preservation and classification evidence below. It does **not** accept the preserved application source. The candidate containing this clarification must still merge, pass hosted checks, and receive Jira closeout before FL-25 can be closed or FL-26 unblocked.

| FL-25 criterion                                                                                       | Exact merged evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Accepted conclusion                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verify Frameleaf repository ownership and the literal default branch                                  | Repository ownership and literal `fork/main` policy merged at `2cdd7f016ccfe08a2fa10804c6da1c7c04d281d0`; the isolated inventory checkout recorded that exact commit and tree `5d61c46a46918a602b5bd9f59ea20876873b2876`; this acceptance-alignment work starts from freshly fetched `fork/main` `59133353c87ad522e64181994466838d6f4b307b`.                                                                                                                                                                                                                          | Work is based on the owned `Frameleaf/frameleaf-app` repository and literal `fork/main`, not an upstream checkout or a remote named `fork` plus branch `main`.       |
| Record old local remotes and authorized remote/branch changes without pushing to `origin` or upstream | The inventory evidence merged at `4bedc0c4d384f365ee5c29739ce201cc114fdd85` records normalized fetch/push identities: old `fork` = `adamtaylor152/immich`, `frameleaf` and `origin` = `Frameleaf/frameleaf-app`, and `upstream` = `immich-app/immich`; the repository policy merged at `2cdd7f016ccfe08a2fa10804c6da1c7c04d281d0` permits writes only through the verified `frameleaf` remote.                                                                                                                                                                        | The historical remote state and authorized destination are durable evidence; neither `origin` nor upstream is an authorized push destination.                        |
| Preserve and classify every modified or untracked path without reset or omission                      | The inventory merged at `4bedc0c4d384f365ee5c29739ce201cc114fdd85` records all 3,520 paths and hashes. Reconciliation commits `d10d490b1732a233ab811fb4dbba7b20bc8d2f67` and `59133353c87ad522e64181994466838d6f4b307b` deterministically classify 164 as already represented and 3,356 as preserved-only, unaccepted.                                                                                                                                                                                                                                                | Every path is preserved and classified. No preserved-only source is accepted, and bulk copying the dirty checkout is forbidden.                                      |
| Record tool versions and the exact reviewed baseline                                                  | Toolchain evidence merged at `db7340284e0fc5370002f7224367e76a2eeba327` is tied to reviewed baseline `4bedc0c4d384f365ee5c29739ce201cc114fdd85`: 61 declaration records from 24 hashed sources, 21 tools, and controlled-host observations of ffmpeg 9.0.1, Node.js 24.19.0, and Python 3.9.6. It records 3 locally resolved tools, 1 missing, 15 deliberately unprobed, 2 probe failures, and 3 exact-pin mismatches. The original isolated inventory baseline remains `2cdd7f016ccfe08a2fa10804c6da1c7c04d281d0` / tree `5d61c46a46918a602b5bd9f59ea20876873b2876`. | Exact declarations, controlled-host observations, mismatches, missing tools, and baseline identities are recorded without installing or silently resolving anything. |

## Remaining boundaries

- **1,603 paths lack exact source-backed routing:** 1,602 are labeled `unreviewed-local-change` and one is labeled `local-evidence`. This is an informational triage statistic, not an FL-25 acceptance gap and not permission to infer an owner.
- The source-backed routing on the other 1,917 paths is also informational. Its 44 epic references across 36 paths and 17 unique epic IDs identify scope only; they are not assignments to actionable implementation owners and do not establish dependency readiness.
- FL-26 owns action- and requirement-level preservation coverage, ownership, gap discovery, and completeness. Raw-path Jira ownership is not required to accept FL-25.
- Future implementation owners must inspect the preserved evidence and current production source after their issue is independently ready and assigned; they may not bulk-copy this checkout.
- Generated/cache material remains subject to issue-specific regeneration and review rather than implicit acceptance.
- Implementation, browser/device/media/hardware parity, qualification, release, publication, and deployment remain unclaimed. Page `61538800` and the preserved `07-feature-ownership.md`/route-map material are not accepted by FL-25.
