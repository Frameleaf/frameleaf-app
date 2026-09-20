---
title: Frameleaf working-tree baseline inventory
---

# Frameleaf working-tree baseline inventory

FL-25 preserves the original application checkout without treating its uncommitted contents as part of `fork/main`. The inventory generator records every reviewable modified or untracked path, its working-tree bytes, Git state, workstream, and conservative review state.

The isolated FL-25 checkout was created from fetched `frameleaf/fork/main` commit `2cdd7f016ccfe08a2fa10804c6da1c7c04d281d0`. Before this slice made any edits, these read-only checks returned the same commit and an empty status payload:

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

## Remaining FL-25 acceptance

- Review and assign every `unreviewed-local-change`; a deterministic inventory is not acceptance of the change.
- Separate generated/cache material from reproducible source and decide what must be regenerated rather than committed.
- Reconcile the dirty checkout's older HEAD with the merged baseline without reset, stash, clean, or bulk copying.
- Record tool versions alongside the eventual reviewed implementation candidates.
- Keep downstream issues blocked until their required source is reviewed and present in a clean, fetched-baseline worktree.
- The implementation-plan and agent-execution Markdown referenced by Jira are not present in this merged baseline; restore them through a separately reviewed documentation slice rather than importing them implicitly.
