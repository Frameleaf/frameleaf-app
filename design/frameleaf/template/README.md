# Interactive design reference

The approved Frameleaf interface is captured here as a standalone React/Vite application with generated sample media. No Frameleaf server, GPU, RunPod account or hosting configuration is needed.

From the repository root, using Node and pnpm:

```sh
cd design/frameleaf/template
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
pnpm dev --port 4174
```

Open `http://127.0.0.1:4174/`. `/viewport.html` provides explicit desktop/tablet/phone review frames and defaults to filling the available window. The app itself always fills its viewport. Use a distinct port/origin from the earlier prototype so their local demonstration state remains separate.

```sh
pnpm test
pnpm build
pnpm preview --port 4174
```

`build` produces local static files in `dist/`; it does not publish. `test` runs the portable state, data and happy-dom interaction test files in `tests/`. Run both through the GitHub Actions workflow (`frameleaf-design.yml`) rather than on a small local machine: the suites start a Vite server per DOM test and are memory hungry. Original DOM tests and repository-contract audits remain with the original prototype because they inspect production source files or installed web dependencies. This portable suite does not substitute for those checks, browser review or production acceptance.

## Review path

Open an album → filter/search and sort → select photos → switch Timeline/Browse/Work → compare → open full-size media and its information panel → quick edit → continue in Studio → preview restoration → choose local/RunPod → simulate export and reconnect → return to the same library selection. Review nested settings, Users, analytics, job concurrency, owner-only duplicate review and Trash through the command center.

For the September 24 refinements also try:
- ⌘K search with filters such as `person:Jamie` (Tab completes); `>` opens the command palette.
- Pinch or +/− in Browse and Work, and Years/Months cards in Timeline.
- Opening a photo: it zooms out of its tile. Tap to hide the controls, swipe down to close, press I for the floating info card with its AI enrichment.
- A slideshow with the Ken Burns or Memories transition.
- Holding `\` in the photo editor to see the original.
- A phone-width window for the tab bar and the viewer's bottom toolbar.
- ⌘K → Advanced for the graphical filters; pick a person or Videos and watch the counts change.
- Settings → Library analytics for the dashboard, and any settings area for the grouped lists.
- Folding a rail section, the "+" beside Shared spaces, and Library Care as the hub for fixes.

Read [the interaction contract](../INTERACTION-REQUIREMENTS.md) for the latest decisions. Studio controls are an interaction layout; exports, restoration, job progress and account actions are simulations. Video playback uses local MP4 demonstrations; editing/restoration still shows sample imagery. Nothing changes a real user's library or contacts cloud compute.

## Source map

| Area | Entry points |
| --- | --- |
| Shell, library and session | `src/App.jsx`, `LibraryRail.jsx`, `styles.css`, `reference/library-session.ts` |
| Search, filters and people | `SearchPalette.jsx` (typed filters and the Advanced graphical view), `search-palette.mjs`, `FilterPanel.jsx` (also embedded in the palette), `SearchableSelect.jsx`, `People.jsx` |
| Apple-style refinements (September 24) | `apple-style.css` (font, materials, corners, per-tab grids, floating toolbar, viewer, info card, slideshow transitions, command palette, phone tab bar, settings icon tiles), `interactions.js` (zoom transition, grid zoom, reduced-motion check), `media-viewer.mjs` (slideshow transitions and Ken Burns moves), `memory-engine.mjs` (shared Memories motion and captions), `timeline-highlights.mjs` (curated Years and Months), `MediaViewer.jsx` `EnrichmentCard` (AI provenance) |
| Timeline, Explore and full-size viewer | `TimelineLibrary.jsx`, `ExploreLibrary.jsx`, `MediaViewer.jsx`, `FaceTagger.jsx` |
| Quick editor and Studio layout | `Editor.jsx`, `state.mjs` |
| Settings and analytics | `CommandCenter.jsx` (grouped area directories), `settings-catalog.mjs`, `settings-coverage.mjs`, `SettingsAnalytics.jsx` + `AnalyticsDashboard.jsx` + `library-insights.mjs` (dashboard sections and their reconciled sample breakdowns) |
| Users, workers, jobs and utilities | `AccountsLibraries.jsx`, `WorkerManager.jsx`, `JobsManager.jsx`, `UtilitiesManager.jsx`, `DuplicateReview.jsx`, `TrashManager.jsx` |
| Portable source snapshots | `src/reference/`: library session, discovery query, theme CSS and plugin method manifest |
| Editing surfaces | `Editor.jsx` + `develop.mjs` (full-screen quick editor, develop module, presets, crop), `Studio.jsx` + `studio-project.mjs` (multitrack timeline, colour, audio, captions, restoration), `Activity.jsx` |
| Timeline, tiles and selection | `TimelineLibrary.jsx` + `justified-layout.mjs`, `AssetTile.jsx`, `SelectionBar.jsx` + `selection.mjs`, `ShortcutsHelp.jsx` + `shortcuts.mjs` |
| Albums, collections and sharing | `Collections.jsx` (Albums page), `AlbumCard.jsx`, `CollectionHeader.jsx`, `ActivityPanel.jsx`, `collections-data.mjs`, `SharedLinks.jsx`, `SharedLinkForm.jsx`, `PublicViewer.jsx`, `PartnerLibrary.jsx`, `QrCode.jsx` + `qr.mjs`, `shared-links-data.mjs` |
| People | `People.jsx`, `PersonDetail.jsx`, `ManagePeople.jsx`, `people-data.mjs` |
| Discovery | `MapView.jsx`, `Places.jsx`, `Tags.jsx`, `Folders.jsx`, `Memories.jsx`, `MemoryPlayer.jsx`, `discovery-data.mjs` |
| System and account | `AuthScreens.jsx`, `SystemPanels.jsx`, `UploadPanel.jsx`, `system-data.mjs`, `CommandPalette.jsx` + `command-palette.mjs`, `Maintenance.jsx` + `maintenance-data.mjs` |

Source-path strings in the coverage catalog identify production inspection anchors; they are not live imports and do not prove those features exist in a clean checkout. The discovery snapshot retains a type-only SDK reference which Vite erases; this template does not advertise standalone production SDK typechecking.

The historical generated raster mark reproduces the captured prototype. Use [the original SVG kit](../brand-kit/manifest.json) for production branding. All photos and avatars are generated demonstration assets; [media provenance](media-provenance.json) retains their source/output hashes and generation notes with portable paths. Icons use Material Design Icons (`@mdi/js`, Apache-2.0) and the UI font is the Apple system font (SF Pro) with bundled Inter (SIL Open Font License) as the fallback; preserve dependency notices. The project remains subject to the repository's license. Freecut's engine is not bundled in this design template.
