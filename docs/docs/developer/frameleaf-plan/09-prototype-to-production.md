# Prototype to production: implementing the September 22 design revision

Status: implementation plan for the features added to the design template on September 22, 2026, revised the same evening for the Albums page vocabulary, the icon catalogue and the physical deduplication preview. It maps every prototype capability to its production owner in the FL backlog, states what production must do differently from the simulation, and sequences the work. It does not claim any of it is implemented. Read [the implementation plan](00-implementation-plan.md) and [agent execution](01-agent-execution.md) first; the boundaries there still apply.

## What the prototype now contains

The template in `design/frameleaf/template` carries the full product surface the parity audit found missing plus the polish directions from the product review. The written decisions are in the "September 22, 2026 revision" of [the interaction requirements](../../../../design/frameleaf/INTERACTION-REQUIREMENTS.md). The prototype is evidence of the intended interaction and layout. Everything in it that renders, computes or persists does so with sample data in the browser. Production keeps its NestJS services, PostgreSQL schema, Python ML and the Svelte web client, and ports the behaviour through real APIs.

Prototype source anchors used below are relative to `design/frameleaf/template/src`.

## Ground rules for every port

- The Svelte app hosts everything. React is bundled only for the Studio editor behind the adapter boundary in [the Studio plan](03-studio-rendering-and-restoration.md). Do not mount the prototype.
- Every action goes through the existing authorized service. A control that exists in the prototype without a backing endpoint is not done until the endpoint exists and is access checked.
- Sensitive and Locked semantics, actor-only duplicates, album membership preservation and original-file preservation are unchanged.
- Strings go through `i18n/en.json`. Prototype copy is the source wording.
- Tokens come from `web/src/lib/frameleaf/tokens.css`, extended with the new motion, radius, status and viewer tokens from `src/reference/tokens.css`. Type scale is 14 px body and 12 px secondary.
- Each story ships with vitest coverage for pure logic, a Playwright journey for the screen, light and dark captures at desktop and phone width, and reduced-motion respected. All of it runs on GitHub Actions only.

## Workstream A: shell, session and library foundation

Owners: FL-29, FL-30, FL-31, FL-32, FL-33, FL-36.

| Prototype | Production work | Notes |
| --- | --- | --- |
| Tokens and type scale (`reference/tokens.css`, `styles.css`) | Extend `tokens.css`; raise base size; add `--fl-motion-*`, `--fl-radius-card`, `--fl-teal`, `--fl-blue`, `--fl-viewer-*` | Contrast test already exists; extend it to the new tokens |
| Icon map (`Icon.jsx`: explicit imports for the app plus a fallback to the whole `@mdi/js` catalogue) | Keep per-component imports for the app's own icons; serve the album icon catalogue as data so pickers can offer every Material icon without bundling the catalogue in the web client | Any `mdi*` name is a valid stored icon; validate names server side against the catalogue |
| Rail with collection tree, discovery destinations, partner library, shared links, support (`LibraryRail.jsx`) | Replace `UserSidebar` navigation with the Frameleaf `Rail` fed by the album tree API and the feature preferences | Hidden features are preferences, not permissions |
| Topbar: single search, upload, notifications, activity indicator, theme, Locked icon, account menu (`App.jsx`, `SystemPanels.jsx`) | Rebuild `NavigationBar.svelte` | Locked toggle stays wired to the existing elevated session |
| Session: Browse default, selection separate from the open item, shift range, group select, page state (`selection.mjs`, `App.jsx`) | Production `library-session` adopts the same reducer semantics | Selection is never persisted across reloads |
| Results toolbar with the single Filter control and badge, chips only while active (`App.jsx`) | Replace the search filter row on timeline pages; the search modal keeps the full filter panel | The Filter menu deep-links into filter panel sections |
| Justified timeline, sticky day headers, day select-all, year scrubber (`TimelineLibrary.jsx`, `justified-layout.mjs`) | Port the layout algorithm into the timeline manager; virtualize by bucket | The prototype does not virtualize; production must |
| Asset tile: badges, hover scrub, Live Photo press, ratings on hover (`AssetTile.jsx`) | Thumbnail component | Hover scrub uses the existing preview transcode; never the original |
| Selection bar and bulk actions with undo (`SelectionBar.jsx`, `selection.mjs`, `bulkAction` in `App.jsx`) | Bind to the existing bulk endpoints: favorite, album add and remove, download, stack, Live Photo link, date, description, location, archive, sensitive mark, tag, trash, restore, permanent delete, refresh jobs | Undo for trash uses restore; partial failures report per item |
| Shortcuts table and help (`shortcuts.mjs`, `ShortcutsHelp.jsx`) | Replace the shortcuts modal content; one key map for timeline and viewer | |
| Paging with Show more (`paginate` in `search.mjs`) | Server paging already exists; keep the cumulative "Showing n of m" summary | |

## Workstream B: viewer and information panel

Owners: FL-35, FL-36, FL-38.

| Prototype | Production work |
| --- | --- |
| Complete More menu grouped Download, Organize, Stack, Set as, Go to, Jobs (`MediaViewer.jsx`) | Map each id to the existing asset service actions; hide unsupported ones per context |
| EXIF line under the title; file, path, checksum details | Detail panel data already present; new layout only |
| Inline edits: description, date and timezone, location with pin picker, tags, rating | Existing change endpoints; the location dialog reuses the geolocation picker |
| Enrichment card: accept, clear, rerun description; sensitivity score and review state | Existing image-enrichment endpoints and NSFW review actions |
| People: hover highlights face box; reassign, create, remove, hide face; hidden people toggle; age at capture | Existing face and person endpoints; birthday from person record |
| Stack strip with keep-this and set-primary; Live Photo play; panorama look-around; offline relink | Stack, motion photo and offline flows already exist server side |
| Cast dialog, copy image, play original or encoded | Existing cast and playback selection |
| Filmstrip, slideshow order and look settings | Client only |

## Workstream C: editing, Studio and restoration

Owners: FL-113 (quick editor), FL-39 and FL-16 (master policy), FL-88 to FL-105 (Studio), FL-110 to FL-115 (restoration).

| Prototype | Production work | Gate |
| --- | --- | --- |
| Full-screen media-aware editor (`Editor.jsx`, `develop.mjs`, `state.mjs`) | A photo develop pipeline does not exist in production. Add a server-side edit recipe renderer for stills (exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, clarity, dehaze, vignette, grain, sharpen, noise reduction, crop, straighten, flip, presets) producing an edited master and a preview | Colour maths must be validated against reference renders; the prototype's CSS filters are approximations |
| Video tools: trim, speed segments, filters, stabilize, auto-enhance, timed text, social presets, export frame | Already in the fork's `VideoEditorPanel`; port the layout and keep the existing commands | Edited-master policy from FL-39 |
| Histogram, before and after, copy and paste settings, versions | Client, fed by the recipe renderer's preview | |
| Studio multitrack, colour, audio, motion, captions, restoration (`Studio.jsx`, `studio-project.mjs`) | The Freecut adaptation plan. The prototype's project model is the interaction contract for the React host; the graph stays Freecut's | Rendering proofs and worker admission from the Studio plan |
| Activity page and indicator (`Activity.jsx`) | Bind to the durable job API from FL-43 and FL-104 | |
| Restoration before and after, estimates, destinations | FL-110 to FL-115; estimates from measured throughput | Never silently upload to cloud |

## Workstream D: collections and sharing

Owners: FL-52, FL-53, FL-54, FL-55, FL-56.

| Prototype | Production work |
| --- | --- |
| Albums page: one shelf per collection (cover mosaic, album and item counts, members, New album, menu) with square album tiles beneath, then albums on their own, then shared spaces; filters All, My albums, Shared, Smart; one sort menu; grid and list views; New menu for album, smart album, collection or shared space; drag an album onto a collection (`Collections.jsx`, `AlbumCard.jsx`, `collections-data.mjs`) | Existing albums API plus one level of nesting: a collection is an album container (`kind: "collection"`), albums nest only inside collections, shared spaces stay top level; persist `icon` on albums and collections. Vocabulary is album, collection and shared space, never subcollection |
| Album header: inline title and description, members with roles, links, map, slideshow, download, cover, options, delete keeping assets, leave; a collection page shows an album strip above its photos (`CollectionHeader.jsx`) | Existing album, share and link endpoints; a collection page lists its albums from the tree endpoint |
| Icon chooser over the whole Material catalogue with a categorised suggested set of 227 icons, embedded in the create and edit dialogs and as a popover on album and collection pages (`IconChooser.jsx`, `collectionIconGroups` in `collections-data.mjs`) | Client component; the catalogue comes from a data endpoint; every future icon picker reuses it |
| Activity panel with likes and comments (`ActivityPanel.jsx`) | Existing activity API |
| Smart collections with rules and re-evaluation | Fork's smart album service |
| Shared links list, form, QR, public viewer, partner header (`SharedLinks.jsx`, `SharedLinkForm.jsx`, `qr.mjs`, `PublicViewer.jsx`, `PartnerLibrary.jsx`) | Existing shared-link and partner endpoints; the public viewer is its own layout without private navigation |
| Share sheet with person tiles and link creation (`ShareSheet`) | Client over the same endpoints |

## Workstream E: people

Owners: FL-37, FL-57, FL-58.

| Prototype | Production work |
| --- | --- |
| People grid with inline naming and suggestions, hide and favorite, merge suggestions, show hidden (`People.jsx`, `people-data.mjs`) | Existing person endpoints; merge suggestions from the recognition service |
| Person page: featured photo, merge, date of birth, hide, favorite, fix incorrect match (`PersonDetail.jsx`) | Existing person and face endpoints |
| Manage people visibility (`ManagePeople.jsx`) | Existing bulk visibility update |
| Pets | FL-58 defines the identity model; the prototype only shows the destination |

## Workstream F: discovery

Owners: FL-46, FL-50, FL-51, FL-62.

| Prototype | Production work |
| --- | --- |
| Map with clusters, settings, search this area (`MapView.jsx`) | Production keeps MapLibre with the configured tile source; port the cluster interaction, the settings sheet and the bounds query |
| Places grouped by country and state (`Places.jsx`) | Existing places endpoint |
| Tags tree with create, rename, colour, nest, delete (`Tags.jsx`) | Existing tag endpoints; colour and parent already supported |
| Folders browser (`Folders.jsx`) | Existing folder endpoint |
| Memories index and player with Ken Burns, gallery, remove, share, make a movie (`Memories.jsx`, `MemoryPlayer.jsx`, `discovery-data.mjs`) | Existing memories API; "make a movie" hands the asset list to Studio |

## Workstream G: system, account and settings

Owners: FL-45, FL-49, FL-71, FL-76, FL-80, FL-81, FL-135.

| Prototype | Production work |
| --- | --- |
| Login, register, forced password change, PIN prompt with digit cells, onboarding, maintenance splash, supporter page (`AuthScreens.jsx`) | Restyle the existing auth and onboarding routes; the PIN cells replace the field in both the sign-in prompt and the Locked unlock dialog |
| Notifications bell and panel, help and feedback, about, account menu, avatar editor (`SystemPanels.jsx`) | Existing notification, about and avatar endpoints |
| Upload button, drag and drop, upload and download panels (`UploadPanel.jsx`, `system-data.mjs`) | Existing upload and download managers |
| Command palette and search dialog Go-to section (`CommandPalette.jsx`, `command-palette.mjs`, `SearchDialog.jsx`) | Index pages, settings areas and actions; people, collections and places from their APIs |
| Enrichment search filters, Not in album, Untagged (`FilterPanel.jsx`, `search.mjs`) | Existing search DTO fields |
| Maintenance area: mode, backups with restore flow, integrity checks and report viewer (`Maintenance.jsx`, `maintenance-data.mjs`) | Existing maintenance, backup and integrity endpoints |
| Users: reset password, reset PIN, delete with delay, restore | Existing admin user endpoints; create-time PIN stays blocked until its server test exists |
| Settings voice pass | Copy only |
| Physical deduplication preview with matching media: one group per retained original showing its thumbnail, owner, size and reference counts, the duplicate copies beside it with owner, decision and collapsible checksum evidence, an Evidence table view, and an inline retained-account choice for previews (`PhysicalDedupManager.jsx`, `physical-dedup-data.mjs`) | Existing physical-deduplication dry-run and apply jobs; the dry-run result must carry per-copy thumbnails, owner, size, checksum match and references before and after; applying still requires the saved `physicalDeduplication.masterUserId` |

## Sequencing

Work proceeds in three waves inside the existing stages. A wave is done when every story in it has production evidence, not when its screens render.

1. **Wave one, foundation and library.** Workstream A, then B, then D. These reuse existing endpoints and unblock everything else. Ship behind the rollout flag from FL-30 and keep the legacy routes until the action ledger rows pass.
2. **Wave two, people, discovery and system.** Workstreams E, F and G. Independent of each other; schedule by team availability.
3. **Wave three, editing.** Workstream C. The quick editor's still-image recipe renderer is new server work and can start now; Studio and restoration wait on the rendering proofs and worker admission gates already defined.

## Prototype behaviours production must not copy

- Colour, sharpen and noise controls are CSS approximations; the histogram samples a small canvas.
- Studio cross-dissolves use a poster still; scopes read the browser frame; restoration "after" is a sharpen preview.
- Uploads, downloads, jobs, backups, integrity checks and cast sessions are timer simulations.
- The map is an offline stylised base with sample coordinates.
- Shared-link passwords live in memory; QR codes are generated client side and can stay that way.
- Merges and face reassignments rewrite a derived view, not face storage.
- Sample face clusters and the two unnamed people are fixtures.

## Maintenance of the template

The template stays the design reference and its tests run in the design workflow on GitHub Actions. Changes to interaction decisions are recorded in the interaction requirements first, then in the template. The agents' integration notes for each area are summarized in the template README source map; the pure modules (`selection.mjs`, `justified-layout.mjs`, `develop.mjs`, `studio-project.mjs`, `collections-data.mjs`, `people-data.mjs`, `discovery-data.mjs`, `shared-links-data.mjs`, `command-palette.mjs`, `maintenance-data.mjs`, `system-data.mjs`) are the closest thing to specifications and should be read before writing the production equivalents.

## Decisions taken after the first draft

- Albums are the unit photos go into; a collection groups albums one level deep; shared spaces stay top level. The old Collections index is replaced by the Albums page described in workstream D.
- Every icon picker offers the whole Material catalogue with a categorised suggested set first.
- Physical deduplication has one page title and a media preview of the plan (workstream G).

## Open items awaiting product feedback

The owner is reviewing the rest of the prototype. Decisions still expected: whether Work mode stays as a third layout or becomes an inspector toggle; the final shape of the collection header on phones; whether the Locked icon stays in the topbar once the account menu carries it; and which discovery destinations belong in the phone rail by default.
