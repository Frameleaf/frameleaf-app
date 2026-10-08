# CARE-01 · Library Care overview

| Field | Value |
| --- | --- |
| Series | Library Care |
| Type | Learn |
| Target length | 2:45 |
| Audience | Library owners and operators who want to understand what Library Care checks and repairs |
| Features demonstrated | Library care area, Media health & integrity toggles, Health scan schedule, Repair queues, Enrichment completeness, Scan again, scan bar, Activity job, account scope |
| Source docs | docs/docs/features/library-care.md |
| Capture checklist | Dark theme, Taylor signed in as admin on frameleaf.home. Sidebar expanded with the footer visible (Library Care, Settings, Support Frameleaf). Settings → Library care directory (Health: Media health & integrity; Repairs: Repair queues, Enrichment completeness; Tools: Duplicate review, Missing media, Damaged media, Live Photo pairing) and each section page: Media health & integrity (Schedule incremental health scans on, Health scan schedule `0 2 * * *`, Verify original checksums on, Audit database and file references on), Repair queues (three suggestion toggles, then the four cards Live Photo pairs, Missing originals, Duplicate groups, Damaged media & RAW), Enrichment completeness (both toggles on). Missing media tool with 3 findings and the count rows Duplicate groups (14 groups waiting for review), Import review (2 items need review), Metadata still to read (0 items waiting), the Scan again button, scan bar in three states (Last scan · 02:14, 19 September; Scanning · 12,480 of 153,792; Last scan failed · …), Pause and Resume. Activity page with a running "Library scan" row. Account picker showing Your account, All accounts, Jamie, Emma. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:17 | LOWER-THIRD "Library Care overview · Library Care". SCREEN: Library timeline (Taylor), sidebar expanded. CURSOR travels to the sidebar footer, HIGHLIGHT on "Library Care", click. Cross-dissolve to Settings with the rail item "Library care" selected. | Library Care → Settings · Library care | "Library Care is where Frameleaf looks after the files behind your photos. Open Library Care at the bottom of the sidebar. It takes you to the Library care area of Settings." |
| 3 | 0:17–0:30 | SCREEN: Library care directory: "Media health & integrity" under Health, "Repair queues" and "Enrichment completeness" under Repairs, and the four repair tools under Tools. Three CALLOUTs slide in as each section is named: "Media health & integrity", "Repair queues", "Enrichment completeness". | Media health & integrity · Repair queues · Enrichment completeness | "It has three parts. Media health and integrity sets what scans check. Repair queues open the tools that fix things. Enrichment completeness decides what gets processed again." |
| 4 | 0:30–0:42 | CURSOR opens "Media health & integrity". ZOOM on its toggles. HIGHLIGHT the toggle "Schedule incremental health scans" (on), then the field "Health scan schedule" showing `0 2 * * *`. CALLOUT "Default: every night at 02:00". | Schedule incremental health scans · Health scan schedule | "Schedule incremental health scans runs a scan by itself. The Health scan schedule is a cron expression, and the default is every night at two." |
| 5 | 0:42–0:56 | ZOOM holds. HIGHLIGHT "Verify original checksums" (on) as named, then "Audit database and file references" (on). Small DIAGRAM beside the toggles: file icon → checksum icon (teal); record icon → file icon (green). | Verify original checksums · Audit database and file references | "Verify original checksums compares each file with the checksum recorded when it was added. Audit database and file references checks that every record points at a real file." |
| 6 | 0:56–1:07 | CURSOR returns to the Library care directory and opens "Repair queues". SCREEN: the Repair queues page: the three suggestion toggles at the top, then four cards in two columns, each with a chevron: "Live Photo pairs", "Missing originals", "Duplicate groups", "Damaged media & RAW". CALLOUT on "Missing originals" with its line "Find moved files and verify their identity", then on "Damaged media & RAW" with "Separate unsupported formats from confirmed damage". | Missing originals · Damaged media & RAW | "Repair queues lists four repairs. Missing originals finds moved files and verifies their identity. Damaged media and RAW separates unsupported formats from confirmed damage." |
| 7 | 1:07–1:15 | ZOOM holds on the cards. CALLOUT on "Duplicate groups" ("Compare copies and choose your keepers"), then on "Live Photo pairs" ("Pair photos with their motion clips"), each as named. | Duplicate groups · Live Photo pairs | "Duplicate groups compares copies so you can choose keepers. Live Photo pairs reconnects photos with their motion clips." |
| 8 | 1:15–1:25 | SCREEN: the four Repair queues cards. CURSOR hovers each card as its tool is named; the chevron lights and a CALLOUT names the tool it opens: "Duplicate review", "Missing media", "Damaged media", "Live Photo pairing". A small "Administrator" badge appears beside Missing media and Damaged media. | Duplicate review · Missing media · Damaged media · Live Photo pairing | "Each card opens its tool: Duplicate review, Missing media, Damaged media or Live Photo pairing. Missing media and Damaged media are for administrators." |
| 9 | 1:25–1:36 | SCREEN: CURSOR clicks "Missing originals"; the Missing media tool opens with "3 findings" in its scan bar. ZOOM on the count rows below the scan bar: "Duplicate groups · 14 groups waiting for review" with Review, "Import review · 2 items need review" with Review, "Metadata still to read · 0 items waiting" with View jobs. CALLOUT on each row as named. | Duplicate groups · Import review · Metadata still to read | "Inside Missing media and Damaged media, counts show what waits elsewhere: duplicate groups, iCloud Photos items in Import review, and metadata still to read." |
| 10 | 1:36–1:43 | CARD "Counted with your privacy": bullet 1 "Another account's Locked media: never counted"; bullet 2 "Your Locked media: counted after you unlock". Locked shield icon in the top bar pulses once. | Counted with your privacy | "Another account's Locked media is never counted, and your own only after you unlock your session." |
| 11 | 1:43–1:53 | SCREEN: Missing media tool header (still open from beat 9). HIGHLIGHT "Scan again" in the header, CURSOR clicks. Scan bar shows "Scan queued. Existing findings remain available." then "Scanning · 12,480 of 153,792" with a teal progress fill. | Scan again | "Scan again checks every item in your library: whether its original is there, and whether it reads back intact." |
| 12 | 1:53–2:07 | SPLIT: left, the scan bar with Pause and Cancel scan; right, Activity page with the "Library scan" row under Running. CURSOR clicks Pause: bar reads "Pausing after the current batch" then "Paused · resume to carry on where it stopped". CURSOR clicks Resume: "Resumed. The job carries on where it stopped." | Activity · Pause · Resume · Cancel scan | "The scan is a background job listed in Activity and in the notifications panel. It records a checkpoint after every small batch, so you can pause, resume or cancel it." |
| 13 | 2:07–2:22 | DIAGRAM: nodes "Scan" → "Checkpoint after each batch" → "Browser closed or server restarted" → "Carries on" (green path); a branch "Fails" → "Retried once" → "Reported". Then SCREEN: scan bar cycling three states: "Last scan · 02:14, 19 September", "Scanning · 88,310 of 153,792", "Last scan failed · 02:31, 17 September". | Carries on where it stopped · Retried once | "Close the browser or restart the server, and it carries on where it stopped. A failed scan is retried once before it is reported. The scan bar shows the last scan, a running one and a failure." |
| 14 | 2:22–2:33 | SCREEN: back in the Library care directory, CURSOR opens "Enrichment completeness"; ZOOM on its toggles. HIGHLIGHT "Reprocess only affected outputs" (on), then "Preserve manual metadata on rerun" (on). | Reprocess only affected outputs · Preserve manual metadata on rerun | "Under Enrichment completeness, Reprocess only affected outputs stops a changed identity from rerunning unrelated jobs. Preserve manual metadata on rerun keeps what you typed." |
| 15 | 2:33–2:42 | SCREEN: Missing media tool header. CURSOR opens the "Account" picker: "Your account" selected; options "All accounts", "Jamie", "Emma". CURSOR hovers "All accounts". Hold. | Account: Your account · All accounts · Jamie · Emma | "Everyone reviews their own findings. An administrator can also choose one other account, or all accounts." |
| 16 | 2:42–2:45 | LOGO OUTRO | Guide: Library Care | "The written guide is linked below." |

## Voice-over (clean)

Library Care is where Frameleaf looks after the files behind your photos. Open Library Care at the bottom of the sidebar. It takes you to the Library care area of Settings.

It has three parts. Media health and integrity sets what scans check. Repair queues open the tools that fix things. Enrichment completeness decides what gets processed again.

Schedule incremental health scans runs a scan by itself. The Health scan schedule is a cron expression, and the default is every night at two.

Verify original checksums compares each file with the checksum recorded when it was added. Audit database and file references checks that every record points at a real file.

[pause]

Repair queues lists four repairs. Missing originals finds moved files and verifies their identity. Damaged media and RAW separates unsupported formats from confirmed damage.

Duplicate groups compares copies so you can choose keepers. Live Photo pairs reconnects photos with their motion clips.

Each card opens its tool: Duplicate review, Missing media, Damaged media or Live Photo pairing. Missing media and Damaged media are for administrators.

Inside Missing media and Damaged media, counts show what waits elsewhere: duplicate groups, iCloud Photos items in Import review, and metadata still to read.

Another account's Locked media is never counted, and your own only after you unlock your session.

[pause]

Scan again checks every item in your library: whether its original is there, and whether it reads back intact.

The scan is a background job listed in Activity and in the notifications panel. It records a checkpoint after every small batch, so you can pause, resume or cancel it.

Close the browser or restart the server, and it carries on where it stopped. A failed scan is retried once before it is reported. The scan bar shows the last scan, a running one and a failure.

[pause]

Under Enrichment completeness, Reprocess only affected outputs stops a changed identity from rerunning unrelated jobs. Preserve manual metadata on rerun keeps what you typed.

Everyone reviews their own findings. An administrator can also choose one other account, or all accounts.

[pause]

The written guide is linked below.

## Production notes

- Prerequisites: Taylor is an administrator, so Missing media and Damaged media are visible. A health scan must have run at least once so "Last scan · …" and the queue counts are non-zero; seed a few missing and damaged findings from the sample library (for example move `Ridge trail` and `Glacier creek` out of library storage before the capture scan).
- Path: the sidebar footer entry "Library Care" opens `/user-settings?area=care`, the "Library care" area of the settings Command Center. The written guide (library-care.md) still says Library Care opens Utilities with the tools grouped as Organize, Repair, Import, Automate and Connect; in the current build those groups live in the separate Utilities area (Settings → Utilities). Do not show the Utilities area in this episode.
- Labels verified in the build: section titles "Media health & integrity", "Repair queues", "Enrichment completeness"; toggles "Schedule incremental health scans", "Health scan schedule" (help text: "…as a cron expression. The default is every night at 02:00."), "Verify original checksums", "Audit database and file references", "Reprocess only affected outputs", "Preserve manual metadata on rerun"; Repair queues cards "Live Photo pairs" ("Pair photos with their motion clips"), "Missing originals" ("Find moved files and verify their identity"), "Duplicate groups" ("Compare copies and choose your keepers"), "Damaged media & RAW" ("Separate unsupported formats from confirmed damage"); count rows in Missing media and Damaged media "Duplicate groups" ("{count} groups waiting for review", button "Review"), "Import review" ("{count} items need review", button "Review"), "Metadata still to read" ("{count} items waiting", button "View jobs"). The Repair queues page also carries three suggestion toggles ("Suggest Live Photo relinking", "Suggest recoverable RAW sources", "Group near-duplicates for review"); leave them in shot but do not call them out.
- Scan bar strings to reproduce exactly: "Scan queued. Existing findings remain available.", "Scanning · {done} of {total}", "Pausing after the current batch", "Paused · resume to carry on where it stopped", "Resumed. The job carries on where it stopped.", "Last scan · {time}", "Last scan failed · {time}". Activity lists the scan under the kind "Library Care" with the item "Library scan".
- The VO says "every night at two"; the on-screen schedule field shows the cron `0 2 * * *` and the callout shows 02:00. Keep both.
- Privacy beat (8): use the Locked shield in the top bar only; never show Locked thumbnails.
- Beat 14: the account picker is an administrator view. For a non-admin capture the picker shows only the signed-in account.
- CTA card: `Guide: Library Care` (producer fills in the public docs URL).
- Correction (checked against the current build): Settings → Library care → Repair queues shows no counts and no "Review" buttons. It is four link cards (title, help line, chevron), each opening its tool (web/src/routes/(user)/user-settings/sections/RepairSection.svelte). The counts with Review buttons live in the Missing media and Damaged media tools (web/src/lib/components/frameleaf/LibraryCareHealth.svelte), and the Missing originals and Damaged media & RAW numbers are those tools' own findings. Beats 3 and 6 to 10 were rewritten to match; library-care.md still describes counted queues. The "Import review" row is hidden while the account picker is on "All accounts" (import review is per account), so capture beat 9 with "Your account" selected.
