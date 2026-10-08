# MKT-06 · Never lose a photo

| Field | Value |
| --- | --- |
| Series | Meet Frameleaf |
| Type | Marketing |
| Target length | 1:15 |
| Audience | People with years of photos across drives and phones who worry about silent loss |
| Features demonstrated | Library Care repair queues, scheduled and on-demand health scans, Missing originals with Locate originals and Relink verified matches, Damaged media with Recover from a verified copy, Live Photo pairing, Duplicate review with original-format keep suggestions |
| Source docs | docs/docs/features/library-care.md, docs/docs/guides/media-recovery.md |
| Capture checklist | Dark theme as Taylor (administrator); Library Care page with repair queues showing Missing originals 3, Damaged media & RAW 1, Duplicate groups 12 and the scan bar "Last scan 02:00"; Media health & integrity toggles; Missing media with Ridge trail as a finding and a checksum-verified candidate; Damaged media with one Confirmed damaged item and a verified copy; Utilities → Live Photo pairing with Lake reflection matched by identifier; Utilities → Duplicate review with a Sony α7 IV RAW and a larger JPEG copy |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "Never lose a photo · Meet Frameleaf". SCREEN: sidebar footer "Library Care" clicked (0:04); the Library care area opens. ZOOM on the repair queues: Missing originals 3, Damaged media & RAW 1, Duplicate groups 12, Metadata still to read 0. Scan bar reads "Last scan 02:00". | Library Care | "A library is only as safe as the files behind it. Library Care checks every one of yours and tells you when something is wrong." |
| 3 | 0:13–0:24 | SCREEN: "Media health & integrity": toggles "Schedule incremental health scans" (on, 02:00) and "Verify original checksums" (on). CURSOR clicks "Scan again" (0:17). Cut at 0:20 to Activity: the scan listed as Running with a progress bar; browser tab closes and reopens at 0:23, the bar has moved on. | Scan again | "Scans run on a schedule or on demand. They read each original back to prove it is intact, and carry on even if you close the browser." |
| 4 | 0:24–0:34 | SCREEN: Missing media. Finding "Ridge trail" with "original can no longer be opened". CURSOR selects it, clicks "Locate originals" (0:26), ticks library storage and the external library, clicks "Search selected locations". A candidate appears on old-server's export folder with "checksum: exact match · decodes" (0:30). CURSOR clicks "Relink verified matches". A small loader, then the row clears. | Locate originals | "Move a drive or rename a folder, and a photo goes missing. Locate originals searches by checksum, never by name, and relinks the exact file." |
| 5 | 0:34–0:42 | SCREEN: Damaged media. One "Confirmed damaged" finding with a thumbnail and error evidence. CURSOR clicks "Recover from a verified copy", ticks "I reviewed the checksum and decode evidence", confirms. CALLOUT: "Damaged file kept beside it". | Recover from a verified copy | "Damaged files can be replaced from a verified copy, and the damaged one is kept beside it, never written over." |
| 6 | 0:42–0:48 | SCREEN: Settings → Utilities → Live Photo pairing. Lake reflection.heic and Lake reflection.mov listed under "Matched by identifier". CURSOR clicks "Relink all confident (4)". The pair becomes one tile with the live photo badge. | Live Photo pairing | "Live Photo pairing puts back together Live Photos that arrived as two files, confident matches in one go." |
| 7 | 0:48–0:59 | SCREEN: Settings → Utilities → Duplicate review. Contact sheet of one group: Summit view as a Sony α7 IV RAW (38 MB) and a JPEG copy (41 MB). The RAW carries the "Keep suggested" mark. HIGHLIGHT on the RAW. CURSOR hovers "Keep suggested" but does not click. | Keep suggested | "Duplicate review lines copies up side by side and suggests keeping the original format, RAW or HEIC, even when the JPEG is bigger. Nothing is deleted until you decide." |
| 8 | 0:59–1:08 | CARD "Checked twice" with bullets per clause: "Verified again at the moment of change", "Changed since you looked? Reported, not applied", "Background jobs that resume". | Checked twice | "Every repair is checked again at the moment it happens. If a file changed since you looked, Frameleaf says so instead of guessing." |
| 9 | 1:08–1:12 | TITLE on the dark canvas over Glacier creek dimmed to 40%. | Never lose a photo. | "Never lose a photo." |
| 10 | 1:12–1:15 | LOGO OUTRO with the tagline lockup; the leaf sways 4° once. | YOUR MEMORIES GROW FURTHER | "Frameleaf. Your memories grow further." |

## Voice-over (clean)

A library is only as safe as the files behind it. Library Care checks every one of yours and tells you when something is wrong.

Scans run on a schedule or on demand. They read each original back to prove it is intact, and carry on even if you close the browser.

[beat]

Move a drive or rename a folder, and a photo goes missing. Locate originals searches by checksum, never by name, and relinks the exact file.

Damaged files can be replaced from a verified copy, and the damaged one is kept beside it, never written over.

Live Photo pairing puts back together Live Photos that arrived as two files, confident matches in one go.

Duplicate review lines copies up side by side and suggests keeping the original format, RAW or HEIC, even when the JPEG is bigger. Nothing is deleted until you decide.

[pause]

Every repair is checked again at the moment it happens. If a file changed since you looked, Frameleaf says so instead of guessing.

[beat]

Never lose a photo.

[beat]

Frameleaf. Your memories grow further.

## Production notes

- Taylor must be an administrator: Missing media and Damaged media are administrator tools (library-care.md). Seed one missing original (move Ridge trail's file into a recovery location or an external library), one confirmed-damaged file with a verified copy in a recovery location (FRAMELEAF_RECOVERY_ROOTS, for example `Verified backup=/mnt/backup/photos`), a separated Live Photo pair for Lake reflection, and a RAW plus JPEG duplicate of Summit view. Run the Media Health scan and Duplicate Detection before capture.
- Beat 2 and 3 labels follow the integration inventory (Library Care): the sidebar footer entry opens the Library care area with "Media health & integrity" toggles ("Schedule incremental health scans", "Verify original checksums", "Audit database and file references"), the repair queues and "Scan again". library-care.md still says the entry opens Utilities; use the area as built.
- Beat 3 claim comes from library-care.md (Scans): the scan records progress after every small batch, can be paused, resumed or cancelled, survives closing the browser or restarting the server, and is retried once automatically.
- Beat 4 flow is the documented one: "Locate originals" → pick locations → "Search selected locations" (exact copies by checksum, never by name) → "Save candidate choices" → "Relink verified matches". A copy in a recovery location is copied into library storage; the recovery location is only read.
- Beat 5: "Recover from a verified copy" needs a checksum-exact copy that decodes; the damaged file is moved beside it, never over anything, and kept for recovery. Do not show "Move confirmed damage to trash" (typed phrase and PIN) in a marketing cut.
- Beat 6: "Matched by identifier" is the confident match; "Matched by filename and time" is the review tier. Buttons are "Relink" and "Relink all confident ({count})". The optional AAC audio track is not carried.
- Beat 7: "Prefer original format" (on by default) pre-selects RAW first, then HEIC/HEIF, even when the JPEG is larger; it only changes the pre-selection and deletes nothing (README, Smarter Duplicate Keep Suggestions). File sizes on screen are sample data.
- Beat 8 wording is from library-care.md (Damaged media): every file is read and verified again at the moment of change, and a finding that changed since review is reported instead of applied.
- media-recovery.md still names "Utilities → Review missing media" and "Review corrupt media"; the current labels are Missing media and Damaged media.
