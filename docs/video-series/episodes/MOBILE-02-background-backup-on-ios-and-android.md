# MOBILE-02 · Background backup on iOS and Android

| Field | Value |
| --- | --- |
| Series | On your phone |
| Type | Learn |
| Target length | 2:30 |
| Audience | Phone users whose photos only seem to upload when they open the app |
| Features demonstrated | Foreground and background backup, the operating system scheduler, iOS Background App Refresh, Low Power Mode, Android battery optimisation (the Battery optimizations dialog and Show me how), the notifications link, Charging in Background Options, iCloud originals downloaded to a temporary cache |
| Source docs | docs/docs/features/mobile-backup.md, docs/docs/FAQ.mdx (Mobile App), mobile/lib/pages/backup/backup.page.dart, i18n/en.json (backup_controller_page_background_battery_info_*, battery_optimization_backup_reliability, notification_backup_reliability) |
| Capture checklist | The Frameleaf mobile app signed in as Taylor to frameleaf.home, dark theme, with backup enabled for Recents. iPhone 16 Pro frame for the iOS beats: the Settings app at General → Background App Refresh, and Low Power Mode off. An Android phone frame for the Android beats, with notifications not yet allowed and battery optimisation still on, so both links show under Enable Backup. A Recents album on the iPhone that includes photos stored only in iCloud. Store listings, launchers and app icon labels out of shot. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:15 | LOWER-THIRD; TITLE "Who decides when backup runs?" with the subheading "Your phone's operating system, not the app". | Background backup on iOS and Android · On your phone | "Background backup is how the Frameleaf mobile app uploads new photos while it is closed. This episode explains why it sometimes waits, and what you can do about it." |
| 3 | 0:15–0:31 | DIAGRAM: node "Frameleaf mobile app" (green) with two paths to "frameleaf.home" (teal). The upper path "App open" is a solid line. The lower path passes through a gate node "Operating system" (blue outline) with a small clock; the line pulses only when the gate opens. | Foreground · Background | "Foreground and background backup are separate. While the app is open, it uploads by itself. Once you leave, the job passes to the phone's operating system, which decides when the background task runs and for how long." |
| 4 | 0:31–0:43 | CARD headline "Why it waits"; bullets one per clause: "Saving battery comes first" · "Other apps compete for the same time" · "Each phone maker sets its own rules". | Why it waits | "Most of those decisions are about saving battery. Other apps compete for the same background time, and each phone maker sets its own rules." |
| 5 | 0:43–0:59 | SCREEN (iPhone frame): the Settings app → General → Background App Refresh. HIGHLIGHT on the switch for the Frameleaf mobile app, already on. CALLOUT "Settings › General › Background App Refresh". | Settings › General › Background App Refresh | "On an iPhone, open the Settings app, then General, then Background App Refresh, and make sure it is on for the Frameleaf mobile app. Without it, the app cannot back up in the background at all." |
| 6 | 0:59–1:15 | CARD headline "Give iOS a reason to run it"; bullets one per clause: "Turn off Low Power Mode when you do not need it" · "Turn off background refresh for apps that do not need it" · "Open the app more often". | Give iOS a reason to run it | "iOS chooses when that task runs, and the app cannot change that. Low Power Mode can stop background tasks, so turn it off when you do not need it. Turn off background refresh for apps that do not need it, and open Frameleaf often." |
| 7 | 1:15–1:30 | SCREEN (Android frame): the Backup page with Enable Backup on. ZOOM on the two links beneath it: "Enable notifications to improve background backup reliability" and "Disabling battery optimizations can improve the reliability of background backup". | Two links under Enable Backup | "On Android, battery optimisation is the usual reason background backup stops. With backup on, the Backup page shows two links: one to allow notifications, and one about battery optimisations." |
| 8 | 1:30–1:45 | SCREEN: tap the battery link; the dialog "Battery optimizations" opens with the buttons "Show me how" and "OK" (dialog body cropped to its title and buttons). HIGHLIGHT on "Show me how". | Battery optimizations · Show me how | "Some phone makers limit background work very strictly. Show me how opens a guide for your model, so you can turn battery optimisation off for the app. Allowing notifications helps too." |
| 9 | 1:45–1:55 | SCREEN (Android frame): Backup Options, Background Options, the "Charging" switch on. CALLOUT "Waits for the charger". | Charging | "Check Background Options as well. With Charging on, background backup waits until the phone is plugged in." |
| 10 | 1:55–2:11 | DIAGRAM: iPhone node, a cloud node "iCloud Photos" (blue), a small box "App cache" beside the phone, and "frameleaf.home". A photo chip travels iCloud → App cache → frameleaf.home, then the cache box empties. | iCloud originals | "iPhones that use iCloud Photos need one more thought. When a selected album holds photos kept only in iCloud, the app downloads each original to a temporary cache, uploads it, then empties the cache." |
| 11 | 2:11–2:22 | CARD headline "Plan for iCloud originals"; bullets one per clause: "Extra data and storage while it runs" · "Keep space free and stay on Wi-Fi". | Plan for iCloud originals | "That uses extra data and space while it runs, so keep some storage free and stay on Wi-Fi for a large library." |
| 12 | 2:22–2:27 | CARD headline "In short"; bullets: "iPhone: Background App Refresh on" · "Android: battery optimisation off". | In short | "Background refresh on for iPhone, battery optimisation off for Android." |
| 13 | 2:27–2:30 | LOGO OUTRO | Guide: Mobile Backup | "The written guide is linked below." |

## Voice-over (clean)

Background backup is how the Frameleaf mobile app uploads new photos while it is closed. This episode explains why it sometimes waits, and what you can do about it.

[pause]

Foreground and background backup are separate. While the app is open, it uploads by itself. Once you leave, the job passes to the phone's operating system, which decides when the background task runs and for how long.

Most of those decisions are about saving battery. Other apps compete for the same background time, and each phone maker sets its own rules.

[pause]

On an iPhone, open the Settings app, then General, then Background App Refresh, and make sure it is on for the Frameleaf mobile app. Without it, the app cannot back up in the background at all.

iOS chooses when that task runs, and the app cannot change that. Low Power Mode can stop background tasks, so turn it off when you do not need it. Turn off background refresh for apps that do not need it, and open Frameleaf often.

[pause]

On Android, battery optimisation is the usual reason background backup stops. With backup on, the Backup page shows two links: one to allow notifications, and one about battery optimisations.

Some phone makers limit background work very strictly. Show me how opens a guide for your model, so you can turn battery optimisation off for the app. Allowing notifications helps too.

Check Background Options as well. With Charging on, background backup waits until the phone is plugged in.

[pause]

iPhones that use iCloud Photos need one more thought. When a selected album holds photos kept only in iCloud, the app downloads each original to a temporary cache, uploads it, then empties the cache.

That uses extra data and space while it runs, so keep some storage free and stay on Wi-Fi for a large library.

[beat]

Background refresh on for iPhone, battery optimisation off for Android.

[pause]

The written guide is linked below.

## Production notes

- Concept order for this Learn episode: what background backup is (beat 2), why it waits (3 and 4), how each platform works and what to do (5 to 9), then the iCloud case (10 and 11). The prerequisite, backup enabled with albums selected, is MOBILE-01.
- Sources: FAQ.mdx "Why does foreground backup stop when I navigate away from the app?" and "Why is background backup on iOS not working?" (Background App Refresh, Low Power Mode, turning off background refresh for other apps, using the app more often); mobile-backup.md Platform Specific Features (Android battery optimisation, charging, delay; iOS Background App Refresh, iOS manages background tasks, iCloud Backup to the cache folder).
- The two Android links and the dialog come from mobile/lib/pages/backup/backup.page.dart (`_BackupFooter`): they appear only on Android with backup on, and only while notifications or battery optimisation are not yet allowed. The dialog's body text still names the previous app, so crop it to the title "Battery optimizations" and the buttons "Show me how" and "OK". "Show me how" opens an external guide site for phone makers; do not show or name the site on screen.
- Name on screen: the phone's own Settings list shows the installed app's display name. If the build on the capture phone does not yet show "Frameleaf" there, crop the Background App Refresh row to its icon and switch, or use a mock of the Settings path; never show the old name. Keep app store pages and icon labels out of shot.
- iCloud: the app pulls iCloud-only originals into its cache while hashing and uploading, then empties the cache; this can use extra data and storage (mobile-backup.md, iCloud Backup). The string "Downloading from iCloud" can appear in the upload details while this runs.
- Say "battery optimisation" in narration; the Android UI spells it "optimizations".
- Outro CTA on screen: `Guide: Mobile Backup`; the producer fills the public URL.
