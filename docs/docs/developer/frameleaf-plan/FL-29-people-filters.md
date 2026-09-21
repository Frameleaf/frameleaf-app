# FL-29 production People filters

Local follow-on to the reviewed primitives in [FL-29](https://heroit.atlassian.net/browse/FL-29) / [PR 128](https://github.com/Frameleaf/frameleaf-app/pull/128), based on `3294180d26dd696109d5683037f0c2a39f6f105d`. This continuation is not pushed, merged, deployed or fully accepted. The original primitive receipt remains a separate historical foundation. All mobile work is deferred by the user.

## Requirement evidence

| FL-29 requirement | Implementation and evidence | Remaining acceptance |
| --- | --- | --- |
| Real faces in active People filters | Production SearchFilters consumes FilterChip and PersonAvatar using owner-scoped getAllPeople results and the existing authenticated thumbnail URL. Existing People selection remains functional in both search entry points. | Authenticated multi-owner end-to-end qualification against a running application. |
| Private evidence and in-flight revocation | Both the dropdown and SearchFilterModal use PeopleSearch. Lock, access changes, PIN reset, logout, session deletion, deleted face evidence and account changes clear names, selected IDs, counts and images, cancel pending requests, and reset picker-local name input. Late responses cannot repopulate a revoked or different account. Routine person/thumbnail updates hide and refetch evidence without clearing the query; only a refreshed complete authorized list prunes inaccessible selected IDs. A failed thumbnail removes the associated evidence and exposes retry. | Independent re-review of the repaired routine-update query-preservation finding and deployed event/session-expiry qualification. This component relies on the established global session event contract; it does not replace the FL-34 session guard. |
| Complete selection and recovery | Fetches every API page before using the allowed ID set, preserves selected-first order, removes inaccessible stale selected IDs, and renders retry for request failures. The actual SearchManager query changes on selection/removal. | Broader large-library performance and full library query migration remain separate acceptance. |
| Keyboard, touch and responsive themes | Scoped Theme follows the application theme manager. Removal buttons are labelled, return focus to the People filter, retain touch dimensions, and remain reachable with long names. Person selectors expose aria-pressed. Only search-history options occupy the combobox's listbox; filter buttons/chips are siblings. | Actual screen-reader review and cross-browser/full application qualification. |
| Supplied branding and no prototype leakage | Reuses the existing token/primitive layer; imports no React prototype runtime or CSS. Supplied SVGs are unchanged. | Broader shell/branding consumers retain their original qualification gates. |

## Validation

Node 24.21.0; repository-installed dependencies reused without lockfile changes. Focused command from `web`:

```sh
./node_modules/.bin/vitest run src/lib/components/shared-components/search-bar/SearchFilters.spec.ts src/lib/components/frameleaf/primitives.spec.ts src/lib/frameleaf/tokens.spec.ts
```

All 19 tests pass. The twelve production-search cases cover a real selected chip and query removal/focus, lock during a pending request, logout, failed-request retry, pagination, account switch, unavailable thumbnail, the full search modal, stale inaccessible IDs, abort on unmount, unrelated background-thumbnail query preservation, and inaccessible-ID pruning after routine refresh. Existing primitive/token cases remain passing. Web TypeScript and the repository Svelte diagnostics report no errors or warnings; changed-file lint passes.

A local Chromium fixture mounts the production SearchFilters and app.css with synthetic API responses, framework/auth stubs and a nonpersonal SVG thumbnail. It verifies Enter removal and focus return, Space selection and aria-pressed, lock clearing, accessible chip names, visible two-pixel focus outlines, minimum 44-pixel removal targets, and long-name removal-button reachability. It captures dark/light views at 1440x1000, 820x1180 and 390x844 without document overflow. A long-name clipped-removal regression was reproduced and repaired before the final pass. Phone-dark and desktop-light screenshots were visually inspected. These are component integration checks, not server authentication, real face-image quality, screen-reader software, or deployed application evidence.

Local browser artifacts use the `frameleaf-fl29-people-` prefix beside the worktrees. The runnable unit checks remain in the repository; the standalone browser fixture is local evidence and is not shipped with the application. No personal media, tokens or credentials were captured or uploaded.

## Delivery limits

Keep FL-29 In Progress. Independent review, hosted checks, merge authorization and full acceptance remain open. The new helper has two real consumers, so both share the same cancellation/privacy behavior rather than preserving an unguarded modal path. No server, schema, SDK, native, FL-34 timeline, or FL-39 editor implementation is changed. Reverting this continuation restores the previous People search consumers; original assets and storage are unaffected.
