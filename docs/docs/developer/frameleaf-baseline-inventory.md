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

## Remaining FL-25 acceptance

- The receipt proves deterministic preservation and classification only. It does not complete FL-25, unblock dependent issues, accept preserved-only application source, or qualify product behavior.
- **1,603 paths still lack exact source-backed future routing:** 1,602 are labeled `unreviewed-local-change` and one is labeled `local-evidence`. Resolving those paths remains explicit FL-25 acceptance work.
- The source-backed routing on the other 1,917 paths is a future triage hint. Its 44 epic references across 36 paths and 17 unique epic IDs identify scope only; they are not assignments to actionable implementation owners and do not establish dependency readiness.
- Future implementation owners must inspect the preserved evidence and current production source after their issue is independently ready and assigned; they may not bulk-copy this checkout.
- Generated/cache material remains subject to issue-specific regeneration and review rather than implicit acceptance.
- Downstream issues remain governed by their declared dependencies and issue-specific evidence. This receipt does not itself start, qualify, release, publish, or deploy them.
