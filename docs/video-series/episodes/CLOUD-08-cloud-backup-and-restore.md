# CLOUD-08 · Cloud backup and restore

| Field | Value |
| --- | --- |
| Series | Frameleaf Cloud |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators who want an off-site, encrypted copy of their library and a way to bring things back |
| Features demonstrated | Settings → Frameleaf Cloud → Cloud backup, Set up cloud backup (Destination: Frameleaf-managed storage or Your own S3-compatible bucket; Encryption key: Generate a key for me or I'll maintain my own key, Keep a copy on this server; Recovery kit shown once, encrypted copy with Frameleaf; Claim bucket; Finish setup), first run, Back up now, Verify, Restore (Items, Albums, Whole library with RESTORE), Library Care Backup column (In backup, Not in any backup, Restore from backup), verified restores |
| Source docs | /Users/adamtaylor/Github/frameleaf-cloud/docs/cloud-backup.md |
| Capture checklist | HOLD: capture from the app design prototype (design/frameleaf/template) with the on-screen label "Preview" on every beat. Taylor (admin), server linked. Settings → Frameleaf Cloud → Cloud backup in "Cloud backup is not set up"; the "Set up cloud backup" dialog on each step (Destination, Encryption key with both choices and "Keep a copy on this server" off, Recovery kit, Claim bucket); the "Cloud backup is set up. The first run starts tonight." notice; the page after a run with Last run filled in and the Verify notice; the Restore card on Items (filter "Deleted from the library"), Albums and Whole library; Library Care → Missing media with the Backup column and the restore dialog. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:19 | LOWER-THIRD "Cloud backup and restore · Frameleaf Cloud". SCREEN (app prototype): CURSOR traces Settings → Frameleaf Cloud → Cloud backup; card "Cloud backup is not set up" ("Back up originals and the database to an encrypted bucket that only this server uses.") with the chip "Off". | Preview · Settings → Frameleaf Cloud → Cloud backup | "This is a preview of cloud backup. It copies your originals and your database to an encrypted bucket that only this server uses. You need a linked server. Open Settings, Frameleaf Cloud, then Cloud backup." |
| 3 | 0:19–0:29 | ZOOM on the benefits "Only new or changed files upload. A photo you have twice is stored once.", "Encrypted with a key for this bucket." and "One bucket per server."; CURSOR clicks "Set up cloud backup". | Preview · Set up cloud backup | "Only new or changed files upload, and a photo you have twice is stored once. Choose Set up cloud backup." |
| 4 | 0:29–0:45 | SCREEN: dialog "Set up cloud backup" with the steps Destination · Encryption key · Recovery kit · Claim bucket. ZOOM on "Where backups are stored": "Frameleaf-managed storage" and "Your own S3-compatible bucket", the managed option's sub-line blurred. CALLOUT: "Priced by what you store · from $7.99/month per TB · 1 TB minimum". CURSOR keeps Frameleaf-managed storage and clicks Continue. | Preview · Destination · Priced by what you store | "First, Destination. Choose Frameleaf-managed storage, priced by what you store, or Your own S3-compatible bucket from a provider that supports customer-provided keys. With managed storage, Frameleaf sees file names and sizes, never contents." |
| 5 | 0:45–1:04 | Step "Encryption key": ZOOM on the note ending "This choice cannot be changed later without starting a new backup." and the two choices "Generate a key for me" and "I'll maintain my own key", each with its warning line. | Preview · Generate a key for me · I'll maintain my own key | "Next, Encryption key. Generate a key for me keeps the key on this server. I'll maintain my own key creates one in your browser for you to download, and nobody can recover it for you. You can't change this later without starting a new backup." |
| 6 | 1:04–1:17 | CURSOR selects "I'll maintain my own key": "Download key file", "I saved the key file somewhere other than this server." and the toggle "Keep a copy on this server". CURSOR turns the toggle off; its help changes to "The key is never saved. After every restart backups pause until someone enters it…" and the "I understand" box appears. CURSOR switches back to "Generate a key for me". | Preview · Keep a copy on this server | "With your own key, Keep a copy on this server lets backups run unattended. Turn it off, and backups pause after every restart until someone loads the key." |
| 7 | 1:17–1:31 | Step "Recovery kit": banner "This kit is shown once"; the kit text (instance ID and fingerprint blurred); buttons Download and Print; the toggle "Also keep an encrypted copy with Frameleaf"; CURSOR ticks "I saved or printed the recovery kit." | Preview · Recovery kit · This kit is shown once | "A generated key comes with a recovery kit, shown once. Download or print it. Also keep an encrypted copy with Frameleaf protects a copy with a passphrase only you know." |
| 8 | 1:31–1:40 | Step "Claim bucket": CURSOR clicks "Claim bucket"; "Bucket claimed for this server."; CURSOR clicks "Finish setup"; notice "Cloud backup is set up. The first run starts tonight." | Preview · The first run starts tonight. | "Claim bucket ties the bucket to this server alone. Choose Finish setup, and the first run starts tonight." |
| 9 | 1:40–1:55 | SCREEN: the backup page after a run: facts Bucket, Region, Key, Key fingerprint (bucket and fingerprint blurred), Last verified; "Storage used"; "Last run … new or changed files uploaded · … already backed up". HIGHLIGHT "Back up now", then CURSOR clicks "Verify"; notice "Verified 312 sampled files against the latest manifest. Everything matched." | Preview · Back up now · Verify | "Each run uploads the newest nightly database backup, then only new or changed files. Back up now starts a run straight away, and Verify checks a sample of files against the latest backup." |
| 10 | 1:55–2:09 | ZOOM on the Restore card: Newest backup, Paired nightly database backup, Deleted items recoverable back to; the switch Items · Albums · Whole library. Items with "Deleted from the library": "Campfire evening.jpg" and "Hiking with Jamie.jpg" marked Deleted, each with "Restore". Then Albums: "Moraine Lake · 3 missing · 1 damaged" with "Repair album". | Preview · Items · Albums · Whole library | "Restore brings things back at four levels. Items returns deleted photos with their favourites, ratings, tags, albums, people and edits. Albums recreates a deleted album, or repairs a damaged one." |
| 11 | 2:09–2:21 | Whole library: banner "The server goes into maintenance mode"; ZOOM on "Type RESTORE to confirm" and "Start whole-library restore" (not clicked). | Preview · Type RESTORE to confirm | "Whole library puts the server into maintenance mode, then restores the database and every file from the backup you choose. Type RESTORE to confirm." |
| 12 | 2:21–2:34 | SCREEN: Library Care → Missing media with the Backup column: "Forest trail.ARW · In backup · Sep 25" and "Kayak.mp4 · Not in any backup". CURSOR clicks "Restore from backup" on Forest trail.ARW; the dialog shows "Restore from", "Details" and "The file is verified against its fingerprint before it touches the library…"; HIGHLIGHT "Restore all from backup" in the toolbar. | Preview · In backup · Restore from backup | "The fourth level is a single item. In Library Care, Missing media and Damaged media gain a Backup column. Restore from backup puts the original back, checked against its fingerprint first." |
| 13 | 2:34–2:42 | CARD headline "Every restore"; bullets: "Checked against its fingerprint first", "Replaced files moved aside, never deleted", "Items go back to their owner". | Every restore | "A file a restore replaces is moved aside, never deleted, and items always go back to their owner." |
| 14 | 2:42–2:45 | LOGO OUTRO | Next: CLOUD-09 · Remote access through Frameleaf Cloud | "Next up: Remote access through Frameleaf Cloud." |

## Voice-over (clean)

This is a preview of cloud backup. It copies your originals and your database to an encrypted bucket that only this server uses. You need a linked server. Open Settings, Frameleaf Cloud, then Cloud backup.

Only new or changed files upload, and a photo you have twice is stored once. Choose Set up cloud backup.

First, Destination. Choose Frameleaf-managed storage, priced by what you store, or Your own S3-compatible bucket from a provider that supports customer-provided keys. With managed storage, Frameleaf sees file names and sizes, never contents.

Next, Encryption key. Generate a key for me keeps the key on this server. I'll maintain my own key creates one in your browser for you to download, and nobody can recover it for you. You can't change this later without starting a new backup.

With your own key, Keep a copy on this server lets backups run unattended. Turn it off, and backups pause after every restart until someone loads the key.

A generated key comes with a recovery kit, shown once. Download or print it. Also keep an encrypted copy with Frameleaf protects a copy with a passphrase only you know.

Claim bucket ties the bucket to this server alone. Choose Finish setup, and the first run starts tonight.

[pause]

Each run uploads the newest nightly database backup, then only new or changed files. Back up now starts a run straight away, and Verify checks a sample of files against the latest backup.

Restore brings things back at four levels. Items returns deleted photos with their favourites, ratings, tags, albums, people and edits. Albums recreates a deleted album, or repairs a damaged one.

Whole library puts the server into maintenance mode, then restores the database and every file from the backup you choose. Type RESTORE to confirm.

The fourth level is a single item. In Library Care, Missing media and Damaged media gain a Backup column. Restore from backup puts the original back, checked against its fingerprint first.

A file a restore replaces is moved aside, never deleted, and items always go back to their owner.

Next up: Remote access through Frameleaf Cloud.

## Production notes

- Narration tone: Careful and steady; this is about not losing things. Spell "RESTORE" as a word, not letter by letter.
- HOLD dependency: cloud backup is not built in the app yet. There is no grant, upload or restore client, and a "Start a cloud backup" request from the account always fails with "cloud backup is not set up on this server" (frameleaf-cloud `docs/app-integration-as-built.md` §5 and open work). Capture every beat from the app design prototype `design/frameleaf/template` (`FrameleafCloud.jsx` Backup, BackupSetup and BackupRestore; `UtilitiesManager.jsx` for the Library Care column) and carry the on-screen label "Preview" on every beat. Publish only after cloud backup ships.
- Price discrepancy: the prototype's managed option reads "Included with your plan · 1 TB · Europe", and the set-up card says "Included with your plan". frameleaf-cloud.md and the shipped Plan page say cloud backup is priced separately by what you store, from $7.99 a month per TB with a 1 TB minimum (owner decision on FL-146). Blur the prototype's sub-line and that description; the beat 4 CALLOUT uses the Plan page's wording. The VO speaks no figure.
- Never show the "Your own S3-compatible bucket" form fields: the prototype's default "Storage address" names a storage provider's endpoint. Show the two choices only. "S3-compatible" is the protocol label printed on screen, not a provider. Never name the storage provider or its region codes; say "an encrypted bucket".
- Plan requirement is unclear: the prototype gates cloud backup behind "Cloud backup is part of a Frameleaf Cloud plan", while frameleaf-cloud.md prices backup by usage only. The VO names only the linked server; keep the gate banner out of frame.
- Key choices map to cloud-backup.md's key modes: "Generate a key for me" is server mode (recovery kit shown once, optional escrow with a passphrase of 12 characters or more, off by default); "I'll maintain my own key" with "Keep a copy on this server" on is own-stored, and with it off is own-memory, which needs the typed "I understand" because a lost key makes every backup unreadable.
- Restore levels follow cloud-backup.md's table: one item (Library Care finding or the info panel), deleted items, album, whole library. Doc discrepancies: the doc places restore at "Settings → Backup → Restore", the prototype puts the Restore card on Settings → Frameleaf Cloud → Cloud backup; the doc names the findings "Missing originals" and "Checksum mismatch", the shipped tools are "Missing media" and "Damaged media". The VO follows the UI.
- The info-panel restore ("In backup · … Restore from backup" in the viewer), Schedule & retention (7 daily, 4 weekly and 12 monthly runs by default) and "Turn off backup…" are left for the written guide.
- Blur instance IDs, bucket names (they contain the instance ID) and key fingerprints. The Library Care rows ("Forest trail.ARW", "Kayak.mp4") and the Restore rows ("Campfire evening.jpg", "Hiking with Jamie.jpg", the album "Moraine Lake") are the prototype's fixtures.
- Only the client side appears. Never show the staff console.
