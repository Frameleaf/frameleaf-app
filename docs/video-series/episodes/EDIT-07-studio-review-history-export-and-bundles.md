# EDIT-07 · Studio: review, history, export and bundles

| Field | Value |
| --- | --- |
| Series | Editing and Studio |
| Type | How-to |
| Target length | 2:45 |
| Audience | People finishing a Studio film who want feedback, a safety net, a finished file, or to move the project to another server |
| Features demonstrated | Review button and drawer, review comments pinned to a moment (Add comment, Resolve, Reopen, Review only for space members), History (Version list, Current, Restore, Restored from version, Show more), Export dialog (Format, Colour, Resolution, Render on, refusal reasons, Activity), Export bundle (Include copies of my photos and videos, Download bundle), Import bundle (Project name, Already here, Matched, Missing, Use my matching item, Import) |
| Source docs | studio/README.md, i18n/en.json (frameleaf_studio_*), web/src/lib/components/frameleaf (StudioHost, StudioHistoryPanel, StudioExportDialog, StudioBundleExportDialog, StudioProjectLibrary), design/frameleaf/template/src/Studio.jsx |
| Capture checklist | HOLD. Taylor signed in, dark theme, on frameleaf.home. Studio chrome, the History and Review drawer, the Export dialog and the bundle dialogs from a build of the integration branch against a mock network (one mocked qualified render worker, a saved project "Summer in the Rockies" at Version 14 with 20+ versions, one open comment from Jamie); the timeline behind them from the design prototype. Label "Preview" in every UI beat. The project belongs to the shared space "Family", where Jamie is a member. A second server "old-server" with Studio projects and some of the same photos, for the import beats. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD; SCREEN: Studio editor on "Summer in the Rockies", header "All changes saved". HIGHLIGHT on "Review" with its count badge "1". Label "Preview" top right from here on. | Studio: review, history, export and bundles · Editing and Studio · Preview | "A film is rarely finished in one sitting. This episode covers feedback, going back to an earlier version, exporting the film, and moving a project to another server." |
| 3 | 0:14–0:27 | SCREEN: CURSOR clicks "Review"; a drawer opens titled "History" with the version list, and below it the "Review" section. ZOOM on Jamie's comment at 0:21, "Can we hold the lake shot a little longer before the dissolve?", with its "Resolve" button. | History · Review | "Choose Review in the header. A drawer opens with the project's history and its review comments. Each comment is pinned to an exact moment on the timeline." |
| 4 | 0:27–0:43 | SPLIT: left, Jamie's view of the same project with "Review only" in the header; right, Taylor's drawer. Taylor moves the playhead to 0:34, types "Swap in the kayak shot here" into "Note for this moment" and clicks "Add comment". CURSOR clicks "Resolve" on Jamie's comment; it shows "Resolved" and the button becomes "Reopen". | Review only · Add comment · Resolve · Reopen | "When a project belongs to a shared space, its members can open it as Review only and leave comments. Type a note for this moment and choose Add comment. Resolve a comment once it is handled, or Reopen it." |
| 5 | 0:43–0:58 | ZOOM on the History list: "Version 14 · Current · 3 changes", "Version 13 · 5 changes", "Version 12 · 2 changes", "Show more". CURSOR clicks "Restore" on Version 12; toast "Version 12 is now the current version."; a new top row "Version 15 · Current" reads "Restored from version 12". | History · Restore · Restored from version 12 | "History lists every saved version, newest first, with how many changes each one holds. Restore brings an earlier version back as a new one, so nothing after it is lost." |
| 6 | 0:58–1:08 | SCREEN: CURSOR clicks "Export" in the header; the dialog "Export Summer in the Rockies" opens with Format, Colour, Resolution and Render on. | Export Summer in the Rockies | "When the cut is right, choose Export. The dialog has four choices." |
| 7 | 1:08–1:24 | ZOOM: CURSOR opens Format: MP4 · H.265 Main10, MP4 · H.264, WebM · AV1, ProRes 422 HQ; chooses MP4 · H.264. Colour: Preserve source, HDR10, Dolby Vision (disabled), with the note "Dolby Vision needs a render worker qualified with the Dolby tools. Until one is, this server can't export it."; leaves Preserve source. Resolution: 2160p · 4K (original), 1440p, 1080p, 720p; leaves 2160p. | Format · Colour · Resolution | "Format offers MP4 in H.265 or H.264, WebM with AV1, and ProRes. Colour can preserve the source or make HDR10. Resolution runs from 4K down to 720p." |
| 8 | 1:24–1:40 | ZOOM on "Render on": This server, A computer on your network; note "Exports render on this server or another computer on your home network. Progress appears in Activity." CALLOUT on a disabled option with its reason, for example "No render worker has enough GPU memory for this resolution. Choose a smaller one." CURSOR clicks "Export"; toast "Export of Summer in the Rockies queued."; the header shows "1 queued · Open Activity". | Render on · 1 queued · Open Activity | "Render on picks this server or another computer on your home network, so exports stay on your own hardware. A choice no render worker can handle is disabled, with the reason. Choose Export, and follow it in Activity." |
| 9 | 1:40–1:56 | SCREEN: Studio projects; CURSOR clicks "Export bundle" on the Summer in the Rockies card. Dialog "Export project bundle": "A bundle holds "Summer in the Rockies" as it is now, with every version detail needed to open it again here or on another Frameleaf server." CURSOR ticks "Include copies of my photos and videos"; note "Only items you own are copied. Shared items are referenced, and Locked items are never included." CURSOR clicks "Export"; toast "Bundle queued. Follow it in Activity." | Export bundle · Include copies of my photos and videos | "To move a project, choose Export bundle, on its card or in the editor header. Tick Include copies of my photos and videos to carry your own files with it. Shared items are only referenced, and Locked items are never included." |
| 10 | 1:56–2:05 | SCREEN: the dialog updates: "4 copies included, 2 items referenced from your library." with "Open Activity" and "Download bundle". CURSOR clicks "Download bundle"; the file downloads. | Download bundle | "When the bundle is ready, the dialog says what it holds. Choose Download bundle." |
| 11 | 2:05–2:22 | SCREEN: Studio projects on "old-server". CURSOR clicks "Import bundle" and picks the file; the button reads "Checking bundle…". Dialog "Import project bundle": "Project name" field, summary "3 already here, 2 matched to your items, 1 missing", rows tagged Already here, Matched (with "Use my matching item" ticked) and Missing, and the note "The bundle becomes a new project. Nothing in your library is changed, and nothing you cannot open is used." CURSOR clicks "Import". | Import bundle · Already here · Matched · Missing | "On the other server, open Studio projects and choose Import bundle. Frameleaf checks the file and marks every source Already here, Matched or Missing. The bundle becomes a new project, and your library is not changed." |
| 12 | 2:22–2:31 | TITLE on the dark canvas: "Studio", with "Preview" beneath it in the muted colour. | Studio · Preview | "Studio needs a render worker, and render workers are not available yet, so these screens are a preview." |
| 13 | 2:31–2:42 | CARD headline "Finishing a film"; bullets one per clause: "Comments pinned to a moment" · "History you can restore from" · "Export on your own hardware, or a bundle". | Finishing a film | "Comments pinned to the moment, a history you can restore from, and exports on your own hardware or as a bundle for another server." |
| 14 | 2:42–2:45 | LOGO OUTRO | Next: MOBILE-01 · Backup settings | "Next up: Backup settings." |

## Voice-over (clean)

A film is rarely finished in one sitting. This episode covers feedback, going back to an earlier version, exporting the film, and moving a project to another server.

Choose Review in the header. A drawer opens with the project's history and its review comments. Each comment is pinned to an exact moment on the timeline.

When a project belongs to a shared space, its members can open it as Review only and leave comments. Type a note for this moment and choose Add comment. Resolve a comment once it is handled, or Reopen it.

[beat]

History lists every saved version, newest first, with how many changes each one holds. Restore brings an earlier version back as a new one, so nothing after it is lost.

[pause]

When the cut is right, choose Export. The dialog has four choices.

Format offers MP4 in H.265 or H.264, WebM with AV1, and ProRes. Colour can preserve the source or make HDR10. Resolution runs from 4K down to 720p.

Render on picks this server or another computer on your home network, so exports stay on your own hardware. A choice no render worker can handle is disabled, with the reason. Choose Export, and follow it in Activity.

[pause]

To move a project, choose Export bundle, on its card or in the editor header. Tick Include copies of my photos and videos to carry your own files with it. Shared items are only referenced, and Locked items are never included.

When the bundle is ready, the dialog says what it holds. Choose Download bundle.

On the other server, open Studio projects and choose Import bundle. Frameleaf checks the file and marks every source Already here, Matched or Missing. The bundle becomes a new project, and your library is not changed.

[pause]

Studio needs a render worker, and render workers are not available yet, so these screens are a preview.

Comments pinned to the moment, a history you can restore from, and exports on your own hardware or as a bundle for another server.

[pause]

Next up: Backup settings.

## Production notes

- HOLD. studio/README.md: this build supplies no engine adapter, deploys no rendering worker and qualifies no hardware, and the command bridge answers not-implemented until each story lands. The Review drawer, History, the Export dialog and the bundle dialogs are in the current build, so capture them from the build against a mock network (mocked render worker evidence, a seeded project and comments), with the prototype's timeline behind them. Every UI frame carries the on-screen label "Preview"; beat 12 is the one narration line that says so. Publish only after render workers ship.
- The prototype differs from the build here: it has a modal "Review" dialog ("Post at 0:21", "What should change here?") and no History panel, and its Export dialog names destinations "Home workstation" and "LAN worker" and adds frame-rate conversion. Use the build's labels: the header "Review" button opens a drawer titled "History" with a "Review" section (StudioHistoryPanel.svelte); Render on offers "This server" and "A computer on your network" (StudioExportDialog.svelte). Keep the prototype's frame-rate and interpolation options out of shot.
- Review: comments are pinned to exact timeline instants; owner and reviewers may comment without holding the edit lease; the author or the owner may resolve. Reviewer access comes from the project belonging to a shared space the viewer is a member of (server studio-project.service `findAccessible`). The control that assigns a project to a space was not found among the current UI strings; if the capture cannot show it, keep beat 4's split to Jamie's "Review only" header and do not narrate how the project was shared. Archived and trashed projects are hidden from reviewers.
- History: newest first, 20 at a time with "Show more"; each row "Version {n}", "Current", "{count} changes", and "Restored from version {n}" on a restore. Restore appends a new revision rather than rewinding, and needs this window to hold the edit lease. The toast is "Version {n} is now the current version."
- Export: formats MP4 · H.265 Main10, MP4 · H.264, WebM · AV1, ProRes 422 HQ; Colour Preserve source, HDR10, Dolby Vision; Resolution 2160p · 4K (original), 1440p, 1080p, 720p. Each choice is judged against what qualified render workers verified; unsupported choices are disabled and the refusal is named before submitting (for example "No qualified render worker is online for this destination."). Studio exports render only on this server or the home network, never on Frameleaf Cloud (StudioExportDialog.svelte). Only the project's owner can export, once saved and while this window is editing. The time, size and cost rows in the prototype are simulated and are not in the build; do not show them.
- Bundles: export and import run on the server itself (server utils/studio-bundle.ts `STUDIO_BUNDLE_DESTINATION` is local), but a saved project needs the editor, so bundles stay in this HOLD episode. Export needs a saved project ("Save the project before exporting it."). "Include copies of my photos and videos" copies owned items only; shared items are referenced; Locked items are never included. Import errors are specific, for example "This file is not a Frameleaf project bundle." Missing items with a copy in the bundle can be added to the library later.
- The second server is the sample library's "old-server"; show only its Studio projects page and the import dialog.
- No engine, vendor or model name is spoken. No date is promised.
