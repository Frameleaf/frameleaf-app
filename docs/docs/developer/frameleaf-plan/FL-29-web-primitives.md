# FL-29 web production primitives

Candidate foundation for [FL-29](https://heroit.atlassian.net/browse/FL-29), based on `fork/main` commit `5acd172436a0c8b68d93e51527c5461812511310`. Not merged, deployed or fully qualified. Native work is explicitly deferred by the September 21 user instruction; the Flutter requirements are retained for future native applications.

## Implementation contract

`web/src/lib/components/frameleaf/Theme.svelte` scopes the approved dark/light token CSS to its subtree. Use the current application theme preference as its `theme` prop. It does not copy the prototype runtime or change existing routes. `Pane`, `Rail`, `TreeBranch`, `Dialog`, `Picker`, `FilterChip`, `PersonAvatar`, `Status` and `Brand` provide composable production components.

- `Rail` exposes bindable collapse state. The shell owns persistence and supplies accessible links for both icon and expanded modes; this primitive never invents navigation or user preferences.
- `Dialog` uses the native modal top layer, focus containment and Escape behavior. It restores the connected invoker on close/unmount; callers supply translated title and close label. Nest it inside `Theme` so the top-layer dialog inherits tokens.
- `Picker` reuses the existing production `Combobox`, including search, full option list and keyboard behavior. Its scoped styles override upstream input/menu/hover/selection/disabled colors with inherited Frameleaf tokens; nested themes resolve independently of the app’s `.dark` class. A native disabled fieldset also disables the clear button. Retain the application TooltipProvider when rendering the picker, as required by the existing UI components. Callers supply authorized options and contextual count labels, never global or sample data.
- `TreeBranch` uses a native disclosure instead of applying incomplete ARIA tree semantics. Links and action controls remain ordinary keyboard destinations.
- `FilterChip` requires a specific accessible removal label and delegates the real filter mutation. `Status` is a polite live region, with optional busy state.
- `PersonAvatar` accepts an already-authorized person DTO and reuses the authenticated thumbnail URL and existing `ImageThumbnail` lifecycle. It mounts no image for absent evidence, and remounts on identity/thumbnail revision changes. It does not fetch, cache or authorize people. Consumers must clear the whole person chip, its name/count and selected evidence on account changes, lock, revocation or inaccessible-source changes. Passing an accessible person response is not permission to expose a private source thumbnail.
- `Brand` references the supplied `frameleaf-logo-white.svg` directly by URL. No original bytes or paths are modified, and no derivative exists. Its explicit charcoal plate preserves the white wordmark in both application themes. The source artwork has an accessible image name.

## Local validation

Focused commands from `web`:

```sh
./node_modules/.bin/vitest run src/lib/components/frameleaf/primitives.spec.ts src/lib/frameleaf/tokens.spec.ts
```

The seven tests cover filter removal, private face evidence unmount, live status, modal open/close and invoker restoration, exact token values, minimum 4.5:1 foreground contrast, nested picker themes and disabled picker controls. A scoped `svelte-check` config covering the new components and fixtures reported zero errors and warnings. Compiler checks also reported no accessibility warnings. Local dependencies were reused read-only from the existing installation; pnpm's automatic install attempt was rejected by its worktree symlink safety check. No lockfiles or shared dependency tree were replaced.

A standalone Chromium fixture exercised real native dialog Escape and focus return, captured both themes at 1440×1000, 820×1180 and 390×844, and checked horizontal overflow. The fixture stubs framework navigation and thumbnail loading, contains no personal data and is not application integration proof. Screenshots are local evidence, not uploaded product screenshots. The phone-light and desktop-dark captures were visually inspected. The supplied-brand inventory check passed; its existing qualified-consumer ledger remains unchanged pending integration qualification.

## Remaining acceptance

Independent privacy review, hosted exact-head checks, real application consumers, authenticated face-source policy/revocation integration, full picker keyboard integration, screen-reader testing and production-theme screenshots remain open. Existing screen/action workflows are retained. The shared shell issue must persist collapse/theme choices and wire these primitives to real services. Full FL-29 acceptance must not be inferred from these isolated controls or test fixtures. Mobile acceptance is deferred, not passed.

A reviewer-found picker theme leak was repaired with scoped token styling. A second Chromium matrix loaded production `app.css` and checked all four combinations of global app dark mode and Frameleaf theme, opposite nested themes, input/menu/keyboard-selected/disabled colors, computed accent focus outlines despite the application reset, and ArrowDown/Enter selection. Four local screenshots record this check; two contrasting app/Frameleaf combinations were visually inspected. The current local Node 25 run disables its experimental web storage flag to use the DOM test environment (`NODE_OPTIONS=--no-experimental-webstorage`); the repository-pinned runtime remains the CI authority.

Confluence synchronization and Jira Smart Commit delivery are pending the reviewed PR candidate. Keep the Jira issue In Progress. No merge, registry publication, deployment or mobile store operation is authorized by this candidate.

## Reduced-motion follow-up — September 21, 2026

This bounded local follow-up starts from `3294180d26dd696109d5683037f0c2a39f6f105d` on the existing FL-29 worktree. The shared `Combobox.svelte` now reads the existing reactive `mediaQueryManager.reducedMotion`: its Svelte intro duration is zero when reduced motion is requested, otherwise the existing 250 ms. The CSS token rule alone did not control Svelte's Web Animations API transition. No new preference, listener, dependency, API, authorization or mobile change is introduced. Frameleaf Picker and the existing camera/location/tag/date/job/settings callers inherit the correction.

A focused two-case regression failed for reduced motion before the fix and passes afterward. All nine focused Frameleaf tests now pass, alongside focused ESLint and the scoped Svelte check (zero errors/warnings). The test also preserves ArrowDown/Enter selection for both preferences. A standalone Chromium check with production `app.css`, real `matchMedia` and real `Element.animate` recorded five 250 ms listbox intro animations under `no-preference`, and no listbox animation calls under `reduce`; keyboard selection produced `Camera A (12)` in both cases, with no page errors. The fixture contains only synthetic options and stubs framework navigation/thumbnail loading; it is component evidence, not library authorization or application-wide qualification.

Local browser artifacts are named `frameleaf-fl29-reduced-motion-browser.json`, `frameleaf-fl29-reduced-motion-no-preference.png` and `frameleaf-fl29-reduced-motion-reduce.png` in the task artifact directory. The repeatable local browser driver is `fl29-reduced-motion-browser.mjs`. This follow-up is local-only during the provider suspension: no fetch, push, GitHub/CI operation, merge, publication or deployment. Its Smart Commit awaits a later authorized push. Parent coordination owns PR #128 lifecycle and integration; native acceptance remains deferred and wider FL-29 acceptance remains open.

## Reconciled qualification — September 21, 2026

The earlier sections are historical checkpoints. PR128 was merged at `fc9d12d38ab707dd368298df84af2848106529be` on September 21, 2026, and is an ancestor of the freshly fetched default `0116d4778d7ce34e9bc41a7d1fed46a4cd88a466`. The reviewed primitives, People-filter integration and reduced-motion correction have landed. This does not establish registry publication, deployment or full accessibility acceptance.

Authenticated People-filter evidence is recorded in `/Users/adamtaylor/.codex/worktrees/frameleaf-authenticated-browser-evidence/README.txt` and its runnable drivers/results. It covers real Chromium, API, WebSocket and disposable synthetic accounts: two-tab server lock clears private person evidence, keyboard chip removal retains usable focus, and recovery returns both tabs to a usable locked search shell. The receipt identifies its exact frontend candidates and the older backend used; it must not be presented as current video-worker or every sensitive-policy qualification.

Production navigation qualification at `deee52d075b8623486c8ddf376b48483692b2546` used a freshly built matching backend and disposable synthetic data. `/Users/adamtaylor/.codex/worktrees/frameleaf-fl30-browser-evidence/README.md` and its JSON/results/drivers record real route and Back navigation, preserved unsaved settings drafts, persisted collapse and rollout preferences, capability gates, collapsed accessible names, keyboard/Escape focus return at 820 and 390 pixels, settled dark/light appearance, logo readability and no horizontal overflow. It qualifies the implemented rail consumer of the shared primitives; that navigation candidate was not on the default branch when this receipt was written.

Remaining FL-29 acceptance includes actual screen-reader software, broader cross-browser and production-consumer journeys, complete private-evidence invalidation across every consuming surface, and full design parity. A Chromium accessibility tree is not a screen-reader test. FL-31 is addressing the separately discovered search/viewer access-event gap; the successful People picker check cannot stand in for that work. Retain the existing original SVG bytes and scoped tokens. Native/mobile implementation remains deferred and FL-29 remains In Progress.
