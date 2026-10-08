# MOBILE-03 · Album sync

| Field | Value |
| --- | --- |
| Series | On your phone |
| Type | How-to |
| Target length | 2:00 |
| Audience | Phone users who organise photos into albums on the phone and want the same albums in Frameleaf |
| Features demonstrated | Backup Albums Synchronization, Sync albums, Creating linked albums, matching album names and merging, shared albums staying shared, Organize into albums for earlier uploads, one-way and per-user sync |
| Source docs | docs/docs/features/mobile-app.mdx (Album Sync), docs/docs/features/mobile-backup.md (Backup album synchronization), mobile/lib/widgets/settings/backup_settings/backup_settings.dart, i18n/en.json (sync_albums, organize_into_albums, creating_linked_albums) |
| Capture checklist | The Frameleaf mobile app signed in as Taylor to frameleaf.home, dark theme, iPhone 16 Pro frame, backing up Recents, Camera and a device album "Summer in the Rockies". On the web, Taylor's album "Summer in the Rockies" already exists and is shared with Jamie and Emma; no "Camera" album exists yet. About forty photos from Camera were backed up before album sync was turned on. Sync albums off at the start. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:18 | LOWER-THIRD; SPLIT: left, the phone's albums Recents, Camera and Summer in the Rockies; right, the Frameleaf web Albums page. Matching names light up in green on both sides as the VO ends. | Album sync · On your phone | "Album sync mirrors the albums you back up from your phone as albums on your Frameleaf server, so your library is organised the way your phone is. It stays off until you turn it on." |
| 3 | 0:18–0:33 | SCREEN (iPhone frame): Backup → gear icon → Backup Options, scrolled to "Backup Albums Synchronization" (subtitle cropped). Tap "Sync albums" on. Cut to Select albums: tap Camera again to confirm it; the overlay "Creating linked albums..." shows briefly. | Backup Albums Synchronization · Sync albums | "Open Backup Options and find Backup Albums Synchronization. Turn on Sync albums. Each album you back up gets an album with the same name on the server, and new uploads land in it automatically." |
| 4 | 0:33–0:48 | SPLIT: the phone's Summer in the Rockies album beside the web album of the same name, which shows the avatars of Jamie and Emma. New photos slide from the phone side into the web album. | Same name, same album | "If an album with that name already exists on the server, the phone's photos are merged into it. When that album is shared, the new photos are shared too, so everyone in it sees them." |
| 5 | 0:48–1:03 | SCREEN (iPhone frame): Backup Options, the row "Organize into albums" with "Put existing photos into albums using current sync settings" and its sync button. Tap the sync button; a spinner turns. Cut to the web: the new album "Camera" fills with the forty earlier uploads. | Organize into albums | "Photos you backed up before turning this on stay where they are. Tap Organize into albums once to put those earlier uploads into their matching albums. On the web they are ordinary albums you own." |
| 6 | 1:03–1:19 | CARD headline "One way, from the phone"; bullets one per clause: "Photos you add on the phone are added" · "Deleting or moving on the phone is not copied" · "Not even when you sync again". | One way, from the phone | "Sync runs one way, from the phone to the server. Photos you add to a phone album are added on the server. Deleting or moving photos on the phone is not copied across, even when you sync again." |
| 7 | 1:19–1:29 | CARD headline "Your sync is yours"; bullets one per clause: "Each user syncs their own albums" · "Partners are never mixed in". | Your sync is yours | "Album sync belongs to each person. It never mixes with other users or with partners, even on the same server." |
| 8 | 1:29–1:39 | SCREEN (web): the Albums page, with a CALLOUT reading "Folders on a computer? See external libraries (OPS-09)". | Phone only | "Album sync is a phone feature. For folders on a computer, use external libraries, covered in the Running Frameleaf series." |
| 9 | 1:39–1:57 | CARD headline "Album sync"; bullets one per clause: "Sync albums: same names on the server" · "Organize into albums for earlier uploads" · "One way, one person". | Album sync | "Turn on Sync albums, organise earlier uploads once, and remember that it only ever adds, one way and one person at a time." |
| 10 | 1:57–2:00 | LOGO OUTRO | Next: MOBILE-04 · Sync only selected photos | "Next up: Sync only selected photos." |

## Voice-over (clean)

Album sync mirrors the albums you back up from your phone as albums on your Frameleaf server, so your library is organised the way your phone is. It stays off until you turn it on.

Open Backup Options and find Backup Albums Synchronization. Turn on Sync albums. Each album you back up gets an album with the same name on the server, and new uploads land in it automatically.

If an album with that name already exists on the server, the phone's photos are merged into it. When that album is shared, the new photos are shared too, so everyone in it sees them.

[beat]

Photos you backed up before turning this on stay where they are. Tap Organize into albums once to put those earlier uploads into their matching albums. On the web they are ordinary albums you own.

[pause]

Sync runs one way, from the phone to the server. Photos you add to a phone album are added on the server. Deleting or moving photos on the phone is not copied across, even when you sync again.

Album sync belongs to each person. It never mixes with other users or with partners, even on the same server.

Album sync is a phone feature. For folders on a computer, use external libraries, covered in the Running Frameleaf series.

[pause]

Turn on Sync albums, organise earlier uploads once, and remember that it only ever adds, one way and one person at a time.

[pause]

Next up: Sync only selected photos.

## Production notes

- Prerequisites: backup set up as in MOBILE-01 with Recents, Camera and Summer in the Rockies selected. The web album "Summer in the Rockies" must be owned by Taylor and shared with Jamie and Emma so the merge and sharing behaviour shows.
- Label discrepancy: docs/docs/features/mobile-app.mdx and mobile-backup.md call the backfill button "Reorganize into album". The current app shows the row "Organize into albums" with the subtitle "Put existing photos into albums using current sync settings" and a sync button (backup_settings.dart `_AlbumSyncActionButton`); it appears only while Sync albums is on. Narrate the current label.
- The "Sync albums" subtitle in the current app still names the previous app ("Create and upload your photos and videos to the selected albums on …"). Crop to the title and switch; never show or read the subtitle.
- "Creating linked albums..." overlays the Select albums page while server albums are created for newly chosen backup albums with Sync albums on.
- Behaviour points come from mobile-app.mdx "Album Synchronization Highlights": one-way sync; name matching merges into an existing album; a shared album stays shared; the album's structure is set when first created, and later deletes or moves on the phone are not reflected even with Sync albums; sync is per user and not shared with partners; mobile only, with external libraries suggested for computers.
- Beat 8 is a CALLOUT over the web Albums page only; do not open the external libraries settings here (OPS-09 covers them).
- Android note: mobile-app.mdx says WhatsApp albums only appear in Free Up Space's Keep albums list when album sync is on; MOBILE-05 relies on that.
