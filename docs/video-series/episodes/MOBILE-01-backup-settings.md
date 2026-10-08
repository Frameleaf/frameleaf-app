# MOBILE-01 · Backup settings

| Field | Value |
| --- | --- |
| Series | On your phone |
| Type | How-to |
| Target length | 2:30 |
| Audience | Anyone backing up a phone to Frameleaf who wants to control what uploads and when |
| Features demonstrated | Backup page (Backup Albums, Selected and Excluded, Total, Backup, Remainder, Enable Backup, View Details), Select albums (tap to include, double tap to exclude), checksum deduplication, Backup Options (Network Requirements: cellular for Videos and Photos, otherwise Wi-Fi only; Android Background Options: Charging, Delay new assets backup), foreground and background backup |
| Source docs | docs/docs/features/mobile-backup.md, docs/docs/partials/_mobile-app-backup.md, docs/docs/FAQ.mdx (Mobile App), mobile/lib/pages/backup, mobile/lib/widgets/settings/backup_settings/backup_settings.dart, i18n/en.json (backup_*, network_requirement_*) |
| Capture checklist | The Frameleaf mobile app signed in as Taylor to frameleaf.home, dark theme, framed in an iPhone 16 Pro device frame on the 16:9 canvas; a second capture on an Android phone for the Background Options beat. Device albums: Recents, Camera, Summer in the Rockies, Screenshots. Recents selected and Screenshots excluded after beat 5. Backup not yet enabled at the start. Home screen, store listings and the app's icon label out of shot. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD; SCREEN (iPhone frame): the Frameleaf mobile app's timeline. HIGHLIGHT then tap on the cloud icon at the top right; the "Backup" page opens. | Backup settings · On your phone | "The Frameleaf mobile app backs up your phone to your own server. Tap the cloud icon at the top of the timeline to open Backup." |
| 3 | 0:14–0:28 | SCREEN: Backup page. The "Backup Albums" card, "Albums to be backed up", "None selected" and the "Select" button. ZOOM on the cards "Total", "Backup" and "Remainder" with their subtitles. | Backup Albums · Total · Backup · Remainder | "Backup Albums says which albums are included and which are left out. Total, Backup and Remainder count what you selected, what is already on the server, and what is still to go." |
| 4 | 0:28–0:46 | SCREEN: tap "Select"; the "Select albums" page opens with "Selection Info", "Albums on device (4)" and the hint "Tap to include, double tap to exclude". Tap on Recents: it turns green. Double tap on Screenshots: it turns red and appears under Excluded. | Select albums · Tap to include, double tap to exclude | "Tap Select to choose albums. Tap an album to include it, and double tap to exclude it. On an iPhone a photo can sit in several albums, so you can back up Recents and still leave out Screenshots." |
| 5 | 0:46–0:56 | SCREEN: back on Backup: "Selected: Recents (All)" and "Excluded: Screenshots". CALLOUT "Excluded wins". | Selected: Recents · Excluded: Screenshots | "An excluded album always wins. Anything in Screenshots stays on the phone, even though it is also in Recents." |
| 6 | 0:56–1:08 | DIAGRAM: a phone node with three photo chips; each chip gets a short checksum tag; two tags match chips already on "frameleaf.home" and are skipped (grey), one uploads (teal line). | Checked, not uploaded twice | "The first time, the app works out a checksum for every file. Anything already on the server, from the web or another device, is skipped, so nothing uploads twice." |
| 7 | 1:08–1:24 | SCREEN: tap the gear icon (tooltip "Backup Options"); the "Backup Options" page shows "Network Requirements" with two switches, both off: "Videos", "Use cellular data to backup videos" and "Photos", "Use cellular data to backup photos". Tap Photos on; snackbar "Network requirements changed, resetting backup queue". | Backup Options · Network Requirements | "The gear icon opens Backup Options. Out of the box the app uploads only on Wi-Fi. Under Network Requirements, turn on Videos or Photos to let that kind of file use cellular data." |
| 8 | 1:24–1:42 | SCREEN (Android frame): Backup Options with a third group, "Background Options": "Charging", "Background backup requires the device to be charging", and "Delay new assets backup: 30 seconds" above a four-step slider. Drag the slider through 5 seconds, 30 seconds, 2 minutes, 10 minutes, then back to 30 seconds. | Background Options · Charging · Delay new assets backup | "On Android there are two more choices under Background Options. Charging runs background backup only while the phone is charging. Delay new assets backup waits five seconds, thirty seconds, two minutes or ten minutes after a new photo." |
| 9 | 1:42–1:54 | SCREEN (iPhone frame): back on Backup, tap the "Enable Backup" switch on; the Remainder count starts to fall. Tap "View Details"; "Upload Details" lists files as they go. | Enable Backup · View Details | "Back on the Backup page, turn on Enable Backup. Uploading starts, and View Details shows each file as it goes." |
| 10 | 1:54–2:07 | DIAGRAM: two lanes. Top lane "Foreground · app open" with a solid teal line from phone to server. Bottom lane "Background · the phone decides" with a dashed line and a small clock that pauses and resumes. | Foreground · Background | "There are two kinds of backup. Foreground backup runs while the app is open and stops when you leave it. Background backup is scheduled by your phone's operating system, which decides when it runs." |
| 11 | 2:07–2:18 | CARD headline "When new photos upload"; bullets one per clause: "When you open or resume the app" · "From time to time in the background". | When new photos upload | "So new photos upload whenever you open or resume the app, and from time to time in the background. The next episode shows how to help background backup along." |
| 12 | 2:18–2:27 | CARD headline "Backup settings"; bullets one per clause: "Include and exclude albums" · "Wi-Fi only unless you allow cellular" · "Android: charging and a delay". | Backup settings | "Include and exclude albums, keep uploads on Wi-Fi unless you allow cellular, and on Android set charging and a delay." |
| 13 | 2:27–2:30 | LOGO OUTRO | Next: MOBILE-02 · Background backup on iOS and Android | "Next up: Background backup on iOS and Android." |

## Voice-over (clean)

The Frameleaf mobile app backs up your phone to your own server. Tap the cloud icon at the top of the timeline to open Backup.

Backup Albums says which albums are included and which are left out. Total, Backup and Remainder count what you selected, what is already on the server, and what is still to go.

Tap Select to choose albums. Tap an album to include it, and double tap to exclude it. On an iPhone a photo can sit in several albums, so you can back up Recents and still leave out Screenshots.

An excluded album always wins. Anything in Screenshots stays on the phone, even though it is also in Recents.

[beat]

The first time, the app works out a checksum for every file. Anything already on the server, from the web or another device, is skipped, so nothing uploads twice.

[pause]

The gear icon opens Backup Options. Out of the box the app uploads only on Wi-Fi. Under Network Requirements, turn on Videos or Photos to let that kind of file use cellular data.

On Android there are two more choices under Background Options. Charging runs background backup only while the phone is charging. Delay new assets backup waits five seconds, thirty seconds, two minutes or ten minutes after a new photo.

Back on the Backup page, turn on Enable Backup. Uploading starts, and View Details shows each file as it goes.

[pause]

There are two kinds of backup. Foreground backup runs while the app is open and stops when you leave it. Background backup is scheduled by your phone's operating system, which decides when it runs.

So new photos upload whenever you open or resume the app, and from time to time in the background. The next episode shows how to help background backup along.

Include and exclude albums, keep uploads on Wi-Fi unless you allow cellular, and on Android set charging and a delay.

[pause]

Next up: Background backup on iOS and Android.

## Production notes

- Prerequisites: the Frameleaf mobile app installed and signed in (START-06), frameleaf.home reachable on Wi-Fi. Backup settings are per app on the phone; nothing carries over from another app (docs/docs/administration/frameleaf-app-transition.md).
- Name on screen: the current mobile source still carries the previous app name in a few strings, including the "Sync albums" subtitle in Backup Options ("…to the selected albums on …") and the battery optimisation dialog. In beat 7, frame Backup Options on Network Requirements and crop the Backup Albums Synchronization group below it (album sync is MOBILE-03). Never read or zoom a string that shows the old name; crop or blur it. Keep the home screen and app icon label out of shot.
- Network Requirements: docs/docs/features/mobile-backup.md says uploads happen only on Wi-Fi by default and can be changed "in the backup settings page". The current UI calls the group "Network Requirements" with two switches, "Videos" (Use cellular data to backup videos) and "Photos" (Use cellular data to backup photos), both off by default. Changing either resets the upload queue ("Network requirements changed, resetting backup queue").
- Background Options appear only on Android (backup_settings.dart `if (CurrentPlatform.isAndroid)`): "Charging" and "Delay new assets backup: {duration}" with four steps, 5 seconds, 30 seconds, 2 minutes and 10 minutes. Capture them on an Android phone, and keep that phone's status bar and launcher out of shot.
- Album selection: the hint "Tap to include, double tap to exclude" and the info panel "Assets can scatter across multiple albums. Thus, albums can be included or excluded during the backup process." The Backup Albums card shows "Selected: " and "Excluded: " lists.
- Enable Backup: the partial doc describes a button; the current app shows an "Enable Backup" switch in a card. On Android with backup on, two links appear under it for notifications and battery optimisation (MOBILE-02). Upload errors show "Upload error for {count} assets".
- Deduplication and the two backup mechanisms are from mobile-backup.md (Deduplication) and FAQ.mdx ("Why does foreground backup stop when I navigate away from the app?"). Uploads also happen "when you open or resume the app, as well as periodically in the background" (mobile-backup.md Overview).
- Settings → Backup ("Manage upload settings") opens the same options as the gear icon.
