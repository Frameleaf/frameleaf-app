# CARE-06 · Large files and the location editor

| Field | Value |
| --- | --- |
| Series | Library Care |
| Type | How-to |
| Target length | 2:15 |
| Audience | Anyone tidying their own library: reclaiming space and fixing where photos were taken |
| Features demonstrated | Utilities Organize group, Large files (size-ordered list, in-view total, Account, Find items, Inspect, Move selected to trash with fixed review, Undo, Export file list, Recent utility activity, Owner access required), Location editor (Coordinate map, Latitude and Longitude, Use this location, Apply to selected, Change location review, Remove location, per-photo loaders) |
| Source docs | docs/docs/features/library-care.md, web utilities (LargeFilesReview.svelte, GeolocationUtility.svelte, UtilityHistory.svelte) |
| Capture checklist | Dark theme, Taylor signed in on frameleaf.home, trash turned on. Large files showing the sample videos and RAW files largest first (`Kayaking.mov` 2.1 GB, `Lake morning.mov` 1.6 GB, `Forest trail.mov` 1.2 GB, `Summit view.ARW` 61 MB…), plus one item Jamie shares with Taylor as a partner. Location editor with Moraine Lake located (51.3217, -116.1860), Lake reflection and Cabin life without a location, and Trailhead directions with a location to remove. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD "Large files and the location editor · Library Care". SCREEN: Settings → Utilities directory, group "Organize" with "Duplicate review", "Large files" ("Find the originals taking the most space before deciding what to keep.") and "Location editor" ("Copy a location or place selected photos at precise coordinates."). HIGHLIGHT each of the last two as named; CURSOR clicks Large files. | Utilities → Organize → Large files · Location editor | "Two Organize tools help you tidy your library by hand. Large files finds what takes the most space, and the Location editor fixes where photos were taken. Both are in Settings, under Utilities." |
| 3 | 0:16–0:31 | SCREEN: Large files. Table columns Original, Account, Size, Review; rows largest first. ZOOM on the stats line "4.9 GB in this view · Largest originals first · logical file sizes". HIGHLIGHT Account ("All accounts"), Find items, Show. CURSOR clicks "Inspect" on Kayaking.mov: Account, Original size, Status "In your library", Original path. "Done". | Largest originals first · in this view · Inspect | "Large files lists your originals, biggest first, with a running total of what is in view. Filter by account, search by filename, and use Inspect to see the size, status and original path." |
| 4 | 0:31–0:43 | CURSOR ticks Lake morning.mov and Forest trail.mov, clicks "Move selected to trash". Dialog "Move to trash": "The selected items below are fixed for this operation. Changing a filter later will not add more items.", two rows with sizes, "Copies you are discarding move to trash. Originals still owned or referenced by other accounts are retained." CURSOR clicks "Confirm 2 items". | Move selected to trash · Confirm 2 items | "Select what you no longer need and choose Move selected to trash. The review lists exactly those items and their sizes. Confirm to move them." |
| 5 | 0:43–0:54 | Notice "2 items moved to trash." with an "Undo" button. HIGHLIGHT Undo, CURSOR clicks: notice "Last change undone." and both rows return. | Undo | "A notice confirms the move, with Undo beside it if you change your mind. Space comes back only when the trash is emptied." |
| 6 | 0:54–1:07 | CURSOR expands "Recent utility activity": entries "Trash · 2 items · 2.8 GB" and "Restore · 2 items · 2.8 GB" with times; CURSOR opens "View items" to list the filenames and sizes. Then HIGHLIGHT "Export file list" in the toolbar. | Recent utility activity · View items · Export file list | "Recent utility activity keeps a record of each move and restore, with the files and sizes. Export file list saves the current list to review elsewhere." |
| 7 | 1:07–1:15 | ZOOM on Jamie's row: Account "Jamie" with "Owner access required"; its checkbox is disabled. | Owner access required | "Items that belong to someone else show Owner access required. Only the owner can move them." |
| 8 | 1:15–1:27 | SCREEN: Utilities → Location editor. Left panel "Coordinate map · WGS 84" with markers around Banff and Lake Louise; right, "Latitude" and "Longitude" fields. Below, a grid of photo cards with a checkbox, filename, and "Taylor · 51.3217, -116.1860" or "Taylor · No location", each with "Use this location". | Location editor · Coordinate map · No location | "The Location editor shows your photos, their coordinates and a map. A photo without a position says No location." |
| 9 | 1:27–1:43 | CURSOR clicks "Use this location" on Moraine Lake: Latitude 51.3217 and Longitude -116.1860 fill in. CURSOR ticks Lake reflection and Cabin life (both "No location"); the button reads "Apply to 2 selected", CURSOR clicks. Dialog "Change location": "Apply 51.3217, -116.186 to 2 selected photos?" CURSOR clicks "Apply (2)". Both cards show the "Processing" loader, then the coordinates. | Use this location · Apply to 2 selected · Change location | "To copy a place, choose Use this location on a photo that has one. Select the photos to fix, choose Apply to selected, check the coordinates in the review and apply." |
| 10 | 1:43–1:53 | CURSOR clicks the map on the shore of Lake Louise; a marker drops and Latitude 51.4254, Longitude -116.1773 fill in. Alternatively the caret types values into the fields. | Click the map · or type coordinates | "You can also click the map, or type a latitude and longitude, to place photos at a precise point." |
| 11 | 1:53–2:04 | CURSOR ticks Trailhead directions, clicks "Remove location from 1 selected". Dialog "Remove location": "Remove the location from 1 selected photos? Their coordinates and place names are cleared, here and in their metadata files." CURSOR clicks "Apply (1)"; the card now reads "No location". | Remove location | "Remove location clears the coordinates and place names of the selected photos, here and in their metadata files." |
| 12 | 2:04–2:12 | SCREEN: the Location editor footer; CURSOR expands "Recent utility activity" showing the location changes with their status and time. | Recent utility activity | "Each change runs in the background with a loader on the photo, and is listed in Recent utility activity." |
| 13 | 2:12–2:15 | LOGO OUTRO | Next: CARE-07 · Physical deduplication for family libraries | "Next up: Physical deduplication for family libraries." |

## Voice-over (clean)

Two Organize tools help you tidy your library by hand. Large files finds what takes the most space, and the Location editor fixes where photos were taken. Both are in Settings, under Utilities.

Large files lists your originals, biggest first, with a running total of what is in view. Filter by account, search by filename, and use Inspect to see the size, status and original path.

Select what you no longer need and choose Move selected to trash. The review lists exactly those items and their sizes. Confirm to move them.

A notice confirms the move, with Undo beside it if you change your mind. Space comes back only when the trash is emptied.

Recent utility activity keeps a record of each move and restore, with the files and sizes. Export file list saves the current list to review elsewhere.

Items that belong to someone else show Owner access required. Only the owner can move them.

[pause]

The Location editor shows your photos, their coordinates and a map. A photo without a position says No location.

To copy a place, choose Use this location on a photo that has one. Select the photos to fix, choose Apply to selected, check the coordinates in the review and apply.

You can also click the map, or type a latitude and longitude, to place photos at a precise point.

Remove location clears the coordinates and place names of the selected photos, here and in their metadata files.

Each change runs in the background with a loader on the photo, and is listed in Recent utility activity.

[pause]

Next up: Physical deduplication for family libraries.

## Production notes

- Source: library-care.md does not describe Large files or the Location editor; every label here comes from the web source (LargeFilesReview.svelte, GeolocationUtility.svelte, UtilityHistory.svelte and i18n/en.json), as the index's "see inventory" note asks. Flag library-care.md for a short section on both tools.
- Utilities groups verified: Organize (Duplicate review, Large files, Location editor), Repair, Import, Automate, Connect. Utilities is Settings → Utilities; the Library care area links only the repair tools.
- Large files strings: "{size} in this view", "Largest originals first · logical file sizes", "Move selected to trash", dialog "Move to trash", "Confirm {n} items", "{n} items moved to trash.", "Undo", "Last change undone.", "Export file list" (downloads `large-file-review.json`), "Recent utility activity", entries "Trash" and "Restore" with "View items". Undo refuses if any item changed since the move ("These items changed since the review. Review them again before continuing.").
- Status strings in Inspect: "In your library", "Shared with you", "In trash". A partner's item shows "Owner access required" and cannot be selected. When an item shares its original with other items (physical deduplication), the review adds "{n} items share their originals with other items, so {size} stays on disk even after the trash is emptied."
- With the trash turned off, "Move selected to trash" is disabled with "Trash is turned off, so items cannot be moved to it from here." Keep the trash on for capture.
- Location editor strings: "Coordinate map", "WGS 84", "Latitude", "Longitude", "Use this location", "Apply to {count} selected", "Remove location from {count} selected", dialogs "Change location" ("Apply {latitude}, {longitude} to {count} selected photos?") and "Remove location", button "Apply ({count})", "No location", "Load More". Only your own photos can be selected.
- Sample coordinates: Moraine Lake 51.3217, -116.1860; Lake Louise 51.4254, -116.1773. Sizes are sample data.
