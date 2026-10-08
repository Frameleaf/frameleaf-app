# START-05 · Upload from your browser

| Field | Value |
| --- | --- |
| Series | Start here |
| Type | How-to |
| Target length | 2:00 |
| Audience | New Frameleaf users adding photos from a computer, and anyone downloading from the web app |
| Features demonstrated | Upload menu (Upload files, Upload folder, Add to, Library only), drag and drop onto a library page ("Drop photos and videos to upload"), Uploads panel (row states Waiting, Uploading %, Uploaded, Already in your library, Failed; Retry failed, Cancel remaining, Clear finished; minimise), uploads are not resumable, Activity rows marked "This browser tab only", Downloads panel (zip archives built on the server, split parts, Save, Retry, Cancel), Download original, Locked items and the panel |
| Source docs | docs/docs/features/uploads-and-downloads.md |
| Capture checklist | Taylor signed in, dark theme, 1920×1080. A folder "Banff 2026" on the desktop with 24 sample photos and videos (Moraine Lake, Lake reflection, Glacier creek, Ridge trail, Wildflowers, Kayaking.mov, Forest trail.mov…), two of which are already in the library (so they show "Already in your library") and one deliberately unreadable file (so one row fails). Album "Summer in the Rockies". Network throttled in the browser so rows stay visible in the Uploading state. "Moraine Lake" edited in the photo editor beforehand so Download original is offered. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:11 | LOWER-THIRD "Upload from your browser · Start here". SCREEN: Library timeline. HIGHLIGHT Upload in the top bar; CURSOR clicks it. | LOWER-THIRD; CALLOUT "Upload" | "To add photos from your computer, choose Upload in the top bar." |
| 3 | 0:11–0:24 | ZOOM on the menu: "Upload files · Photos and videos from this device", "Upload folder · Everything inside, including subfolders". CURSOR opens "Add to" (default "Library only") and picks Summer in the Rockies; hint "New uploads also join “Summer in the Rockies”." CURSOR clicks Upload folder and picks "Banff 2026" in the system dialog. | CALLOUT "Upload files · Upload folder"; CALLOUT "Add to" | "Upload files picks photos and videos. Upload folder takes everything inside, including subfolders. Add to puts them straight into an album, or leave it on Library only." |
| 4 | 0:24–0:31 | INSET: files dragged from the desktop onto the album page "Summer in the Rockies"; overlay "Drop photos and videos to upload · They are added to your library as they arrive". | CALLOUT "Drag and drop" | "You can also drag files onto any library page. From an album page, they join that album." |
| 5 | 0:31–0:48 | SCREEN: the Uploads panel in the bottom corner, header "Uploading 8 of 24" with the overall bar. ZOOM on rows as named: "Waiting", "Uploading 42%", "Uploaded", "Already in your library" (two rows). CURSOR clicks "Minimise uploads", opens All albums from the sidebar, then clicks the minimised pill ("Show uploads") to reopen the panel; the count has moved on. | CALLOUT "Waiting · Uploading · Uploaded · Already in your library" | "The Uploads panel lists every file with its state: waiting, uploading with a percentage, uploaded, or already in your library. Duplicates are recognized by their content and never stored twice. Keep browsing; uploads carry on as you move between pages." |
| 6 | 0:48–1:01 | ZOOM on the panel footer: one row "Failed"; buttons "Retry failed", "Cancel remaining", "Clear finished". HIGHLIGHT each as named; CURSOR clicks Clear finished and the uploaded and duplicate rows disappear while the rest continue. | CALLOUT "Retry failed · Cancel remaining · Clear finished" | "Retry failed sends failed files again. Cancel remaining stops the rest, and anything already uploaded stays. Clear finished tidies the list while the others continue." |
| 7 | 1:01–1:13 | CARD "Keep this tab open": bullet 1 "Reload or close the tab: waiting files stop"; bullet 2 "Finished files are already in your library"; bullet 3 "Upload the same files again: finished ones are skipped". | CARD | "Uploads aren't resumable: reloading or closing the tab stops whatever is still waiting. To finish, upload the same files again, and the ones already there are skipped." |
| 8 | 1:13–1:22 | CURSOR clicks Activity in the top bar: Upload rows with the note "This browser tab only", filters All · Running · Done · Failed. | CALLOUT "This browser tab only" | "Activity, in the top bar, lists them too, marked This browser tab only." |
| 9 | 1:22–1:39 | SCREEN: Library; CURSOR selects Moraine Lake, Lake reflection and Glacier creek; clicks Download in the selection bar. The Downloads panel opens: "Preparing 1 download", hint "Archives are built on the server, then saved to this device", the row "3 items" at 64%, then "Ready" with "Save". CURSOR clicks Save. Inset: a second row that failed, with "Retry". | CALLOUT "Downloads"; CALLOUT "Save · Retry" | "Downloads work the same way. Several items or an album download as a zip archive, built on the server; a large one is split into parts. The Downloads panel shows each one preparing, then Save. A failed row offers Retry." |
| 10 | 1:39–1:48 | SCREEN: viewer on the edited "Moraine Lake"; CURSOR opens More actions; the Download group shows "Download" and "Download original"; HIGHLIGHT Download original. | CALLOUT "Download original" | "A single item downloads its current version; for an edited photo, Download original gets the untouched file." |
| 11 | 1:48–1:57 | CARD "Locked stays locked": bullet 1 "Locked items download only in an unlocked session"; bullet 2 "Locking or signing out clears the panel". The top bar's Locked control pulses once. | CARD | "Locked items download only after you unlock this session, and locking again or signing out clears the panel." |
| 12 | 1:57–2:00 | LOGO OUTRO | Next: START-06 · Get the mobile app and sign in | "Next up: Get the mobile app and sign in." |

## Voice-over (clean)

To add photos from your computer, choose Upload in the top bar.

Upload files picks photos and videos. Upload folder takes everything inside, including subfolders. Add to puts them straight into an album, or leave it on Library only.

You can also drag files onto any library page. From an album page, they join that album.

The Uploads panel lists every file with its state: waiting, uploading with a percentage, uploaded, or already in your library. Duplicates are recognized by their content and never stored twice. Keep browsing; uploads carry on as you move between pages.

Retry failed sends failed files again. Cancel remaining stops the rest, and anything already uploaded stays. Clear finished tidies the list while the others continue.

[pause]

Uploads aren't resumable: reloading or closing the tab stops whatever is still waiting. To finish, upload the same files again, and the ones already there are skipped.

Activity, in the top bar, lists them too, marked This browser tab only.

[pause]

Downloads work the same way. Several items or an album download as a zip archive, built on the server; a large one is split into parts. The Downloads panel shows each one preparing, then Save. A failed row offers Retry.

A single item downloads its current version; for an edited photo, Download original gets the untouched file.

Locked items download only after you unlock this session, and locking again or signing out clears the panel.

Next up: Get the mobile app and sign in.

## Production notes

- Labels verified in the build (UploadMenuButton, UploadPanel, DownloadPanel, ActivityView and i18n `frameleaf_transfer_*`): "Upload", "Upload files", "Upload folder", "Add to", "Library only", "New uploads also join “{album}”.", "Drop photos and videos to upload", "They are added to your library as they arrive", "Uploading {n} of {total}", "Waiting", "Uploading {n}%", "Uploaded", "Already in your library", "Failed", "Retry failed", "Dismiss errors", "Cancel remaining", "Clear finished", "Done", "Minimise uploads", "Show uploads", "Downloads", "Archives are built on the server, then saved to this device", "Preparing {n} download", "Ready", "Save", "Retry", "Cancel", "Dismiss", "Download original", Activity note "This browser tab only".
- Button visibility: "Clear finished" and "Cancel remaining" show only while uploads are still running; "Retry failed" and "Dismiss errors" only when something failed; "Done" replaces them when everything has finished. Keep the network throttled for beats 5 and 6 so all three appear together.
- A file already in the trash shows "In trash" instead of "Already in your library"; avoid trashed duplicates in the sample folder.
- Beat 4: dropping on an album page joins that album (the drag-and-drop overlay default); dropping on the Locked view keeps uploads Locked. Only the album case is narrated.
- Beat 9: the archive is split when it is bigger than the size limit in the account's download settings; each part gets its own row. Live Photos include their motion clip; the embedded video in Android motion photos only with "Embedded videos" turned on in download settings (not narrated).
- A prepared download is held by the tab until saved and does not survive a reload (doc); not narrated, but do not reload during beat 9.
- Beat 11 comes from the doc: "A Locked item is never downloaded or named unless you have unlocked Locked content in this session … Locking the session or signing out clears the panel." Never show Locked thumbnails; the CARD carries no images.
- The Activity page lists uploads alongside server jobs; nothing else in Activity is explained here (see START-04).
