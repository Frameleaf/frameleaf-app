# FL-29 web production primitives

Candidate foundation for [FL-29](https://heroit.atlassian.net/browse/FL-29), based on `fork/main` commit `5acd172436a0c8b68d93e51527c5461812511310`. Not merged, deployed or fully qualified. Native work is explicitly deferred by the September 21 user instruction; the Flutter requirements are retained for future native applications.

## Implementation contract

`web/src/lib/components/frameleaf/Theme.svelte` scopes the approved dark/light token CSS to its subtree. Use the current application theme preference as its `theme` prop. It does not copy the prototype runtime or change existing routes. `Pane`, `Rail`, `TreeBranch`, `Dialog`, `Picker`, `FilterChip`, `PersonAvatar`, `Status` and `Brand` provide composable production components.

- `Rail` exposes bindable collapse state. The shell owns persistence and supplies accessible links for both icon and expanded modes; this primitive never invents navigation or user preferences.
- `Dialog` uses the native modal top layer, focus containment and Escape behavior. It restores the connected invoker on close/unmount; callers supply translated title and close label. Nest it inside `Theme` so the top-layer dialog inherits tokens.
- `Picker` reuses the existing production `Combobox`, including search, full option list and keyboard behavior. Callers supply authorized options and contextual count labels, never global or sample data.
- `TreeBranch` uses a native disclosure instead of applying incomplete ARIA tree semantics. Links and action controls remain ordinary keyboard destinations.
- `FilterChip` requires a specific accessible removal label and delegates the real filter mutation. `Status` is a polite live region, with optional busy state.
- `PersonAvatar` accepts an already-authorized person DTO and reuses the authenticated thumbnail URL and existing `ImageThumbnail` lifecycle. It mounts no image for absent evidence, and remounts on identity/thumbnail revision changes. It does not fetch, cache or authorize people. Consumers must clear the whole person chip, its name/count and selected evidence on account changes, lock, revocation or inaccessible-source changes. Passing an accessible person response is not permission to expose a private source thumbnail.
- `Brand` references the supplied `frameleaf-logo-white.svg` directly by URL. No original bytes or paths are modified, and no derivative exists. Its explicit charcoal plate preserves the white wordmark in both application themes. The source artwork has an accessible image name.

## Local validation

Focused commands from `web`:

```sh
./node_modules/.bin/vitest run src/lib/components/frameleaf/primitives.spec.ts src/lib/frameleaf/tokens.spec.ts
```

The six tests cover filter removal, private face evidence unmount, live status, modal open/close and invoker restoration, exact token values and minimum 4.5:1 foreground contrast. A scoped `svelte-check` config covering the new components and fixtures reported zero errors and warnings. Compiler checks also reported no accessibility warnings. Local dependencies were reused read-only from the existing installation; pnpm's automatic install attempt was rejected by its worktree symlink safety check. No lockfiles or shared dependency tree were replaced.

A standalone Chromium fixture exercised real native dialog Escape and focus return, captured both themes at 1440×1000, 820×1180 and 390×844, and checked horizontal overflow. The fixture stubs framework navigation and thumbnail loading, contains no personal data and is not application integration proof. Screenshots are local evidence, not uploaded product screenshots. The phone-light and desktop-dark captures were visually inspected. The supplied-brand inventory check passed; its existing qualified-consumer ledger remains unchanged pending integration qualification.

## Remaining acceptance

Independent privacy review, hosted exact-head checks, real application consumers, authenticated face-source policy/revocation integration, full picker keyboard integration, screen-reader testing and production-theme screenshots remain open. Existing screen/action workflows are retained. The shared shell issue must persist collapse/theme choices and wire these primitives to real services. Full FL-29 acceptance must not be inferred from these isolated controls or test fixtures. Mobile acceptance is deferred, not passed.

Confluence synchronization and Jira Smart Commit delivery are pending the reviewed PR candidate. Keep the Jira issue In Progress. No merge, registry publication, deployment or mobile store operation is authorized by this candidate.
