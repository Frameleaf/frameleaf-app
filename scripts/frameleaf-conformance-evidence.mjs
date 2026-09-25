#!/usr/bin/env node
/**
 * Writes docs/docs/developer/frameleaf-plan/prototype-conformance-2026-09-23.json: for every
 * web-action requirement in the action preservation ledger and every committed route in the route
 * inventory, the September 22 prototype module that designs it, the production counterpart, the
 * conformance status found by the FL-83 audit, the gap ids in the audit document and the follow-up.
 *
 * The table below is the audit's hand-authored mapping; the generator only expands it against the
 * ledger so that a new action or route without a row (or a stale row) fails
 * scripts/frameleaf-conformance-audit.test.mjs instead of being dropped.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
export const evidencePath = resolve(
  root,
  "docs/docs/developer/frameleaf-plan/prototype-conformance-2026-09-23.json",
);
export const auditDocPath =
  "docs/docs/developer/frameleaf-plan/11-conformance-audit-2026-09-23.md";
const P = "design/frameleaf/template/src";
const W = "web/src";

export const STATUS_VOCABULARY = Object.freeze([
  "match",
  "partial",
  "missing",
  "fixed",
  "in-flight",
  "studio-parked",
  "retained-live-route",
  "intentional-product-change",
]);

// ---- web actions ------------------------------------------------------------------------------

const sectionDefaults = {
  "albums-organization": {
    prototype: [
      `${P}/Collections.jsx`,
      `${P}/CollectionHeader.jsx`,
      `${P}/collections-data.mjs`,
    ],
    production: [
      `${W}/lib/components/frameleaf/AlbumDirectory.svelte`,
      `${W}/lib/components/frameleaf/AlbumHeader.svelte`,
    ],
  },
  "info-people": {
    prototype: [`${P}/MediaViewer.jsx`, `${P}/media-viewer.mjs`],
    production: [`${W}/lib/components/asset-viewer/DetailPanel.svelte`],
  },
  "quick-edit": {
    prototype: [`${P}/Editor.jsx`, `${P}/develop.mjs`, `${P}/state.mjs`],
    production: [`${W}/lib/components/frameleaf/editor/QuickEditor.svelte`],
  },
  "search-discovery": {
    prototype: [
      `${P}/SearchPalette.jsx`,
      `${P}/search-palette.mjs`,
      `${P}/FilterPanel.jsx`,
      `${P}/search.mjs`,
    ],
    production: [
      `${W}/lib/components/frameleaf/SearchPalette.svelte`,
      `${W}/lib/components/frameleaf/FilterPanel.svelte`,
    ],
  },
  "timeline-bulk": {
    prototype: [
      `${P}/TimelineLibrary.jsx`,
      `${P}/SelectionBar.jsx`,
      `${P}/selection.mjs`,
    ],
    production: [
      `${W}/lib/components/frameleaf/LibraryView.svelte`,
      `${W}/lib/components/frameleaf/SelectionBar.svelte`,
    ],
  },
  viewer: {
    prototype: [`${P}/MediaViewer.jsx`, `${P}/media-viewer.mjs`],
    production: [
      `${W}/lib/components/asset-viewer/AssetViewer.svelte`,
      `${W}/lib/frameleaf/viewer-menu.ts`,
    ],
  },
};

// requirementId suffix -> [status, gaps, followUp?, overrides?]
const actions = {
  // albums-organization
  "add-selected-existing-assets": [
    "fixed",
    ["AL-11", "AL-17"],
    "Add photos labels and the album page in the Frameleaf shell (fixed on codex/FL-52-albums-sharing)",
  ],
  "album-display-order-newest-oldest": ["match", []],
  "album-grouping-by-owner-year-no-grouping": [
    "intentional-product-change",
    [],
    "The Albums page groups by collection shelves (interaction requirements, Sept 22); owner/year grouping is retired",
  ],
  "album-search-owned-shared-all-filtering": ["match", []],
  "album-slideshow-download-cast": ["match", []],
  "album-sort-by-title-count-modified-created-recent-oldest": ["match", []],
  "browse-albums-as-covers-list": ["match", []],
  "change-collaborator-editor-viewer-role-remove-collaborator-leave-shared-album":
    [
      "fixed",
      ["AL-3", "AL-5", "AL-15", "AL-44"],
      "Frameleaf share dialog everywhere, leave confirmation, invite search, role labels (fixed on codex/FL-52-albums-sharing)",
    ],
  "create-album": [
    "fixed",
    ["AL-8"],
    "Stay on the page after create (fixed); AL-8",
  ],
  "create-manage-album-public-links": [
    "fixed",
    ["AL-7", "AL-24", "AL-33"],
    "Create link menu item, Link ready step, Frameleaf form and share sheet from the viewer (fixed on codex/FL-52-albums-sharing)",
  ],
  "custom-smart-album-filter-preset-snapshot": [
    "partial",
    ["AL-1", "AL-6", "AL-12", "S-14"],
    "Per-album rules shipped with FL-60 (AL-1, AL-12) and saved presets in the rail (S-14); AL-6 remains",
  ],
  "delete-album-while-retaining-assets": [
    "fixed",
    ["AL-4"],
    "Frameleaf delete dialog everywhere; legacy prompt path removed",
  ],
  "edit-album-title-and-description": [
    "fixed",
    ["AL-2"],
    "Frameleaf edit dialog with the full icon chooser; AlbumEditModal retired (fixed on codex/FL-52-albums-sharing)",
  ],
  "nested-albums-expand-collapse-all-top-level-all-views": [
    "match",
    [],
    undefined,
    {
      production: [
        `${W}/lib/components/frameleaf/LibraryRail.svelte`,
        `${W}/lib/components/frameleaf/CollectionShelf.svelte`,
      ],
    },
  ],
  "real-folders-and-external-library-path-browsing": [
    "fixed",
    ["FD-1", "FD-2", "FD-3", "FD-4", "FD-5", "FD-6"],
    "Folders browser: storage-folder tree, sort, counts and sizes, browsable files with the viewer and bulk actions (fixed on codex/FL-46-complete-browsers)",
    {
      prototype: [`${P}/Folders.jsx`],
      production: [`${W}/lib/components/frameleaf/FolderBrowserPanel.svelte`],
    },
  ],
  "remove-selected-assets-from-album": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/frameleaf/bulk-actions.ts`] },
  ],
  "select-change-album-cover": [
    "partial",
    ["AL-13"],
    '"Always use the newest item" option in the cover dialog',
  ],
  "share-album-invite-people": [
    "fixed",
    ["AL-3", "AL-15"],
    "Invite search field + listbox; Frameleaf share dialog from the Albums page (fixed on codex/FL-52-albums-sharing)",
  ],
  "show-hide-asset-owner-badges": ["match", []],
  "toggle-comments-likes-show-activity": [
    "fixed",
    ["AL-14", "AL-18"],
    "Activity control always shown; Frameleaf per-asset activity panel (fixed on codex/FL-52-albums-sharing)",
    { production: [`${W}/lib/components/frameleaf/ActivityPanel.svelte`] },
  ],
  "upload-from-computer-into-album": [
    "fixed",
    ["AL-11"],
    "Add photos menu labels",
    { production: [`${W}/lib/components/frameleaf/UploadMenuButton.svelte`] },
  ],
  // info-people
  "accept-detection-result-mark-safe-sensitive-from-evidence-panel": [
    "fixed",
    ["V-2", "V-10"],
    "Enrichment card for owners (fix-viewer); its Accept and Clear tags stay as preserved source actions, recorded deviations (codex/FL-35-complete-viewer)",
    {
      production: [
        `${W}/lib/components/asset-viewer/DetailPanelImageEnrichment.svelte`,
      ],
    },
  ],
  "add-a-person-draw-bounding-box-search-existing-person-confirm": [
    "fixed",
    ["V-28"],
    "Draw-to-tag, numeric inputs, multi-face session, Undo, Remove face, batch Save face tags and the stale-revision banner (FL-38); detected faces move and resize through the revision-checked PATCH /faces/:id, and every correction is kept in the person's correction history (FL-57)",
    {
      prototype: [`${P}/FaceTagger.jsx`, `${P}/face-tags.mjs`],
      production: [`${W}/lib/components/frameleaf/FaceTagger.svelte`],
    },
  ],
  "add-edit-location": [
    "fixed",
    ["V-24"],
    "Edit location dialog with City / State or region / Country, coordinates and a MapLibre pin; typed place names are kept over geocoding (codex/FL-35-complete-viewer)",
    {
      production: [
        `${W}/lib/components/asset-viewer/DetailPanelLocation.svelte`,
        `${W}/lib/components/frameleaf/ViewerLocationDialog.svelte`,
      ],
    },
  ],
  "add-remove-tags": [
    "fixed",
    ["V-25"],
    "Inline Add a tag combobox with Create and No tags yet.; T opens it (codex/FL-35-complete-viewer)",
    { production: [`${W}/lib/components/asset-viewer/DetailPanelTags.svelte`] },
  ],
  "camera-lens-location-search-shortcuts": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/components/frameleaf/ViewerDetailRows.svelte`] },
  ],
  "clear-generated-description": [
    "match",
    [],
    undefined,
    {
      production: [
        `${W}/lib/components/asset-viewer/DetailPanelImageEnrichment.svelte`,
      ],
    },
  ],
  "clear-generated-tags": [
    "match",
    [],
    undefined,
    {
      production: [
        `${W}/lib/components/asset-viewer/DetailPanelImageEnrichment.svelte`,
      ],
    },
  ],
  "create-a-person-while-tagging-a-manual-face": [
    "match",
    [],
    undefined,
    {
      prototype: [`${P}/FaceTagger.jsx`],
      production: [`${W}/lib/components/frameleaf/FaceTagger.svelte`],
    },
  ],
  "display-edit-faces-with-no-named-person": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/components/frameleaf/PersonFaceActions.svelte`] },
  ],
  "edit-add-description": [
    "fixed",
    ["V-19"],
    "Enter commits, Escape reverts, non-owner placeholder (fix-viewer)",
    {
      production: [
        `${W}/lib/components/asset-viewer/DetailPanelDescription.svelte`,
      ],
    },
  ],
  "edit-capture-date-time-timezone": [
    "fixed",
    ["V-23"],
    "Edit date and time dialog: date, time, Keep the current time zone, preview (codex/FL-35-complete-viewer)",
    {
      production: [
        `${W}/lib/components/asset-viewer/DetailPanelDate.svelte`,
        `${W}/lib/components/frameleaf/ViewerDateDialog.svelte`,
      ],
    },
  ],
  "edit-reassign-existing-detected-face": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/components/frameleaf/PersonFaceActions.svelte`] },
  ],
  "hover-focus-person-highlights-corresponding-face-box": [
    "match",
    [],
    undefined,
    {
      production: [`${W}/lib/components/asset-viewer/DetailPanelPeople.svelte`],
    },
  ],
  "inspect-description-detection-status-model-evidence-score-and-review": [
    "fixed",
    ["V-2"],
    "Card visible to owners, not only admins (fix-viewer)",
    {
      production: [
        `${W}/lib/components/asset-viewer/DetailPanelImageEnrichment.svelte`,
      ],
    },
  ],
  "open-location-in-openstreetmap": [
    "match",
    [],
    undefined,
    {
      production: [
        `${W}/lib/components/asset-viewer/DetailPanelLocation.svelte`,
      ],
    },
  ],
  "person-age-at-capture-birthday-tooltip": [
    "match",
    [],
    undefined,
    {
      production: [`${W}/lib/components/asset-viewer/DetailPanelPeople.svelte`],
    },
  ],
  "recognized-person-avatars-and-open-persons-media": [
    "match",
    [],
    undefined,
    {
      production: [`${W}/lib/components/asset-viewer/DetailPanelPeople.svelte`],
    },
  ],
  "rerun-description-on-asset": [
    "match",
    [],
    undefined,
    {
      production: [
        `${W}/lib/components/asset-viewer/DetailPanelImageEnrichment.svelte`,
      ],
    },
  ],
  "rerun-sensitive-detection-on-asset": [
    "match",
    [],
    undefined,
    {
      production: [
        `${W}/lib/components/asset-viewer/DetailPanelImageEnrichment.svelte`,
      ],
    },
  ],
  "select-copy-ocr-text-with-image-region-boxes": [
    "match",
    [],
    undefined,
    {
      production: [`${W}/lib/components/frameleaf/DocumentTextSection.svelte`],
    },
  ],
  "set-clear-rating": [
    "fixed",
    ["V-3", "V-20"],
    "Rating popover in the top row; explicit Clear in the panel (codex/FL-35-complete-viewer)",
    {
      production: [
        `${W}/lib/components/asset-viewer/DetailPanelStarRating.svelte`,
      ],
    },
  ],
  "show-appears-in-albums-navigate-to-album-membership": ["match", []],
  "show-file-location-open-parent-folder": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/components/frameleaf/ViewerDetailRows.svelte`] },
  ],
  "show-filename-capture-date-dimensions-camera-lens-exposure-location": [
    "match",
    [],
    undefined,
    {
      production: [
        `${W}/lib/components/frameleaf/ViewerDetailRows.svelte`,
        `${W}/lib/components/frameleaf/ViewerTitle.svelte`,
      ],
    },
  ],
  "show-hidden-people-toggle": [
    "fixed",
    ["V-21"],
    'Text toggle "Show hidden (n)" and empty state (fix-viewer)',
    {
      production: [`${W}/lib/components/asset-viewer/DetailPanelPeople.svelte`],
    },
  ],
  "show-offline-file-availability-and-ownership-context": [
    "fixed",
    ["V-27"],
    "Owner line for every non-owned asset; the offline banner (codex/FL-35-complete-viewer)",
    {
      production: [`${W}/lib/components/frameleaf/ViewerOfflineBanner.svelte`],
    },
  ],
  "show-shared-by-owner-metadata": [
    "fixed",
    ["V-27"],
    "Owned by / Shared by line whenever the asset is not the viewer's (codex/FL-35-complete-viewer)",
  ],
  // quick-edit
  "ai-preview-full-job-faithful-creative-local-lan-versus-runpod": [
    "fixed",
    ["R-1", "R-2", "R-3"],
    "Estimate Output and Cloud cost rows, 100% loupe, Use current frame and the video labels (fixed in FL-115)",
    {
      prototype: [`${P}/Studio.jsx`],
      production: [
        `${W}/lib/components/frameleaf/editor/RestorationPanel.svelte`,
        `${W}/lib/components/frameleaf/editor/RestorationCompare.svelte`,
      ],
    },
  ],
  "audio-mute-gain-channel-timing-preservation": [
    "fixed",
    ["VE-1"],
    "Audio panel in the Frameleaf video editor: clip gain 0-150% (limited above 100%), mute switch, channels preserved (FL-113)",
    {
      production: [
        `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
      ],
    },
  ],
  "auto-enhance-and-stabilization": [
    "fixed",
    ["VE-10", "VE-1"],
    "Enhance panel: Stabilize (edges cropped) and Auto-enhance, applied when the version is saved (FL-113)",
    {
      production: [
        `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
      ],
    },
  ],
  "brightness-contrast-white-point-highlights-shadows-black-point-saturation-warmth-tint-skin-tone-blue-tone-vignette-hdr-adjustments":
    [
      "fixed",
      ["VE-4"],
      "Video Adjust uses the develop groups with a histogram of the current frame; the server renders the develop model (FL-113)",
      {
        production: [
          `${W}/lib/components/frameleaf/editor/DevelopGroup.svelte`,
          `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
        ],
      },
    ],
  "extract-frame-from-playhead": [
    "fixed",
    ["VE-3"],
    "Export frame on the transport and in More actions, saved as a new photo (FL-113)",
    {
      production: [
        `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
      ],
    },
  ],
  "fast-keyframe-trim-versus-precise-trim-with-actual-boundaries": [
    "fixed",
    ["VE-7"],
    "Precise / Fast · keyframes trim, In/Out fields, I/O keys; a lone fast trim copies the streams (FL-113)",
    {
      production: [
        `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
      ],
    },
  ],
  "filter-effect-presets-and-strengths": [
    "fixed",
    ["VE-5"],
    "Video presets through PresetStrip, with strength and the video-only B&W (FL-113)",
    {
      production: [
        `${W}/lib/components/frameleaf/editor/PresetStrip.svelte`,
        `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
      ],
    },
  ],
  "numeric-trim-input-and-draggable-start-end-handles": [
    "fixed",
    ["VE-7", "VE-1"],
    "Filmstrip trim handles (drag and keys) and numeric In/Out (FL-113)",
    {
      production: [
        `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
      ],
    },
  ],
  "open-close-reset-save-photo-edit": [
    "fixed",
    ["E-3", "E-4"],
    "Discard with toast; Save version closes",
  ],
  "open-full-workspace-retaining-draft-and-playhead": [
    "partial",
    ["E-1", "MPY-10"],
    "Open in Studio from the editor (fix-editor-albums, FL-113); the memory player's Make a movie opens Studio with its items (MPY-10 fixed, FL-62); keeping the draft and playhead in the workspace is studio-parked",
  ],
  "persistent-render-status-cancel-retry-reload-revision-supersession": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/frameleaf/develop-api.ts`] },
  ],
  "photo-crop-free-original-square-aspect-rotate-left-right-horizontal-vertical-flip":
    [
      "match",
      [],
      undefined,
      {
        production: [`${W}/lib/components/frameleaf/editor/CropOverlay.svelte`],
      },
    ],
  "rotate-straighten-mirror-crop-coordinates-aspect": [
    "fixed",
    ["VE-6"],
    "Video crop chips, straighten dial, turns, flips and the draggable crop through CropOverlay (FL-113)",
    {
      production: [
        `${W}/lib/components/frameleaf/editor/CropOverlay.svelte`,
        `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
      ],
    },
  ],
  "save-version-versus-export-versus-revert": [
    "fixed",
    ["VE-11", "E-2"],
    "Video versions with Save version, Versions menu, export and revert (FL-39, FL-113); Versions popover (E-2)",
    {
      production: [
        `${W}/lib/components/frameleaf/editor/QuickEditor.svelte`,
        `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
      ],
    },
  ],
  "text-overlay-content-position-timing-style": [
    "fixed",
    ["VE-9"],
    "Up to 20 overlays with grid position, timing, size, swatches and shadow, rendered the same way (FL-113)",
    {
      production: [
        `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
      ],
    },
  ],
  "undo-redo-reset-and-reopen-draft": [
    "fixed",
    ["VE-11"],
    "Undo/redo (buttons and ⌘Z) and Revert for video as for photos (FL-113)",
  ],
  "video-quick-tools-trim-rotate-crop-adjust-audio": [
    "fixed",
    ["VE-1", "VE-2", "VE-3", "VE-12"],
    "Frameleaf video quick editor (VideoQuickEditor.svelte), opens on Trim (FL-113)",
    {
      production: [
        `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
      ],
    },
  ],
  "whole-video-and-segment-speed-changes": [
    "fixed",
    ["VE-8"],
    "Whole-clip speed plus ranges at the playhead, blue bands on the filmstrip (FL-113)",
    {
      production: [
        `${W}/lib/components/frameleaf/editor/VideoQuickEditor.svelte`,
      ],
    },
  ],
  // search-discovery
  "camera-make-model-lens": ["match", []],
  "cancel-stale-requests-and-restore-url-query-navigation-position": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/frameleaf/search-context.ts`] },
  ],
  "clear-all-removable-chips-filter-presets": [
    "fixed",
    ["S-19", "SD-12"],
    "Chips open their section, the search text is a chip and Clear all shows whenever anything is active (S-19, fixed by the FL-30 library gaps); Save search and the results-page chips (SD-12) fixed on codex/FL-49-search-palette",
    {
      production: [
        `${W}/lib/components/frameleaf/ResultsToolbar.svelte`,
        `${W}/lib/components/frameleaf/FilterChip.svelte`,
      ],
    },
  ],
  "command-palette-across-assets-people-albums-places-settings-actions": [
    "fixed",
    ["S-1"],
    "Upstream palette providers and lib/commands.ts removed; the palette manager only dispatches action shortcuts and Ctrl/Cmd+K and / open Frameleaf search",
    {
      prototype: [`${P}/CommandPalette.jsx`, `${P}/command-palette.mjs`],
      production: [`${W}/lib/components/frameleaf/CommandPalette.svelte`],
    },
  ],
  "context-smart-versus-filename-text-description-ocr-path-search": [
    "fixed",
    ["SD-1", "SD-2", "SD-3"],
    "Glass search palette: scope toggle with counts, per-mode placeholders, All text as an or over every text field (fixed on codex/FL-49-search-palette)",
  ],
  "country-state-city-facets": [
    "fixed",
    ["FP-3", "SD-7"],
    "Facet counts from POST /search/facets in the palette and its Advanced view (fixed on codex/FL-49-search-palette)",
  ],
  "dates-presets-custom-range": ["match", []],
  "dynamic-counts-facets-that-respect-access-privacy": [
    "fixed",
    ["FP-3", "SD-7"],
    "Server-scoped facet, histogram and scope counts, dropped on every access change (fixed on codex/FL-49-search-palette)",
  ],
  "enrichment-review-override-failure-missing-description-missing-detection-filters":
    [
      "fixed",
      ["FP-2", "SD-6"],
      "Text & descriptions and Sensitivity review radiogroups over the one enrichment enum; palette Enrichment quick filters with counts (fixed on codex/FL-49-search-palette)",
    ],
  "explore-empty-error-loading-states": [
    "fixed",
    ["T-12"],
    'Explore empty copy "Nothing to explore in this view" (fixed on codex/FL-50-explore-albums-map)',
    {
      prototype: [`${P}/ExploreLibrary.jsx`],
      production: [`${W}/lib/components/frameleaf/ExplorePanel.svelte`],
    },
  ],
  "explore-memories-carousel-and-open-memory-story": [
    "fixed",
    ["T-15"],
    "The upstream memory strip is gone from the library (FL-33 library gaps); memories open from the Memories destination",
    {
      prototype: [`${P}/ExploreLibrary.jsx`, `${P}/Memories.jsx`],
      production: [`${W}/lib/components/frameleaf/ExplorePanel.svelte`],
    },
  ],
  "explore-people-and-view-all": [
    "fixed",
    ["T-12"],
    "Per-card counts from POST /search/facets in the scope of the search each card opens (fixed on codex/FL-50-explore-albums-map)",
    {
      prototype: [`${P}/ExploreLibrary.jsx`],
      production: [`${W}/lib/components/frameleaf/ExplorePanel.svelte`],
    },
  ],
  "explore-places-and-view-all": [
    "fixed",
    ["T-12"],
    "Per-card counts from POST /search/facets in the scope of the search each card opens (fixed on codex/FL-50-explore-albums-map)",
    {
      prototype: [`${P}/ExploreLibrary.jsx`],
      production: [`${W}/lib/components/frameleaf/ExplorePanel.svelte`],
    },
  ],
  "explore-recently-added-and-direct-asset-viewer": [
    "fixed",
    ["T-12"],
    "Recent captures by capture date with name, Video label and capture day (fixed on codex/FL-50-explore-albums-map)",
    {
      prototype: [`${P}/ExploreLibrary.jsx`],
      production: [`${W}/lib/components/frameleaf/ExplorePanel.svelte`],
    },
  ],
  "extra-things-collections-highlight-cards": [
    "fixed",
    ["T-12"],
    '"Things in your photos" tags section with counts and covers (fixed on codex/FL-50-explore-albums-map)',
    {
      prototype: [`${P}/ExploreLibrary.jsx`],
      production: [`${W}/lib/components/frameleaf/ExplorePanel.svelte`],
    },
  ],
  "image-video-type": ["match", []],
  "interpret-natural-language-into-editable-constraints": ["match", []],
  "map-search-results-clustering-bounded-truncated-result-disclosure": [
    "fixed",
    ["MV-2", "MV-4", "MV-5", "MV-6"],
    "Cluster zoom, In-view chip, empty state, list rows (fixed, FL-51 on codex/FL-50-complete-discovery)",
    {
      prototype: [`${P}/MapView.jsx`],
      production: [`${W}/lib/components/shared-components/map/Map.svelte`],
    },
  ],
  "moment-search-frame-caption-transcript-timestamp-matches-and-jump-playback":
    [
      "in-flight",
      [],
      "FL-59 video moments (beyond the prototype)",
      {
        production: [`${W}/lib/components/frameleaf/VideoMomentsPanel.svelte`],
      },
    ],
  "people-filter-with-face-avatars-and-matching-choices": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/components/frameleaf/FilterMultiSelect.svelte`] },
  ],
  "people-tag-any-all-exclude-groups-and-retained-chips": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/components/frameleaf/FilterMultiSelect.svelte`] },
  ],
  "play-annotate-a-discovered-video-moment": [
    "in-flight",
    [],
    "FL-59 video moments (beyond the prototype)",
    { production: [`${W}/lib/components/frameleaf/VideoMomentResults.svelte`] },
  ],
  "rating-favorites-archive-not-in-album-untagged": ["match", []],
  "save-update-delete-custom-server-queries": [
    "fixed",
    ["S-14"],
    "Palette Save search (Smart album, Album snapshot, saved search) and RailSavedSearches mounted in LibraryRail's Albums section",
    {
      prototype: [
        `${P}/App.jsx`,
        `${P}/FilterPanel.jsx`,
        `${P}/LibraryRail.jsx`,
      ],
      production: [
        `${W}/lib/components/frameleaf/RailSavedSearches.svelte`,
        `${W}/lib/components/frameleaf/LibraryRail.svelte`,
      ],
    },
  ],
  "search-assets-inside-shared-spaces-or-named-pets": [
    "fixed",
    ["SD-1"],
    "Palette scope toggle: current album, pet or space and the entire library, each with its count (fixed on codex/FL-49-search-palette)",
  ],
  "search-input-recent-searches-clear-history-individual-term": [
    "fixed",
    ["SD-5"],
    "Recent searches keep chips, mode and filters, with the Try a search fallback (fixed on codex/FL-49-search-palette)",
  ],
  "server-paging-load-more-and-large-result-sets": [
    "fixed",
    ["T-14"],
    "ShowMore only where a page pages its results (never under the timeline); Select all N reads the grid's count until the server has counted (FL-33 shell completion)",
    {
      production: [
        `${W}/lib/components/frameleaf/ShowMore.svelte`,
        `${W}/lib/components/frameleaf/LibraryView.svelte`,
      ],
    },
  ],
  // timeline-bulk
  "bulk-add-remove-tags": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/components/frameleaf/BulkTagDialog.svelte`] },
  ],
  "bulk-add-to-album": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/components/frameleaf/BulkAlbumDialog.svelte`] },
  ],
  "bulk-change-date-location-description": [
    "intentional-product-change",
    ["T-13", "T-19"],
    "Friendly searchable zones and the selection pre-fill are done (T-19, FL-32 library gaps); the location place-name fields are not built by owner decision (T-13, FL-146 2026-09-25)",
    {
      production: [
        `${W}/lib/components/frameleaf/BulkDateDialog.svelte`,
        `${W}/lib/components/frameleaf/BulkLocationDialog.svelte`,
      ],
    },
  ],
  "bulk-delete-undo-with-partial-failures": [
    "fixed",
    ["T-1"],
    "Undo on the result toast",
    { production: [`${W}/lib/frameleaf/bulk-controller.svelte.ts`] },
  ],
  "bulk-download-archive-unarchive": [
    "fixed",
    ["T-17"],
    "Archived items leave a Timeline view and unarchived ones leave Archive; no Archived badge; Offline badge from the bucket (FL-33 shell completion)",
    { production: [`${W}/lib/frameleaf/bulk-operations.ts`] },
  ],
  "bulk-favorite-unfavorite": ["match", []],
  "bulk-mark-unmark-sensitive": ["match", []],
  "bulk-refresh-thumbnails-metadata-transcodes": ["match", []],
  "click-open-asset-select-deselect-items": [
    "fixed",
    ["T-4", "T-20"],
    "Tile hover quick actions are done (T-4, FL-33 library gaps); Deselect label, full day titles and Timeline-only Locked (T-20, FL-33 shell completion)",
    { production: [`${W}/lib/components/frameleaf/AssetTile.svelte`] },
  ],
  "date-grouped-photos-browse-chronological-library": [
    "fixed",
    ["T-3", "T-7", "T-10"],
    "Timeline captions and the Frameleaf empty states are done (T-7, T-10, FL-33 library gaps); Years/Months/Days/All grouping with ⌘-wheel, pinch, D/M/Y and the announcement (T-3)",
    { production: [`${W}/lib/components/frameleaf/LibraryTimeline.svelte`] },
  ],
  "grid-list-compare-and-persisted-query-selection-layout": [
    "fixed",
    ["T-8", "S-15", "S-17"],
    "Toolbar count, Slideshow, information toggle, Sort (Timeline dated; Browse/Work/List by upload date, file name or rating through GET /timeline/ordered), Grid/List and More library actions are in (S-15, FL-30 library gaps and review); square Browse and Work grids with Thumbnail size (T-8; the month-boundary row gap is owner decision FL-143)",
    { production: [`${W}/lib/components/frameleaf/ResultsToolbar.svelte`] },
  ],
  "jump-scroll-to-time-restore-asset-position": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/components/frameleaf/YearScrubber.svelte`] },
  ],
  "link-live-photo-still-and-video": ["match", []],
  "select-all-select-groups-range-multi-selection-keyboard-bulk-behavior": [
    "fixed",
    ["T-5", "S-22", "T-14"],
    "Library action shortcuts work on every library page (T-5, FL-33 library gaps); ←/→ move focus in the timeline and Delete has no Shift path there (S-22); Select all N (T-14)",
    {
      production: [
        `${W}/lib/frameleaf/library-shortcuts.ts`,
        `${W}/lib/components/frameleaf/LibraryView.svelte`,
      ],
    },
  ],
  "stack-selected-photos": ["match", []],
  "upload-from-library-progress-errors-duplicates": [
    "fixed",
    ["U-1", "U-2", "U-3", "U-4", "U-5", "S-20"],
    "Dismiss errors scope, pill, row status and region fixed on codex/FL-45-download-panel (S-20 fixed earlier)",
    {
      prototype: [`${P}/UploadPanel.jsx`],
      production: [
        `${W}/lib/components/frameleaf/UploadPanel.svelte`,
        `${W}/lib/stores/upload.ts`,
      ],
    },
  ],
  // viewer
  "add-to-album": ["match", []],
  "add-to-stack": [
    "fixed",
    ["V-11"],
    'Label "Add to stack" (codex/FL-35-complete-viewer)',
  ],
  "album-activity-comments-likes-activity-panel": [
    "fixed",
    ["AL-18"],
    "Frameleaf per-asset activity panel (fixed on codex/FL-52-albums-sharing)",
    { production: [`${W}/lib/components/frameleaf/ActivityPanel.svelte`] },
  ],
  "archive-unarchive": ["match", []],
  "cast-to-receiver": [
    "match",
    [],
    undefined,
    { production: [`${W}/lib/services/app.service.ts`] },
  ],
  "copy-image-to-clipboard": [
    "fixed",
    ["V-5"],
    'Label "Copy image" (codex/FL-35-complete-viewer)',
  ],
  "download-current-edited-media": [
    "fixed",
    ["D-1", "D-2", "D-3"],
    "Single downloads go through the download panel with progress, Cancel and Retry (codex/FL-45-download-panel)",
    {
      prototype: [`${P}/UploadPanel.jsx`, `${P}/system-data.mjs`],
      production: [
        `${W}/lib/components/frameleaf/DownloadPanel.svelte`,
        `${W}/lib/managers/download-manager.svelte.ts`,
        `${W}/lib/services/asset.service.ts`,
      ],
    },
  ],
  "download-original-separately": [
    "fixed",
    ["D-1", "D-2", "D-3"],
    "Original and edited files are separate download panel rows (codex/FL-45-download-panel)",
    {
      prototype: [`${P}/UploadPanel.jsx`, `${P}/system-data.mjs`],
      production: [
        `${W}/lib/components/frameleaf/DownloadPanel.svelte`,
        `${W}/lib/managers/download-manager.svelte.ts`,
        `${W}/lib/services/asset.service.ts`,
      ],
    },
  ],
  "favorite-unfavorite": [
    "fixed",
    ["V-5"],
    'Labels "Add to favorites" / "Remove from favorites" (codex/FL-35-complete-viewer)',
  ],
  "image-video-panorama-and-photo-sphere-viewers": [
    "match",
    [],
    undefined,
    {
      production: [
        `${W}/lib/components/asset-viewer/ImagePanoramaViewer.svelte`,
      ],
    },
  ],
  "keep-this-stack-asset-and-delete-the-others": [
    "fixed",
    ["V-11"],
    'Label "Keep this, remove the rest"',
    { production: [`${W}/lib/components/frameleaf/ViewerStackStrip.svelte`] },
  ],
  "keyboard-navigation-and-focus-restoration": [
    "fixed",
    ["V-14", "V-15"],
    "Zoom keys (fix-viewer); Space, S, T, Backspace and no a/d (codex/FL-35-complete-viewer)",
    { production: [`${W}/lib/components/asset-viewer/PhotoViewer.svelte`] },
  ],
  "live-motion-photo-play-and-stop": [
    "fixed",
    ["V-16"],
    "On-image Live badge with hover-to-play (codex/FL-35-complete-viewer)",
    { production: [`${W}/lib/components/frameleaf/ViewerLiveBadge.svelte`] },
  ],
  "make-stack-primary": [
    "fixed",
    ["V-11"],
    'Label "Set as stack primary"',
    { production: [`${W}/lib/components/frameleaf/ViewerStackStrip.svelte`] },
  ],
  "mark-sensitive-unmark-sensitive": ["match", []],
  "move-into-out-of-origin-locked-visibility": [
    "intentional-product-change",
    [],
    "Locked is one lock record; visibility = locked is never written (CODEX-HANDOFF §3)",
    {
      production: [
        `${W}/lib/components/asset-viewer/actions/SetVisibilityAction.svelte`,
      ],
    },
  ],
  "move-to-trash": [
    "fixed",
    ["V-5", "V-15"],
    'Label "Move to trash (Delete)"; Backspace',
    {
      production: [
        `${W}/lib/components/asset-viewer/actions/DeleteAction.svelte`,
      ],
    },
  ],
  "offline-asset-indicator-and-source-specific-behavior": [
    "fixed",
    ["V-6"],
    "FL-35 September 24 viewer: the legacy Offline button and panel block are gone; the offline banner remains",
    {
      production: [`${W}/lib/components/frameleaf/ViewerOfflineBanner.svelte`],
    },
  ],
  "open-editor": [
    "fixed",
    ["V-5"],
    'Label "Edit" (codex/FL-35-complete-viewer)',
  ],
  "open-full-viewer-close-back-escape-previous-next": [
    "fixed",
    ["V-5"],
    '"Close viewer" titled "Close viewer (Escape)"; "n of N" is in the footer (V-12) (codex/FL-35-complete-viewer)',
    {
      production: [
        `${W}/lib/components/frameleaf/ViewerTitle.svelte`,
        `${W}/lib/components/frameleaf/ViewerFooter.svelte`,
      ],
    },
  ],
  "open-info": ["fixed", ["V-5"], 'Label "Information (I)" (fix-viewer)'],
  "permanently-delete-in-the-appropriate-viewer-context": [
    "fixed",
    ["V-1", "V-4"],
    "Non-suppressible confirm with prototype copy (fix-viewer); Delete permanently in the Trash group",
    {
      production: [
        `${W}/lib/components/asset-viewer/actions/DeleteAction.svelte`,
      ],
    },
  ],
  "play-pause-seek-volume-fullscreen-for-video": [
    "fixed",
    ["V-13"],
    "FL-35 September 24 viewer: the footer carries full screen and the source segment",
    {
      production: [
        `${W}/lib/components/asset-viewer/VideoNativeViewer.svelte`,
        `${W}/lib/components/frameleaf/ViewerFooter.svelte`,
      ],
    },
  ],
  "refresh-faces-for-this-asset": ["match", []],
  "refresh-metadata-for-this-asset": ["match", []],
  "regenerate-thumbnails-for-this-asset": ["match", []],
  "remove-from-current-album": ["match", []],
  "restore-a-trashed-asset-from-viewer": [
    "fixed",
    ["V-4"],
    "Restore in the trash toolbar and the Trash group (codex/FL-35-complete-viewer)",
  ],
  "set-account-profile-picture": ["fixed", ["V-11"], 'Label "Profile picture"'],
  "set-album-cover": [
    "fixed",
    ["V-9", "V-11"],
    "Album cover, with the album chooser outside the album (codex/FL-35-complete-viewer)",
    {
      production: [`${W}/lib/components/frameleaf/ViewerChooserDialog.svelte`],
    },
  ],
  "set-persons-featured-photo": [
    "fixed",
    ["V-9", "V-11"],
    "Featured photo for person, with the person chooser (codex/FL-35-complete-viewer)",
    {
      production: [`${W}/lib/components/frameleaf/ViewerChooserDialog.svelte`],
    },
  ],
  "share-with-recipients-create-or-manage-a-public-link": [
    "partial",
    ["AL-30", "AL-30b", "AL-32", "AL-33"],
    "Selection Share link opens the form and ShareSheet offers the link only (fixed); the viewer's Share opens ShareSheet (AL-33, fixed on codex/FL-52-albums-sharing); per-item person sharing has no server contract (AL-30b, owner)",
    {
      production: [
        `${W}/lib/components/frameleaf/ShareSheet.svelte`,
        `${W}/lib/components/frameleaf/SharedLinkForm.svelte`,
      ],
    },
  ],
  "shared-link-download-with-link-restrictions": [
    "fixed",
    ["AL-37"],
    "Labelled Download in the public viewer; slideshow no longer gated on downloads (fixed, FL-56)",
    {
      prototype: [`${P}/PublicViewer.jsx`],
      production: [`${W}/lib/components/pages/SharedLinkPage.svelte`],
    },
  ],
  "slideshow-ascending-descending-order": [
    "fixed",
    ["V-8"],
    "Frameleaf slideshow settings panel (fixed on codex/FL-62-sept24-slideshow-memories)",
    {
      production: [
        `${W}/lib/components/asset-viewer/SlideshowBar.svelte`,
        `${W}/lib/components/frameleaf/SlideshowSettingsPanel.svelte`,
      ],
    },
  ],
  "slideshow-blurred-background-look-progress-transition-settings": [
    "fixed",
    ["V-8", "V-18"],
    "Frameleaf settings panel, five transitions and inline slideshow (fixed on codex/FL-62-sept24-slideshow-memories)",
    {
      production: [
        `${W}/lib/components/asset-viewer/SlideshowBar.svelte`,
        `${W}/lib/components/frameleaf/SlideshowSettingsPanel.svelte`,
      ],
    },
  ],
  "slideshow-duration-contain-cover-metadata-captions": [
    "fixed",
    ["V-8"],
    "Frameleaf slideshow settings panel (fixed on codex/FL-62-sept24-slideshow-memories)",
    {
      production: [
        `${W}/lib/components/asset-viewer/SlideshowBar.svelte`,
        `${W}/lib/components/frameleaf/SlideshowSettingsPanel.svelte`,
      ],
    },
  ],
  "slideshow-play-pause-previous-next-repeat-shuffle": [
    "fixed",
    ["V-7", "V-15", "V-18"],
    "Play/Pause slideshow and Slideshow settings in the menu, Space/S, inline playback (codex/FL-35-complete-viewer)",
    { production: [`${W}/lib/components/asset-viewer/SlideshowBar.svelte`] },
  ],
  "star-rating-clear-rating": [
    "fixed",
    ["V-3"],
    "Rating popover in the top row",
    {
      production: [
        `${W}/lib/components/asset-viewer/actions/RatingAction.svelte`,
      ],
    },
  ],
  "toggle-original-video-versus-encoded-playback": [
    "fixed",
    ["V-11"],
    'The footer segment "Play original / Play encoded" (V-13); the menu entry is gone, as in the template (codex/FL-35-complete-viewer)',
    { production: [`${W}/lib/components/frameleaf/ViewerFooter.svelte`] },
  ],
  "transcode-this-video": [
    "fixed",
    ["V-7"],
    "Transcode video and Refresh encoded video in the Jobs group (codex/FL-35-complete-viewer)",
  ],
  "unstack-remove-one-item-from-a-stack": [
    "fixed",
    ["V-10", "V-11"],
    'Label "Unstack"; "Remove from stack" stays as the FL-36 remove-member action (recorded deviation, codex/FL-35-complete-viewer)',
    { production: [`${W}/lib/components/frameleaf/ViewerStackStrip.svelte`] },
  ],
  "view-in-timeline": ["match", []],
  "view-similar-photos": [
    "fixed",
    ["V-11"],
    'Label "Find similar" (codex/FL-35-complete-viewer)',
  ],
  "zoom-in-out-fit-image-pan": [
    "fixed",
    ["V-6", "V-13", "V-14"],
    "FL-35: footer Zoom out / Fit or N% of fit / Zoom in; zoom keys (fix-viewer); legacy buttons gone",
    {
      production: [
        `${W}/lib/components/asset-viewer/PhotoViewer.svelte`,
        `${W}/lib/components/frameleaf/ViewerFooter.svelte`,
      ],
    },
  ],
};

// ---- routes -----------------------------------------------------------------------------------

const page = (route) => {
  const dir = route.replace(/^\//, "").split("/").filter(Boolean);
  return dir;
};

const routes = {
  "/": [
    "retained-live-route",
    [],
    "Lifecycle redirect (welcome / setup / login / photos)",
    [`${P}/AuthScreens.jsx`],
    [`${W}/routes/+page.ts`],
  ],
  "/activity": [
    "fixed",
    ["A-1", "A-6", "A-8", "A-9", "A-10"],
    'The indicator and filter count say "jobs" (A-1) and rows carry the status line with percent, ETA, "Paused at N%" and "Waiting for connection" (A-6), both by the FL-30 library gaps. A-2…A-5 and A-7 are fixed on claude/frameleaf-implementation by the design foundation Activity port. FL-104 adds the completion live region (A-8), the Reduce Motion guard (A-9) and Pause disabled with its reason (A-10)',
    [`${P}/Activity.jsx`],
    [
      `${W}/routes/(user)/activity/+page.svelte`,
      `${W}/lib/components/frameleaf/ActivityView.svelte`,
    ],
  ],
  "/admin": [
    "fixed",
    ["CC-9", "C-2"],
    "Overview homepage on /admin with the template copy, the restore-test and worker-compatibility rows, and the ML endpoint, GPU Studio and cloud destination from the server (FL-71)",
    [`${P}/CommandCenter.jsx`],
    [`${W}/routes/admin/+page.ts`],
  ],
  "/admin/jobs-status": [
    "fixed",
    ["CC-35"],
    "Redirects to the Job manager (FL-71)",
    [`${P}/JobsManager.jsx`],
    [`${W}/routes/admin/jobs-status/+page.ts`],
  ],
  "/admin/library-management": [
    "fixed",
    ["CC-34"],
    "Frameleaf libraries in the Command Center: search, filter, sort, status and scan progress, Cancel scan, typed-name removal (FL-78, closed September 25)",
    [`${P}/AccountsLibraries.jsx`],
    [
      `${W}/routes/admin/library-management/(list)/+page.ts`,
      `${W}/lib/components/frameleaf/LibrariesManager.svelte`,
    ],
  ],
  "/admin/library-management/[id]": [
    "fixed",
    ["CC-34"],
    "Frameleaf libraries in the Command Center: search, filter, sort, status and scan progress, Cancel scan, typed-name removal (FL-78, closed September 25)",
    [`${P}/AccountsLibraries.jsx`],
    [
      `${W}/routes/admin/library-management/[id]/+page.ts`,
      `${W}/lib/components/frameleaf/LibraryDetail.svelte`,
    ],
  ],
  "/admin/library-management/[id]/edit": [
    "fixed",
    ["CC-34"],
    "Frameleaf libraries in the Command Center: search, filter, sort, status and scan progress, Cancel scan, typed-name removal (FL-78, closed September 25)",
    [`${P}/AccountsLibraries.jsx`],
    [
      `${W}/routes/admin/library-management/[id]/edit/+page.ts`,
      `${W}/lib/components/frameleaf/LibraryFormDialog.svelte`,
    ],
  ],
  "/admin/library-management/new": [
    "fixed",
    ["CC-34"],
    "Frameleaf libraries in the Command Center: search, filter, sort, status and scan progress, Cancel scan, typed-name removal (FL-78, closed September 25)",
    [`${P}/AccountsLibraries.jsx`],
    [
      `${W}/routes/admin/library-management/(list)/new/+page.ts`,
      `${W}/lib/components/frameleaf/LibraryFormDialog.svelte`,
    ],
  ],
  "/admin/maintenance": [
    "fixed",
    ["CC-21"],
    'The server records each check\'s last full run and the card reads "Last run …" / "Never run" (FL-81 CC-21); mode card, reason, backups, integrity checks and reports fixed by FL-81 (CC-14..CC-20, CC-22, CC-24)',
    [`${P}/Maintenance.jsx`, `${P}/maintenance-data.mjs`],
    [
      `${W}/routes/admin/maintenance/+page.ts`,
      `${W}/routes/(user)/user-settings/sections/MaintenanceSection.svelte`,
    ],
  ],
  "/admin/maintenance/integrity-report/[type]": [
    "fixed",
    ["CC-23"],
    "Report viewer summary, Download CSV and Download report file, delete confirm (fixed by FL-81); severity is server-limited",
    [`${P}/Maintenance.jsx`],
    [
      `${W}/routes/admin/maintenance/integrity-report/[type]/+page.ts`,
      `${W}/routes/(user)/user-settings/sections/IntegrityReportSection.svelte`,
    ],
  ],
  "/admin/physical-deduplication": [
    "fixed",
    ["UT-23", "UT-24", "UT-25"],
    "Configuration-error state with Open settings; per-read file availability with the unavailable overlay; detail line, picker and Change link (FL-71, September 25)",
    [`${P}/PhysicalDedupManager.jsx`, `${P}/physical-dedup-data.mjs`],
    [
      `${W}/routes/admin/physical-deduplication/+page.ts`,
      `${W}/lib/components/frameleaf/PhysicalDedupManager.svelte`,
    ],
  ],
  "/admin/processing-destinations": [
    "match",
    ["CC-45"],
    "Only the enclosing admin sidebar (CC-1)",
    [`${P}/WorkerManager.jsx`, `${P}/worker-settings.mjs`],
    [
      `${W}/routes/admin/processing-destinations/+page.ts`,
      `${W}/routes/(user)/user-settings/sections/ProcessingSection.svelte`,
    ],
  ],
  "/admin/queues": [
    "fixed",
    ["CC-42", "CC-43", "CC-44"],
    "Job manager fixed by FL-71 (CC-35..CC-41, Retry failed, Account and Worker columns, Account filter J-1 with per-account counts) and FL-59 (CC-42, the Frameleaf Enrichment tasks dialog with When and Acceleration); CC-43 and CC-44 are obsolete: the GPU provider is removed and Frameleaf Cloud processing replaces it (FL-159)",
    [`${P}/JobsManager.jsx`, `${P}/jobs-data.mjs`],
    [
      `${W}/routes/admin/queues/+page.ts`,
      `${W}/routes/(user)/user-settings/sections/QueuesSection.svelte`,
    ],
  ],
  "/admin/queues/[name]": [
    "fixed",
    ["CC-38"],
    "Queue detail with job tabs, Account and Worker columns, Retry failed and the job detail dialog (FL-71)",
    [`${P}/JobsManager.jsx`],
    [
      `${W}/routes/admin/queues/[name]/+page.ts`,
      `${W}/routes/(user)/user-settings/sections/QueuesSection.svelte`,
    ],
  ],
  "/admin/render-workers": [
    "studio-parked",
    [],
    "Render workers are beyond the prototype (Studio rendering)",
    [`${P}/WorkerManager.jsx`],
    [
      `${W}/routes/admin/render-workers/+page.ts`,
      `${W}/routes/(user)/user-settings/sections/RenderWorkersSection.svelte`,
    ],
  ],
  "/admin/server-status": [
    "fixed",
    ["CC-9"],
    "Redirects to Library analytics in the Command Center (FL-79); the Overview is /admin",
    [`${P}/CommandCenter.jsx`],
    [`${W}/routes/admin/server-status/+page.ts`],
  ],
  "/admin/system-settings": [
    "partial",
    [
      "CC-1",
      "CC-2",
      "CC-3",
      "CC-4",
      "CC-5",
      "CC-6",
      "CC-7",
      "CC-8",
      "CC-11",
      "CC-12",
    ],
    "Rail, areas, search, directory and draft/review fixed (FL-66, FL-71; section titles, search count and scope note aligned in the Sept 24 re-audit); the server name fixed (CC-4, `server.name`); the platform shortcut hint fixed (CC-7, September 25); configuration transfer fixed by FL-71 (CC-46..CC-48)",
    [
      `${P}/CommandCenter.jsx`,
      `${P}/settings-catalog.mjs`,
      `${P}/ConfigurationTransfer.jsx`,
    ],
    [
      `${W}/routes/admin/system-settings/+page.ts`,
      `${W}/lib/components/frameleaf/settings/SettingsHost.svelte`,
      `${W}/lib/components/frameleaf/settings/SettingsHost.svelte`,
    ],
  ],
  "/admin/user-management": [
    "retained-live-route",
    [],
    "Redirect to /admin/users",
    [`${P}/AccountsLibraries.jsx`],
    [`${W}/routes/admin/user-management/+page.ts`],
  ],
  "/admin/users": [
    "fixed",
    ["CC-25", "CC-26", "CC-27"],
    '"Your server" heading, Items and Storage used / quota columns, toolbar, Edit account in the detail header (FL-71, FL-76)',
    [`${P}/AccountsLibraries.jsx`, `${P}/account-library-data.mjs`],
    [
      `${W}/routes/admin/users/(list)/+page.ts`,
      `${W}/routes/(user)/user-settings/sections/UsersSection.svelte`,
      `${W}/lib/components/frameleaf/AccountTable.svelte`,
    ],
  ],
  "/admin/users/[id]": [
    "fixed",
    ["CC-28", "CC-30", "CC-32"],
    "Detail header, PIN is set / No PIN set with Set, Change and Reset PIN from the admin-only PIN state, typed email on every delete (FL-76); snapshot, sign-in provider and device dialog fixed by FL-76 (CC-29, CC-31, CC-33)",
    [`${P}/AccountsLibraries.jsx`],
    [
      `${W}/routes/admin/users/[id]/+page.ts`,
      `${W}/routes/(user)/user-settings/sections/UserDetail.svelte`,
      `${W}/lib/components/frameleaf/AccountDetailTabs.svelte`,
    ],
  ],
  "/admin/users/[id]/edit": [
    "match",
    [],
    undefined,
    [`${P}/AccountsLibraries.jsx`],
    [
      `${W}/routes/admin/users/[id]/edit/+page.ts`,
      `${W}/routes/(user)/user-settings/sections/UserDetail.svelte`,
      `${W}/lib/components/frameleaf/AccountFormDialog.svelte`,
    ],
  ],
  "/admin/users/new": [
    "match",
    [],
    undefined,
    [`${P}/AccountsLibraries.jsx`],
    [
      `${W}/routes/admin/users/(list)/new/+page.ts`,
      `${W}/routes/(user)/user-settings/sections/UsersSection.svelte`,
      `${W}/lib/components/frameleaf/AccountFormDialog.svelte`,
    ],
  ],
  "/albums": [
    "partial",
    ["AL-1", "AL-2", "AL-3", "AL-4", "AL-5", "AL-6", "AL-7", "AL-8", "AL-9"],
    "Albums page dialogs and smart album create fixed; AL-6 (built-in smart albums) and AL-9 (editor move rights, owner decision) remain",
    [`${P}/Collections.jsx`, `${P}/AlbumCard.jsx`, `${P}/collections-data.mjs`],
    [
      `${W}/routes/(user)/albums/+page.svelte`,
      `${W}/lib/components/frameleaf/AlbumDirectory.svelte`,
    ],
  ],
  "/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]": [
    "partial",
    [
      "AL-10",
      "AL-11",
      "AL-12",
      "AL-13",
      "AL-14",
      "AL-15",
      "AL-16",
      "AL-17",
      "AL-18",
    ],
    "Album header conformance; AL-13 (newest-item cover) needs a server change",
    [`${P}/CollectionHeader.jsx`, `${P}/ActivityPanel.jsx`],
    [
      `${W}/routes/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
      `${W}/lib/components/frameleaf/AlbumHeader.svelte`,
    ],
  ],
  "/archive/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["T-10", "S-10"],
    "Frameleaf empty state (T-10, FL-33 library gaps; S-10 fixed)",
    [`${P}/TimelineLibrary.jsx`, `${P}/App.jsx`],
    [
      `${W}/routes/(user)/archive/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
    ],
  ],
  "/auth/change-password": [
    "fixed",
    ["AU-3"],
    "Prototype copy, strength meter, Sign out instead (fixed on claude/frameleaf-implementation by the FL-80 auth screens)",
    [`${P}/AuthScreens.jsx`],
    [`${W}/routes/auth/change-password/+page.svelte`],
  ],
  "/auth/login": [
    "fixed",
    ["AU-1"],
    'Heading, forgot-password note and "Keep me signed in" (fixed on claude/frameleaf-implementation by the FL-80 auth screens)',
    [`${P}/AuthScreens.jsx`],
    [`${W}/routes/auth/login/+page.svelte`],
  ],
  "/auth/logout": [
    "retained-live-route",
    [],
    "Sign-out redirect",
    [`${P}/SystemPanels.jsx`],
    [`${W}/routes/auth/logout/+page.svelte`],
  ],
  "/auth/onboarding": [
    "fixed",
    ["O-8", "O-12"],
    "Store links only when configured (O-12, FL-135); Check for new versions is a real switch that asks only Frameleaf's releases (O-8, FL-80). Onboarding ported by FL-80 (ON-1, O-1..O-7, O-9..O-11)",
    [`${P}/AuthScreens.jsx`, `${P}/system-data.mjs`],
    [`${W}/routes/auth/onboarding/+page.svelte`],
  ],
  "/auth/pin-prompt": [
    "fixed",
    ["AU-4"],
    "PIN prompt copy, keypad, Reset PIN, create-mode cells (fixed on claude/frameleaf-implementation by the FL-80 auth screens)",
    [`${P}/AuthScreens.jsx`],
    [
      `${W}/routes/auth/pin-prompt/+page.svelte`,
      `${W}/lib/components/frameleaf/PinCells.svelte`,
    ],
  ],
  "/auth/register": [
    "fixed",
    ["AU-2"],
    "Prototype copy, field order, strength meter (fixed on claude/frameleaf-implementation by the FL-80 auth screens)",
    [`${P}/AuthScreens.jsx`],
    [`${W}/routes/auth/register/+page.svelte`],
  ],
  "/best-photos/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["T-6"],
    "Tiles show each item's own rating and Best Photos keeps the server quality order (T-6 fixed, FL-50); ranked video best-moment play and cover actions added on codex/FL-50-explore-albums-map",
    [`${P}/App.jsx`, `${P}/AssetTile.jsx`],
    [
      `${W}/routes/(user)/best-photos/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
    ],
  ],
  "/buy": [
    "partial",
    ["BU-1", "S-31", "B-1", "B-2", "B-3", "B-4", "B-5", "B-6", "B-7", "B-9"],
    "Frameleaf supporter page; Support Frameleaf wording and store-link removal done (FL-157 wording pass); full prototype screen port and store from FRAMELEAF_CLOUD_URL stay with FL-157",
    [`${P}/AuthScreens.jsx`, `${P}/system-data.mjs`],
    [`${W}/routes/(user)/buy/+page.svelte`],
  ],
  "/documents/[[photos=photos]]/[[assetId=id]]": [
    "in-flight",
    [],
    "FL-63 documents (beyond the prototype)",
    [`${P}/App.jsx`],
    [
      `${W}/routes/(user)/documents/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
    ],
  ],
  "/explore": [
    "fixed",
    ["T-12"],
    "Explore sections, counts and snapping carousels (fixed on codex/FL-50-explore-albums-map)",
    [`${P}/ExploreLibrary.jsx`, `${P}/explore-timeline.mjs`],
    [
      `${W}/routes/(user)/explore/+page.svelte`,
      `${W}/lib/components/frameleaf/ExplorePanel.svelte`,
    ],
  ],
  "/favorites/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["T-10", "S-10"],
    "Frameleaf empty state (T-10, FL-33 library gaps; S-10 fixed)",
    [`${P}/TimelineLibrary.jsx`, `${P}/App.jsx`],
    [
      `${W}/routes/(user)/favorites/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
    ],
  ],
  "/folders/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["FD-1", "FD-2", "FD-3", "FD-4", "FD-5", "FD-6", "FD-7", "FD-8"],
    "Folders browser ported from Folders.jsx (fixed on codex/FL-46-complete-browsers)",
    [`${P}/Folders.jsx`, `${P}/discovery-data.mjs`],
    [
      `${W}/routes/(user)/folders/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
      `${W}/lib/components/frameleaf/FolderBrowserPanel.svelte`,
    ],
  ],
  "/link": [
    "retained-live-route",
    [],
    "Deep-link resolver",
    [`${P}/App.jsx`],
    [`${W}/routes/link/+page.ts`],
  ],
  "/locked/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["S-6", "S-7", "T-20"],
    "Locked control and in-place unlock dialog (fixed on claude/frameleaf-implementation by FL-80); the layout switch offers the Timeline only (T-20)",
    [`${P}/LockedContent.jsx`, `${P}/locked-content.mjs`],
    [`${W}/routes/(user)/locked/[[photos=photos]]/[[assetId=id]]/+page.svelte`],
  ],
  "/maintenance": [
    "fixed",
    ["MS-1", "M-1", "M-2", "M-3", "M-4", "M-5", "M-6"],
    "Maintenance splash (fixed by FL-80)",
    [`${P}/AuthScreens.jsx`, `${P}/system-data.mjs`],
    [`${W}/routes/maintenance/+page.svelte`],
  ],
  "/map/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["MV-1", "MV-2", "MV-3", "MV-4", "MV-5", "MV-6", "MV-7", "MV-8"],
    "Map settings sheet with counts, cluster zoom, chips, empty, offline and disabled states, list rows and hover card (fixed, FL-51)",
    [`${P}/MapView.jsx`, `${P}/discovery-data.mjs`],
    [`${W}/routes/(user)/map/[[photos=photos]]/[[assetId=id]]/+page.svelte`],
  ],
  "/memories": [
    "fixed",
    ["MI-1", "MI-2", "MI-3", "MI-4", "MI-5", "MI-6", "MI-7"],
    "Today/Upcoming/Earlier from the local date, badges, quiet card, Hide memory with Hidden memories, show-less, Memory settings (fixed, FL-62)",
    [`${P}/Memories.jsx`, `${P}/discovery-data.mjs`],
    [
      `${W}/routes/(user)/memories/+page.svelte`,
      `${W}/lib/components/frameleaf/MemoriesPanel.svelte`,
    ],
  ],
  "/memories/[id]/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    [
      "MPY-1",
      "MPY-2",
      "MPY-3",
      "MPY-4",
      "MPY-5",
      "MPY-6",
      "MPY-7",
      "MPY-8",
      "MPY-9",
      "MPY-10",
    ],
    "Header and segment labels, Show all items (G), Space/M/G/Home/End, soundtrack, Open item, people, rename/reorder/favorite, Make a movie opens Studio (fixed, FL-62)",
    [`${P}/MemoryPlayer.jsx`],
    [
      `${W}/routes/(user)/memories/[id]/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
      `${W}/lib/components/frameleaf/MemoryPlayerPanel.svelte`,
    ],
  ],
  "/memory/[[photos=photos]]/[[assetId=id]]": [
    "retained-live-route",
    [],
    "Redirect to /memories",
    [`${P}/Memories.jsx`],
    [`${W}/routes/(user)/memory/[[photos=photos]]/[[assetId=id]]/+page.ts`],
  ],
  "/partners/[userId]/[[photos=photos]]/[[assetId=id]]": [
    "partial",
    ["AL-39", "AL-40", "AL-41"],
    "Partner header copy (the legacy bar is removed, AL-41)",
    [`${P}/PartnerLibrary.jsx`],
    [
      `${W}/routes/(user)/partners/[userId]/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
      `${W}/lib/components/frameleaf/PartnerLibraryHeader.svelte`,
    ],
  ],
  "/people": [
    "fixed",
    [
      "PG-1",
      "PG-2",
      "PG-3",
      "PG-4",
      "PG-5",
      "PG-6",
      "PG-7",
      "PG-8",
      "PG-9",
      "PN-1",
      "PN-2",
      "PN-3",
    ],
    "People grid: sort, Find a person, counts (GET /people assetCount/lastSeenAt), labels, summary, empty/status copy, combobox name editor and Frameleaf merge/birthday dialogs (PN-1/PN-2 by fix-discovery; the rest on codex/FL-37-people-faces)",
    [`${P}/People.jsx`, `${P}/people-data.mjs`],
    [
      `${W}/routes/(user)/people/+page.svelte`,
      `${W}/lib/components/frameleaf/people/PersonCard.svelte`,
      `${W}/lib/components/frameleaf/people/MergePeopleDialog.svelte`,
    ],
  ],
  "/people/[personId]/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["PD-1", "PD-2", "PD-3", "PD-4", "PD-5", "PD-6", "PD-7", "PD-8", "PD-9"],
    "Person hero toolbar, facts line, name editor, Fix incorrect match panel and Frameleaf featured/merge/birthday dialogs (codex/FL-37-people-faces); Fix incorrect match splits selected faces into an existing or new person with revision-checked corrections, and PD-9 Correction history is FL-57's paginated history with Undo (the story requires it; FL-146 defaults accepted 2026-09-25)",
    [`${P}/PersonDetail.jsx`, `${P}/People.jsx`],
    [
      `${W}/routes/(user)/people/[personId]/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
      `${W}/lib/components/frameleaf/people/PersonHero.svelte`,
      `${W}/lib/components/frameleaf/people/FixMatchPanel.svelte`,
      `${W}/lib/components/frameleaf/people/CorrectionHistoryPanel.svelte`,
    ],
  ],
  "/people/manage": [
    "fixed",
    ["MP-1", "MP-2", "MP-3", "MP-4", "MP-5", "MP-6"],
    "Batch labels, pending footer, Discard changes? guard, back button, empty and status copy (fixed on claude/frameleaf-implementation by the people visibility recovery); MP-6 card aria (name, state, unsaved change) verified present",
    [`${P}/ManagePeople.jsx`],
    [`${W}/routes/(user)/people/manage/+page.svelte`],
  ],
  "/pets": [
    "intentional-product-change",
    [],
    "FL-58 pets beyond the prototype's tag query: durable named cat/dog profiles, checksum-guarded review with Undo, CLIP-based recognition on the routed destination (this server, a computer on the network or Frameleaf Cloud) with actionable refusals; composed from the People grid and grouped-list patterns",
    [`${P}/App.jsx`],
    [`${W}/routes/(user)/pets/+page.svelte`],
  ],
  "/pets/[petId=id]/[[photos=photos]]/[[assetId=id]]": [
    "intentional-product-change",
    [],
    "FL-58 pet page (beyond the prototype): the pet's confirmed photos through the petIds search filter, and its decisions with stale regions to check",
    [`${P}/App.jsx`],
    [
      `${W}/routes/(user)/pets/[petId=id]/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
    ],
  ],
  "/photos/[[assetId=id]]": [
    "fixed",
    [
      "T-3",
      "T-4",
      "T-5",
      "T-6",
      "T-7",
      "T-8",
      "T-10",
      "T-14",
      "T-15",
      "S-15",
      "S-16",
      "S-17",
      "S-19",
    ],
    "Timeline, toolbar and bottom bar conformance (FL-30/FL-33 shell completion)",
    [`${P}/TimelineLibrary.jsx`, `${P}/App.jsx`, `${P}/AssetTile.jsx`],
    [
      `${W}/routes/(user)/photos/[[assetId=id]]/+page.svelte`,
      `${W}/lib/components/frameleaf/LibraryView.svelte`,
    ],
  ],
  "/places": [
    "fixed",
    ["PL-1", "PL-2", "PL-3", "PL-4", "PL-5", "PL-6", "PL-7", "PL-8"],
    "Frameleaf Places panel: summary, counts, grouping, state map, search and empty states (fixed, FL-51)",
    [`${P}/Places.jsx`, `${P}/discovery-data.mjs`],
    [`${W}/routes/(user)/places/+page.svelte`],
  ],
  "/recently-added/[[assetId=id]]": [
    "fixed",
    ["T-10", "S-10"],
    "Frameleaf empty state (T-10, FL-33 library gaps; S-10 fixed)",
    [`${P}/TimelineLibrary.jsx`],
    [`${W}/routes/(user)/recently-added/[[assetId=id]]/+page.svelte`],
  ],
  "/recently-added/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["T-10", "S-10"],
    "Frameleaf empty state (T-10, FL-33 library gaps; S-10 fixed)",
    [`${P}/TimelineLibrary.jsx`],
    [
      `${W}/routes/(user)/recently-added/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
    ],
  ],
  "/s/[slug]/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["AL-34", "AL-35", "AL-36", "AL-37", "AL-38"],
    "Public viewer states, title line and footer; slideshow not gated on downloads (fixed, FL-56)",
    [`${P}/PublicViewer.jsx`],
    [
      `${W}/routes/(user)/s/[slug]/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
      `${W}/lib/components/pages/SharedLinkPage.svelte`,
    ],
  ],
  "/search/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["SD-12"],
    "Search palette (SD-1..SD-11, FP-1..FP-5) and the results page's palette-style chips (SD-12) fixed on codex/FL-49-search-palette",
    [
      `${P}/SearchPalette.jsx`,
      `${P}/search-palette.mjs`,
      `${P}/FilterPanel.jsx`,
      `${P}/search.mjs`,
    ],
    [
      `${W}/routes/(user)/search/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
      `${W}/lib/components/frameleaf/SearchPalette.svelte`,
    ],
  ],
  "/share/[key]/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["AL-34", "AL-35", "AL-36", "AL-37", "AL-38"],
    "Public viewer states, title line and footer; slideshow not gated on downloads (fixed, FL-56)",
    [`${P}/PublicViewer.jsx`],
    [
      `${W}/routes/(user)/share/[key]/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
      `${W}/lib/components/pages/SharedLinkPage.svelte`,
    ],
  ],
  "/shared-links": [
    "partial",
    [
      "AL-19",
      "AL-20",
      "AL-21",
      "AL-22",
      "AL-23",
      "AL-24",
      "AL-25",
      "AL-26",
      "AL-27",
      "AL-28",
      "AL-29",
    ],
    "Shared links form preview/slug availability (AL-25, AL-26); AL-19..AL-24, AL-27..AL-29 fixed",
    [
      `${P}/SharedLinks.jsx`,
      `${P}/SharedLinkForm.jsx`,
      `${P}/shared-links-data.mjs`,
    ],
    [
      `${W}/routes/(user)/shared-links/(list)/+layout.svelte`,
      `${W}/lib/components/frameleaf/SharedLinkList.svelte`,
    ],
  ],
  "/shared-links/[id]/edit": [
    "retained-live-route",
    ["AL-23"],
    "Redirect to the list's Frameleaf edit form (/shared-links?edit={id})",
    [`${P}/SharedLinkForm.jsx`],
    [`${W}/routes/(user)/shared-links/(list)/[id]/edit/+page.ts`],
  ],
  "/sharing": [
    "fixed",
    ["AL-45", "AL-2", "AL-3", "AL-5"],
    "Workspace menu through Frameleaf dialogs (fixed on codex/FL-52-albums-sharing)",
    [`${P}/Collections.jsx`, `${P}/CollectionHeader.jsx`],
    [
      `${W}/routes/(user)/sharing/+page.svelte`,
      `${W}/lib/components/frameleaf/SharedSpacesWorkspace.svelte`,
    ],
  ],
  "/sharing/[spaceId=id]/[[photos=photos]]/[[assetId=id]]": [
    "partial",
    ["AL-42", "AL-43", "AL-44"],
    "Space header controls (AL-42); confirmations and role labels fixed on codex/FL-52-albums-sharing",
    [`${P}/CollectionHeader.jsx`],
    [
      `${W}/routes/(user)/sharing/[spaceId=id]/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
      `${W}/lib/components/frameleaf/SharedSpaceDetail.svelte`,
    ],
  ],
  "/sharing/sharedlinks": [
    "retained-live-route",
    [],
    "Redirect to /shared-links",
    [`${P}/SharedLinks.jsx`],
    [`${W}/routes/(user)/sharing/sharedlinks/+page.ts`],
  ],
  "/studio": [
    "studio-parked",
    ["ST-1", "ST-2", "ST-3", "ST-4", "ST-5", "ST-6"],
    "The header is done (ST-2…ST-7, FL-88: rename, Library back, review count, Basic/Advanced, avatar, export dialog; the workspace layout is stored per account, FL-91). The workspace itself waits on the parked engine (ST-1)",
    [`${P}/Studio.jsx`, `${P}/studio-project.mjs`],
    [
      `${W}/routes/(user)/studio/+page.svelte`,
      `${W}/lib/components/frameleaf/StudioHost.svelte`,
    ],
  ],
  "/studio/projects": [
    "studio-parked",
    [],
    "Project library is beyond the prototype",
    [`${P}/Studio.jsx`],
    [`${W}/routes/(user)/studio/projects/+page.svelte`],
  ],
  "/suppressed/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["S-6", "S-7"],
    "Locked destination behind the in-place unlock (fixed on claude/frameleaf-implementation by FL-80)",
    [`${P}/LockedContent.jsx`],
    [
      `${W}/routes/(user)/suppressed/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
    ],
  ],
  "/suppressed/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["S-6", "S-7"],
    "Locked album view behind the in-place unlock",
    [`${P}/LockedContent.jsx`, `${P}/CollectionHeader.jsx`],
    [
      `${W}/routes/(user)/suppressed/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
    ],
  ],
  "/tags/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    [
      "TG-1",
      "TG-2",
      "TG-3",
      "TG-4",
      "TG-5",
      "TG-6",
      "TG-7",
      "TG-8",
      "TG-9",
      "TG-10",
      "TG-11",
      "TG-12",
    ],
    "Tags browser ported from Tags.jsx (fixed on codex/FL-46-complete-browsers)",
    [`${P}/Tags.jsx`, `${P}/discovery-data.mjs`],
    [
      `${W}/routes/(user)/tags/[[photos=photos]]/[[assetId=id]]/+page.svelte`,
      `${W}/lib/components/frameleaf/TagBrowserPanel.svelte`,
    ],
  ],
  "/takeout": [
    "in-flight",
    [],
    "FL-65 Takeout import (beyond the prototype's utilities directory)",
    [`${P}/UtilitiesManager.jsx`],
    [`${W}/routes/(user)/takeout/+page.svelte`],
  ],
  "/trash/[[photos=photos]]/[[assetId=id]]": [
    "match",
    [],
    undefined,
    [`${P}/TrashManager.jsx`, `${P}/trash-data.mjs`],
    [
      `${W}/routes/(user)/trash/[[photos=photos]]/[[assetId=id]]/+page.ts`,
      `${W}/routes/(user)/user-settings/sections/TrashSection.svelte`,
      `${W}/lib/components/frameleaf/TrashManager.svelte`,
    ],
  ],
  "/user-settings": [
    "fixed",
    ["CC-49", "AL-46", "US-2"],
    "Personal preferences inside the command center; App settings controls, confirmations and People & sharing fixed by FL-67/FL-71 (CC-50..CC-54, AL-46); server key product name fixed (US-2)",
    [
      `${P}/AccountPreferences.jsx`,
      `${P}/AccountsLibraries.jsx`,
      `${P}/SharingAccess.jsx`,
    ],
    [`${W}/routes/(user)/user-settings/+page.svelte`],
  ],
  "/utilities": [
    "match",
    ["UT-12"],
    "UT-12 obsolete: the September 24 prototype has no hub cards, utilities are Command Center directory rows. PL-0, UT-1 and UT-1a are fixed on claude/frameleaf-implementation: utilities are the Command Center utilities area and application setup is a utility",
    [`${P}/UtilitiesManager.jsx`, `${P}/utilities-data.mjs`],
    [
      `${W}/routes/(user)/utilities/+page.ts`,
      `${W}/lib/components/frameleaf/settings/UtilitiesArea.svelte`,
    ],
  ],
  "/utilities/corrupt-media": [
    "fixed",
    ["UT-2"],
    "Undo on the notice through the reopen endpoint (FL-69)",
    [`${P}/UtilitiesManager.jsx`, `${P}/UtilityRecovery.jsx`],
    [
      `${W}/routes/(user)/utilities/corrupt-media/+page.ts`,
      `${W}/lib/components/frameleaf/LibraryCareHealth.svelte`,
    ],
  ],
  "/utilities/downloads": [
    "fixed",
    ["UT-1", "UT-1a"],
    "Mobile applications setup is a Command Center utility (fixed on claude/frameleaf-implementation)",
    [`${P}/UtilitiesManager.jsx`, `${P}/utilities-data.mjs`],
    [
      `${W}/routes/(user)/utilities/downloads/+page.ts`,
      `${W}/lib/components/frameleaf/ApplicationSetup.svelte`,
    ],
  ],
  "/utilities/duplicates/[[photos=photos]]/[[assetId=id]]": [
    "match",
    [],
    undefined,
    [`${P}/DuplicateReview.jsx`, `${P}/duplicate-review.mjs`],
    [
      `${W}/routes/(user)/utilities/duplicates/[[photos=photos]]/[[assetId=id]]/+page.ts`,
      `${W}/lib/components/frameleaf/DuplicateUtility.svelte`,
      `${W}/lib/components/frameleaf/DuplicateReview.svelte`,
    ],
  ],
  "/utilities/geolocation": [
    "partial",
    ["GL-1", "UT-10", "UT-17", "UT-18", "UT-19", "UT-5"],
    "Location editor conformance",
    [`${P}/UtilitiesManager.jsx`, `${P}/UtilityMapPicker.jsx`],
    [
      `${W}/routes/(user)/utilities/geolocation/+page.ts`,
      `${W}/lib/components/frameleaf/GeolocationUtility.svelte`,
    ],
  ],
  "/utilities/geolocation/photos/[photoId]": [
    "retained-live-route",
    [],
    "Viewer deep link inside the location editor",
    [`${P}/UtilitiesManager.jsx`],
    [`${W}/routes/(user)/utilities/geolocation/photos/[photoId]/+page.ts`],
  ],
  "/utilities/icloud-sync": [
    "fixed",
    ["UT-11"],
    "Recent utility activity on every tool (FL-69)",
    [`${P}/UtilitiesManager.jsx`, `${P}/utilities-data.mjs`],
    [
      `${W}/routes/(user)/utilities/icloud-sync/+page.ts`,
      `${W}/lib/components/frameleaf/ICloudSyncPanel.svelte`,
    ],
  ],
  "/utilities/large-files/[[photos=photos]]/[[assetId=id]]": [
    "fixed",
    ["UT-11", "UT-15", "UT-16"],
    "Recent utility activity, row type and resolution, title (fixed on codex/FL-35-complete-viewer, FL-47)",
    [`${P}/UtilitiesManager.jsx`],
    [
      `${W}/routes/(user)/utilities/large-files/[[photos=photos]]/[[assetId=id]]/+page.ts`,
      `${W}/lib/components/frameleaf/LargeFilesUtility.svelte`,
      `${W}/lib/components/frameleaf/LargeFilesReview.svelte`,
    ],
  ],
  "/utilities/live-photos": [
    "partial",
    ["LP-1", "UT-3", "UT-4", "UT-5", "UT-6", "UT-7", "UT-8", "UT-9"],
    "Live Photo pairing labels, states, scope, notice",
    [`${P}/UtilitiesManager.jsx`],
    [
      `${W}/routes/(user)/utilities/live-photos/+page.ts`,
      `${W}/lib/components/frameleaf/LivePhotosUtility.svelte`,
    ],
  ],
  "/utilities/missing-media": [
    "fixed",
    ["UT-2"],
    "Undo on the notice through the reopen endpoint (FL-69)",
    [`${P}/UtilitiesManager.jsx`, `${P}/UtilityRecovery.jsx`],
    [
      `${W}/routes/(user)/utilities/missing-media/+page.ts`,
      `${W}/lib/components/frameleaf/LibraryCareHealth.svelte`,
    ],
  ],
  "/utilities/obtainium": [
    "fixed",
    ["UT-1", "UT-1a"],
    "Obtainium setup is a Command Center utility (fixed on claude/frameleaf-implementation)",
    [`${P}/UtilitiesManager.jsx`, `${P}/utilities-data.mjs`],
    [
      `${W}/routes/(user)/utilities/obtainium/+page.ts`,
      `${W}/lib/components/frameleaf/ApplicationSetup.svelte`,
    ],
  ],
  "/workflows": [
    "in-flight",
    [],
    "FL-82 workflows and plugins",
    [`${P}/WorkflowDesigner.jsx`, `${P}/workflow-schema.mjs`],
    [
      `${W}/routes/(user)/workflows/+page.ts`,
      `${W}/lib/components/frameleaf/WorkflowsPanel.svelte`,
    ],
  ],
  "/workflows/[workflowId]": [
    "in-flight",
    [],
    "FL-82 workflows and plugins",
    [`${P}/WorkflowDesigner.jsx`],
    [
      `${W}/routes/(user)/workflows/[workflowId]/+page.ts`,
      `${W}/lib/components/frameleaf/WorkflowDesigner.svelte`,
    ],
  ],
};

export async function buildEvidence(repository = root) {
  const ledger = JSON.parse(
    await readFile(
      resolve(
        repository,
        "docs/docs/developer/frameleaf-plan/action-preservation-ledger.json",
      ),
      "utf8",
    ),
  );
  const inventory = JSON.parse(
    await readFile(
      resolve(repository, "docs/docs/developer/frameleaf-route-inventory.json"),
      "utf8",
    ),
  );
  const actionRows = ledger.requirements
    .filter((row) => row.kinds.includes("web-action"))
    .map((row) => {
      const [, section, suffix] = row.requirementId.match(
        /^action:([^:]+):(.+)$/,
      );
      const entry = actions[suffix];
      if (!entry)
        throw new Error(`No conformance row for ${row.requirementId}`);
      const [status, gaps, followUp, overrides = {}] = entry;
      return {
        requirementId: row.requirementId,
        title: row.title,
        prototype: overrides.prototype ?? sectionDefaults[section].prototype,
        production: overrides.production ?? sectionDefaults[section].production,
        status,
        gaps,
        followUp: followUp ?? null,
      };
    });
  const routeRows = inventory.productionRoutes.map((route) => {
    const entry = routes[route];
    if (!entry) throw new Error(`No conformance row for route ${route}`);
    const [status, gaps, followUp, prototype, production] = entry;
    return {
      route,
      prototype,
      production,
      status,
      gaps,
      followUp: followUp ?? null,
    };
  });
  return {
    schemaVersion: 1,
    status: "audited-implementation-not-qualified",
    scope:
      "FL-83 prototype conformance: for every web action in the preservation ledger and every committed route, the September 22, 2026 prototype module that designs it, the production counterpart and the audited conformance status. A row never establishes qualification; Studio, native and GPU work carry their own gates.",
    auditDocument: auditDocPath,
    auditedIntegrationHead: "f603a8f1c7",
    reconciledIntegrationHead: "ad0616322d",
    statusVocabulary: STATUS_VOCABULARY,
    counts: {
      webActions: actionRows.length,
      routes: routeRows.length,
      byStatus: Object.fromEntries(
        STATUS_VOCABULARY.map((status) => [
          status,
          [...actionRows, ...routeRows].filter((row) => row.status === status)
            .length,
        ]),
      ),
    },
    webActions: actionRows,
    routes: routeRows,
  };
}

// Prettier is loaded only when writing the file: the drift test in CI imports buildEvidence from an
// install (`--filter @immich/scripts --filter immich`) that does not include it.
const formatJson = async (value) => {
  const { format, resolveConfig } = await import("prettier");
  const config = (await resolveConfig(evidencePath)) ?? {};
  return format(JSON.stringify(value), { ...config, filepath: evidencePath });
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const evidence = await buildEvidence();
  await writeFile(evidencePath, await formatJson(evidence));
  console.log(
    `wrote ${evidencePath}: ${evidence.counts.webActions} actions, ${evidence.counts.routes} routes`,
  );
}
