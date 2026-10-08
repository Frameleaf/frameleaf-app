# OPS-08 · Storage & originals: the storage template

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators who want the originals on disk arranged in readable folders, for example to browse or back them up outside the app |
| Features demonstrated | Storage & originals → Originals & folder structure, Enable storage template engine, Hash verification enabled, Variables (date and time, filename, filetype, camera, album), Preset, Template, preview and path length, album conditional template, lowercase extensions and sequence numbers, storage labels (Edit account), Storage organization migration job (Start task), what moves and what stays, turning the template off |
| Source docs | docs/docs/administration/storage-template.mdx (partial `docs/docs/partials/_storage-template.md`), docs/docs/administration/backup-and-restore.md, docs/docs/administration/user-management.mdx |
| Capture checklist | Taylor signed in as administrator on frameleaf.home, dark theme, with Taylor's storage label set to `taylor` and Emma's to `emma`. Settings → Storage & originals → Originals & folder structure with the engine off at the start. A terminal on the host listing `UPLOAD_LOCATION/upload/<account id>/…` before and `UPLOAD_LOCATION/library/taylor/2026/2026-08-14/…` after the migration. Users → Emma → Edit account. Job manager with the Storage organization queue idle before the migration. Album "Summer in the Rockies" holding Moraine Lake and Summit view. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD "Storage & originals: the storage template · Running Frameleaf". SPLIT of two TERMINAL panels: left "Template off" listing `upload/5f3c…/a1/b2/7e9d…jpg`; right "Template on" listing `library/taylor/2026/2026-08-14/IMG_4127.jpg`. | Template off · Template on | "Out of the box, Frameleaf files originals by account in folders arranged for the app, not for people. The storage template names and arranges them your way: by date, album or camera." |
| 3 | 0:16–0:27 | SCREEN: Settings → Storage & originals; CURSOR clicks "Originals & folder structure" ("Choose how originals are named and arranged on disk."). HIGHLIGHT the toggle "Enable storage template engine"; CURSOR turns it on; the Variables and Template panels appear. HIGHLIGHT "Hash verification enabled" (on). | Enable storage template engine · Hash verification enabled | "Open Settings, then Storage & originals, then Originals & folder structure. Turn on Enable storage template engine, and leave Hash verification enabled on." |
| 4 | 0:27–0:42 | ZOOM on "Variables": the date and time list with "Asset's creation timestamp is used for the datetime information", then the other variables: `{{filename}}` IMG_123, `{{ext}}` jpg, `{{filetype}}` VID or IMG, `{{make}}`, `{{model}}`, `{{lensModel}}`, `{{album}}`, `{{album-startDate-x}}`, `{{assetId}}`. HIGHLIGHT each group as named. | Variables | "Variables lists what you can use: date and time parts from each item's creation time, the file name and type, camera make, model and lens, and the album. Dates use the server's local time zone." |
| 5 | 0:42–0:57 | ZOOM on "Template": CURSOR opens "Preset" and hovers two entries; the "Template" field shows `{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}` with "Extension .jpg". The preview reads `UPLOAD_LOCATION/library/taylor/2022/2022-02-03/IMAGE_56437.jpg`, with "Approximate path length limit: …/260" and "taylor is the user's Storage Label". | Preset · Template · Preview | "Pick a preset or type your own. The default makes a folder for each year, then one for each day. The preview shows the full path and how close it is to the length limit." |
| 6 | 0:57–1:15 | CURSOR replaces the template with `{{y}}/{{#if album}}{{album}}{{else}}Other{{/if}}/{{MM}}/{{filename}}`; preview updates to `…/library/taylor/2022/Album Name/02/IMAGE_56437.jpg`. DIAGRAM beside it: Moraine Lake → folder "Summer in the Rockies"; Cabin at dusk (no album) → folder "Other". CALLOUT "In several albums: the most recently created album wins"; CALLOUT "`{{{album}}}` keeps & as &". | Album folders · Other | "To file by album, use an if block: the album's folder when there is one, and Other when there is not. A photo in several albums goes to the most recently created one. Wrap album in three braces to keep characters like ampersands." |
| 7 | 1:15–1:25 | ZOOM on "Notes": "The storage template will convert all extensions to lowercase. Template changes will only apply to new assets. To retroactively apply the template to previously uploaded assets, run the Storage Template Migration Job." Small DIAGRAM: two `IMG_4127.jpg` files → `IMG_4127.jpg` and `IMG_4127+1.jpg`. | Lowercase · never overwritten | "Extensions become lowercase, and files with the same name are never overwritten; a number is added. Changes apply only to new uploads." |
| 8 | 1:25–1:40 | SCREEN: Settings → Users → Emma → Edit account. ZOOM on "Storage label" with `emma` and the hint "The storage label is an optional folder name: letters, numbers, hyphens or underscores." CALLOUT on "Changing the label does not move existing files. Run the storage template migration separately when you are ready." CURSOR clicks Cancel. | Storage label | "The first folder is the account's storage label, or its ID when there is none. Set labels in Users, with Edit account. Changing a label moves nothing until you run the migration." |
| 9 | 1:40–1:56 | SCREEN: back on Originals & folder structure; CURSOR clicks Review changes, then Save changes. CURSOR clicks the link "Storage Template Migration Job" in Notes; Job manager opens; CURSOR opens "Storage organization" ("Move files according to the configured storage template."), clicks "Start task"; the review dialog opens; CURSOR confirms. The queue shows Active. | Storage Template Migration Job → Storage organization → Start task | "Review and save. Then apply the template to what is already stored. The note's link opens Job manager: open Storage organization, choose Start task, and confirm the review. Each original moves into the new layout." |
| 10 | 1:56–2:12 | DIAGRAM of `UPLOAD_LOCATION`: an arrow (green) moves files from `upload/<id>/` into `library/taylor/` and `library/emma/`; the folders `thumbs/`, `encoded-video/`, `profile/` and `backups/` stay grey and still. A separate node "External libraries" with a lock. A small phone icon drops a file into `upload/` which then slides to `library/`. | What moves · what stays | "What moves: originals, into the library folder under each label. Thumbnails, playback videos, profile pictures and database backups stay where they are, and external libraries are never moved. Mobile uploads land in the upload folder first, then move." |
| 11 | 2:12–2:26 | CARD "Turning it off": bullet 1 "Files stay in library/"; bullet 2 "New uploads are saved in upload/"; bullet 3 "Never move or rename files by hand". | Turning it off | "Turning the template off later leaves files where they are, and new uploads are saved in the upload folder. Never move or rename files by hand; only Frameleaf should change them." |
| 12 | 2:26–2:42 | TERMINAL on the host: `ls UPLOAD_LOCATION/library/taylor/2026/` prints `2026-07-30  2026-08-14  2026-09-02`; hold. | Back up first | "Before a big migration, make sure your backups are current; the backup episodes show how." |
| 13 | 2:42–2:45 | LOGO OUTRO | Next: OPS-09 · External libraries | "Next up: External libraries." |

## Voice-over (clean)

Out of the box, Frameleaf files originals by account in folders arranged for the app, not for people. The storage template names and arranges them your way: by date, album or camera.

Open Settings, then Storage & originals, then Originals & folder structure. Turn on Enable storage template engine, and leave Hash verification enabled on.

Variables lists what you can use: date and time parts from each item's creation time, the file name and type, camera make, model and lens, and the album. Dates use the server's local time zone.

Pick a preset or type your own. The default makes a folder for each year, then one for each day. The preview shows the full path and how close it is to the length limit.

[pause]

To file by album, use an if block: the album's folder when there is one, and Other when there is not. A photo in several albums goes to the most recently created one. Wrap album in three braces to keep characters like ampersands.

Extensions become lowercase, and files with the same name are never overwritten; a number is added. Changes apply only to new uploads.

The first folder is the account's storage label, or its ID when there is none. Set labels in Users, with Edit account. Changing a label moves nothing until you run the migration.

[pause]

Review and save. Then apply the template to what is already stored. The note's link opens Job manager: open Storage organization, choose Start task, and confirm the review. Each original moves into the new layout.

What moves: originals, into the library folder under each label. Thumbnails, playback videos, profile pictures and database backups stay where they are, and external libraries are never moved. Mobile uploads land in the upload folder first, then move.

Turning the template off later leaves files where they are, and new uploads are saved in the upload folder. Never move or rename files by hand; only Frameleaf should change them.

Before a big migration, make sure your backups are current; the backup episodes show how.

[pause]

Next up: External libraries.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. The doc's path "Administration -> Settings -> Storage Template" is now Settings → Storage & originals → "Originals & folder structure" (group "Storage"). The same section also holds "Physical deduplication" ("Enable physical deduplication", "Master account"); leave it off and out of focus.
- Labels verified in the build: "Enable storage template engine", "Hash verification enabled" (help: "Enables hash verification, don't disable this unless you're certain of the implications"), "Variables", "Template", "Preview", "Preset", "Extension", "Notes", "Approximate path length limit: {n}/260", "{label} is the user's Storage Label", the Notes paragraph quoted in beat 7, and the link text "Storage Template Migration Job". The preview uses the build's fixed sample values (`IMAGE_56437`, 3 February 2022, "Album Name"); keep them as printed.
- Default template `{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}` (server default and doc). Album rules from the doc: the most recently created album wins; special characters are HTML-escaped unless wrapped in triple braces; a sequence number is appended when names collide. The `+1` suffix in beat 7 is illustrative; show whatever the migration writes.
- The migration: the doc calls it "Storage Template Migration" and says it runs "on the Job page". In the build it is the Job manager queue "Storage organization" (category Maintenance) with the start command "Start task"; its description links back to "Storage Template". The Notes link opens the Job manager page, not the queue itself.
- Storage labels (user-management.mdx "Set Storage Label For User"): the administrator's label defaults to `admin`; labels replace the account ID in `library/`. The account form's notice "Changing the label does not move existing files. Run the storage template migration separately when you are ready." is quoted in beat 8. The doc still says "Administration > Users → context menu"; the build uses Settings → Users → account → Edit account.
- What moves (backup-and-restore.md "Asset Types and Storage Locations", Storage Template On): originals go to `UPLOAD_LOCATION/library/<label or id>`; thumbs, encoded-video and profile stay in their own per-account folders; database dumps stay in `backups/`; mobile uploads are held in `upload/` until the upload completes. Turning the engine off leaves files in `library/` and saves new assets to `upload/`. External-library files are skipped by the migration (verified in the server's storage template service); the docs only describe the template for uploads.
- The doc's danger note ("Do not touch the files inside these folders … except taking a backup") backs the "never move or rename files by hand" line.
- Date variables render in the server's local timezone (partial doc). Seed the sample photos so their August 2026 dates produce the folders in beats 2 and 12.
