# MOBILE-04 · Sync only selected photos

| Field | Value |
| --- | --- |
| Series | On your phone |
| Type | How-to |
| Target length | 1:45 |
| Audience | Phone users with large libraries who want to choose exactly which photos go to Frameleaf |
| Features demonstrated | Show storage indicator on asset tiles (Settings → Photo Grid), the three cloud icons, selecting an album for backup, Library → On this device, multi-select and Upload |
| Source docs | docs/docs/features/mobile-app.mdx (Sync only selected photos), docs/docs/FAQ.mdx (cloud icons), mobile/lib/presentation/actions/upload.action.dart, i18n/en.json (theme_setting_asset_list_storage_indicator_title, on_this_device, upload) |
| Capture checklist | The Frameleaf mobile app signed in as Taylor to frameleaf.home, dark theme, iPhone 16 Pro frame. The device album Camera selected on the Backup page with Enable Backup off. In Camera: "Emma at the lake", "Wildflowers" and "Family hike" not yet backed up; "Moraine Lake" backed up and still on the phone; one server-only photo, "Cabin at dusk", visible in the timeline. Show storage indicator off at the start. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:17 | LOWER-THIRD; SCREEN (iPhone frame): the Frameleaf mobile app's timeline, scrolling gently. | Sync only selected photos · On your phone | "You do not have to back up everything. When the phone holds far more than you want to keep, the Frameleaf mobile app lets you pick exactly which photos go to your server." |
| 3 | 0:17–0:29 | SCREEN: profile picture → Settings → "Photo Grid". Tap "Show storage indicator on asset tiles" on. Back on the timeline, small cloud icons appear in the corner of each tile. | Photo Grid · Show storage indicator on asset tiles | "First, open Settings, then Photo Grid, and turn on Show storage indicator on asset tiles. A small cloud icon then appears in the corner of every tile." |
| 4 | 0:29–0:47 | ZOOM on three tiles side by side, each with a CALLOUT: Wildflowers with a crossed-out cloud "Only on this phone"; Moraine Lake with a cloud and tick "On the server and on this phone"; Cabin at dusk with a plain cloud "Only on the server". | Only on this phone · On both · Only on the server | "A crossed-out cloud means the photo is only on this phone and not backed up. A cloud with a tick means it is on the server and still on the phone. A plain cloud means it is only on the server." |
| 5 | 0:47–0:58 | SCREEN: the Backup page, "Selected: Camera", with the "Enable Backup" switch off. HIGHLIGHT on the Camera entry. | Selected: Camera | "Next, make sure the album is selected on the Backup page, as in the first episode of this series. Automatic backup can stay off." |
| 6 | 0:58–1:07 | SCREEN: the Library tab, scrolled to "On this device"; tap the album Camera. | Library · On this device | "Albums selected for backup are listed in the Library tab, under On this device. Open Camera." |
| 7 | 1:07–1:25 | SCREEN: long-press Emma at the lake, then tap Wildflowers and Family hike, all with crossed-out clouds. The menu at the bottom shows "Upload"; tap it. The three icons change to the cloud with a tick. | Upload | "Long-press to select the photos you want, the ones with the crossed-out cloud, and tap Upload in the menu at the bottom. When they finish, their icons change to the cloud with a tick. Anything already on the server is skipped." |
| 8 | 1:25–1:42 | CARD headline "Sync only selected photos"; bullets one per clause: "Show storage indicator on asset tiles" · "Select the album for backup" · "On this device, then Upload". | Sync only selected photos | "Turn on the storage indicator, select the album for backup, then upload just what you choose from On this device. The rest stays on the phone until you decide." |
| 9 | 1:42–1:45 | LOGO OUTRO | Next: MOBILE-05 · Free Up Space | "Next up: Free Up Space." |

## Voice-over (clean)

You do not have to back up everything. When the phone holds far more than you want to keep, the Frameleaf mobile app lets you pick exactly which photos go to your server.

First, open Settings, then Photo Grid, and turn on Show storage indicator on asset tiles. A small cloud icon then appears in the corner of every tile.

A crossed-out cloud means the photo is only on this phone and not backed up. A cloud with a tick means it is on the server and still on the phone. A plain cloud means it is only on the server.

[pause]

Next, make sure the album is selected on the Backup page, as in the first episode of this series. Automatic backup can stay off.

Albums selected for backup are listed in the Library tab, under On this device. Open Camera.

Long-press to select the photos you want, the ones with the crossed-out cloud, and tap Upload in the menu at the bottom. When they finish, their icons change to the cloud with a tick. Anything already on the server is skipped.

[pause]

Turn on the storage indicator, select the album for backup, then upload just what you choose from On this device. The rest stays on the phone until you decide.

[pause]

Next up: Free Up Space.

## Production notes

- Sources: mobile-app.mdx "Sync only selected photos" (Settings → Photo Grid → Show Storage indicator on asset tiles; albums listed under Library → On this device; select local-only photos and tap Upload in the bottom menu) and the FAQ table of cloud icons. The on-screen setting reads "Show storage indicator on asset tiles" (lower-case "storage"); the doc capitalises it.
- Icons (thumbnail_tile.widget.dart): crossed-out cloud for a local-only item, plain cloud for a server-only item, cloud with a tick for an item on both. FAQ.mdx says a plain cloud also covers a photo "deleted from this device after upload"; the VO keeps to "only on the server".
- "Automatic backup can stay off" (beat 5): the doc asks only for the album to be selected on the Backup page (steps 1 and 2 of the backup partial) before uploading by hand; Enable Backup is step 3 and is not part of this flow. If Enable Backup were on, every photo in Camera would upload by itself, which is not what this episode shows.
- The Upload action appears only when the selection contains photos on this phone that are not yet backed up (upload.action.dart); items already on the server are left out. The server still checks checksums, so nothing is stored twice.
- Multi-select is unavailable in read-only mode (MOBILE-06); make sure it is off.
