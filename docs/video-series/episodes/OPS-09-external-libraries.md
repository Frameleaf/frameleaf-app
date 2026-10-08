# OPS-09 · External libraries

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators with an existing photo collection on a disk or NAS who want Frameleaf to show it without copying it |
| Features demonstrated | Mount paths in docker-compose (read-only), checking the path inside the container, Libraries area, Add external library (Library name, Owner, Import folders, Exclusion patterns, Create library), Scan library and scan progress, External Library settings (Periodic Scanning, Library watching [EXPERIMENTAL]), caveats (metadata only in Frameleaf, moved files, deleted files and trash, quotas), Remove library, troubleshooting |
| Source docs | docs/docs/features/libraries.md, docs/docs/guides/external-library.md |
| Capture checklist | frameleaf.home with a NAS share at `/mnt/nas/family-archive` holding the folders `2019`, `2020`, `Raw` and `@eaDir`, filled with landscape photos from the sample library (Lake reflection, Glacier creek, Elk in meadow, Wildflowers). Taylor signed in as administrator, dark theme. Settings → Libraries showing only "Taylor's uploads", "Jamie's uploads" and "Emma's uploads" at the start. A terminal in the Frameleaf folder. For beat 12, a throwaway library "Test import" to remove. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD "External libraries · Running Frameleaf". DIAGRAM: a NAS node "family-archive" (teal) linked by a dashed line to "Frameleaf" (green); thumbnails flow into a timeline strip while the NAS node stays unchanged; label "Indexed in place". | Indexed in place | "External libraries bring in photos that already live in folders on your server or NAS. Frameleaf indexes them in place and never moves the files." |
| 3 | 0:14–0:32 | TERMINAL: `docker-compose.yml` at `immich-server:` → `volumes:`; under `- ${UPLOAD_LOCATION}:/data` a new line is typed: `- /mnt/nas/family-archive:/mnt/media/family-archive:ro`. HIGHLIGHT `:ro`. Then `docker compose up -d`, then `docker compose exec immich-server ls /mnt/media/family-archive` prints `2019  2020  Raw  @eaDir`. | :ro = read-only | "First, mount the folder into the server container in your compose file. End the line with read-only, so Frameleaf cannot delete files or write sidecars there. Recreate the containers, then list the path inside the container to be sure it is visible." |
| 4 | 0:32–0:43 | CARD "Path rules": bullet 1 "Use /mnt/media/family-archive, not /mnt/nas/…"; bullet 2 "No symlinks across mounts; forward slashes"; bullet 3 "Same mount in any separate job container". | Path rules | "Always use the path as the container sees it, not the NAS path. Avoid symlinks, and mount the same path into any separate job container." |
| 5 | 0:43–0:55 | SCREEN: Settings → Libraries ("Connect existing folders and manage each owner’s collection."), list of three "… uploads" rows. CURSOR clicks "Add external library". Dialog "Add external library" with the notice "External libraries index files already on your server. Your source folders stay in place." CURSOR types Library name "Family archive"; opens Owner and picks Taylor; CALLOUT on "Ownership is fixed after the library is created." | Add external library · Owner | "In Settings, open Libraries and choose Add external library. Name it and pick the owner. Each library has one owner, and that cannot change later." |
| 6 | 0:55–1:11 | ZOOM on "Import folders": CURSOR clicks "Add folder" and types `/mnt/media/family-archive`. ZOOM on "Exclusion patterns": CURSOR clicks "Add exclusion" and types `**/Raw/**`, then a second one `**/\@eaDir/**`. CALLOUT "Glob patterns · escape special characters". CURSOR clicks "Check path format". | Import folders · Exclusion patterns | "Under Import folders, add the container path. Folders are scanned with all their subfolders, and a file in two folders is added once. Under Exclusion patterns, add glob patterns to skip files, such as every folder named Raw." |
| 7 | 1:11–1:23 | ZOOM on the footnotes "Saving paths and exclusions does not start a scan." and "Folder availability and permissions are checked when the server scans." CURSOR clicks "Create library"; notice "External library created". The detail panel opens: "Source · Referenced files in external folders", "Owner · Taylor · fixed", "Last scan · Not yet". CURSOR clicks "Scan library". | Create library · Scan library | "Choose Create library. Saving never starts a scan, so open the library and choose Scan library. Access and permissions are checked when the server scans." |
| 8 | 1:23–1:37 | ZOOM on "Scan progress" with "Cancel scan"; notice "Library scan queued". Cut to the Activity page with the row "Library scan · Running". Cut to Taylor's timeline: Lake reflection, Glacier creek and Elk in meadow appear; CURSOR adds Glacier creek to the album "Summer in the Rockies". | Scan progress · Activity | "The scan runs in the background; follow it here or in Activity. New items appear in the owner's timeline and behave like any other, in albums, on the map and in search." |
| 9 | 1:37–1:51 | SCREEN: back in Libraries, scroll below the list to "External Library": group "Periodic Scanning" with "Enable periodic library scanning" (on) and "Cron expression presets" set to "Every night at midnight"; group "Library watching [EXPERIMENTAL]" with "Watch external libraries for file changes" (off). HIGHLIGHT each. | Periodic Scanning · Library watching [EXPERIMENTAL] | "Below the list, External Library sets Periodic Scanning, every night at midnight by default. Library watching imports changes as they happen, but it is experimental and usually does not work on network drives." |
| 10 | 1:51–2:09 | CARD "Caveats": bullet 1 "Albums, descriptions and edits live only in Frameleaf"; bullet 2 "A file moved inside the library returns as a new item"; bullet 3 "A file deleted on disk goes to Trash on the next scan". Each bullet illustrated with a small icon as it appears. | Caveats | "Know the caveats. Albums, descriptions and other changes live only in Frameleaf, never in the files. Move a file within the library and it returns as a new item, without them. Delete a file on disk, and the next scan moves it to trash." |
| 11 | 2:09–2:21 | CARD "Also good to know": bullet 1 "Not counted in storage quotas"; bullet 2 "To recover a trashed item, restore the original file"; bullet 3 "Changed files outside Frameleaf? Scan again". | Also good to know | "External libraries do not count toward storage quotas. To bring a trashed item back, restore the original file. After changing files outside Frameleaf, scan again." |
| 12 | 2:21–2:33 | SCREEN: the throwaway library "Test import" → "Remove library". Dialog "Remove library": "Remove Test import and its indexed entries? The files in your source folders will remain." CURSOR types the name into "Type the library name to confirm" and confirms; notice "Library removed · source files retained". | Remove library · source files retained | "Remove library deletes the library and its entries from Frameleaf once you type its name. The files in your folders stay where they are." |
| 13 | 2:33–2:42 | CARD "Scan found nothing?": bullet 1 "Is the volume mounted?"; bullet 2 "Does the import path match the mount?"; bullet 3 "Can the container read it?". | Scan found nothing? | "If a scan finds nothing, check the mount, the import path and the folder permissions." |
| 14 | 2:42–2:45 | LOGO OUTRO | Next: OPS-10 · Backups: database dumps and your media | "Next up: Backups: database dumps and your media." |

## Voice-over (clean)

External libraries bring in photos that already live in folders on your server or NAS. Frameleaf indexes them in place and never moves the files.

First, mount the folder into the server container in your compose file. End the line with read-only, so Frameleaf cannot delete files or write sidecars there. Recreate the containers, then list the path inside the container to be sure it is visible.

Always use the path as the container sees it, not the NAS path. Avoid symlinks, and mount the same path into any separate job container.

[pause]

In Settings, open Libraries and choose Add external library. Name it and pick the owner. Each library has one owner, and that cannot change later.

Under Import folders, add the container path. Folders are scanned with all their subfolders, and a file in two folders is added once. Under Exclusion patterns, add glob patterns to skip files, such as every folder named Raw.

Choose Create library. Saving never starts a scan, so open the library and choose Scan library. Access and permissions are checked when the server scans.

The scan runs in the background; follow it here or in Activity. New items appear in the owner's timeline and behave like any other, in albums, on the map and in search.

Below the list, External Library sets Periodic Scanning, every night at midnight by default. Library watching imports changes as they happen, but it is experimental and usually does not work on network drives.

[pause]

Know the caveats. Albums, descriptions and other changes live only in Frameleaf, never in the files. Move a file within the library and it returns as a new item, without them. Delete a file on disk, and the next scan moves it to trash.

External libraries do not count toward storage quotas. To bring a trashed item back, restore the original file. After changing files outside Frameleaf, scan again.

Remove library deletes the library and its entries from Frameleaf once you type its name. The files in your folders stay where they are.

If a scan finds nothing, check the mount, the import path and the folder permissions.

[pause]

Next up: Backups: database dumps and your media.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. Both docs still say "Administration -> External Libraries", "Create Library", a "Folders" section with "Add", and a three-dots "Scan New Library Files" menu. The current build is Settings → "Libraries" (rail group Your library, administrators only) with "Add external library", a dialog holding "Library name", "Owner", "Import folders" ("Add folder") and "Exclusion patterns" ("Add exclusion"), "Check path format" and "Create library", then "Scan library" in the library's detail panel. The doc's "Scan Settings page for each library" is now the dialog's Exclusion patterns list; "Scan all libraries" is the list's "Scan {n} libraries" button.
- The scan-interval settings the doc places at "Administration -> Settings -> External Library" sit below the Libraries manager in the same area: section "External Library" with "Periodic Scanning" ("Enable periodic library scanning", "Cron expression presets", "Cron expression") and "Library watching [EXPERIMENTAL]" ("Watch external libraries for file changes"). Defaults verified: scanning on at `0 0 * * *` (every night at midnight), watching off.
- Compose: the service key `immich-server` stays for compatibility (docker/README.md) and appears on screen only. The doc's own example uses `/mnt/nas/christmas-trip` → `/mnt/media/christmas-trip:ro`; the episode uses the sample library's "Family archive" instead. The `ro` tip is from the doc: read-only also stops deleting from the web UI and writing XMP sidecars.
- "Mount the same path into any separate job container" covers the doc's "Are the volumes also mounted to any worker containers?" (split api and job containers, OPS-19).
- Exclusion examples from the doc: `**/Raw/**`, `**/\@eaDir/**` (escape `@`), `**/*.tif`. Globs are matched against the full path and may be translated to database patterns, so the doc advises basic folder exclusions only.
- Caveats are quoted from libraries.md: metadata added in Frameleaf is not written to the file; moving a file inside the library loses that metadata on rescan; a file deleted from disk goes to trash on rescan and is removed after 30 days; restoring the original file restores the item; files changed outside need a rescan. The doc marks the moved-file behaviour as a known issue; the VO states it without promising a fix. Library watching may fail with ENOSPC on large folders; that stays in the written guide.
- Quotas: user-management.mdx and server-stats.md both state external libraries do not count toward storage quotas.
- Remove library strings: "Remove library", "Remove {name} and its indexed entries? The files in your source folders will remain.", "Type the library name to confirm", "Library removed · source files retained". The doc's warning that assets are "immediately deleted along with the library" refers to the entries in Frameleaf, not the files on disk.
- Use only landscape photos in the NAS folder; keep any real file paths out of shot.
