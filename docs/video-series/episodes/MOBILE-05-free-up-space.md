# MOBILE-05 · Free Up Space

| Field | Value |
| --- | --- |
| Series | On your phone |
| Type | How-to |
| Target length | 2:30 |
| Audience | Phone users running out of storage whose photos are already backed up to Frameleaf |
| Features demonstrated | Free Up Space (Settings), Keep on device (Keep favorites, Keep albums, Always keep Photos or Videos), Select cutoff date (30 days to 3 years, Custom date), Scan, Move to device trash with Preview, the confirmation, the phone's own trash, iCloud Shared Albums excluded, the iCloud Photos warning |
| Source docs | docs/docs/features/mobile-app.mdx (Free Up Space, iCloud Photos, External App Dependencies), mobile/lib/widgets/settings/free_up_space_settings.dart, i18n/en.json (free_up_space*, keep_*, always_keep*, cutoff_*, cleanup_*) |
| Capture checklist | The Frameleaf mobile app signed in as Taylor to frameleaf.home, dark theme, iPhone 16 Pro frame. Backup complete for Recents; about 1,200 backed-up photos older than one year still on the phone; several favourites; the device album "Summer in the Rockies". Stage the scan result "Found 1,284 backed up assets (6.2 GB)" or whatever the capture phone reports. Free Up Space opened fresh (no keep settings except the default favourites). |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD; SCREEN (iPhone frame): profile picture → Settings; HIGHLIGHT then tap on "Free Up Space" ("Free up device storage"). | Free Up Space · On your phone | "Free Up Space clears room on your phone by removing photos and videos that are already safely backed up to your Frameleaf server. Open Settings, then Free Up Space." |
| 3 | 0:16–0:28 | ZOOM on the intro card: "Move backed-up photos and videos to your device's trash to free up space. Your copies on the server remain safe." | Your copies on the server remain safe | "It only touches items that are already on the server and not in its trash. They go to your phone's own trash, and the copies on the server stay safe." |
| 4 | 0:28–0:47 | SCREEN: tap the "Keep on device" card; it expands with "Choose what stays on your device when freeing up space.", the switch "Keep favorites" (on), "Keep albums" with an album list, and "Always keep" with three segments: —, Photos, Videos. Tap Summer in the Rockies under Keep albums; the card's subtitle reads "Keeping: Favorites, Keeping 1 album". | Keep on device · Keep favorites · Keep albums · Always keep | "Start with Keep on device. Keep favorites is on by default. Keep albums holds everything in the albums you pick, whatever else you choose. Always keep can keep every photo or every video on the phone." |
| 5 | 0:47–0:57 | CALLOUT over the Keep albums list: "Messaging app albums are kept by default". | Messaging app albums kept by default | "Albums from messaging apps such as WhatsApp are kept by default, because their chats show pictures from those files." |
| 6 | 0:57–1:12 | SCREEN: step 1 "Select cutoff date" with "Keep photos from the last…" and the choices 30 days, 60 days, 90 days, 1 year, 2 years, 3 years, then "Custom date". Tap "1 year"; the step shows the date; tap "Continue". | Select cutoff date · 1 year | "Step one is Select cutoff date. Choose how much to keep on the phone, from thirty days to three years, or pick a custom date. Only items from before that date are considered." |
| 7 | 1:12–1:27 | SCREEN: step 2 "Scan": "Scan for backed up assets matching your date and keep settings." and the note "iCloud Shared Albums are excluded from the scan". Tap "Scan"; the step reads "Found 1,284 backed up assets (6.2 GB)". | Scan · Found 1,284 backed up assets (6.2 GB) | "Step two is Scan. The app looks for backed-up items that match your date and keep settings, and says how many it found and how much space they use. On an iPhone, iCloud Shared Albums are left out." |
| 8 | 1:27–1:38 | SCREEN: step 3 "Move to device trash" (summary box cropped to its first sentence). Tap "Preview"; the page "Assets to remove (1,284)" shows the grid; scroll, then back. | Move to device trash · Preview | "Step three is Move to device trash. Before anything happens, tap Preview and look through every item that will be removed." |
| 9 | 1:38–1:53 | SCREEN: tap "Move to device trash"; the dialog "Remove from this device?" (body cropped) → tap "Confirm"; "Moving to trash..." → dialog "Success", "Moved 1,284 assets to device trash", "To fully reclaim storage space, open the system gallery app and empty the trash", "Done". | Moved to device trash · Empty the trash | "Then tap Move to device trash and confirm. Items go to the phone's own trash, not straight to deletion. To use the space right away, empty that trash in the phone's gallery app." |
| 10 | 1:53–2:02 | SCREEN: a messaging app's photo picker, blurred and generic, with a CALLOUT "Removed photos no longer appear here"; cut to the Frameleaf mobile app's share sheet. | Share from Frameleaf | "Removed photos no longer show up in other apps, so share them from the Frameleaf mobile app instead." |
| 11 | 2:02–2:18 | CARD in amber, headline "Using iCloud Photos?"; bullets one per clause: "iCloud syncs both ways" · "Removing here removes from iCloud and your other devices" · "If iCloud is one of your backups, use Optimize iPhone Storage instead". | Using iCloud Photos? | "If you use iCloud Photos, stop here first. iCloud syncs both ways, so removing a photo from your iPhone removes it from iCloud and your other Apple devices too. If iCloud is one of your backups, use Optimize iPhone Storage instead." |
| 12 | 2:18–2:27 | CARD headline "Your server holds the copy"; bullet: "Keep the server itself backed up". | Your server holds the copy | "After Free Up Space, your server holds the copy you rely on, so keep the server itself backed up." |
| 13 | 2:27–2:30 | LOGO OUTRO | Next: MOBILE-06 · Read-only mode and marking sensitive on the phone | "Next up: Read-only mode and marking sensitive on the phone." |

## Voice-over (clean)

Free Up Space clears room on your phone by removing photos and videos that are already safely backed up to your Frameleaf server. Open Settings, then Free Up Space.

It only touches items that are already on the server and not in its trash. They go to your phone's own trash, and the copies on the server stay safe.

[beat]

Start with Keep on device. Keep favorites is on by default. Keep albums holds everything in the albums you pick, whatever else you choose. Always keep can keep every photo or every video on the phone.

Albums from messaging apps such as WhatsApp are kept by default, because their chats show pictures from those files.

[pause]

Step one is Select cutoff date. Choose how much to keep on the phone, from thirty days to three years, or pick a custom date. Only items from before that date are considered.

Step two is Scan. The app looks for backed-up items that match your date and keep settings, and says how many it found and how much space they use. On an iPhone, iCloud Shared Albums are left out.

Step three is Move to device trash. Before anything happens, tap Preview and look through every item that will be removed.

Then tap Move to device trash and confirm. Items go to the phone's own trash, not straight to deletion. To use the space right away, empty that trash in the phone's gallery app.

Removed photos no longer show up in other apps, so share them from the Frameleaf mobile app instead.

[pause]

If you use iCloud Photos, stop here first. iCloud syncs both ways, so removing a photo from your iPhone removes it from iCloud and your other Apple devices too. If iCloud is one of your backups, use Optimize iPhone Storage instead.

After Free Up Space, your server holds the copy you rely on, so keep the server itself backed up.

[pause]

Next up: Read-only mode and marking sensitive on the phone.

## Production notes

- Sources: mobile-app.mdx "Free Up Space": only items backed up to the server and not in its trash; Cutoff date (on or before the date); Keep favorites and Keep albums (WhatsApp-related albums kept by default on Android); Keep on device with Always keep; Scan & Review; deletion to the phone's native Trash or Recycle Bin, in batches; empty the trash to reclaim space; removed photos no longer appear in other apps; iCloud Photos warning and Shared Album exclusion; "Provided the server is healthy and backed up, assets removed by Free Up Space can always be accessed."
- UI versus doc: the doc treats "Keep on device" as the Always keep setting. In the current app (free_up_space_settings.dart) "Keep on device" is the whole card that holds Keep favorites, Keep albums and Always keep (—, Photos, Videos), and its subtitle summarises the choices ("Keeping: …"). The doc's "Scan & Review" is steps 2 and 3 in the app: "Scan", then "Move to device trash" with a "Preview" button that opens "Assets to remove ({count})". Narrate the app's labels.
- Crop two strings that still name the previous app: the step 3 summary ("… to remove from your local device. Photos will remain accessible from the … app.") and the confirmation body ("… found {count} assets …"). Show the step title, the first sentence of the summary if it fits, the dialog title "Remove from this device?" and its buttons.
- Cutoff presets: 30, 60 and 90 days, 1, 2 and 3 years, plus Custom date. The scan step's iCloud note appears only on iOS.
- Default keep albums: the app pre-selects any album whose name contains WhatsApp, Telegram, Signal, Messenger, Viber, WeChat or Line (mobile/lib/services/cleanup.service.dart `getDefaultKeepAlbumIds`); the doc mentions WhatsApp on Android. On Android the WhatsApp album appears in Keep albums only when album sync is on (mobile-app.mdx, External App Dependencies; MOBILE-03). If the capture phone has no such album, show the CALLOUT only.
- iCloud: after Free Up Space an iCloud Photos item stays only on the server and in the phone's Recently Deleted for 30 days; iCloud Shared Album items are excluded because iCloud does not allow removing them. Name Apple's "Optimize iPhone Storage" setting exactly as the doc does; do not show Apple's settings screens.
- Beat 10: do not show a real messaging app's branding; use a blurred, generic picker.
- Batch sizes (2000 per batch on Android, 10000 on iOS) are in the doc and are not narrated.
