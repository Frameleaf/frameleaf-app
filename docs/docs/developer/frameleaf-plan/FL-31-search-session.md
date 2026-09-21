# FL-31 production search session slice

Status: bounded production candidate; [FL-31](https://heroit.atlassian.net/browse/FL-31) remains In Progress. This is not cross-surface library-session acceptance.

Baseline: `0116d4778d7ce34e9bc41a7d1fed46a4cd88a466`, freshly fetched `Frameleaf/frameleaf-app` `fork/main`. The committed prototype session and discovery query remain design references. Their production source anchors are absent from this baseline, so this slice does not import their simulated state or invent unsupported APIs.

## Production behavior

`web/src/lib/frameleaf/library-search-session.svelte.ts` owns the typed metadata/smart/Ask query, result collection, loading state and pagination for the existing authenticated search page. The page uses the existing SDK search endpoints and loader; backend ownership, album-read checks, elevation and privacy projections remain authoritative. The session is a component-owned instance, never a global cache or localStorage record.

A query replacement aborts the previous request and invalidates its identity. A late success, failure or completion cannot alter the newer result collection, page cursor or loading state, even when transport cancellation is ignored. Metadata, smart and Ask searches share that owner. Concurrent pagination calls coalesce; a current failure leaves its page available for retry. The session controls page and EXIF loading rather than accepting a stale page number from a portable filter URL.

The existing `query` and `ask` URL formats remain compatible. Deep links and Back/Forward query changes update the result request and the existing editable filter manager together. Opening an asset under the same search URL keeps the search request and collection. Successful page destruction aborts outstanding work; a merely attempted navigation does not discard the collection. Zero-result filter chips remain visible and removable. Delete undo reloads the current URL query through a zero-argument wrapper: the restored `TimelineAsset[]` callback payload cannot replace the search filters.

The existing selection manager, gallery viewer, scroll restoration, asset actions and quick editor remain in place. The session forwards existing viewing order in the search request and never writes shared album ordering. It introduces no new layout, storage preference, API, server migration, cloud action or rollout flag; existing search is repaired in place. New Frameleaf layouts remain outside this slice and require their planned rollout gate.

## Acceptance ledger

| FL-31 requirement                                                 | Evidence in this slice                                                                                                                           | Remaining acceptance                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One typed scope/query/filter/sort/group/view and navigation model | Typed existing search DTOs, one result and paging owner for metadata/smart/Ask production requests                                               | Timeline, albums, Spaces, pickers, maps and moments still have independent production models. Full shared grouping/view/layout state is not implemented.       |
| Preserve collection and filters across navigation                 | Production route tests restore deep-linked filters and editable fields through query history; asset-route navigation retains the current request | Authenticated full browser Back/Forward, cross-layout selection/scroll, open-media playhead and edit draft/undo return remain unqualified.                     |
| Portable query and device-local layout                            | Existing query URLs retained; no local selection, private assets or editor journal is persisted by this session                                  | Versioned complete portable library state and device-local layout preference remain open. Malformed legacy query URL validation remains an existing follow-up. |
| Personal sort distinct from shared album order                    | Scoped metadata request test retains album IDs and personal sort; no album mutation API is used                                                  | Cross-surface sorting and album editor parity remain open.                                                                                                     |
| Stale responses cannot overwrite newer scope                      | Deferred-response tests cover old scoped metadata success, old smart failure after Ask replacement, reset/disposal, duplicate loading and retry  | Facet races, PIN/access-event invalidation across all views and physical browser/server revocation tests remain open.                                          |
| Removable zero-match choices                                      | Actual Svelte search route renders zero-result chips and removes the filter through the existing URL/navigation path                             | Full faceted counts and picker preservation remain open.                                                                                                       |

## Validation and limits

Node `24.21.0`; focused web Vitest session and production-page suites: nine tests. The route suite mounts the production page and filter manager with mocked SDK, gallery and application chrome; it is not full browser, live API, accessibility, media or native qualification. Focused ESLint and Prettier apply to the four changed TypeScript/Svelte files.

The delete/undo regression mounts the production search page and deletion action, uses the real delete/restore utility and Undo toast callback, and checks that the repeated metadata request retains the URL filters. It fails with the original direct callback binding and passes with the wrapper. Gallery, chrome and SDK transport remain mocked.

Dependencies are installed inside this worktree from the frozen lockfile; tests do not use another worktree's `node_modules` or SDK build. With the pinned Node `24.21.0` and pnpm `11.24.0` on PATH, reproduce from the repository root:

```sh
node --version
pnpm --version
pnpm install --filter immich-web... --frozen-lockfile
pnpm --filter @immich/sdk build
pnpm --dir web exec svelte-kit sync
pnpm --dir web exec vitest run src/lib/frameleaf/library-search-session.svelte.spec.ts 'src/routes/(user)/search/[[photos=photos]]/[[assetId=id]]/page.svelte.spec.ts'
```

Run Vitest from the web working directory (`pnpm --dir web`), not from the repository root with a Vite root override; SvelteKit resolves its configuration from the working directory.

The initial check using borrowed dependencies reported two enum errors in the unchanged `DetailPanelImageEnrichment.spec.ts`. With the isolated frozen-lockfile install and locally rebuilt SDK, the whole-web TypeScript check passes. Hosted exact-candidate Actions remain the authoritative merge gate.

GitNexus indexed this exact baseline in the owned worktree. It cannot resolve the page-local Svelte functions and reports UNKNOWN risk for them; manual caller tracing covers the production route, gallery reload/pagination callbacks and search filter manager. Before commit, change detection must be run against `fork/main`; lack of indexed Svelte symbols is not zero-impact evidence.

All mobile implementation remains deferred. Keep FL-31 open until its full requirements are implemented and qualified. Rollback is a revert of this search-only slice; it requires no data or configuration migration.
