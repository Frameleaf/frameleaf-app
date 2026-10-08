# CARE-09 · iCloud Photos: recovery, stacks and setup

| Field | Value |
| --- | --- |
| Series | Library Care |
| Type | Learn |
| Target length | 2:45 |
| Audience | iCloud Photos users who want to understand what the import does to their library, and the administrators who set it up |
| Features demonstrated | Same-asset recovery (reuse, repair, import, trashed items), external-library recovery boundary, Apple edits as stacks, edit version limit, Live Photos with independent movie recovery, one-way boundaries and unsupported items, administrator bridge setup summary (Compose overlay, HTTPS, secrets, private staging, backup, small-album test) |
| Source docs | docs/docs/guides/icloud-photos-sync.md, docs/docs/guides/icloud-photos-server-setup.md |
| Capture checklist | Dark theme, Taylor (administrator) on frameleaf.home. An iCloud Photos connection "Personal iCloud" after a finished run whose Reconciliation includes "Glacier creek.HEIC · Missing original restored from iCloud" (seed: remove Glacier creek's original, keep the same photo in the test iCloud album), and the admin links "Resolved missing media" and "Resolved damaged media". Viewer on "Emma at the lake" as a stack of the original and an Apple-cropped edit. Viewer on "Lake reflection" as a Live Photo. A terminal on the server host in the Frameleaf deployment folder (paths blurred). |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:17 | LOWER-THIRD "iCloud Photos: recovery, stacks and setup · Library Care". DIAGRAM: blue node "iCloud" → node "HTTPS bridge" → green node "frameleaf.home"; a teal arrow runs one way; a return arrow is drawn and crossed out. | One way: iCloud → Frameleaf | "iCloud Photos is more than an import. It can repair photos you already have, keep Apple edits and Live Photos together, and it only ever copies in one direction." |
| 3 | 0:17–0:33 | DIAGRAM: an iCloud file compared with the library by content. Four outcomes appear as named: "Same content, healthy → reused", "No match → imported as new", "Missing or damaged, checksum matches → repaired", "In your trash → left there". CALLOUT "Compared by content, never by name". | Reused · Imported · Repaired · Left in trash | "Every iCloud file is compared with your library by its content, never its name. A healthy match is reused, not copied again. Anything without a match is imported. A photo you trashed stays in the trash." |
| 4 | 0:33–0:49 | SCREEN: Utilities → iCloud Photos, Reconciliation. ZOOM on the row "Glacier creek.HEIC · Missing original restored from iCloud · Open". HIGHLIGHT the links "Resolved missing media" and "Resolved damaged media"; CURSOR clicks the first: Missing media opens with Glacier creek marked "Resolved". | Missing original restored from iCloud · Resolved | "If your copy is missing or damaged but its saved checksum matches, the file is downloaded, validated, and used to repair the same photo. It keeps its identity, albums and links, and the Library Care finding is resolved." |
| 5 | 0:49–0:59 | CARD "Exact originals only": bullets "Resized or edited copies cannot stand in", "External library: needs Recover external files into managed storage". | Exact originals only | "Only the exact original can do this; a resized or edited version cannot. For an external library, it also needs Recover external files into managed storage." |
| 6 | 0:59–1:17 | SCREEN: viewer on "Emma at the lake" with the stack badge; the stack strip shows the original and Apple's cropped version. CALLOUT "Apple edit: its own photo, stacked with the original". CURSOR steps between the two members. | Edited versions → stacks | "With Edited versions on, each Apple edit arrives as its own photo, stacked with its original. The latest Apple edit can show on top, unless you chose the cover yourself. Reverting in Apple never deletes your original." |
| 7 | 1:17–1:27 | CARD "What arrives": bullets "Apple's finished image, not its editing recipe", "Up to 20 edit versions per photo". | Finished image · up to 20 versions | "Apple's finished image is imported, not its editing recipe, and up to twenty edit versions are kept for each photo." |
| 8 | 1:27–1:41 | SCREEN: viewer on "Lake reflection"; the Live Photo plays its motion. DIAGRAM beside it: still + movie → one Live Photo; a second line "Movie damaged → recovered on its own". | Live Photos stay together | "Live Photos are linked using Apple's own identifiers, so the movie plays inside the still instead of appearing as a separate item. If only the movie is damaged, it is recovered on its own." |
| 9 | 1:41–1:55 | CARD "Boundaries": bullets "One way: nothing written back, deletions kept here", "Not supported: Shared Albums, text-message codes, edited Live Photo pairs", "Captions, locations and time zones are not read". | Boundaries | "Know the boundaries. Shared Albums, text-message codes and edited Live Photo pairs are not supported, and captions and locations are not read. Live Apple-account sync has not yet been verified." |
| 10 | 1:55–2:11 | TERMINAL: `docker compose --env-file .env -f docker-compose.yml -f icloud-sync.compose.yml config --quiet` typed, no output; then the same with `up -d --build`; container "icloud-bridge" reports Started. DIAGRAM overlay: server → private network → "icloud-bridge" (no published port) → blue "Apple over HTTPS". | icloud-sync.compose.yml · no published port | "For administrators: the connector runs through a separate HTTPS bridge, added with a Compose overlay. The bridge has no published port, and Frameleaf itself must be served over HTTPS." |
| 11 | 2:11–2:27 | CARD "Bridge setup": bullets "Bearer token, encryption key, private CA and certificate", "Private staging folder, outside every media folder, mode 0700", "A non-root user that owns your media". Secret values never shown. | Bridge setup | "Generate its token, encryption key and certificates once, and keep the key, because stored sessions depend on it. Staging must be a private folder, outside every media folder." |
| 12 | 2:27–2:42 | CARD "Before a large import": bullets "Back up database, media, staging and key together", "Test a small album: sign-in, a Live Photo, an Apple edit", "Run it twice, then pause and resume". | Before a large import | "Back up the database, media, staging and key together. Then test a small album: sign in, a Live Photo, an Apple edit, a repeated run, and a pause and resume." |
| 13 | 2:42–2:45 | LOGO OUTRO | Guide: iCloud Photos Sync | "The written guide is linked below." |

## Voice-over (clean)

iCloud Photos is more than an import. It can repair photos you already have, keep Apple edits and Live Photos together, and it only ever copies in one direction.

Every iCloud file is compared with your library by its content, never its name. A healthy match is reused, not copied again. Anything without a match is imported. A photo you trashed stays in the trash.

If your copy is missing or damaged but its saved checksum matches, the file is downloaded, validated, and used to repair the same photo. It keeps its identity, albums and links, and the Library Care finding is resolved.

Only the exact original can do this; a resized or edited version cannot. For an external library, it also needs Recover external files into managed storage.

With Edited versions on, each Apple edit arrives as its own photo, stacked with its original. The latest Apple edit can show on top, unless you chose the cover yourself. Reverting in Apple never deletes your original.

Apple's finished image is imported, not its editing recipe, and up to twenty edit versions are kept for each photo.

Live Photos are linked using Apple's own identifiers, so the movie plays inside the still instead of appearing as a separate item. If only the movie is damaged, it is recovered on its own.

[pause]

Know the boundaries. Shared Albums, text-message codes and edited Live Photo pairs are not supported, and captions and locations are not read. Live Apple-account sync has not yet been verified.

For administrators: the connector runs through a separate HTTPS bridge, added with a Compose overlay. The bridge has no published port, and Frameleaf itself must be served over HTTPS.

Generate its token, encryption key and certificates once, and keep the key, because stored sessions depend on it. Staging must be a private folder, outside every media folder.

Back up the database, media, staging and key together. Then test a small album: sign in, a Live Photo, an Apple edit, a repeated run, and a pause and resume.

[pause]

The written guide is linked below.

## Production notes

- CTA card: `Guide: iCloud Photos Sync` (the guide's title; the in-app name is now "iCloud Photos"). The administrator guide, "iCloud Photos Sync: server setup", can sit beside it in the description. The producer fills in the public docs URLs.
- Recovery (beats 3 to 5) follows icloud-photos-sync.md "What happens to existing photos?" and media-recovery.md: a database checksum alone never skips recovery; the destination file is verified, and failed validation never counts as a repair. The repaired photo keeps its ID and associations. Reconciliation outcome strings in the build: "Existing original matched", "Missing original restored from iCloud", "Damaged original restored from iCloud", "Imported". The guide's "Recent verified results → View media" is now the Reconciliation list with "Open", and administrators get "Resolved missing media" and "Resolved damaged media" links.
- External libraries: the guide's setting "Allow damaged external-library matches to become managed assets" is labelled "Recover external files into managed storage" in the current build. It never overwrites the external file; without it the match needs review and the staged copy is kept.
- Stacks: the current Apple edit becomes the displayed member only when that does not override your manual stack choice or local work; reverting in Apple removes the edit preference but never deletes the original, older imported versions or your own Frameleaf edits. The 20-version ceiling raises a review ("Too many edited versions kept for this photo").
- Live Photos: the movie becomes the still's motion component through the native Live Photo link using Apple source identities. Files imported another way are paired with Live Photo pairing (CARE-05); the guide still calls it "Utilities → Relink live photos". An ambiguous iCloud pair shows "Ambiguous Live Photo pair" with a Review button that opens Live Photo pairing.
- Boundaries (guide, Supported media and limits): Apple Shared Albums, sharing permissions and Smart Albums unsupported; SMS verification unsupported; edited Live Photo pairing, Apple adjustment rendering and slow-motion or HDR edit behaviour unsupported; captions, locations and time zone fields not supported by the verified adapter (existing values are kept); at most 100 libraries and 10,000 albums per connection, 200 albums shown at once; interrupted downloads restart the file from the beginning.
- Setup (icloud-photos-server-setup.md): the Compose overlay `deployment/icloud-sync.compose.yml`; the doc's commands use `--env-file` and absolute paths for the base Compose file and the overlay. The TERMINAL beat shows a shortened form; blur real paths. Secrets are generated once with restrictive permissions; the encryption key is a base64-encoded 32-byte key and must never be regenerated on update; keep the CA signing key offline and renew the bridge certificate before it expires. Server-wide limits (defaults): 4 concurrent downloads, 100 GiB staging, 1 GiB free space kept. Do not name the server environment variables on screen.
- The setup guide describes the required build in internal repository terms; do not narrate or show that wording. Say only that the server needs a Frameleaf build that includes iCloud Photos and its bridge.
- Backup (setup guide): database, managed media, retained source resources, private staging state and encryption key as one consistent checkpoint; restoring a database without its key means signing in to Apple again. Never attach tokens, keys or session values to support reports.
