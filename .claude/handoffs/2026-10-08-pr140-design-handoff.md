# Handoff: PR 140 design review, brand system and implementation (paused 2026-10-08)

Paused at the owner's request. Session ran in the worktree
`/Users/adamtaylor/Github/immich/.claude/worktrees/pr-140-design-review-ada8e2`.

## Where things are

| Thing | State |
|---|---|
| PR 140 branch `master/frameleaf-implementation` | Contains rounds 1-3 of this work. My push was `4d951e0292`. Someone else has since pushed two Studio commits; head was `5d9ae86e0d` at pause. |
| Review branch `aj/pr-140-design-review-ada8e2` | At `4d951e0292` (same as my push). |
| Backup branch `aj/pr-140-design-round4-wip` | Round 4 partial work as ONE unverified WIP commit on top of `4d951e0292`. Pushed for backup only. Do not merge as is. |
| CI | My push's run was cancelled by the later Studio pushes (a push cancels the ~1h run). The new run on `5d9ae86e0d` had Web unit, both real-server web e2e runs and server suites still pending. One failure there, "Manager (arm64): HTTPS claim, session and restart integration", is packaging work, not this change. |
| Servers / temp files | Dev servers stopped, temporary specs and the `e2e/test-assets` symlink removed, baseline worktree removed. |

## What landed in PR 140 (rounds 1-3, commit `a49026e429` plus two merges)

- Design review: 130 findings, report at `design/reviews/pr-140/README.md` (local only, `design/` is gitignored).
- Brand system v3: `web/src/lib/frameleaf/brand-tokens.json` (byte-identical to `design/frameleaf/tokens.json`, enforced by `tokens.spec.ts`; inventory regenerated through `scripts/frameleaf-brand-assets.py`), `tokens.css`, `tokens.ts`, `base.css`, `motion.ts`, `BRAND.md`.
- Shared primitives: InlineError, Skeleton, Spinner, EmptyState, CountUp, Toast with Undo, Dialog/Menu exits, kit theme bridge.
- Area fixes across library, viewer/editor, Studio chrome, command center, search/discovery, people/albums/sharing, sign-in/setup/Cloud/photography.
- Full per-agent record: `design/reviews/pr-140/IMPLEMENTATION.md` (local), screenshots in `design/reviews/pr-140/shots` (before) and `after`.

Verified at `4d951e0292`: svelte-check 0 errors, tsc, eslint, prettier clean; unit suite 548 files pass; e2e package lint/tsc/prettier clean; mocked browser suite 257 pass. Known local-only failures that also fail on the untouched head: six in `studio/studio-stream.e2e-spec.ts`, `asset-viewer/ocr.e2e-spec.ts:127`, and `timeline.e2e-spec.ts:375` (flaky). NOT verified: real-server e2e (specs were updated by reading only; CI is the judge), frame-by-frame motion, Reduce Motion paths.

## Round 4 (stopped mid-flight, on `aj/pr-140-design-round4-wip`)

Six agents were working on leftovers when stopped. None had finished or reported. Their edits are partial and have had NO checks run. About 58 files. Treat every one as suspect.

Areas and intended items (full brief: workflow script `pr140-design-round4-leftovers` in the session folder):
1. foundation: kit button corners and dark secondary (app.css), mono font stack, remove `bg-light` body class, UserPageLayout title row and duplicate titles, scope UploadPanel globals, handleError voice mapping, queue-manager keeps last snapshot, handleSystemConfigSave reports failure.
2. voice: BRAND.md voice applied to existing `i18n/en.json` values plus every asserting spec; extend `customer-copy.spec.ts`. Highest risk of half-done state: strings may be changed without their assertions.
3. search: `/search` into the app shell, map legend on error, chip radii and hit areas, memory player galleries.
4. command-center: backup time agreement (new `settings/backup-time.ts`), library card titles, error headings, users master-detail, rail footer overlap.
5. viewer-people: video control padding, single error on Sharing, person page in shell, PersonAvatar fallback, shared RecipientPicker.
6. cloud-onboarding: Buddy Backup states, buy empty gap, setup stops on failed save, pin-prompt lock reveal.

To resume round 4: check out the WIP branch, run `pnpm run check:svelte`, `check:typescript`, `lint`, `prettier --check .`, `vitest run` in `web/`, then the mocked UI suite; either finish each area or revert that area's files to `4d951e0292`. Simplest safe option: discard the WIP and rerun the round with the same brief.

Also in the WIP commit and worth keeping regardless: the owner's brand concept in `BRAND.md` section 1.

## Owner direction received this session

- Brand: build the strongest brand; prototype and website (frameleaf.app, repo `~/Github/fl-app-website`) are inputs, not the authority.
- Brand concept: the frame and the dot are the home server; the leaf is managing your library as it grows.
- For other brand recommendations the owner wants to see them on a single screen. Published (private): https://claude.ai/artifact/29yTMFaEbTRP3kXouoTiqp, source in the session scratchpad as `frameleaf-brand-decisions.html`. Ten numbered decisions; the owner has not yet said which to keep, change or drop. WAITING ON OWNER.

## Open decisions for the owner

1. The ten brand decisions on the artifact (keep/change/drop by number).
2. Photo tile corners: Browse square, Timeline/Work 16px. Square everywhere?
3. Heading weight: needs an Inter 700 font file downloaded into `web/src/lib/assets/fonts/Inter` (needs approval to download).
4. Website changes to match the brand (list in IMPLEMENTATION.md under round 2 brand agent). Website repo untouched.
5. Kept as previously decided: seven-button person toolbar, five Locked entry points, phone top tabs, job manager acknowledgement checkbox.

## Deferred, needs server or Studio engine

Studio Basic/Advanced wiring (control removed), comment authors and clickable timecodes, clip count/duration on project cards, exact search totals and sort, translatable render failure codes. Other languages have no translations for new or changed English strings.

## Gotchas learned

- Local mocked UI suite: `vite dev` on a port, then from `e2e/`: `PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> PLAYWRIGHT_DISABLE_WEBSERVER=1 pnpm exec playwright test --project=ui`. Needs Node 24, `pnpm --filter @frameleaf/sdk build`, and `e2e/test-assets` (symlink from the main checkout; do not commit it).
- Chromium ignores input during a root view transition even with `pointer-events: none` on the overlay; grouping/layout changes use an in-place dissolve instead.
- Parallel agents editing `i18n/en.json` can lose keys; scan for used-but-missing `frameleaf_` keys after each round.
- Any push to the PR branch cancels the in-flight CI run. Batch pushes.
- Foreground waits over 10 minutes get killed; run long checks as background jobs writing to a log.
