# Browser privacy recovery review follow-up — 2026-09-23

This local candidate addresses the two P1 findings on reviewed browser head
`191b5c2ffd708b01fa59bed67d7ed712e3fe2ece`. That head contains recovery commit
`243e505304c4387d7a3ab97af0b73ded9ae61ba4`, which recovered PR131/133 browser
privacy safeguards and the September 22 prototype authentication screens. This
follow-up changes two production files and their focused regressions. It does
not change server behavior, the prototype layout, or logout preferences.

## Behavior

- A rejected in-place PIN unlock now enters the shared compensating lock flow.
  A rejected transport response cannot prove the server remained locked. The
  persisted root shield survives a failed lock, cancellation, and component
  disposal; a later retry locks and refreshes before release.
- `SessionDelete` synchronously retires the document, media sources, players,
  Picture-in-Picture content, and downloads through the recovered
  `revokeSessionView` boundary. This applies to both locked and elevated
  authentication, even while status verification or SPA logout navigation is
  unresolved. Its revision change invalidates late PIN callbacks.
- An authoritative SDK HTTP 401 on status revalidation uses the same full
  authentication retirement. Ordinary offline errors retain the existing
  locked-only behavior. Credential PIN lock/reset events retain their narrower
  verified-locked exception; deleted authentication does not use that exception.
- Hard navigation targets `/auth/logout`, preserving the existing
  `consumeLogoutPreference` forced-password continuation instead of skipping the
  logout route.

## Local verification

Dependencies were installed into this worktree with
`pnpm install --frozen-lockfile --offline --ignore-scripts` (2,480 packages, zero
downloads). Root and web `node_modules` are directories owned by this worktree;
there are no shared dependency-directory links to another worktree. The local
SDK was compiled and SvelteKit synchronization ran before checking the web app.

- Whole-web `pnpm run check:typescript`: passed.
- Official whole-web `pnpm run check:svelte`: zero errors and zero warnings.
- Focused Vitest run: 12 files, 145 tests passed. Files cover the mounted unlock
  dialog and PIN route, root shield and TopBar, privacy guard and real media
  retirement boundary, asset cache and timeline, password/preferences, login,
  and auth shell. Node 25 required `NODE_OPTIONS=--no-experimental-webstorage`.
- New mounted dialog cases defer/reject the actual mocked SDK boundary, exercise
  failed and successful compensation, cancellation/disposal, and session
  deletion followed by a late successful response.
- New retirement cases exercise locked and elevated sessions with stalled SPA
  navigation, status request, and Picture-in-Picture exit. Focus and reconnect
  401 cases construct the actual SDK HTTP error via a mocked HTTP response.

- Scoped ESLint for the five changed source/test files: passed with zero warnings.
- Prettier and `git diff --check`: passed.

## Trace and qualification boundaries

Manual caller trace: root `SessionPrivacyGuard.svelte` owns
`watchSessionPrivacy`; websocket `on_session_delete` emits `SessionDelete`;
`AuthManager` starts asynchronous SPA logout while the guard independently
retires the document. TopBar owns `LockedUnlockDialog`; both production PIN
surfaces register the SDK promise, and the shared coordinator waits for pending
unlocks before locking. The logout route consumes the existing preference
continuation. No search-route or viewer sequencing files changed.

GitNexus impact returned `UNKNOWN` because the registered index did not contain
`watchSessionPrivacy`. Its explicit-worktree `detect_changes` recognized the five
changed source/test files but resolved zero symbols or processes. Those empty
results are an indexing limitation, not proof of zero impact; the manual trace
and focused regressions supply the bounded evidence here.

The separate server candidate supplies persisted `on_session_lock` and
`on_session_delete(sessionId)` notifications. These browser tests are not an
integrated server/browser, real-browser PiP, Docker, hosted CI, merge, or deployed
qualification result. Independent re-review of this exact follow-up remains
required. This task performs no push, default-branch merge, or deployment; the
parent owner retains Jira, Smart Commit ingestion, and PR lifecycle work.

## Wrong PIN retry follow-up

Review accepted both P1 repairs at `ab2b56c31536fe444d9f2ce5bb193c19271b3acd`
and identified a P2 regression: compensating every rejection also discarded the
prototype's Wrong PIN retry dialog. The follow-up limits the exception to an
actual SDK HTTP 400 whose server message is exactly `Wrong PIN code`.
`AuthService.validatePinCode` throws that response before `unlockSession` updates
the session. This confirmed rejection clears the entered digits and displays
the error in the open dialog; a second valid attempt can unlock in place.

Transport errors, HTTP 500, authentication HTTP 401, and unrecognized responses
retain the compensating lock. No broad HTTP 401 exception was introduced for
the PIN throttle, since authentication also uses that status. Mounted tests use
the actual SDK response parser for the Wrong PIN 400, 500, and 401 paths; they
verify retry and persistent shielding after failed compensation. Existing
TypeError, dismissal, unmount, and late-response regressions remain.

The follow-up changes only the dialog, its tests, and this evidence. Manual
impact remains the TopBar-owned in-place unlock flow; the route PIN prompt and
session deletion handling are unchanged. GitNexus could not resolve `unlock`
in its stale index. The focused dialog, route PIN, and privacy-guard run passed
52 tests across three files. Whole-web TypeScript and official Svelte checks
passed (zero Svelte errors or warnings), as did scoped ESLint, Prettier, and
`git diff --check`. Existing broader qualification limits above still apply.
