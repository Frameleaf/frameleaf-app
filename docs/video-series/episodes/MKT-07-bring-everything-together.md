# MKT-07 · Bring everything together

| Field | Value |
| --- | --- |
| Series | Meet Frameleaf |
| Type | Marketing |
| Target length | 1:15 |
| Audience | People whose photos are split between Google Photos, iCloud and an older server |
| Features demonstrated | Import Google Photos (Stage, Scan, Reconcile, Report), iCloud Photos import with stacked Apple edits and Live Photos, server-to-server migration with the audit report, preservation packages |
| Source docs | docs/docs/features/google-photos-import.md, docs/docs/guides/icloud-photos-sync.md, docs/docs/administration/server-migration.md, docs/docs/features/preservation.md |
| Capture checklist | Dark theme as Taylor; Settings → Import & protection → Google Photos & server imports → Preview import workflow with a small Takeout export staged, scanned and on the Reconcile → Report tab; Settings → Utilities → iCloud Photos with connection "Personal iCloud" and the album Summer in the Rockies selected; a terminal running the migrate command from old-server to frameleaf.home; Settings → Storage & originals → Move or export your library → Prepare migration checklist at the Review stage with an audit report showing Pass; Settings → Import & protection → Originals & preservation with one verified package |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:11 | LOWER-THIRD "Bring everything together · Meet Frameleaf". DIAGRAM: three blue nodes appear as the VO names them, Google Photos, iCloud Photos and "old-server"; teal arrows draw from each into a green node "frameleaf.home" at centre. | — | "Your photos are scattered: some in Google Photos, some in iCloud, some on an old server. Frameleaf brings them home." |
| 3 | 0:11–0:20 | SCREEN: Import Google Photos wizard, Stage tab. CURSOR chooses three Takeout ZIP files; upload bars run. At 0:15 the browser tab closes and reopens; the same files are chosen again and the bars continue from where they were. CALLOUT: "Carries on where it stopped". Tabs Stage · Scan · Reconcile visible. | Import Google Photos | "Import Google Photos takes a Takeout export whole: originals, dates, descriptions, locations and albums. If the upload drops, it carries on." |
| 4 | 0:20–0:28 | SCREEN: Reconcile → Report tab. Counts: imported 1,204, matched 312, skipped 3. ZOOM on "matched 312"; CALLOUT: "Already in your library, matched by checksum, not copied". | Matched, not copied | "Photos you already have are matched by checksum, not copied again. Run it twice and you still get one of everything." |
| 5 | 0:28–0:36 | SCREEN: Settings → Utilities → iCloud Photos. Connection "Personal iCloud"; "Load libraries and albums" done; album Summer in the Rockies ticked; CURSOR clicks "Save" then "Run now" (0:31). Cut at 0:33 to a viewer stack: Emma at the lake with its Apple-edited version stacked, stack badge visible. | iCloud Photos | "iCloud Photos imports on the server and keeps going after you close the browser. Apple edits arrive stacked with their originals." |
| 6 | 0:36–0:41 | SCREEN: same iCloud Photos page; CALLOUT on the album selector: "Start with a small album". | Start with a small album | "Live Apple accounts are still being verified, so start with a small album." |
| 7 | 0:41–0:50 | TERMINAL: `node packages/cli/dist/index.js migrate --ledger ./library-move.sqlite --serve` typed; output lines "Resuming: 91204/153792 assets already on frameleaf.home." then a progress line. Keys are never shown (they come from environment variables read earlier). Ctrl+C at 0:46; the command is typed again and resumes. | migrate | "Moving from another server is one command you can stop and restart. Nothing is stored twice, and nothing is deleted from the old server." |
| 8 | 0:50–0:58 | SCREEN: Settings → Storage & originals → Move or export your library → Prepare migration checklist, Review stage. CURSOR clicks "Open audit report" and picks library-move.sqlite.audit.json. Verdict "Pass"; Originals "Verified by checksum 153,792 of 153,792". ZOOM on the verdict. | Pass | "When it finishes, an audit checks every file by checksum. You retire the old server only when the report says Pass." |
| 9 | 0:58–1:07 | SCREEN: Settings → Import & protection → Originals & preservation. CURSOR clicks "Preview preservation manifest", chooses the whole library, "Start export" (1:01). Cut at 1:04 to the package list: one package marked Verified; buttons "Verify files" and "Download package". | Preservation package · Verified | "For the copy you keep elsewhere, a preservation package holds your originals and everything you know about them, verified file by file." |
| 10 | 1:07–1:12 | TITLE on the dark canvas over a slow pan across the timeline. | Bring everything together. | "Bring everything together." |
| 11 | 1:12–1:15 | LOGO OUTRO with the tagline lockup; the leaf sways 4° once. | YOUR MEMORIES GROW FURTHER | "Frameleaf. Your memories grow further." |

## Voice-over (clean)

Your photos are scattered: some in Google Photos, some in iCloud, some on an old server. Frameleaf brings them home.

Import Google Photos takes a Takeout export whole: originals, dates, descriptions, locations and albums. If the upload drops, it carries on.

Photos you already have are matched by checksum, not copied again. Run it twice and you still get one of everything.

[beat]

iCloud Photos imports on the server and keeps going after you close the browser. Apple edits arrive stacked with their originals.

Live Apple accounts are still being verified, so start with a small album.

[beat]

Moving from another server is one command you can stop and restart. Nothing is stored twice, and nothing is deleted from the old server.

When it finishes, an audit checks every file by checksum. You retire the old server only when the report says Pass.

For the copy you keep elsewhere, a preservation package holds your originals and everything you know about them, verified file by file.

[pause]

Bring everything together.

[beat]

Frameleaf. Your memories grow further.

## Production notes

- Beat 3 and 4: google-photos-import.md. Open the wizard from Settings → Import & protection → "Google Photos & server imports" → "Preview import workflow" (the word Preview here is the shipped label, not a HOLD marker). Uploads resume when the same files are chosen again; items already in the library are matched by checksum and never copied twice. Seed a small Takeout export (three ZIPs) containing a mix of new photos and photos already in the library so "matched" is non-zero. Counts on screen are sample data.
- Beat 5: the current utility label is "iCloud Photos" (Settings → Utilities → Import); icloud-photos-sync.md still calls it "iCloud Photos Sync". The steps "Add connection", "Sign in to iCloud", "Load libraries and albums", "Save", "Run now" are documented. Never show the Apple account email, password or verification code; capture after sign-in. Apple edits import as separate assets stacked with the original ("Import available Apple-edited versions and stack them with originals", on by default).
- Beat 6 is required by STYLE-GUIDE.md section 4: icloud-photos-sync.md states "A live Apple-account sync has not yet been verified. Start with a small album before selecting a large library." The connector also needs the administrator's bridge setup (icloud-photos-server-setup.md) and an HTTPS address.
- Beat 7 TERMINAL: server-migration.md provides the keys through IMMICH_FROM_URL, IMMICH_TO_URL, IMMICH_FROM_KEY and IMMICH_TO_KEY; never put a key in the command or on screen. The doc's example resume line is "Resuming: 148291/512773 assets already on B."; the on-screen line uses the sample library's 153,792 items and the server name frameleaf.home. Nothing is deleted from the source; each finished item is committed to the ledger so the same command resumes.
- Beat 8: the web app never runs a migration; it opens the audit report read-only in the browser (Settings → Storage & originals → Move or export your library → Prepare migration checklist → Review → Open audit report). "Pass" appears only when every original was verified by checksum; Dry run and Incomplete never pass.
- Beat 9: preservation.md places the feature under Settings → Originals & preservation (administrators also under Import & protection) and lists "Preview preservation manifest", "Start export", "Verify files", "Download package". A written package is Not verified until "Verify files" has run; capture after verification. The doc also mentions "Utilities → Preservation verification", which the integration inventory says does not exist; do not look for it.
- A preservation package is not a server backup (no accounts, sharing, settings, pets, memories or Studio projects); the narration says "the copy you keep elsewhere", not "backup".
