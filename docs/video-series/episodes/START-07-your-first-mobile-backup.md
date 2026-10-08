# START-07 · Your first mobile backup

| Field | Value |
| --- | --- |
| Series | Start here |
| Type | How-to |
| Target length | 2:00 |
| Audience | Frameleaf mobile app users backing up a phone for the first time |
| Features demonstrated | Backup (cloud) icon in the app bar, Backup page, Backup Albums and Select, Select albums (tap to include, double tap to exclude, Search albums, Select all), Total / Backup / Remainder counts, Enable Backup, backup on app open and in the background, content checks that skip files already on the server, Backup Options (Network Requirements for photos and videos, Android Background Options: Charging), iOS Background App Refresh, timeline cloud icons (only on the phone, only on the server, on both), backup status badge |
| Source docs | docs/docs/features/mobile-backup.md, docs/docs/partials/_mobile-app-backup.md |
| Capture checklist | iPhone in a device frame with the Frameleaf mobile app signed in as Taylor to `frameleaf.home` (from START-06), backup off, on Wi-Fi. Phone albums: Recents (about 180 items, including the sample trip photos and Lake morning.mov, Forest trail.mov, Kayaking.mov), Screenshots, Favorites. Three of the phone's photos already on the server (uploaded from the web in START-05) so the "skipped" point and the cloud-with-tick icon are real. A few server-only items (uploaded from the web, not on the phone) so the plain cloud icon appears. An Android phone for the one Background Options inset. Status bar clean; no store listings or app-store names in shot. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD "Your first mobile backup · Start here". PHONE: the Frameleaf mobile app timeline. ZOOM on the backup icon at the top right, a cloud with an upward arrow and a small crossed-out cloud badge. | LOWER-THIRD; CALLOUT "Backup" | "Backup copies the photos on your phone to your Frameleaf server. It starts from the cloud icon at the top right of the Frameleaf mobile app." |
| 3 | 0:14–0:22 | PHONE: tap; the page "Backup" opens with the card "Backup Albums", "Albums to be backed up", "None selected" and the button "Select". HIGHLIGHT Select; tap. | CALLOUT "Backup Albums · Select" | "Tap it to open Backup. First choose the albums to back up: tap Select." |
| 4 | 0:22–0:39 | PHONE: "Select albums", "Albums on device (3)", hint "Tap to include, double tap to exclude", the search icon and "Select all". Tap Recents: it turns green (included). Double tap Screenshots: it turns red (excluded). ZOOM on the "Selection Info" note "Assets can scatter across multiple albums…". | CALLOUT "Tap: include"; CALLOUT "Double tap: exclude" | "Tap an album to include it; double tap to exclude one. That helps on iPhone, where a photo can sit in several albums: include Recents, exclude Screenshots, and everything but screenshots is backed up." |
| 5 | 0:39–0:50 | PHONE: back on "Backup". The albums card now reads "Selected: Recents (All)" and "Excluded: Screenshots". Three cards appear: "Total · All unique photos and videos from selected albums", "Backup · Backed up photos and videos", "Remainder · Remaining photos and videos to back up from selection", with their numbers. | CALLOUT "Total · Backup · Remainder" | "Back on the Backup page, three counts appear: Total in the selected albums, what's already backed up, and the Remainder still to go." |
| 6 | 0:50–1:02 | PHONE: HIGHLIGHT the card "Enable Backup" with its switch; tap the switch on. The icon in the card turns into a spinner; Remainder starts to count down; the upload list at the bottom fills. | CALLOUT "Enable Backup" | "Turn on Enable Backup. The app uploads those albums, then backs up new photos whenever you open the app, and periodically in the background." |
| 7 | 1:02–1:13 | DIAGRAM beside the phone: a phone node sends files to a server node; a teal "checksum" tag on each file; three files hit the server node and bounce off with a small "already there" mark; the rest go through. | "Already on the server? Skipped." | "First it checks each file's content against the server, so anything already there, from the web or another device, is skipped." |
| 8 | 1:13–1:28 | PHONE: tap the gear at the top of Backup ("Backup Options"): "Network Requirements" with "Videos · Use cellular data to backup videos" and "Photos · Use cellular data to backup photos", both off. INSET: an Android phone on the same page showing "Background Options" with "Charging · Background backup requires the device to be charging". CALLOUT on the iPhone: "iPhone Settings › General › Background App Refresh". | CALLOUT "Backup Options"; CALLOUT "Android: Charging"; CALLOUT "iPhone: Background App Refresh" | "Uploads wait for Wi-Fi by default. The gear opens Backup Options, where photos or videos can use cellular data. On Android, background backup can wait for charging; on iPhone, turn on Background App Refresh." |
| 9 | 1:28–1:44 | PHONE: back to the timeline, zoomed so tile corners are legible. CALLOUTs point at three tiles as named: a crossed-out cloud (a screenshot, only on the phone), a plain cloud (Wildflowers, uploaded from the web), a cloud with a tick (Moraine Lake). | CALLOUT "Only on this phone"; CALLOUT "Only on the server"; CALLOUT "On both" | "In the timeline, small cloud icons show where each item is. A crossed-out cloud: only on the phone, not backed up yet. A plain cloud: only on the server. A cloud with a tick: on both." |
| 10 | 1:44–1:57 | ZOOM on the app-bar backup icon; its badge cycles through four states as CALLOUTs name them: crossed-out cloud (off), spinner (uploading), tick (on), warning triangle (needs attention). | CALLOUT "Off · Uploading · On · Needs attention" | "The badge on that icon shows backup itself: off, uploading, on, or a warning when something needs attention." |
| 11 | 1:57–2:00 | LOGO OUTRO | Next: START-08 · Already running Immich? Move to Frameleaf | "Next up: Already running Immich? Move to Frameleaf." |

## Voice-over (clean)

Backup copies the photos on your phone to your Frameleaf server. It starts from the cloud icon at the top right of the Frameleaf mobile app.

Tap it to open Backup. First choose the albums to back up: tap Select.

Tap an album to include it; double tap to exclude one. That helps on iPhone, where a photo can sit in several albums: include Recents, exclude Screenshots, and everything but screenshots is backed up.

Back on the Backup page, three counts appear: Total in the selected albums, what's already backed up, and the Remainder still to go.

Turn on Enable Backup. The app uploads those albums, then backs up new photos whenever you open the app, and periodically in the background.

First it checks each file's content against the server, so anything already there, from the web or another device, is skipped.

[pause]

Uploads wait for Wi-Fi by default. The gear opens Backup Options, where photos or videos can use cellular data. On Android, background backup can wait for charging; on iPhone, turn on Background App Refresh.

[pause]

In the timeline, small cloud icons show where each item is. A crossed-out cloud: only on the phone, not backed up yet. A plain cloud: only on the server. A cloud with a tick: on both.

The badge on that icon shows backup itself: off, uploading, on, or a warning when something needs attention.

Next up: Already running Immich? Move to Frameleaf.

## Production notes

- Mobile labels verified in the shared i18n and the current backup screens (`mobile/lib/pages/backup/backup.page.dart`, `backup_album_selection.page.dart`, `backup_toggle_button.widget.dart`, `backup_settings.dart`): "Backup", "Backup Albums", "Albums to be backed up", "None selected", "Select", "Select albums", "Albums on device ({count})", "Tap to include, double tap to exclude", "Selection Info", "Search albums", "Select all", "Deselect All", "Selected: ", "Excluded: ", "Total", "Backup", "Remainder", "Enable Backup", "Backup Options", "Network Requirements", "Use cellular data to backup videos", "Use cellular data to backup photos", "Background Options" (Android only), "Charging", "Background backup requires the device to be charging".
- Docs vs interface: `_mobile-app-backup.md` says to "Scroll down to the bottom and press Enable Backup". In the current app, the Backup page shows the counts and the "Enable Backup" card with a switch only after at least one album is selected; the narration says "Turn on Enable Backup". The partial and mobile-backup.md also still name the other product in several places; narration says Frameleaf.
- Beat 4: mobile-backup.md: "You can also exclude specific albums (by double-tapping on them) … useful for iOS users since assets can belong to multiple albums." Capture on an iPhone for this reason; only beat 8's Background Options inset is Android.
- Beat 7: mobile-backup.md: "When you first select albums for backup, Immich calculates a checksum for each file's content. … Files matching existing assets are skipped." The VO avoids the word checksum; the DIAGRAM tag shows it.
- Beat 8: "By default, Immich will only upload photos and videos when connected to Wi-Fi" (mobile-backup.md); "You must enable Background App Refresh" on iOS; the Android charging option and the delay slider live under Background Options. Keep "Backup Albums Synchronization" out of shot: its subtitle still names the other product. Album sync is covered in the MOBILE series.
- Beat 9 icon meanings come from FAQ.mdx ("What is the difference between the cloud icons on the mobile app?"): crossed-out cloud = only on the device, not yet backed up; plain cloud = only on the server (uploaded elsewhere, or deleted from the device after upload); cloud with a tick = uploaded from this device and still on it. The icons show while "Show storage indicator on asset tiles" is on (the default, under the app's Photo Grid settings).
- Beat 10: the app-bar badge states come from the app bar's backup indicator: backup off, uploading, error, otherwise a tick.
- iCloud-only originals: mobile-backup.md notes that iCloud items are downloaded to the app's cache before upload and may use data and storage; not narrated. Keep the phone on Wi-Fi.
- The outro VO names Immich because it reads the next episode's exact title; the style guide allows START-08 to name the system being moved from.
