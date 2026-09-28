# FL-31 search and viewer concurrency recovery

This packet starts from integration `fbbdc7970eca748fef793e04ec1847660a73c9d3`. The September 23 read-only comparison with PR 133 (`0a042d2490`) found lost production concurrency contracts, not just different presentation. FL-31 remains In Progress; this is a bounded recovery, not full shared-session or privacy acceptance.

## Recovered contracts

The search request owner and deferred-response cases reuse the reviewed FL-31 implementation in `6ce2bc612d`. The current Search page retains its September 22 components and `dq`/legacy parsing, but metadata, smart and Ask now share a component-owned request identity. Query or endpoint replacement aborts the old request and rejects its late data, errors and loading completion. Pagination coalesces while in flight, retains a failed page for retry, and follows structured cursors without mixing deprecated flat paging fields. Asset-only URL changes retain the collection and mounted result draft; destruction aborts and retires pending work. The existing library selection/view store remains the selection authority.

Viewer action recovery adapts `65b4153d47`, `ff66374915`, `2a38cbc108` and `55fdce8e95`. Delete, archive, restore and mark/unmark-sensitive completion retain the invoked asset across confirmation, navigation and request delays. Pre-action navigation is awaited through the real AssetViewer producer chain; a rejected navigation does not start its mutation. Delete events identify the invoked asset even after the viewer has advanced. Flat results choose the replacement before the mutation event; Timeline rejects old confirmation cursors and late neighbor lookups. The current lock/unlock APIs and view-specific lock behavior remain in place. Archive failure no longer returns a successful asset/completion.

No archive-operation backend, layout, dialog, Command Center, session-lock coordinator, schema, generated SDK or mobile source is changed. The former `library-access.ts` adapter is not reintroduced: cross-surface access retirement is a separate coordinated privacy packet.

## Local verification

Node 24.21.0 and pnpm 11.24.0, isolated worktree and frozen dependencies. Rebuilt only this worktree's JavaScript SDK; no live API, personal media or external email was used.

The same four recovered/adapted regression suites were run against the unchanged integration production files: **20 failed, 3 passed**, with one unhandled rejection from the original non-awaited navigation path. Candidate source bytes were then restored. The complete focused candidate set passes **82 tests with one existing skip across ten files**:

- Route-owned search session and production Search page.
- Captured action identity, real Timeline deletion and real flat-results deletion integration.
- Existing DeleteAction, AssetViewer, TimelineAssetViewer, asset utility and discovery-query suites.

The mounted tests retain actual action/viewer/event code while mocking SDK transport, route publication and unrelated media/editor internals. Deferred responses establish ordering, target identity, stale-result rejection and retained route-component drafts. They are not authenticated browser or physical media/playhead qualification. The expanded existing suite prints happy-dom teardown fetch warnings for an unavailable localhost:3000 service; Vitest reports no candidate test errors.

Whole-web TypeScript passes. The official Svelte command (`svelte-check --no-tsconfig --fail-on-warnings`) reports zero errors and zero warnings. Changed-file lint and formatting pass. Independent review and exact-head hosted validation belong to the parent integration owner; no push, merge, deployment or full-issue completion is claimed.

## Impact boundary

GitNexus's partial index cannot resolve the relevant Svelte callbacks or the recovered request-owner class and reports UNKNOWN. Its resolved `toggleArchive` entry reports LOW, but misses its Svelte caller. Manual source tracing therefore covers Search, Photos/Albums/Trash Timeline viewers, flat-results viewers and the shared action producer/utility chain. `detect_changes` ran against the explicit isolated worktree and counted all 19 staged files, but its stale offsets attributed the asset utility change to `selectAllAssets` instead of `toggleArchive` and omitted the Svelte callbacks. Its LOW summary is therefore incomplete; source tracing and the staged diff establish this packet’s actual scope.
