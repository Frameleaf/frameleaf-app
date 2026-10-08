# CARE-08 · iCloud Photos: import your library

| Field | Value |
| --- | --- |
| Series | Library Care |
| Type | How-to |
| Target length | 2:45 |
| Audience | Anyone moving an Apple photo library into their own Frameleaf account |
| Features demonstrated | iCloud Photos (Utilities → Import), prerequisites, Add connection, Connect account (Apple account email, Password), Verify connection with the six-digit code, Check device approval, first sync, Photo libraries, Source albums with Find albums, Include (Edited versions, Hidden photos, Recover external files into managed storage), Sync limits (Connection name, Check every (hours), Concurrent downloads, Staging budget (GiB)), Save sync preferences, Sync now, Pause, Resume, Cancel, Retry, Rescan source, Sync progress, Reconciliation, Review connection (Check saved session, Disconnect) |
| Source docs | docs/docs/guides/icloud-photos-sync.md |
| Capture checklist | Dark theme, Taylor signed in on frameleaf.home served over HTTPS; the administrator has completed iCloud Photos server setup. A test Apple account with a small library including the album "Summer in the Rockies", a trusted device for the code, and "Access iCloud Data on the Web" on. Capture sign-in with every credential field blurred. Settings → Utilities → iCloud Photos starting empty ("Connect an iCloud library"); later states with a paused first sync, the album selected, a resumed run and a finished run with a Reconciliation summary. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD "iCloud Photos: import your library · Library Care". SCREEN: Settings → Utilities, group "Import", CURSOR clicks "iCloud Photos" ("Manage connections, source albums, sync schedules and import results."). Empty state "Connect an iCloud library" with "Import originals into your own Frameleaf account." and the button "Add connection". | Utilities → Import → iCloud Photos | "iCloud Photos imports your Apple photo library into your own Frameleaf account. Downloads run on the server and carry on after you close the browser. Find it in Settings, under Utilities." |
| 3 | 0:16–0:29 | CARD "Before you start": bullets appear per clause, "Your administrator has set up iCloud Photos", "Frameleaf opened over HTTPS", "Access iCloud Data on the Web turned on, trusted device at hand". | Before you start | "Before you start, your administrator must set it up, Frameleaf must be open over HTTPS, and Access iCloud Data on the Web must be on for your trusted Apple device." |
| 4 | 0:29–0:36 | The CARD gains a fourth line in amber: "Live Apple-account sync not yet verified · start with a small album". | Start with a small album | "Live Apple-account sync has not been verified yet, so start with a small album." |
| 5 | 0:36–0:46 | CURSOR clicks "Add connection". Notice "Connection added."; the connection card "iCloud connection 1" with the button "Connect account". Toolbar: "Connection" select, "Add connection", "Refresh". | Add connection · Connect account | "Choose Add connection. You can keep several connections. Then choose Connect account." |
| 6 | 0:46–1:01 | Dialog "iCloud connection": "Sign in with your Apple account to choose libraries and albums. Frameleaf keeps an encrypted session, never your password." Fields "Apple account email" and "Password" (both blurred). CURSOR clicks "Connect account". Next step: "Six-digit verification code" (digits blurred) with "Enter the code shown on your trusted Apple device. The code is sent once and not kept."; CURSOR clicks "Verify connection". | Apple account email · Password · Verify connection | "Enter your Apple account email and password, and choose Connect account. Frameleaf keeps an encrypted session, never your password. Enter the six-digit code from your trusted device, then choose Verify connection." |
| 7 | 1:01–1:10 | Alternate dialog state: "Approve web access on a trusted Apple device, then check the approval here. Each check makes one request." Button "Check device approval". CALLOUT "Text-message codes are not supported". | Check device approval | "If Apple asks for approval instead, approve it on your device and choose Check device approval. Text-message codes are not supported." |
| 8 | 1:10–1:23 | Notice "Account connected. The first sync has started." Sync progress panel: badge "Syncing", "Reading the library", link "Open in Activity". HIGHLIGHT "Pause", CURSOR clicks; notice "Sync paused. It stops after the item in progress."; badge "Paused". | The first sync has started · Pause | "Connecting starts the first sync straight away, and until you choose, every library is included. To start small, choose Pause while it reads your library." |
| 9 | 1:23–1:38 | ZOOM on "Photo libraries": "Personal library" and "Shared library"; CURSOR leaves only Personal library ticked. "Source albums" with the hint "Leave albums unselected to import all albums in the selected libraries."; CURSOR types "Summer" into "Find albums" and ticks "Summer in the Rockies". | Photo libraries · Source albums · Find albums | "Your libraries and albums appear as the library is read. Tick a library, then use Find albums to pick one album. Leaving albums unticked imports everything in the libraries you chose." |
| 10 | 1:38–1:55 | ZOOM on "Include": "Edited versions" (ticked), "Hidden photos" (unticked), "Recover external files into managed storage" (unticked). Then "Sync limits": "Connection name" edited to "Personal iCloud", "Check every (hours)" 24, "Concurrent downloads" 1, "Staging budget (GiB)" 20, hint "Downloads wait when the staging budget is full. Originals are matched before importing." | Include · Sync limits | "Under Include, Edited versions brings Apple edits in as stacks. Hidden photos arrive Locked, so saving asks you to unlock first. Under Sync limits, name the connection and set how often it checks, how many downloads run at once, and the staging budget." |
| 11 | 1:55–2:07 | CURSOR clicks "Save sync preferences": notice "Connection updated." CURSOR clicks "Resume": notice "Sync resumed."; progress "212 of 1,048 items settled" with a teal bar. | Save sync preferences · Resume | "Choose Save sync preferences, then Resume. Progress is saved as it goes, so the counts survive closing the page or restarting the server." |
| 12 | 2:07–2:22 | HIGHLIGHT each control as named: "Sync now", "Pause", "Cancel", "Retry", "Rescan source". Under the progress panel: "Next sync 20 Sep 2026, 10:30". | Sync now · Pause · Cancel · Retry · Rescan source | "The controls sit below. Sync now starts a run. Pause and Cancel stop one and keep what is imported. Retry tries failed items again, and Rescan source checks everything against iCloud again without importing twice." |
| 13 | 2:22–2:34 | ZOOM on "Reconciliation": "Imported 1,016 · matched 28 · review 2 · skipped 2", two rows with their reasons and "Open", and the policy line "Nothing is written back to iCloud. Photos deleted in iCloud stay here, and no original is overwritten; anything that needs a decision is listed above." | Reconciliation | "Reconciliation sums up each run and lists anything that needs a decision. Nothing is written back to iCloud, and photos deleted there stay here." |
| 14 | 2:34–2:42 | CURSOR clicks "Review connection": dialog with "Disconnecting stops new imports and forgets the saved Apple session. Photos already in Frameleaf are retained.", buttons "Check saved session" and "Disconnect". CURSOR closes it. | Review connection · Check saved session · Disconnect | "Review connection checks the saved session or disconnects. Imported photos always stay." |
| 15 | 2:42–2:45 | LOGO OUTRO | Next: CARE-09 · iCloud Photos: recovery, stacks and setup | "Next up: iCloud Photos: recovery, stacks and setup." |

## Voice-over (clean)

iCloud Photos imports your Apple photo library into your own Frameleaf account. Downloads run on the server and carry on after you close the browser. Find it in Settings, under Utilities.

Before you start, your administrator must set it up, Frameleaf must be open over HTTPS, and Access iCloud Data on the Web must be on for your trusted Apple device.

Live Apple-account sync has not been verified yet, so start with a small album.

Choose Add connection. You can keep several connections. Then choose Connect account.

Enter your Apple account email and password, and choose Connect account. Frameleaf keeps an encrypted session, never your password. Enter the six-digit code from your trusted device, then choose Verify connection.

If Apple asks for approval instead, approve it on your device and choose Check device approval. Text-message codes are not supported.

Connecting starts the first sync straight away, and until you choose, every library is included. To start small, choose Pause while it reads your library.

Your libraries and albums appear as the library is read. Tick a library, then use Find albums to pick one album. Leaving albums unticked imports everything in the libraries you chose.

Under Include, Edited versions brings Apple edits in as stacks. Hidden photos arrive Locked, so saving asks you to unlock first. Under Sync limits, name the connection and set how often it checks, how many downloads run at once, and the staging budget.

Choose Save sync preferences, then Resume. Progress is saved as it goes, so the counts survive closing the page or restarting the server.

[pause]

The controls sit below. Sync now starts a run. Pause and Cancel stop one and keep what is imported. Retry tries failed items again, and Rescan source checks everything against iCloud again without importing twice.

Reconciliation sums up each run and lists anything that needs a decision. Nothing is written back to iCloud, and photos deleted there stay here.

Review connection checks the saved session or disconnects. Imported photos always stay.

[pause]

Next up: iCloud Photos: recovery, stacks and setup.

## Production notes

- Docs vs interface (flag icloud-photos-sync.md for an update): the guide names "Utilities → iCloud Photos Sync", "Sign in to iCloud", "Verify code", "Load libraries and albums", "Save", "Run now", "Cancel current run", "Retry failures", "Reconcile and rescan", "Disconnect account" and "Recent verified results → View media". The current tool is "iCloud Photos" with "Connect account", "Verify connection", "Save sync preferences", "Sync now", "Cancel", "Retry", "Rescan source", "Disconnect" (inside "Review connection") and "Reconciliation" rows with "Open". Settings are "Edited versions", "Hidden photos", "Recover external files into managed storage", "Check every (hours)", "Concurrent downloads" and "Staging budget (GiB)" (the guide gives bytes).
- There is no "Load libraries and albums" button: signing in queues a sync straight away (server: "Signing in is the owner asking for a sync"), and the page says "Your photo libraries appear here after the first sync reads the account. Until then, every library is included." Beats 8 to 11 (Pause, choose one album, Save sync preferences, Resume) are how the current interface honours the guide's "Start with a small album before selecting a large library." Items fetched before the pause stay imported; the policy line confirms nothing is overwritten.
- Beat 4 is required by STYLE-GUIDE.md section 4: the guide states "A live Apple-account sync has not yet been verified. Start with a small album before selecting a large library."
- Prerequisites (guide): the administrator must enable the connector (icloud-photos-server-setup.md; otherwise "iCloud Photos is unavailable"), Frameleaf must be served over HTTPS ("Signing in to iCloud needs a secure (HTTPS) connection to this server."), "Access iCloud Data on the Web" on the trusted device, trusted-device codes only. Advanced Data Protection may ask for approval again when access expires.
- Never show the Apple account email, password or code; blur every credential field and capture with a test account. Passwords and codes are cleared after submission; the server keeps an encrypted session. "Check saved session" checks that access is still valid.
- Defaults: Check every 24 hours, Concurrent downloads 1 (maximum 4, also limited by the server), Staging budget 20 GiB (separate from the account quota). Up to 20 connections per account.
- Hidden photos and external recovery open a "Review import access" dialog ("Allow and save"); hidden photos arrive Locked, so saving sends you to unlock first.
- The Library care queue "Import review" leads here. Status badges include "Syncing", "Paused", "Awaiting verification", "Awaiting device approval", "Waiting for iCloud", "Retrying shortly", "Needs attention", "Completed". Counts on screen are sample data.
- Recovery of existing photos, Apple edits as stacks, Live Photos and administrator setup are covered in CARE-09.
