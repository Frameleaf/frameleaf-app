# Frameleaf implementation handoff (September 23, 2026)

> **Latest handoff (2026-09-24):** read [`docs/docs/developer/frameleaf-plan/14-agent-handoff-2026-09-24.md`](docs/docs/developer/frameleaf-plan/14-agent-handoff-2026-09-24.md) after this file; its section 0 explains how an agent on another computer fetches and reads it. Where it and this file disagree about branch state, page 14 is newer.

For the Codex agent picking up this work. You will not have the original machine, its memory files or the Claude session. Everything you need is in this repository, Jira project **FL** (cloud `heroit.atlassian.net`) and Confluence space **FR**.

## 1. Where things stand

- **This branch:** `claude/frameleaf-implementation`. It is the integration branch for the September 22, 2026 design revision. It contains about 125 story merges on top of the design revision below. **Nothing on it has been built or tested.** The owner's 7 GB Mac cannot run builds or test suites, so every spec was written but not run. Your first job is to make hosted CI green (section 6).
- **Design revision:** PR #135 (`claude/frameleaf-ui-review-157143`) lands the September 22 prototype in `design/frameleaf/`. It is green on CI apart from flaky web e2e. PR #136 (`claude/frameleaf-design-rules-sep23`) is stacked on #135 and adds the September 23 rule updates (see section 3) plus Confluence receipts. It gets CI only once retargeted to `fork/main` after #135 merges. This integration branch already contains everything from both.
- **Two story branches are pushed to the `frameleaf` remote but not merged here.** Nothing is running on them; pick them up from their pushed heads:
  - `codex/FL-66-settings-draft-transactions` @ `6a1f1a6bf`, based on an older head (admin settings: one draft, stale-save rejection, transaction boundaries). Its reviewer approved except one P2, which is not fixed yet: a concurrent RunPod key / HF token save can be silently overwritten; inside the settings lock, redo the "empty means keep" step from the freshly read config.
  - `codex/FL-74-preservation-packages` @ `c1bbbb6ec` (preservation package export/verify/restore; migration 510; 15 `/preservation` endpoints; four pausable `preservation_*` job kinds). Implementation is complete but **unreviewed** and based on an older head (`16db04449`): run a review pass, then merge this branch in. Expect conflicts in the shared registries, OpenAPI/SDK, `en.json`, and `web/src/routes/(user)/utilities/UtilitiesMenu.svelte`, which FL-69 deleted (move FL-74's Utilities entry into FL-69's `LibraryCareDirectory.svelte`/utilities page instead). Add `operationKindKey` labels for the four new kinds in `web/src/lib/frameleaf/render-workers.ts`. Open questions: mirror `docs/docs/features/preservation.md` to Confluence?; 100,000 items per package limit; restored faces may be removed by a later detection run; people created by a restore get no thumbnails generated.
  Review each, finish it, merge it into this branch.

## 2. Hard rules (from `AGENTS.md` and the owner)

- Commit as `AJ Taylor <aj@ajtaylor.net>` (author and committer). Put the Jira key in the subject (`feat: FL-123 …`). **No `Co-Authored-By` or any trailers.**
- Never push to `origin` or `upstream`; push to the `frameleaf` remote (`Frameleaf/frameleaf-app`). The default branch is literally `fork/main`. Do not merge, publish or deploy without the owner's authorization. Merging to `fork/main` can trigger Docker publication.
- **The September 22 prototype in `design/frameleaf/template/src` is authoritative for product design.** Match its screens, navigation, labels, controls, states and flows. A difference from it is a bug to fix, not a question. Only behaviour it does not cover is a product question. Its React code is a specification, not code to mount; port it into Svelte (`web/src`) and NestJS (`server/src`).
- The Frameleaf UI is the **only** UI. No feature flags, no legacy fallback. Delete legacy components that lose their last caller.
- **Never touch the iOS or Android apps** (`mobile/`, `mobile/openapi`). They are being removed and rebuilt natively. Mobile CI checks were removed. Do not regenerate the Dart client.
- Customer copy never says "fork" or uses "Immich" as the product name.
- Vocabulary: an album holds photos; a collection groups albums one level deep (`kind: "collection"`); a shared space stays top level. Never "subcollection".
- Every icon picker offers the full Material Design Icons catalogue with a categorised suggested set first.
- Repository Markdown is authoritative and changed Frameleaf specs/process docs are mirrored to Confluence FR in the same pass, with receipts in `docs/docs/developer/frameleaf-plan/confluence-mirror.json` (see section 6).

## 3. Product decisions made during this run (binding)

**Locked and privacy**
- **One Locked system:** a per-asset lock record (`asset_lock`, migration 320, reasons `marked` / `detected` / `immich-locked-folder`). It is metadata, never a relocation. Upstream `visibility = locked` is **never written**. On upgrade from Immich, old Locked-folder assets migrate into lock records (reason `immich-locked-folder`, visibility back to timeline). Old clients sending `visibility: locked` create a lock instead. Helpers: `server/src/utils/locked.ts`, `database.ts` (`isLockedAsset`, `isNotLockedAsset`, `lockedOwnerScope`), `locked-visibility.ts`, `locked-state.ts`.
- A Locked asset (id, count, metadata, thumbnail) is visible only to its **owner in an elevated (PIN-unlocked) session**. Never to partners, album/space members or shared links.
- **Background runners and backend tasks always access Locked assets.** Only interactive exposure needs elevation.
- Locked media may sit in albums; albums hide it unless the owner's session is elevated. Stacks and Live Photos lock and unlock as a whole.
- A photo that becomes Locked is removed from every cover and featured use (album, collection, space, person, space-person, pet, profile picture), in the same transaction. Replacements prefer Best Photos (score ≥ 0.9), then newest visible.
- Suppressed (hidden) people, pets and tags answer 404 while the session is locked.

**Jobs**
- Every background/media operation retries exactly once automatically (idempotent), then manual retry. Resumable jobs may resume a lost claim up to twice first. One neutral recovery sweep (`MediaOperationSweepService`).
- Durable bulk: selections over 500 and "select all matching" run as jobs; smaller ones act immediately with undo. Tiles being processed keep a loader in the top-right corner.
- Running jobs (including server queues for admins) appear in the notifications panel with growing-total progress bars and pause/play.

**Sharing and spaces**
- Partner location sharing is on by default (per partner).
- Shared spaces appear on the Albums page, have their own viewer (`/sharing/{space}/photos/{asset}`), an everyone-activity feed, comments with Facebook-style threaded replies (separate fork table), @mentions with **in-app notifications only** (no email). Owners and editors moderate. The album view of a space uses the same comments.

**Other**
- Casting stays; admins can turn casting off per user (enforced).
- Studio is top-level navigation (Library / Studio / Activity) as in the prototype. Studio trash retention is 30 days. Editor export offers "include copies of media I own".
- Zip downloads have descriptive names (album, person, pet, tag, space…); generic views get a `frameleaf-` prefix.
- Choosing a cloud destination for restoration counts as upload consent (the panel warns).
- Freecut engine vendoring is **parked** by the owner (licence gates: LGPL SoundTouch, CC-BY-NC MusicGen). Do not vendor it.

## 4. Remaining work

**Not started (all open FL issues except the exclusions below):** FL-60 (classification rules), FL-64 (selective photo tools / RAW round trips), FL-75 (migration operator flow), FL-78 (external libraries), FL-79 (scoped analytics), FL-82 (workflows/plugins), FL-40 (end-to-end migration slice), FL-43 (durable media operations unification, largely done by FL-104 — verify and close gaps), FL-106 (project derivatives), FL-119 (reproducible SDK generation), then FL-83 (action parity qualification), FL-87 and FL-107–109 (HDR/Dolby proofs, need real media/hardware), FL-136–142 (QA and release). Finish with a **full prototype conformance audit** of every merged screen.

**Excluded until the owner decides:** mobile/native stories FL-116–FL-134 and native release FL-130–132; Freecut-dependent Studio stories FL-84, 85, 86, 94, 97, 98, 99, 100, 103, 105, 111, 112.

**Almost every story is still "In Progress" in Jira**, not Done: the code is written, but acceptance needs hosted CI, browser runs and (for media/ML) real hardware. Each story has a Jira evidence comment listing what was verified and what is outstanding. Read the latest comment on an issue before touching it.

**Open owner questions** (collected; ask rather than decide):
- Detections: only positive evidence (a mark or a detection) locks; unchecked photos stay visible. Detections lock only while "hide sensitive detections" is on. Confirm both.
- Unlocked search shows old-Locked-folder items but the timeline doesn't; should they match?
- Trash: owner-trashed items whose file later went missing can still be restored/deleted (narrow rule); scan-trashed offline items are listed only.
- Compare: Keep = 5 stars, Reject = rejected rating; undo lasts the visit; partially failed duplicate group stays as-is.
- Moment search: include partners' videos? Should a chosen moment cover replace the video thumbnail?
- Library Care: recovered copies and kept damaged files aren't quota-counted or auto-cleaned; schedule toggles lack config keys; no un-dismiss endpoint.
- FL-67: credential changes are server-wide and only logged (no per-account audit); prototype wording "Immich server support" and a purchase sentence should probably change; changing SMTP host/user clears the stored password.
- FL-73: admins can't leave out only the Locked copies they can't see; plans cap at the 500 previewed copies (paging?); the review-token secret is in memory, so a restart means reviewing again.
- FL-65: Locked Folder imports use lock reason `marked`; per-import switches live in the wizard, not settings.
- Studio preview: Locked-between-request-and-render window up to the 10-minute manifest cache; reviewers' previews are per account; preview saves pending edits first.
- Restoration: should an accepted restoration drive the viewer's playback source? Result retention beyond explicit discard?
- The Confluence Studio README page (61408007) carries two unreconciled versions (FL-84/86 engine workspace vs integration FL-88/90/92).
- The main checkout on the owner's Mac holds older, uncommitted Takeout code; FL-65 rebuilt the feature, so that code should not be imported.

## 5. Fork migrations

Fork migrations live in `server/src/schema/migrations/2100000000NNN-Name.ts`, listed in `server/src/schema/migrations/ORDER` (keep the fork block sorted numerically, no duplicates) and registered in `server/src/fork-schema/migration-manifest.ts` `LEGACY_FORK_MIGRATIONS` plus an assertion in `migration-manifest.spec.ts`.
Used on this branch: 010–110, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 240, 250, 260, 270, 280, 290, 300, 310, 320, 340, 380, 390, 400, 450, 460, 490, 500, 530 (FL-41 generated schema reconciliation). FL-73 used no migration. In flight: 410 (FL-66, if used), 510 (FL-74). **Next free: 540.** None of these has run on a shared database yet, so in-place edits are still allowed until the first deployment.

## 6. Getting CI green (do this first)

Push this branch to `frameleaf` and open it against `fork/main` (or let this PR run). Expect, in order:
1. **Generated code drift.** OpenAPI (`open-api/immich-openapi-specs.json`) and the SDK (`packages/sdk/src/fetch-client.ts`) were edited by hand for every contract change. Regenerate with the server's `sync-open-api` and `oazapfts` (see `.github/workflows/fork-integration.yml` "Verify OpenAPI and TypeScript client freshness") and commit the result. SQL query snapshots under `server/src/queries` were hand-edited; regenerate with `mise run //:sql`. The fork v2 schema catalog may need regeneration for new tables.
2. **Format, lint, types.** Prettier was never run; run `pnpm format:fix` per package. Then server `check`/`lint`, web `svelte-check`/`check:typescript`.
3. **Specs.** Server unit and medium specs, web vitest, scripts tests. Expect a long tail of small mismatches from hand-written mocks.
4. **Documentation coverage** (`scripts/frameleaf-documentation-coverage.mjs`, run in `test.yml`). Mirrored docs changed after the last sync (e.g. `docs/docs/features/image-enrichment.md`). For each mirrored source whose bytes changed, update its Confluence page (keep everything else on the page), read it back, and update its receipt in `confluence-mirror.json` (bytes, sourceSha256, version, verification containing "read back", verifiedAt). Then pin `sourceAnchorSha256` in `scripts/frameleaf-documentation-coverage.test.mjs`: the digest is computed from the **committed** tree, so compute it after committing (`node -e` importing `validateDocumentationCoverage(process.cwd())`), and note that PR CI runs on the merge commit with `fork/main`.
5. **Route inventory / ledgers** (`docs/docs/developer/frameleaf-route-inventory.json`, `frameleaf-plan/action-preservation-ledger.json`, `preservation-source-evidence.json`, `backlog.json`). New routes since the last sync (e.g. `/takeout`) and deleted components (`UtilitiesMenu.svelte`, `MediaHealthReview.svelte`) must be reflected; validators are `scripts/frameleaf-route-inventory*.mjs`, `frameleaf-library-admin-contracts.mjs`, `frameleaf-preservation-ledger.mjs`.
6. **Known pre-existing:** web e2e has flaky maintenance-mode tests; re-run before debugging.

## 7. How the work was run (useful patterns)

- One branch per story, `codex/FL-<n>-<desc>`, cut from the integration head, merged with `git merge --no-ff` as AJ Taylor.
- Recurring merge conflicts and fixes: `i18n/en.json` (union, keys sorted, 2-space indent, trailing newline); the OpenAPI JSON (3-way JSON merge preserving key order; `paths` and `components.schemas` sorted); `fetch-client.ts` union seams sometimes lose a closing `}` / `};` between blocks (check brace balance); `server/src/enum.ts` unions sometimes lose a `/**` comment opener; ORDER and the migration manifest (union, sorted by number, dedupe).
- Every story ended with an independent read-only review pass (P0–P3) before merge. Keep doing that.
- Each story's Jira comment is the evidence record: branch, SHAs, files, contract changes, what was verified by reading, what awaits CI, open questions.

## 8. Key references

- `AGENTS.md` (repo rules), `design/AGENTS.md`, `design/frameleaf/README.md`, `design/frameleaf/INTERACTION-REQUIREMENTS.md` (September 22 revision and later decisions).
- `docs/docs/developer/frameleaf-plan/` — `00-implementation-plan.md`, `01-agent-execution.md`, `09-prototype-to-production.md` (maps every prototype capability to its FL owner), `10-agent-handoff-2026-09-22.md`.
- `docs/docs/developer/frameleaf-development.md` (validation policy, release flow, Confluence synchronization).
- Jira FL (every story's latest comment), Confluence FR.
