# MOBILE-06 · Read-only mode and marking sensitive on the phone

| Field | Value |
| --- | --- |
| Series | On your phone |
| Type | How-to |
| Target length | 2:00 |
| Audience | Parents and anyone who hands their phone to someone else, and people who keep some photos private |
| Features demonstrated | Read-only mode (long-press the profile picture, Settings → Advanced → Read-only mode, what it turns off), Mark NSFW and Mark safe in the multi-select menu, what a locked photo is hidden from, the Locked folder on the phone with the PIN |
| Source docs | docs/docs/features/mobile-app.mdx (Read-only/kid Mode), docs/docs/features/fork-privacy-suite.md (Mobile Actions), docs/docs/features/locked.md, mobile/lib/presentation/actions/nsfw.action.dart, i18n/en.json (advanced_settings_readonly_mode_*, readonly_mode_*, mark_nsfw*, mark_safe*, enter_your_pin_code*) |
| Capture checklist | The Frameleaf mobile app signed in as Taylor to frameleaf.home, dark theme, iPhone 16 Pro frame. Taylor already has a PIN (set on the web in PRIV-02). Landscape photos only for the hidden examples: "Glacier creek" and "Summit view", both owned by Taylor and visible in the timeline; "Through the forest" already locked. Read-only mode off at the start. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD; SCREEN (iPhone frame): the Frameleaf mobile app's timeline. | Read-only mode and marking sensitive on the phone · On your phone | "Two ways to make the phone safer to hand around: read-only mode for browsing, and marking photos sensitive so they stay out of sight." |
| 3 | 0:13–0:26 | SCREEN: long-press on the profile picture at the top of the timeline; toast "Read-only mode enabled". Tap the picture: the profile sheet shows "Read-only mode enabled. Long-press the user avatar icon to exit." | Read-only mode enabled | "Long-press your profile picture at the top of the timeline to turn on read-only mode. The app confirms it, and your profile sheet reminds you how to leave it." |
| 4 | 0:26–0:42 | SCREEN: long-press on a tile; nothing is selected. Cut to Settings → Advanced: the switch "Read-only mode" (on) with its subtitle. Back on the timeline, long-press the profile picture again; toast "Read-only mode disabled". | Settings › Advanced › Read-only mode · Read-only mode disabled | "In read-only mode photos can only be viewed. Selecting several at once, sharing, casting and deleting are all turned off. The same switch is in Settings, then Advanced. Long-press the picture again to turn it off." |
| 5 | 0:42–0:58 | SCREEN: long-press Glacier creek, tap Summit view; scroll the menu at the bottom to "Mark NSFW" and tap it. Toast "2 marked NSFW"; both tiles leave the timeline. | Mark NSFW · 2 marked NSFW | "To hide photos, select them and scroll the menu at the bottom to Mark NSFW. It works on photos you own. They are locked, the same as Mark Sensitive on the web, and leave the timeline." |
| 6 | 0:58–1:16 | CARD headline "A locked photo is hidden from"; bullets one per clause: "Your timeline, albums, search, the map and memories" · "Partners, album and space members, shared links" · "It keeps its albums and place". | A locked photo is hidden from | "Until you unlock with your PIN, a locked photo stays out of your timeline, albums, search, the map and memories. Partners, album members and shared links never see it. It keeps its albums and its place, so nothing moves." |
| 7 | 1:16–1:32 | SCREEN: the Library tab → "Locked Folder"; the screen "Enter your PIN code" with "Enter your PIN code to access the locked folder"; the PIN is typed (dots only). The locked grid shows Through the forest, Glacier creek and Summit view. | Locked Folder · Enter your PIN code | "To see them, open the Library tab and choose Locked Folder, then enter your PIN. Every locked item is listed there, whether it was marked on the phone, on the web, or flagged by detection." |
| 8 | 1:32–1:46 | SCREEN: in Locked Folder, long-press Summit view; tap "Mark safe" in the menu; toast "1 marked safe". Cut to the timeline: Summit view is back in its place. | Mark safe · 1 marked safe | "To bring one back, select it inside Locked Folder and tap Mark safe. It returns to the timeline, and detection will not lock it again." |
| 9 | 1:46–1:57 | CARD headline "On the phone"; bullets one per clause: "Read-only mode for lending the phone" · "Mark NSFW to lock" · "Mark safe to bring it back". | On the phone | "Read-only mode for lending the phone, Mark NSFW to lock a photo, and Mark safe to bring it back." |
| 10 | 1:57–2:00 | LOGO OUTRO | Next: OPS-01 · The settings Command Center | "Next up: The settings Command Center." |

## Voice-over (clean)

Two ways to make the phone safer to hand around: read-only mode for browsing, and marking photos sensitive so they stay out of sight.

Long-press your profile picture at the top of the timeline to turn on read-only mode. The app confirms it, and your profile sheet reminds you how to leave it.

In read-only mode photos can only be viewed. Selecting several at once, sharing, casting and deleting are all turned off. The same switch is in Settings, then Advanced. Long-press the picture again to turn it off.

[pause]

To hide photos, select them and scroll the menu at the bottom to Mark NSFW. It works on photos you own. They are locked, the same as Mark Sensitive on the web, and leave the timeline.

Until you unlock with your PIN, a locked photo stays out of your timeline, albums, search, the map and memories. Partners, album members and shared links never see it. It keeps its albums and its place, so nothing moves.

[beat]

To see them, open the Library tab and choose Locked Folder, then enter your PIN. Every locked item is listed there, whether it was marked on the phone, on the web, or flagged by detection.

To bring one back, select it inside Locked Folder and tap Mark safe. It returns to the timeline, and detection will not lock it again.

[pause]

Read-only mode for lending the phone, Mark NSFW to lock a photo, and Mark safe to bring it back.

[pause]

Next up: The settings Command Center.

## Production notes

- Read-only mode: mobile-app.mdx ("long-press the profile icon or go to Settings > Advanced > Read-only Mode"). The current labels are "Read-only mode" (lower-case "mode") with the subtitle "Enables the read-only mode where the photos can be only viewed, things like selecting multiple images, sharing, casting, delete are all disabled. Enable/Disable read-only via user avatar from the main screen"; toasts "Read-only mode enabled" and "Read-only mode disabled"; the profile sheet line "Read-only mode enabled. Long-press the user avatar icon to exit." Read-only mode is a setting in this app on this phone only.
- Mark NSFW and Mark safe (nsfw.action.dart) act on owned server items in the multi-select menu; toasts "{count} marked NSFW" and "{count} marked safe", or a partial count when some fail. On the server, Mark NSFW records the review and locks the item with the reason Marked, the same lock as Mark Sensitive on the web (server image-enrichment.service `updateAssetEnrichment`); stacks and live photos lock as a whole. Mark safe on a locked item needs a PIN-unlocked session, releases Marked and Detected locks only, and records the review as safe, so detection does not lock it again (locked.md, "The Locked view"). Items locked as "Moved from old Locked folder" stay locked; unlock those from Locked on the web with Unmark Sensitive (PRIV-02).
- What hides (locked.md "Who sees a locked item"): while locked, the item is left out of the timeline, albums, search, the map, memories, people, pets and downloads; partners, album and space members and shared links never see it; your own devices still sync it, marked locked, which is why it appears in the phone's Locked Folder. Locking never changes albums, stack, favourites, tags or place.
- Do not use the phone's "Move to locked folder" or "Remove from locked folder" in the capture. "Move to locked folder" also offers to delete the phone's own copy and its dialog text still names the previous app. "Remove from locked folder" only changes the stored visibility, and on a Frameleaf server that never unlocks an item (server asset.service `applyLockedVisibility`; locked.md "Setting any other visibility never unlocks"), so the item would stay hidden. Flag this app behaviour for the mobile team.
- Locked Folder title: mobile/lib/presentation/pages/library.page.dart and locked_folder.page.dart use the translation key `locked_folder` ("Locked Folder"), which commit 3f67e0e461 (FL-83) removed from i18n/en.json. Until the key is restored the mobile translation build fails or the title is missing; restore it before capture.
- PIN screens: "Enter your PIN code" and "Enter your PIN code to access the locked folder"; a first-time user sees "Setup a PIN code". Biometric unlock ("Use biometric") may appear; either is fine. Never show the digits.
- Sensitive examples are landscapes only (style guide, section 6). The sample library already has Through the forest locked.
- Web-side locking, detection and PIN rules are covered in PRIV-02 to PRIV-04.
