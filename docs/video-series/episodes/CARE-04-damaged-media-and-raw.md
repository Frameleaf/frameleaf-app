# CARE-04 · Damaged media and RAW

| Field | Value |
| --- | --- |
| Series | Library Care |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators handling files that fail to read back, and anyone with RAW camera files |
| Features demonstrated | Damaged media (Damaged media & RAW queue), statuses Confirmed damaged, Suspected damage and Unsupported RAW, Inspect evidence, validation timeouts, Scan again, Enhanced RAW rendering, Recover from a verified copy (Recover damaged originals, Record verified recovery), Trash confirmed damage (PIN, typed phrase MOVE CORRUPT MEDIA TO TRASH, dialog Move confirmed damage to trash), background jobs with revalidation |
| Source docs | docs/docs/features/library-care.md, docs/docs/guides/media-recovery.md, README.md (Enhanced RAW Support and Media Health) |
| Capture checklist | Dark theme, Taylor (administrator, with a PIN) on frameleaf.home. Recovery location `Verified backup=/mnt/backup/photos`. Health scan run within the last day with four damaged-media findings: `Glacier creek.HEIC` Confirmed damaged (truncated file; an exact copy in `/mnt/backup/photos/2026/08/`), `Summit view.jpg` Confirmed damaged (no copy anywhere), `Elk in meadow.ARW` Unsupported RAW, `Lake morning.mov` Suspected damage from a validation timeout. Settings → Editing & playback → Image previews with Enhanced RAW rendering on. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:17 | LOWER-THIRD "Damaged media and RAW · Library Care". SCREEN: Settings → Library care, Repair queues. HIGHLIGHT "Damaged media & RAW" ("Separate unsupported formats from confirmed damage"), CURSOR clicks. Utilities → Damaged media opens: subtitle "Separate verified damage from unsupported formats before taking action.", scan bar "4 findings · Last scan · 02:14, 19 September". | Library care → Damaged media & RAW → Damaged media | "Damaged media lists originals that did not read back cleanly during a health scan. Open Library Care, then Damaged media and RAW. Like Missing media, it is an administrator tool." |
| 3 | 0:17–0:35 | ZOOM on the Finding column. Badges appear as named: "Confirmed damaged" (red) on Glacier creek and Summit view, "Suspected damage" (amber) on Lake morning.mov, "Unsupported RAW" (blue) on Elk in meadow.ARW. CALLOUT on the policy line "Unsupported RAW and suspected damage are kept until validation confirms a problem." | Confirmed damaged · Suspected damage · Unsupported RAW | "Each finding has a status. Confirmed damaged means the file failed to decode, or no longer matches its checksum. Suspected damage and Unsupported RAW prove nothing yet, so they stay until validation confirms a problem." |
| 4 | 0:35–0:49 | CURSOR clicks "Inspect" on Elk in meadow.ARW: Evidence "The decoder does not support this camera. The original has not been proven damaged." Done. Then "Inspect" on Lake morning.mov: Evidence "Validation did not finish in time. Further validation is needed." Done. | Inspect · Evidence | "Inspect explains each one. An unsupported RAW is a decoder limit, not damage. A long video that timed out simply needs more time to be checked." |
| 5 | 0:49–1:05 | CARD "Validation timeout": bullets "Default: 2 minutes per file", "Range: 10 seconds to 24 hours", "Set on each server and worker that validates". Then SCREEN: Damaged media, CURSOR clicks "Scan again"; scan bar "Scan queued. Existing findings remain available." | Validation timeout · Scan again | "The check has a two-minute limit by default. For long videos, your administrator can raise it on each server that validates, then run Scan again. A timeout never counts as damage, or as a repair." |
| 6 | 1:05–1:22 | SCREEN: Settings → Editing & playback → Image previews. ZOOM on the toggle "Enhanced RAW rendering" (on) with "Use LibRaw to render RAW files when embedded previews are missing or unusable." Inset SPLIT: a Sony α7 IV `.ARW` thumbnail before (grey placeholder) and after (Elk in meadow rendered). | Editing & playback → Image previews → Enhanced RAW rendering | "For RAW files, Enhanced RAW rendering is on by default, under Editing and playback, then Image previews. It uses the preview inside the RAW file first, and renders the RAW itself when that preview is missing or unusable." |
| 7 | 1:22–1:39 | Back in Damaged media. CURSOR ticks Glacier creek (Confirmed damaged), clicks "Recover from a verified copy". Dialog "Recover damaged originals": "Choose an exact copy from a backup. A valid decode alone does not prove that a file is the same original." Search locations "Library storage" and "Verified backup" ticked; CURSOR clicks "Search selected locations". Candidate `/mnt/backup/photos/2026/08/IMG_2231.HEIC` with "Checksum: exact match · Decode: validated · 3.1 MB". | Recover from a verified copy · Checksum: exact match · Decode: validated | "To repair confirmed damage, select it and choose Recover from a verified copy. Search library storage and your recovery locations. Only a copy whose checksum matches exactly, and that decodes, can be chosen." |
| 8 | 1:39–1:56 | CURSOR selects the candidate, ticks "I reviewed the checksum and decode evidence. Keep the previous damaged source and its provenance for recovery.", clicks "Record verified recovery". Notice "1 verified recovery queued. Previous source evidence is retained." Row loader, then "Resolved". Small DIAGRAM beside it: "Verified copy" → "Hidden Library Care folder" (teal); "Damaged file" → "Kept beside it" (green). | Record verified recovery · Damaged file kept beside it | "Tick that you reviewed the evidence, then Record verified recovery. The copy is published without replacing any file, and the damaged file is kept beside it, never written over." |
| 9 | 1:56–2:14 | CURSOR ticks Summit view.jpg (Confirmed damaged, no copy), clicks "Trash confirmed damage". The PIN prompt appears; digits blurred; it returns to the tool. Dialog "Move confirmed damage to trash" with the fixed list and the field "Type MOVE CORRUPT MEDIA TO TRASH"; the caret types the phrase; note "Additional identity verification is required when your private-media policy is enabled."; policy "Copies you are discarding move to trash. Originals still owned or referenced by other accounts are retained." "Confirm 1 item" enables. | Trash confirmed damage · PIN · Type MOVE CORRUPT MEDIA TO TRASH | "When no good copy exists, choose Trash confirmed damage. Enter your PIN if your account has one, then type the phrase shown, move corrupt media to trash, and confirm." |
| 10 | 2:14–2:28 | Notice "1 item queued for the trash."; the row badge reads "Queued for trash", then "Trashed". CALLOUT "Checked again as it moves". CALLOUT on the scan bar time "Evidence from the last day". | Queued for trash · Trashed | "The evidence must be from the last day, and each item is checked again as it moves; one that no longer fails is kept. Moving to the trash is not a recovery." |
| 11 | 2:28–2:42 | CARD "Checked at the moment of change": bullets "Every file read and verified again", "Changed since you looked? Reported, not applied", "Pause, cancel, one automatic retry". | Checked at the moment of change | "Recoveries and moves are background jobs you can pause or cancel, retried once automatically. A finding that changed since you reviewed it is reported instead of applied." |
| 12 | 2:42–2:45 | LOGO OUTRO | Next: CARE-05 · Live Photo pairing | "Next up: Live Photo pairing." |

## Voice-over (clean)

Damaged media lists originals that did not read back cleanly during a health scan. Open Library Care, then Damaged media and RAW. Like Missing media, it is an administrator tool.

Each finding has a status. Confirmed damaged means the file failed to decode, or no longer matches its checksum. Suspected damage and Unsupported RAW prove nothing yet, so they stay until validation confirms a problem.

Inspect explains each one. An unsupported RAW is a decoder limit, not damage. A long video that timed out simply needs more time to be checked.

The check has a two-minute limit by default. For long videos, your administrator can raise it on each server that validates, then run Scan again. A timeout never counts as damage, or as a repair.

[pause]

For RAW files, Enhanced RAW rendering is on by default, under Editing and playback, then Image previews. It uses the preview inside the RAW file first, and renders the RAW itself when that preview is missing or unusable.

To repair confirmed damage, select it and choose Recover from a verified copy. Search library storage and your recovery locations. Only a copy whose checksum matches exactly, and that decodes, can be chosen.

Tick that you reviewed the evidence, then Record verified recovery. The copy is published without replacing any file, and the damaged file is kept beside it, never written over.

When no good copy exists, choose Trash confirmed damage. Enter your PIN if your account has one, then type the phrase shown, move corrupt media to trash, and confirm.

The evidence must be from the last day, and each item is checked again as it moves; one that no longer fails is kept. Moving to the trash is not a recovery.

[beat]

Recoveries and moves are background jobs you can pause or cancel, retried once automatically. A finding that changed since you reviewed it is reported instead of applied.

[pause]

Next up: Live Photo pairing.

## Production notes

- Prerequisites: Taylor must be an administrator (Damaged media is an administrator tool) and should have a PIN so the PIN step shows. The trash action needs evidence from the last day (library-care.md), so run Scan again shortly before capture.
- Status mapping verified in the web and server source: a decode failure or checksum mismatch is "Confirmed damaged" (red); a decoder that does not support the format is "Unsupported RAW" (blue, evidence "The decoder does not support this camera…" or "This format cannot be decoded here…"); a validation timeout or an unverified decode is "Suspected damage" (amber, evidence "Validation did not finish in time. Further validation is needed."). Only Confirmed damaged can be recovered or moved to the trash.
- Timeout (beat 5): icloud-photos-server-setup.md documents `IMMICH_MEDIA_VALIDATION_TIMEOUT_MS`, default 120000 ms (two minutes), clamped to 10000–86400000 ms, set on each server or worker that validates. The CARD keeps the variable name off screen; show it only in an administrator-focused cut. To capture a timeout, use a long clip under the Lake morning.mov name or lower the timeout to its 10-second minimum on a test server, and restore the default afterwards.
- Enhanced RAW rendering: README.md places it under "Admin > System Settings > Image"; in the current build it is Settings → Editing & playback → Image previews, toggle "Enhanced RAW rendering", on by default. README: embedded previews first, then LibRaw/dcraw_emu for a full render; unsupported RAW stays separate from confirmed damage.
- Recovery (library-care.md): the copy must match the original checksum exactly and decode; it comes from library storage or a recovery location (the item's own external library is not offered here). It is published into a hidden Library Care folder in library storage, the damaged file is moved beside it and recorded on the finding, and it is never imported again as a new item. A damaged file another item still uses stays where it is. Kept files do not count toward the account quota; operators can review the `.library-care` folders.
- Trash flow labels: the toolbar button is "Trash confirmed damage" (as in library-care.md); the review dialog title is "Move confirmed damage to trash" (the index wording). The PIN prompt appears first only when the account has a PIN and the session is not already unlocked. The phrase is exactly `MOVE CORRUPT MEDIA TO TRASH`; "Confirm {n} items" stays disabled until it matches. Never show the PIN digits.
- Docs vs interface: media-recovery.md still names "Utilities → Review corrupt media" and the results "Confirmed corruption" and "Validation timeout"; the current tool is "Damaged media" with the statuses above, and a timeout shows as Suspected damage with its evidence line. Flag media-recovery.md for an update.
- If the Library care toggle "Suggest recoverable RAW sources" is off, the page shows "RAW originals are not searched for while “Suggest recoverable RAW sources” is off in Library care settings." Keep it on for capture.
- Paths, sizes and times are sample data. Recovered and kept files take disk space but do not change the item's size for quotas.
