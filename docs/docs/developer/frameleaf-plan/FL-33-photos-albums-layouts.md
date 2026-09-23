# FL-33 Photos and Albums layout packet

Issue: [FL-33 / LIB-001](https://heroit.atlassian.net/browse/FL-33). This is a bounded production web packet, not full issue completion. Parent coordination owns Jira, GitHub, CI and Confluence mirroring. No push, merge, publication or deployment is included.

## Production boundary

The route-owned `LibraryTimelineSession` and paginated `TimelineManager` remain the data authority for Photos and Album detail. Those two routes opt into Timeline, Browse and Work only while the existing Frameleaf navigation preview is enabled. Timeline stays first and stretches short chronological day groups across the photo area. Browse uses equal 3:2 contact-sheet cells; Work uses a denser grid beside a collapsible selection inspector. The inspector uses current authorized selection fields and opens the original full viewer for all information and editing. Original day grouping, ordering dates, selection callbacks, menus, album membership and source actions remain in their existing components.

Presentation changes reuse the same Timeline, manager, loaded months and Portal/TimelineAssetViewer. The actual image/video editor remains mounted; there is no copied editor recipe, fabricated undo history or serialized playback state. The layout controls capture and restore an asset-relative scroll offset without fetching or resurrecting a deleted/revoked asset. Only layout and inspector collapse preferences persist on the device; queries, identities and private media evidence do not enter those preferences. Turning off the preview returns to the original layout. Search, Memory and Spaces are not opted in.

The shared geometry option setter previously short-circuited after its first changed field, skipping later dimensions. It now applies header height, row height and gap together. The original non-preview geometry height calculation is retained exactly. No backend, API, SDK, privacy contract, search adapter, bulk-archive worker, viewer action or native implementation is changed.

## Local validation

Candidate `dba7e6691c92251afbf8fa4747f2b2d7d72e1220` follows base `ea4a057e009d6c8cf203ded5c6c7b75f1ae13cf9`. Sixty-nine focused tests pass across the existing manager, route session, mounted Timeline component and new geometry tests. The focused component suite passed again after the browser-found duration conversion correction. Focused ESLint, TypeScript and Svelte checks pass; the Svelte check reports zero errors and warnings. GitNexus reported HIGH class-level impact for TimelineManager before its single presentation property was added; staged change analysis was LOW for the bounded diff. These are local checks, not hosted merge gates.

Actual Chromium qualification used this clean source candidate, its built SDK/plugin SDK/server, Node 24.21.0, pnpm 11.24.0, real API and microservices, disposable PostgreSQL 14 VectorChord and Valkey 9, and thirteen generated-color photo/video assets. API, Vite, PostgreSQL and Valkey used loopback ports 12333, 13033, 15463 and 16363. No personal media, production credentials, intercepted authorization, fake asset API or prototype runtime was used. The local FFmpeg lacks a WebP encoder; the disposable instance was configured through the real admin API to generate JPEG thumbnails, then the video thumbnail was regenerated through the real job API.

The evidence bundle records:

- Photos and Album detail switch through all three layouts while retaining selected IDs, their real route scope and an asset-relative viewport offset. Real API responses contain two month pages. Work inspector collapse changes pane visibility without changing layout. Original selected-action bars remain present.
- Empty Album detail stays empty through all layouts. Layout/collapse preferences survive reload; browser Back returns to the collection route. Enter and Space activate the actual controls. Light and dark captures at 1440 and 390 pixels show no horizontal document overflow; the existing rail can collapse independently.
- A second real browser tab changes the same device preference while the first keeps a real video open. The same video element, asset URL and paused four-second playhead remain. The same image editor Save node and unsaved rotation remain through each layout, and its existing Reset changes action still works. The actual video editor instance also retains an unsaved enhancement draft and its working Reset action. No new undo behavior is claimed.
- Real API deletion retires an open asset and its timeline thumbnail through server events. Actual session lock replaces the elevated document and retires the open viewer. No browser page errors were recorded in these completed checks.

Evidence lives in the local `frameleaf-fl33-browser-evidence-20260921` bundle: drivers, screenshots and structured layout/viewer/extra/retirement proof. Session tokens and raw operational logs are excluded. Runtime cleanup is recorded in the bundle README.

## Remaining acceptance

Keep FL-33 In Progress. Independent exact-candidate review, hosted current-head gates, full Search/Memory/Spaces layouts, exhaustive action/privacy/error matrices, production-scale libraries, screen-reader and cross-browser qualification remain open. Native/mobile work is explicitly deferred. Broad Studio remains gated separately. The existing editor Reset behavior is demonstrated, not a new undo stack or full Studio qualification. The full-screen viewer hides the library controls; the cross-tab device-preference test proves retained media/editor instances without inventing an additional viewer toolbar. No fetch-all path or unsupported Spaces backend was added.

## Independent review and integration

Independent review approved exact candidate `e5de571e8c753bcfdb0c9337ecd078fce8ed0266` with no actionable P0–P2 findings; its runtime remains `dba7e6691c92251afbf8fa4747f2b2d7d72e1220`. The reviewer traced retained managers/viewer subtrees, geometry, anchor retirement and browser evidence, and independently passed eight focused layout/component tests. Root integrated it as `4fc7323e6`, preserving the additive FL-32 matching Archive action. The combined layout, Photos, archive modal and real Gallery/Timeline deletion suites pass all 28 tests; whole-web TypeScript and Svelte checks pass with zero errors or warnings. This resolves the independent-review item above; hosted and broader acceptance remain open.
