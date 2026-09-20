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

`build` produces local static files in `dist/`; it does not publish. `test` runs the 18 existing portable state/data test files captured with this package. Original DOM tests and repository-contract audits remain with the original prototype because they inspect production source files or installed web dependencies. This portable suite does not substitute for those checks, browser review or production acceptance.

## Review path

Open an album → filter/search and sort → select photos → switch Timeline/Browse/Work → compare → open full-size media and its information panel → quick edit → continue in Studio → preview restoration → choose local/RunPod → simulate export and reconnect → return to the same library selection. Review nested settings, Users, analytics, job concurrency, owner-only duplicate review and Trash through the command center.

Read [the interaction contract](../INTERACTION-REQUIREMENTS.md) for the latest decisions. Studio controls are an interaction layout; exports, restoration, job progress and account actions are simulations. Video playback uses local MP4 demonstrations; editing/restoration still shows sample imagery. Nothing changes a real user's library or contacts cloud compute.

## Source map

| Area | Entry points |
| --- | --- |
| Shell, library and session | `src/App.jsx`, `LibraryRail.jsx`, `styles.css`, `reference/library-session.ts` |
| Search, filters and people | `SearchDialog.jsx`, `FilterPanel.jsx`, `SearchableSelect.jsx`, `People.jsx` |
| Timeline, Explore and full-size viewer | `TimelineLibrary.jsx`, `ExploreLibrary.jsx`, `MediaViewer.jsx`, `FaceTagger.jsx` |
| Quick editor and Studio layout | `Editor.jsx`, `state.mjs` |
| Settings and analytics | `CommandCenter.jsx`, `settings-catalog.mjs`, `settings-coverage.mjs`, `SettingsAnalytics.jsx` |
| Users, workers, jobs and utilities | `AccountsLibraries.jsx`, `WorkerManager.jsx`, `JobsManager.jsx`, `UtilitiesManager.jsx`, `DuplicateReview.jsx`, `TrashManager.jsx` |
| Portable source snapshots | `src/reference/`: library session, discovery query, theme CSS and plugin method manifest |

Source-path strings in the coverage catalog identify production inspection anchors; they are not live imports and do not prove those features exist in a clean checkout. The discovery snapshot retains a type-only SDK reference which Vite erases; this template does not advertise standalone production SDK typechecking.

The historical generated raster mark reproduces the captured prototype. Use [the original SVG kit](../brand-kit/manifest.json) for production branding. All photos and avatars are generated demonstration assets; [media provenance](media-provenance.json) retains their source/output hashes and generation notes with portable paths. Icons use Material Design Icons (`@mdi/js`, Apache-2.0) and the local UI font is Inter (SIL Open Font License); preserve dependency notices. The project remains subject to the repository's license. Freecut's engine is not bundled in this design template.
