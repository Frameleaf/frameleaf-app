# Repository instructions

## Commit hygiene

- Commit application source, tests, reviewed product documentation, and required
  license/provenance records only. Keep agent skills, plugins, caches, session
  state, prompts, plans, audit/review reports, screenshots, and handoffs private
  outside the repository or in ignored local directories.
- Never use `git add -f` or an ignore exception to commit private work products.
  `.gitignore` does not remove files already tracked: untrack them before committing.
- `AGENTS.md` and `design/AGENTS.md` are the reviewed repository instruction files.
  Do not append generated indexes, local machine state, task reports, or private
  infrastructure details. Keep other tool-generated instructions local.
- Never commit credentials, tokens, secret values, customer media, production
  logs, or private Jira/Confluence exports. Use sanitized test fixtures only.
- Before committing, inspect `git diff --cached --name-status` and run
  `bash .github/check-repository-hygiene.sh`. CI runs the same check and rejects
  tracked files covered by ignore rules, including force-added files.
- If private material entered commit history, deleting it in a later commit is
  insufficient. Sanitize the affected branch history with an exact-head push
  lease; preserve unrelated branches and worktrees. Rotate exposed credentials
  through the authorized secret manager if any are found. Rebase or cherry-pick
  existing branches onto the sanitized head; never merge the removed history back.

## Scope and delivery

- Work only in `Frameleaf/frameleaf-app`. Verify the `frameleaf` remote URL before
  pushing; never write to the upstream Immich repository. The default branch is
  literally `fork/main`.
- Preserve unrelated uncommitted work and use isolated checkouts for changes.
  Use author and committer `AJ Taylor <aj@ajtaylor.net>` without coauthor trailers.
- PR #140 uses head branch `master/frameleaf-implementation` and base `fork/main` and stays draft, open, and
  unmerged until the user separately authorizes merge/publication/deployment.
- Do not restore the removed Flutter/mobile applications. Server APIs consumed
  by native clients remain in scope. Preserve media, ownership, privacy,
  database integrity, compatibility, accessibility, and required tests.
- Local tests, lint, typechecks, builds, and CI validation are allowed. Hosted
  checks must pass for the exact candidate before an authorized merge; source
  review, CI, deployment, and acceptance are separate claims.
- Before changing existing functions/classes/methods, use GitNexus upstream impact
  analysis and report HIGH/CRITICAL risk. Run `detect_changes` before committing
  when the index is available; report missing or stale coverage honestly.
- Assign one owner per external operation. Prefer event-driven waits; space
  remote status rechecks at least seven minutes apart and suspend monitoring
  after two unchanged checks. Reconcile live PR state, exact code ancestry,
  exact-head checks, and linked issue status at shipping boundaries.
