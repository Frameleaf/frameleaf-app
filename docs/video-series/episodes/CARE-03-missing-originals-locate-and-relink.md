# CARE-03 · Missing originals: locate and relink

| Field | Value |
| --- | --- |
| Series | Library Care |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators whose originals moved or were renamed on disk |
| Features demonstrated | Missing media (Missing originals queue), Inspect evidence with recorded checksum, Locate originals, Search locations (Library storage, external libraries, recovery locations), Search selected locations, candidate checksum and decode evidence, Save candidate choices, Relink verified matches with the fixed review, relink provenance, recovery roots (FRAMELEAF_RECOVERY_ROOTS) |
| Source docs | docs/docs/features/library-care.md, docs/docs/guides/media-recovery.md |
| Capture checklist | Dark theme, Taylor (administrator) on frameleaf.home. Recovery locations configured as `Verified backup=/mnt/backup/photos;/mnt/photos/recovered`; an external library named "Family archive". Seed three missing originals from the last health scan: `Ridge trail.ARW` (its bytes copied, renamed to `DSC04512.ARW`, into `/mnt/backup/photos/2026/08/`), `Glacier creek.HEIC` (exact copies both in library storage under another folder and in the backup), and Jamie's `Cabin life.jpg` (no copy anywhere). Plus a look-alike `Ridge trail copy.jpg` in Family archive with different bytes. Settings → Library care visible with Repair queues. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:17 | LOWER-THIRD "Missing originals: locate and relink · Library Care". SCREEN: Settings → Library care, Repair queues. HIGHLIGHT "Missing originals" ("Find moved files and verify their identity"), CURSOR clicks. Utilities → Missing media opens: heading "Missing media", subtitle "Locate moved originals, inspect candidate files and restore their links.", scan bar "3 findings · Last scan · 02:14, 19 September". | Library care → Missing originals → Missing media | "When a drive moves or a folder is renamed, Frameleaf can lose track of an original. Missing media finds it again. Open Library Care, then Missing originals. It is an administrator tool." |
| 3 | 0:17–0:31 | CARD "Check storage first": bullets "Is the drive or share mounted?", "Can the server still read it?", "Many at once? Fix access before relinking". | Check storage first | "A missing file is not proof that anything was deleted. If many photos go missing at once, check that the storage is mounted and readable first. Restoring access may be all you need." |
| 4 | 0:31–0:45 | SCREEN: table with columns Original, Account, Finding, Review. Rows `Ridge trail.ARW` (Taylor, "Missing"), `Glacier creek.HEIC` (Taylor, "Missing"), `Cabin life.jpg` (Jamie, "Missing"). CURSOR clicks "Inspect" on Ridge trail: dialog shows Status "Missing", Original path, Evidence "The original path could not be opened. The thumbnail may still be available.", Checked, "Recorded SHA1" with the value. ZOOM on the checksum. CURSOR clicks "Done". | Inspect · Evidence · Recorded SHA1 | "Each finding shows the original, its account and its status. Inspect shows the evidence, the original path and the checksum recorded when the photo was added. That checksum is what proves a match." |
| 5 | 0:45–1:01 | CURSOR ticks Ridge trail and Glacier creek, clicks "Locate originals". Dialog "Choose candidate originals" with "Select configured locations, then review a candidate for each missing original. Similar names do not prove an exact match." ZOOM on "Search locations": "Library storage" (ticked), "Family archive" (ticked), "Verified backup" `/mnt/backup/photos` (unticked). CURSOR ticks Verified backup. | Locate originals · Search locations | "Select the findings and choose Locate originals. Pick where to look: library storage, your external libraries and, for administrators, the recovery locations your operator set up." |
| 6 | 1:01–1:15 | CURSOR clicks "Search selected locations"; the button reads "Searching…" with the hint "Searches run in the background and appear in Activity." Cut to the scan bar: notice "Search queued. Candidates appear here when it finishes.", "Searching for originals" with a teal progress fill, then "Last search · 10:42". | Search selected locations | "Search selected locations looks for exact copies by checksum, never by name. It runs in the background and shows in Activity, so you can close the page while it works." |
| 7 | 1:15–1:32 | Dialog again. Under "Ridge trail.ARW" two candidates: `/mnt/backup/photos/2026/08/DSC04512.ARW` with "Checksum: exact match · Decode: validated · 38.2 MB" (selectable), and `Family archive/Ridge trail copy.jpg` with "Checksum: different · Decode: validated" (greyed out). CALLOUT on the first "Renamed, same bytes"; CALLOUT on the second "Similar name, different file". | Checksum: exact match · Decode: validated | "Each candidate shows where it was found, whether its checksum is an exact match and whether it decodes. A renamed file with the same bytes matches. A look-alike with a different checksum cannot be chosen." |
| 8 | 1:32–1:44 | Under "Glacier creek.HEIC" two exact candidates, one in "Library storage", one in "Verified backup". CURSOR picks the library storage copy, clicks "Save candidate choices". Notice "Candidate search choices saved. Review exact matches before relinking." Both rows now show the badge "Found" and "Verified copy ready to relink". | Save candidate choices · Verified copy ready to relink | "When a copy turns up in more than one place, choose one, then Save candidate choices. Each row now reads Verified copy ready to relink." |
| 9 | 1:44–2:00 | CURSOR clicks "Relink verified matches". Dialog "Relink originals": "The selected items below are fixed for this operation. Changing a filter later will not add more items.", two rows with their candidate paths, policy "Original files and ownership are retained." CURSOR clicks "Confirm 2 items". Notice "2 items queued for relinking."; each thumbnail shows the "Processing" loader, then the badge "Relinked". | Relink verified matches · Confirm 2 items | "Choose Relink verified matches. The review lists exactly what will change, fixed for this operation. Confirm, and each row shows a small loader until its relink is done." |
| 10 | 2:00–2:16 | DIAGRAM: node "Copy in library storage or the photo's own external library" → "Linked where it is" (green path). Node "Copy in a recovery location" → "Copied into library storage" (teal data arrow); a lock icon on the recovery node labelled "Read only". | Linked where it is · Copied into library storage · Recovery locations: read only | "A copy in library storage, or in the photo's own external library, is linked where it is. A copy in a recovery location is copied into library storage first. Recovery locations are only ever read." |
| 11 | 2:16–2:31 | TERMINAL: the server `.env` with the line `FRAMELEAF_RECOVERY_ROOTS=Verified backup=/mnt/backup/photos;/mnt/photos/recovered` typed, then a Compose volume line `- /mnt/backup/photos:/mnt/backup/photos:ro`. CALLOUT "Name=path, separated by semicolons"; CALLOUT on `:ro` "Mount read-only". | FRAMELEAF_RECOVERY_ROOTS · Mount read-only | "Operators add recovery locations with one server setting, each with a readable name. Mount them read-only if you can. A candidate reached through a link that leads outside its location is refused." |
| 12 | 2:31–2:42 | SCREEN: Show set to "All results"; CURSOR clicks "Inspect" on Ridge trail: "Relinked · Taylor · Verified backup · 10:44", "Previous path", "Copy used". CURSOR opens the photo from the timeline; it loads at full size. | Relinked · Previous path · Copy used | "Inspect a relinked item to see who relinked it, from where, and its previous path. Then open the photo to check it." |
| 13 | 2:42–2:45 | LOGO OUTRO | Next: CARE-04 · Damaged media and RAW | "Next up: Damaged media and RAW." |

## Voice-over (clean)

When a drive moves or a folder is renamed, Frameleaf can lose track of an original. Missing media finds it again. Open Library Care, then Missing originals. It is an administrator tool.

A missing file is not proof that anything was deleted. If many photos go missing at once, check that the storage is mounted and readable first. Restoring access may be all you need.

Each finding shows the original, its account and its status. Inspect shows the evidence, the original path and the checksum recorded when the photo was added. That checksum is what proves a match.

Select the findings and choose Locate originals. Pick where to look: library storage, your external libraries and, for administrators, the recovery locations your operator set up.

Search selected locations looks for exact copies by checksum, never by name. It runs in the background and shows in Activity, so you can close the page while it works.

Each candidate shows where it was found, whether its checksum is an exact match and whether it decodes. A renamed file with the same bytes matches. A look-alike with a different checksum cannot be chosen.

When a copy turns up in more than one place, choose one, then Save candidate choices. Each row now reads Verified copy ready to relink.

Choose Relink verified matches. The review lists exactly what will change, fixed for this operation. Confirm, and each row shows a small loader until its relink is done.

A copy in library storage, or in the photo's own external library, is linked where it is. A copy in a recovery location is copied into library storage first. Recovery locations are only ever read.

[pause]

Operators add recovery locations with one server setting, each with a readable name. Mount them read-only if you can. A candidate reached through a link that leads outside its location is refused.

Inspect a relinked item to see who relinked it, from where, and its previous path. Then open the photo to check it.

[pause]

Next up: Damaged media and RAW.

## Production notes

- Prerequisites: Taylor must be an administrator; Missing media and Damaged media are administrator tools (library-care.md). A health scan (Scan again) must have run so the findings exist. For a non-admin capture the Library care repair list omits Missing originals.
- Docs vs interface: media-recovery.md still names "Utilities → Review missing media" and a "Locate" action; the current labels are "Missing media" and "Locate originals". library-care.md says the sidebar entry opens Utilities; it now opens the Library care settings area, whose Repair queues list "Missing originals". Flag both guides for an update.
- Labels verified in the build: "Locate originals", "Choose candidate originals", "Search locations", "Library storage", "Search selected locations", "Searching…", "Searches run in the background and appear in Activity.", "Checksum: exact match" / "Checksum: different", "Decode: validated" / "Decode: not validated", "Save candidate choices", "Candidate search choices saved. Review exact matches before relinking.", "Verified copy ready to relink" (or "{n} candidates" when a choice is still needed), status "Found", "Relink verified matches", dialog "Relink originals", "Confirm {n} items", "{n} items queued for relinking.", status "Relinked", inspect labels "Relinked", "Previous path", "Copy used".
- Default search locations: Library storage and external libraries are ticked when locating; recovery locations must be ticked by hand. Only candidates with an exact checksum the server verified can be chosen. "Relink verified matches" stays disabled until every selected row has one verified copy (chosen, or the only one).
- Recovery locations (library-care.md): configured by the operator with `FRAMELEAF_RECOVERY_ROOTS`, for example `Verified backup=/mnt/backup/photos;/mnt/photos/recovered`; the name before `=` is what Search locations shows. "Mount them read-only if you can." The `:ro` Compose line in beat 11 is an illustration of that advice, not a documented file. A candidate must still be a regular file inside its location when it is recovered; a link leading outside is refused.
- media-recovery.md: the search covers configured locations with bounded scans, never every disk. If Locate finds nothing, the file may be outside that scope or no trustworthy content checksum was saved. Matching names, similar thumbnails or equal video durations never authorize a relink.
- A relink cannot be undone from the page (the old path is not put back), so no Undo appears after it. Relinks run as background jobs with pause, cancel and one automatic retry; a failed relink is tried again from Library Care, not from Activity, so its review is checked again.
- The toolbar's "Account" picker (explained in CARE-01) lets an administrator review one other account or "All accounts"; Jamie's row appears because the capture uses All accounts. Cabin life stays "Missing" with no candidates ("No candidates in the selected locations yet. Search them to look for exact copies.").
- Paths, times and sizes are sample data; never show real server mount paths beyond the sample ones.
