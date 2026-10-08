# CARE-10 · Import Google Photos

| Field | Value |
| --- | --- |
| Series | Library Care |
| Type | How-to |
| Target length | 2:45 |
| Audience | Anyone bringing a Google Photos library into Frameleaf from a Google Takeout export |
| Features demonstrated | Google Photos & server imports (Preview import workflow), Import Google Photos wizard (Start an import, Stage with resumable uploads, Scan on the server, Reconcile tabs Review, Live Photos, Albums, Import options, Report), Import with checksum matching, Locked Folder into Locked, Report downloads (JSON, CSV), Delete import, server-folder source for administrators |
| Source docs | docs/docs/features/google-photos-import.md |
| Capture checklist | Dark theme, Taylor (administrator) on frameleaf.home. A small Google Takeout export of three ZIP files (`takeout-001.zip` to `takeout-003.zip`) made from sample photos: some new, some already in the library, two with disagreeing sidecars, two photo-and-video pairs sharing a name, a few year folders, and one Locked Folder photo. Settings → Import & protection with "Google Photos & server imports" in view. For beat 5, a second browser tab to close and reopen mid-upload. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:19 | LOWER-THIRD "Import Google Photos · Library Care". SCREEN: Settings → Import & protection. ZOOM on "Google Photos & server imports" ("Stage → scan → review → import → reconcile. Existing assets retain recovered album membership."). HIGHLIGHT "Preview import workflow", CURSOR clicks. CALLOUT on the word "Preview". | Import & protection → Google Photos & server imports → Preview import workflow | "Import Google Photos brings a Google Takeout export into your library. In Settings, open Import and protection, then Google Photos and server imports, and choose Preview import workflow. Frameleaf still labels this workflow a preview." |
| 3 | 0:19–0:35 | SCREEN: page "Import Google Photos", eyebrow "Import & protection", intro "A server-staged import continues after the browser closes."; stepper "1 Stage · 2 Scan · 3 Reconcile". Panel "Start an import": "Name" (default "Google Photos import", CURSOR types "Takeout September 2026"), "Source" segmented "Upload Takeout archives" / "Server folder". Panel "Your imports" reads "No imports yet." CURSOR clicks "Continue". | Stage · Scan · Reconcile · Start an import | "The wizard has three stages: Stage, Scan and Reconcile. Name the import and choose Continue. Administrators can instead read an export from a permitted folder on the server." |
| 4 | 0:35–0:52 | Stage: CURSOR clicks "Choose archives" and picks the three ZIPs; bars "Uploading takeout-002.zip", "1.2 GB of 2.0 GB"; note "Keep this page open while archives upload. Scanning and importing continue on the server after you close it." At 0:44 the tab closes; it reopens, the same files are chosen, "Checking what is already uploaded of takeout-002.zip", and the bar resumes. CALLOUT "Carries on where it stopped". | Choose archives · Carries on where it stopped | "In Stage, choose every ZIP file from one Takeout export, and keep the page open while they upload. If an upload stops, choose the same files again and it carries on where it stopped." |
| 5 | 0:52–1:07 | "Archives uploaded"; CURSOR clicks "Continue". Scan: "The server reads each archive, matches every photo with its metadata and finds the albums and possible Live Photos."; progress "3,412 of 5,980 files read"; buttons "Pause", "Stop", link "Open Activity"; note "This runs on the server. You can close this page; progress also shows in Activity." | Scan · Pause · Stop · Open Activity | "Scan runs on the server. It reads each archive and matches every photo with its metadata, even when Google shortened a sidecar name or put it in another archive. You can close the page." |
| 6 | 1:07–1:18 | Facts list: "Source 3 Takeout archives", "New assets 1,204", "Matched originals 312 · restore album memberships", "Needs review 2 ambiguous sidecars · 2 possible Live Photo pairs". Note "2 files were refused: an unsafe name, a link, encryption or damaged data." | New assets · Matched originals · Needs review | "The summary counts new photos, originals you already have, and anything to review. Unsafe or damaged entries are refused, never staged." |
| 7 | 1:18–1:35 | Reconcile, tab "Review": a row with two "Metadata sidecar" candidates; CURSOR picks one, "Use this choice"; another row offers "Import without a sidecar" and "Skip". Tab "Live Photos": pair `Campfire evening.jpg` + `Campfire evening.mp4` with "A photo and a video share a name in the same folder…", buttons "These belong together" and "Keep separate"; CURSOR links it. | Review · Live Photos | "Reconcile has five tabs. In Review, where sidecars disagree, choose one or import without it. Live Photos lists photos and videos that share a name; link only the ones that belong together." |
| 8 | 1:35–1:50 | Tab "Albums": export folders with item counts; "Summer in the Rockies" on; three "Year folder" rows off; help "Photos already in your library join these albums too, without a second copy." Tab "Import options": toggles "Recreate album memberships", "Review ambiguous sidecars", "Dates taken", "Locations", "Descriptions", "Favorites", "Archived photos stay archived", "Fill in missing details on photos already in your library" ("Nothing already in your library is replaced."). | Albums · Import options | "Albums chooses which folders become albums; Google's year folders start off. Import options chooses what comes over, including Fill in missing details on photos already in your library." |
| 9 | 1:50–2:06 | CURSOR clicks "Import". Progress "486 of 1,516 items" with "Pause" and "Stop". Then the notice "Import complete. Your originals and album memberships are in your library." | Import | "Choose Import. Each file is copied in and checked against the scan, and your export is never changed. A photo you already have is matched by checksum, not copied again. Failed steps are retried once." |
| 10 | 2:06–2:15 | ZOOM on the note under Import options: "Photos from the Google Photos Locked Folder always go into Locked." Locked shield icon in the top bar pulses once. | Locked Folder → Locked | "Photos from Google's Locked Folder go straight into Locked." |
| 11 | 2:15–2:30 | Tab "Report": "Imported 1,204", "Matched 312", "Skipped 3", "Unresolved 0", "Failed 0". HIGHLIGHT "Download report (JSON)" and "Download report (CSV)". | Report · Download report (JSON) · Download report (CSV) | "Report shows what was imported, matched, skipped, unresolved and failed, and downloads the full reconciliation report as JSON or CSV." |
| 12 | 2:30–2:42 | CURSOR clicks "Delete import" in the footer. Dialog "Delete this import?": "Its staged copies are removed. Everything it brought into your library stays there." CURSOR clicks "Delete". The page returns to "Your imports". | Delete import | "When you are done, Delete import removes its staged copies. Everything it brought in stays, and running an import again never creates a second copy." |
| 13 | 2:42–2:45 | LOGO OUTRO | Next: CARE-11 · Preservation packages | "Next up: Preservation packages." |

## Voice-over (clean)

Import Google Photos brings a Google Takeout export into your library. In Settings, open Import and protection, then Google Photos and server imports, and choose Preview import workflow. Frameleaf still labels this workflow a preview.

The wizard has three stages: Stage, Scan and Reconcile. Name the import and choose Continue. Administrators can instead read an export from a permitted folder on the server.

In Stage, choose every ZIP file from one Takeout export, and keep the page open while they upload. If an upload stops, choose the same files again and it carries on where it stopped.

Scan runs on the server. It reads each archive and matches every photo with its metadata, even when Google shortened a sidecar name or put it in another archive. You can close the page.

The summary counts new photos, originals you already have, and anything to review. Unsafe or damaged entries are refused, never staged.

Reconcile has five tabs. In Review, where sidecars disagree, choose one or import without it. Live Photos lists photos and videos that share a name; link only the ones that belong together.

Albums chooses which folders become albums; Google's year folders start off. Import options chooses what comes over, including Fill in missing details on photos already in your library.

[pause]

Choose Import. Each file is copied in and checked against the scan, and your export is never changed. A photo you already have is matched by checksum, not copied again. Failed steps are retried once.

Photos from Google's Locked Folder go straight into Locked.

Report shows what was imported, matched, skipped, unresolved and failed, and downloads the full reconciliation report as JSON or CSV.

When you are done, Delete import removes its staged copies. Everything it brought in stays, and running an import again never creates a second copy.

[pause]

Next up: Preservation packages.

## Production notes

- "Preview" (beat 2): the entry button reads "Preview import workflow" in google-photos-import.md and in the build. As instructed for this batch, the VO says in one sentence that Frameleaf labels the workflow a preview. The index status is READY and MKT-07 treats the word as the shipped button label, so no HOLD "Preview" badge is added on screen; confirm with the series editor.
- Path: google-photos-import.md says "Settings → Google Photos & server imports → Preview import workflow"; in the current build that section sits inside the Import & protection area for every account (administrators also see "Permitted import locations" there). The wizard is a page of its own titled "Import Google Photos".
- Server folder source (administrators only): only folders inside the locations the operator permitted with `IMMICH_IMPORT_ROOTS`, read without following links and never from library storage. Keep the variable name off screen.
- Uploads: each archive is uploaded in parts; choosing the same files again resumes, and a different file with the same name is refused. An archive is refused when the storage quota or the server's free space could not hold it.
- Scan: runs on the server, shows in Activity and the running-jobs panel, can be paused, resumed or stopped there or in the wizard. It handles localized folder names, shortened sidecar names and sidecars in another archive. Unsafe entries, links, encrypted entries and damaged data are refused and counted ("{n} files were refused: an unsafe name, a link, encryption or damaged data.").
- Import: photos already in the library (same file, by checksum) are matched, keep their own date and details, and gain only what is missing when "Fill in missing details on photos already in your library" is on. Every failing step is retried once automatically, and failed items get one more attempt before they are reported; retry again from the wizard or Activity.
- Locked Folder photos are locked before anything else is written. While the session is locked, the wizard only counts them ("{n} items go into Locked and are not listed. Unlock Locked to review them.").
- The primary footer button changes with the stage: "Continue", "Scan again", "Import", "Import remaining", "Import again", "Done". "Delete import" appears only when nothing is running.
- Counts and file names are sample data; never show a real Google account or export.
