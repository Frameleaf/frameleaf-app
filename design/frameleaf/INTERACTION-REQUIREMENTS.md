# Frameleaf interaction requirements

Preserved user decisions from the design engagement. These requirements take precedence over earlier screenshot details. Production parity is still tracked separately.


- The left navigation rail must collapse to icons, preserving access to every destination and remembering the preference.
- People views must use face photographs. Use smaller versions in person pickers and active filter chips, not generic person icons when a photo is available.
- Search and filtering must reflect the fork's existing smart, filename, description, OCR and full-path search plus its structured people, date, location, camera, tag and media-state filters. Preserve scoped queries and show contextual result counts.
- Long filter dropdowns (places, cameras, lenses and similar choices) must support autocomplete search as well as opening the full option list, with keyboard navigation and contextual counts.
- Keep navigation section titles clear of their dividers, with consistent padding above/below each heading; leave breathing room above the collection search bar.
- Keep the selected restrained three-pane design; maintain dark/light and touch/keyboard quality when refining it.
- Normal preview must fill the browser window. The viewport review page defaults to Fill window; fixed desktop/tablet/phone frames are explicit review choices. Return to the full-page app after responsive QA.
- Settings should be a command center: version/build, disk capacity, recovery readiness, processing, and actionable issues on its homepage. Move these system details out of the library rail.
- Include a rich analytics destination with useful photographic and home-server metrics, clear units/scopes/time windows, graphs, data tables, and export. Keep logical asset bytes, physical originals, and whole-filesystem usage distinct.
- Reimagine all settings around user tasks, not the upstream accordion order. Preserve the fork's complete capabilities and privacy policies; mark proposed behavior honestly. Keep personal, Space, server, and device scopes clear.
- Release/version checks to infrastructure owned by Frameleaf or the operator are allowed, whether LAN-hosted or internet-hosted. External/upstream checks and external telemetry remain prohibited. Update service addresses are managed by Frameleaf deployment/build configuration, never editable or exposed as a user setting. Never invent an endpoint or silently fall back externally. Local analytics collection is separate from outbound reporting.
- Product copy is written for customers. Do not say “fork”, expose source identifiers, or narrate implementation plans in menus, labels, help, or dialogs. Keep developer caveats in the documentation, with a compact preview/sample-data disclosure for this prototype.
- The settings prototype design round is implemented; production integration remains pending. Read [the current settings handoff](https://heroit.atlassian.net/wiki/spaces/FR/pages/61374807/Frameleaf+settings+work+handoff) before continuing; it records completed checks and remaining production qualification.
- The second settings pass must model multiple independent accounts and owned libraries. Scope analytics by account/library while retaining whole-host capacity; do not reuse a single-user total everywhere.
- Use nested settings pages and area directories, with rich operational tools for users, libraries, jobs and utilities. Every source setting/action needs a traceable home; do not equate a link or readonly explanation with implemented action parity.
- All queue concurrency edits must use the central settings draft/review. Keep source queue-specific action constraints, fixed concurrency and owner scopes explicit.
- Fold the original utilities into the command center and redesign their actual review workflows. Never treat unsupported RAW as confirmed damage or resolve a partially filtered duplicate group.
- Duplicate review must support thousands of groups with immediate, undoable decisions, automatic advance, keyboard shortcuts and bulk actions. Do not interrupt routine keeper or stack decisions with confirmation popups.
- Duplicate groups can contain many related burst frames. Use a contact sheet with multiple keepers and preserve complete group membership through filters. Offer stacking without deletion; do not treat similar burst frames as disposable duplicates or include them in automatic suggested-keeper bulk deletion.

- Trash belongs in the settings rail as an actual owner-only asset browser, with quick restore, selected/all operations and deliberate permanent-delete confirmation. Connect it to duplicate and utility deletion state.
- Do not add repeated generic scope/permissions banners under settings headings (Resource settings, Signed in as, original-owner boilerplate, All utilities). Use breadcrumbs/account selection and contextual action feedback; keep forms focused on their controls.

- Duplicate review is private to the signed-in user, including photos, thumbnails, filenames, group counts, search, suggestions and bulk actions. Do not show other accounts’ groups as read-only. Remove account switching from this workflow; omit ambiguous mixed-owner groups and unscoped activity history.
- User administration must include per-account feature preferences, separate navigation visibility, notifications, downloads, appearance, storage and sign-in configuration. Audit the actual source contracts; existing feature preferences are user-editable and are not administrator-enforced module permissions. Do not imply that hiding a feature revokes data/API access. Preserve independent account state, private-content choices, pending drafts and revision checks. Read [the account settings audit](https://heroit.atlassian.net/wiki/spaces/FR/pages/61407287/Frameleaf+account+settings+audit) before production integration.

- Locked is one system (owner decision, September 22, 2026): a per-asset privacy lock that is metadata, never a relocation. Album memberships and original organization are preserved; locked media is hidden while the session is locked and listed in the Locked view for its owner in an unlocked session. The upstream Locked folder (`visibility = locked`) is not used as a state: upgrading from an Immich library migrates those assets into the lock (recorded as moved from the old Locked folder) so nothing disappears, and existing sensitive marks and detections migrate the same way. Use neutral Locked wording in the new UI.
- Do not put Duplicate review, Large files, or Live Photo pairing under Tools in the library rail. They remain under Settings → Utilities.
- Restore the existing Explore discovery experience, Best Photos and collection slideshow. Timeline appears before Browse and Work. Single-click media opens a full-size viewer with information, favorite, sharing, editing, trash and More actions.

- The media actions must be named **Mark Sensitive** and **Unmark Sensitive**. Locked remains the name of the filtered destination/session control; marking is metadata, never an asset relocation.

- Timeline day groups must fill the available photo area, including groups with fewer thumbnails than the maximum column count.
- Preserve Information → People → Add → draw a face region → assign an existing or new person. Keep face photos in the information panel, people views, and filters, with keyboard/numeric alternatives to drawing.
- A route or settings inventory is not feature parity. Track every source screen and action, its redesigned home, implementation status, and validation. Do not remove existing production screens until their required actions pass parity checks. Read the screen and library-action parity audits linked in the handoff; both explicitly record remaining gaps.

## September 22, 2026 revision

Decisions recorded after the product review and the parity audit against the production web app. They extend, and where noted supersede, the earlier bullets.

- Browse is the default library layout. Work remains available and opens the information panel only above tablet width; on phones it never auto-opens the panel.
- Selection is a separate multi-select state from the open item. Nothing is selected on load, shift-click selects a range, a day header selects its group, and a floating selection bar carries the complete bulk action set (favorite, add to collection, share link, download, stack, link motion clips, change date, description and location, archive, mark sensitive, tag, delete with undo, and the per-item refresh jobs).
- The timeline uses justified rows that respect each item's aspect, sticky day headers, and a draggable year and month scrubber. Ratings appear on hover or selection only. _(Superseded September 24: Work always shows ratings, Browse never does, and Years and Months are curated cards; see below.)_
- The quick editor is media aware: photos open on Adjust with a histogram and Lightroom-style Light, Color, Effects and Detail groups, presets, a draggable crop with straighten and flip; videos open on Trim and keep every control the production video editor already had (speed, filters, stabilize, auto-enhance, timed text, social presets, export frame). It is a full-screen surface, not a small dialog.
- Studio has a working multitrack timeline (drag, split, ripple trim, transitions, music and voice tracks, speed, Ken Burns, title styles), colour scopes and wheels, captions, and a restoration flow with a before and after split and cost estimates.
- The viewer exposes the complete production action set and the information panel edits description, date and time, location, tags, rating and faces in place, shows the enrichment evidence, and links to collections, folders and OpenStreetMap.
- Collections are managed objects with an index, nested tree, icons, covers, members with roles, public links, activity, display order and smart rules. Shared links, a public viewer without private navigation, and partner libraries exist as their own destinations.
- People management includes inline naming, hide and favorite, merge suggestions, a person page with featured photo, merge, date of birth and fix-incorrect-match, and a show-and-hide people page.
- Map, Places, Tags, Folders and Memories are first-class destinations; the map is an offline stylised base that never fetches tiles.
- Authentication, onboarding, maintenance, supporter, help, about, notifications, upload and download surfaces are designed in the prototype rather than left to the legacy pages.
- The settings command center gains a Maintenance area (maintenance mode, database backups with a restore flow, integrity checks with report viewer) and account actions for password and PIN reset; headline copy is plain and consistent.
- The type scale is 14px body and 12px secondary with nothing below 11px; cards use 10px radii _(superseded September 24: 12px continuous corners, set in SF Pro)_; the accent green is reserved for primary actions, selection and focus while teal and blue carry status; panels and dialogs use short motion tokens with reduced-motion honoured.
- The library has one search entry point: the top bar, whose scope defaults to the current collection. The in-page collection search row is gone; this supersedes the earlier note about breathing room above it. Structured filtering lives behind a single Filter control in the results toolbar (badge when active, menu for People, Date, Places, Media, Tags and All filters), and filter chips appear only while a filter is active. Chips that merely restate the destination (Favorites, Pets, a person page) are not shown.
- Collection icons are changed in place: hovering the album icon on the collection page reveals an edit badge, and clicking opens a searchable chooser over the whole Material Design Icons catalogue (about 7,400 icons): a categorised suggested set of over 200 first, then every icon, filtered as you type. The create and edit dialogs embed the same chooser instead of a small fixed grid, and any icon in the catalogue is valid. Every icon picker in the product must offer this breadth; a couple of dozen fixed icons is too few.
- All builds and test suites run on GitHub Actions. They are not run on the operator's machine.
- Physical deduplication (Storage → Physical deduplication) has a single page title; its toolbar holds the scan scope, the retained account and the Prepare preview plan action. A preview shows the matching media: one group per retained original with its thumbnail, owner, size and reference count before and after the plan, and the duplicate copies beside it as thumbnails with their owner, the decision (share, or skip with the reason) and collapsible checksum and path evidence. Copies with no exact match in the retained account are grouped on their own. An Evidence view keeps the full table. A preview can be prepared against an account chosen on the page; applying a plan requires the saved retained account.
- Albums are what photos are organised into. A collection is a named group of albums, one level deep, and shared spaces stay at the top level; nothing is called a subcollection. The Albums page lays each collection out as a shelf: a mosaic of its album covers, its name, album and item counts, members, a New album action and a menu, with its albums beneath as square tiles. Albums on their own follow, then shared spaces. The page has one search field, one sort menu, grid and list views, filter pills for All, My albums, Shared and Smart, and a New menu for album, smart album, collection or shared space. Album tiles are square covers with the name and count below and member avatars; smart albums carry a small mark on the cover rather than a pill. Albums can be dragged onto a collection shelf or moved through a dialog, and opening a collection shows its albums above its photos.

## Apple-style refinements — approved September 24, 2026

The owner reviewed before/after comparisons of each suggestion and approved them with the corrections below. The template implements them in `template/src/apple-style.css`, `interactions.js`, `SearchPalette.jsx`, `search-palette.mjs` and the slideshow transitions in `media-viewer.mjs`. Where they conflict with the September 22 revision, these decisions supersede it: Work always shows ratings and Browse never does (instead of ratings on hover or selection), and cards use 12px continuous corners (instead of 10px radii).

- Use SF Pro throughout: the font stack starts with the Apple system font and falls back to bundled Inter elsewhere, because SF Pro cannot be licensed for web delivery.
- **Browse** is the dense, Photos-style square grid with 2px gutters and no file names or star ratings. **Work** is the Lightroom-style editing surface: it keeps star ratings and rejects on every tile and hides file names by default. The name shows on hover and in the inspector, and a toolbar toggle turns file names back on (remembered per device). Timeline is unchanged.
- People photos use a squircle shape everywhere: avatars, pickers, chips, filters, information panel and account menu. Use a mask that renders the same shape in every browser. Larger continuous corners apply to controls, cards and sheets, with CSS `corner-shape: squircle` where supported.
- Search is a glass, Spotlight-style palette (⌘K) built for large libraries. It offers:
  - typed filters (`person:`, `place:`, `tag:`, `type:`, `camera:`, `lens:`, `rating:`, `is:favorite`, `year:`, `month:`, `after:`, `before:`, `file:`, `text:`, `path:`, with `-` to exclude) that become removable chips
  - typeahead suggestions with counts
  - live results with a preview
  - a date histogram that narrows by clicking
  - facet refinement for people, media, places, cameras and rating
  - scope counts for the current collection and the entire library
  - "Go to" results from the shared command index; typing `>` hands off to the command palette
  - the enrichment quick filters (description missing or failed, needs sensitivity review)
  - saved searches and full keyboard control
  - responsive typing while results update.

  Natural-language smart search and every existing search mode remain. Filters still resolve through the metadata-search contract; nothing invents results.
- Slideshows keep **Fade** as the default transition. The Transition setting adds **Ken Burns** (slow pan and zoom) and **Memories** (Ken Burns with a title card, blurred backdrop and place and date captions) alongside None, Fade and Slide. With Reduce Motion on, moving transitions fade instead.
- Also approved as suggested:
  - reduced motion turns movement into crossfades, and Svelte transitions must check it in JavaScript
  - spring motion tokens
  - frosted materials, with solid fallbacks for Increase Contrast and Reduce Transparency
  - a frosted toolbar that sticks while the header scrolls away, with a large title that shrinks as you scroll
  - a floating capsule toolbar centred over the library photos (other screens keep the docked bar)
  - animated sheets and menus
  - the thumbnail-to-viewer zoom transition
  - pinch, Ctrl-scroll and +/− grid zoom with an animated reflow
  - a black viewer with frosted controls, tap to hide the controls and swipe down to close
  - snapping Explore carousels
  - balanced titles, tabular numbers and a Display P3 accent
  - the screen stays awake during slideshows
  - Media Session controls
  - "Send a copy…" through the native share sheet, kept separate from Frameleaf sharing
  - safe-area insets and a theme colour for edge-to-edge devices.

### Second pass on the full prototype — approved September 24, 2026

- **One toolbar.** While items are selected, the selection bar takes the library toolbar's place and carries Compare, Quick edit and Open in Studio (labelled) ahead of the bulk actions (icon-only, named in tooltips). Nothing selected shows the library toolbar alone.
- The `>` command palette uses the same glass treatment as search.
- **Phones:**
  - Album actions beyond Add photos and Share move into the "…" menu.
  - Viewer actions sit in a bottom toolbar, like iPhone Photos.
  - A frosted tab bar gives Library, Memories, Albums and Search. The ☰ drawer stays, because Favorites, Archive, People, Map, Folders, Trash, Shared links and Library Care are reachable only from it.
  - The top bar shows the Frameleaf symbol only; the button keeps "Frameleaf" as its accessible name.
- **Memories** use one engine: the Memory player, the Memories page previews and the slideshow's Memories transition share the same pan-and-zoom, title card and caption presentation.
- **Photo editor:** hold the compare button, or hold `\` (Y also works), to see the original. The photo sits on a black stage with frosted panels, and controls use spring motion (fades under Reduce Motion).
- **Timeline Years and Months** are curated cards: a key photo per year or month (highest Best Photos score, then rating, then most recent), with counts and top places. Months add a strip of highlights. Clicking a card steps into the next level.
- **Information** floats over the photo as a glass card on tablet and desktop; phones keep the bottom sheet.
- **Settings** areas get coloured icon tiles, like System Settings.
- **AI provenance.** AI-produced content carries a sparkle mark on a reserved indigo. The description shows an "AI" badge, or "Yours" when written by the owner. The Enrichment card is a grouped list that says who wrote the description (model and confidence when AI) and how the sensitive-content check was made. Indigo is used instead of a multicolour gradient to respect the rule against decorative gradients.

### Polish pass and dashboard — approved September 24, 2026

- **Navigation rail.** Order is Library, then Explore (Explore, People, Pets, Memories, Places, Map, Tags, Folders, Documents), then Albums, Shared spaces and Tools. Each section heading folds its section away, remembered per device; the icon-only rail always shows everything. Albums and Shared spaces each have a "+" (New album, New shared space). Opening All albums never replays a pending "New album" request.
- **Library Care** opens the Library care settings area, which is the hub for fixing things: health, repairs and duplicates, plus the Duplicate review, Missing media, Damaged media and Live Photo pairing tools.
- **Top bar.** On wide screens the search field sits in the true centre. On phones the top bar has no search field, because the tab bar owns Search.
- **Library status bar** (counts, selection, save state, Thumbnail size) appears only where photos are browsed: library, person and partner views. Compare, Quick edit and Open in Studio appear only on the selection bar while something is selected.
- **Thumbnail size** scales every layout, including Timeline rows (its middle position keeps the default row height). Captions under tiles are inset so one tile's time never runs into the next tile's name.
- **Advanced search.** The search palette has an Advanced view with the original design's graphical filters: people with face photos, media type, capture dates, places, rating and favourites, tags, camera and lens, description status, sensitivity review and library status. Counts update as you pick; a graphical pick replaces any typed chip for the same field; the choice of view is remembered per device. Typed person suggestions show face photos and skip unnamed people, who have no name to type. Every people photo, named or not, uses the squircle.
- **Settings.** Area pages are grouped lists (like System Settings) with plain-language descriptions, no repeated icons, and a scope tag only when a row differs from the rest of its area. Settings pages use compact right-aligned controls in a single column. Every page heading uses the same overline, and a section named like its area does not repeat the name.
- **Small actions.** Each notification can be dismissed on its own. The upload panel offers "Clear finished" while uploads continue. Checking a workflow shows a step-by-step dry run of what a run would do. Workflow import is a normal button.
- **Library analytics** is a dashboard. It opens with the library total, its span in years, fact chips and four tiles (added this period, volume used, deduplication savings, photos and videos). It then shows growth, captures per year, a weekday-by-hour punchcard, a storage donut, a daily heatmap (with an exact-count table), cameras, lenses and focal lengths, photo formats, video resolution and orientation, people and places, coverage rings and library records. Every breakdown adds up to the library totals for the selected scope; catch-all rows ("Everywhere else") stay last and never set the bar scale.
