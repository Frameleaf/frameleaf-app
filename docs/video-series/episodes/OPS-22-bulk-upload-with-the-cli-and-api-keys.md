# OPS-22 · Bulk upload with the CLI and API keys

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:30 |
| Audience | People with a large folder of photos on a computer who want to upload it in bulk from the command line |
| Features demonstrated | Settings → Access & security → API keys (Create API key, API key name, Find permissions, choosing permissions instead of Full access, key shown once, Copy API key, Rotate, Delete), keys belong to one account, installing the command-line tool (Node.js 22+, Docker alternative), login and logout, upload --dry-run, --recursive, --album (albums from folder names), --album-name, --ignore, --visibility, --skip-hash, --watch, duplicate handling, Google Photos Takeout pointer (Frameleaf Google Photos import, community immich-go) |
| Source docs | docs/docs/features/command-line-interface.md, docs/docs/features/user-settings.md, docs/docs/administration/server-migration.md |
| Capture checklist | Taylor signed in on frameleaf.home; Settings → Access & security → API keys with no keys at the start; the Create API key dialog with the name "Laptop upload" and five permissions selected (user.read, asset.upload, album.read, album.create, albumAsset.create); the "Your new API key" dialog with the value blurred; a laptop terminal with Node.js 22 and a folder `~/Pictures/Rockies` holding two subfolders, "Summer in the Rockies" and "Winter 2026", filled with copies of sample photos that are not yet in the library (for example Lake reflection, Glacier creek, Summit view); the Albums page afterwards; dark theme |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD "Bulk upload with the CLI and API keys · Running Frameleaf". SCREEN: a file browser on the laptop showing `~/Pictures/Rockies` with the folders "Summer in the Rockies" and "Winter 2026". | LOWER-THIRD | "For a big folder of photos, the command-line tool uploads in bulk from any computer. It signs in with an API key, so start there." |
| 3 | 0:16–0:31 | SCREEN: Settings → Access & security, section API keys ("Separate access for importers, scripts and trusted applications."). CURSOR clicks Create API key; in the dialog CURSOR types "Laptop upload" into API key name. CALLOUT "Uploads belong to this account". | CALLOUT "Settings → Access & security → API keys" | "Open Settings, then Access & security, then API keys, and choose Create API key. Name it. A key belongs to one account, and everything it uploads belongs to that account too." |
| 4 | 0:31–0:46 | ZOOM on Find permissions; CURSOR types "user.read" and ticks it, then "asset.upload", then album.read, album.create and albumAsset.create. The counter reads "Choose only the access this application needs. 5 permissions selected." HIGHLIGHT the unticked "Full access (all permissions)". | CALLOUT "Sign in: user.read"; CALLOUT "Upload: asset.upload"; CALLOUT "Albums: album.read · album.create · albumAsset.create" | "Choose only what the tool needs. Signing in needs user read, and uploading needs asset upload. To create albums as well, add album read, album create and album asset create." |
| 5 | 0:46–0:56 | CURSOR clicks Create API key. The dialog "Your new API key" shows the value (blurred) and "This key is shown once. Copy it now; it cannot be shown again." CURSOR clicks Copy API key; status "Copied API key." | CALLOUT "Shown once" | "Create it and copy the key now. It is shown once and can never be shown again." |
| 6 | 0:56–1:17 | TERMINAL: `node --version` prints v22; `npm i -g @immich/cli`; then `immich login http://frameleaf.home:2283/api` followed by the key (blurred). Output: "Logged in as taylor@example.test" and "Wrote auth info to ~/.config/immich/auth.yml". CALLOUT "No Node.js? A Docker version exists". | TERMINAL; CALLOUT "Node.js 22 or later" | "Install the tool with Node.js 22 or later; the guide also has a Docker version. Log in with your server's API address and the key. Both are stored in a small file in your home folder, so log out when you are done." |
| 7 | 1:17–1:28 | TERMINAL: `immich upload --dry-run --recursive ~/Pictures/Rockies`; output lists files found, how many are new and how many the server already has; nothing uploads. | TERMINAL; CALLOUT "Dry run: nothing changes" | "Always start with a dry run. It scans the folder and its subfolders and shows what would upload, without changing anything." |
| 8 | 1:28–1:42 | TERMINAL: `immich upload --album --recursive ~/Pictures/Rockies`; hashing and upload progress bars run to 100%. Cut to SCREEN: the Albums page on frameleaf.home with "Summer in the Rockies" and "Winter 2026" holding the new photos. | TERMINAL; CALLOUT "One album per folder" | "Now upload for real. The album option turns each folder name into an album. To put everything into one album instead, use the album name option." |
| 9 | 1:42–2:02 | CARD "Useful options": bullet 1 "--ignore: skip files matching a pattern, such as **/Raw/**"; bullet 2 "--visibility: archive, timeline, hidden or locked"; bullet 3 "--skip-hash · --watch". | CARD | "A few more options. Ignore skips files matching a pattern. Visibility can send uploads straight to the archive. Skip hash saves time on fast connections, and watch keeps uploading new files as they appear. The server still spots duplicates." |
| 10 | 2:02–2:14 | SCREEN: Settings → Access & security → API keys showing "Laptop upload" with its permissions and "Updated" date, and the buttons Edit, Rotate and Delete. HIGHLIGHT Rotate, then Delete. | CALLOUT "Rotate"; CALLOUT "Delete" | "When the import is finished, delete the key, or rotate it if you will use it again. A rotated key stops working at once." |
| 11 | 2:14–2:27 | CARD "Importing a Google Photos Takeout?": bullet 1 "Use Frameleaf's Google Photos import (Library Care)"; bullet 2 "Community alternative". Under bullet 2, a one-line TERMINAL strip shows the tool name `immich-go`. | CARD | "Importing a Google Photos Takeout? Use Frameleaf's own Google Photos import instead. The command-line guide also points to a community tool built for Takeout archives." |
| 12 | 2:27–2:30 | LOGO OUTRO | Next: OPS-23 · Installing on Unraid, Synology, TrueNAS and Portainer | "Next up: Installing on Unraid, Synology, TrueNAS and Portainer." |

## Voice-over (clean)

For a big folder of photos, the command-line tool uploads in bulk from any computer. It signs in with an API key, so start there.

[beat]

Open Settings, then Access & security, then API keys, and choose Create API key. Name it. A key belongs to one account, and everything it uploads belongs to that account too.

Choose only what the tool needs. Signing in needs user read, and uploading needs asset upload. To create albums as well, add album read, album create and album asset create.

Create it and copy the key now. It is shown once and can never be shown again.

[pause]

Install the tool with Node.js 22 or later; the guide also has a Docker version. Log in with your server's API address and the key. Both are stored in a small file in your home folder, so log out when you are done.

Always start with a dry run. It scans the folder and its subfolders and shows what would upload, without changing anything.

[beat]

Now upload for real. The album option turns each folder name into an album. To put everything into one album instead, use the album name option.

A few more options. Ignore skips files matching a pattern. Visibility can send uploads straight to the archive. Skip hash saves time on fast connections, and watch keeps uploading new files as they appear. The server still spots duplicates.

[pause]

When the import is finished, delete the key, or rotate it if you will use it again. A rotated key stops working at once.

Importing a Google Photos Takeout? Use Frameleaf's own Google Photos import instead. The command-line guide also points to a community tool built for Takeout archives.

[pause]

Next up: Installing on Unraid, Synology, TrueNAS and Portainer.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. Build labels: section "API keys" in Settings → Access & security; buttons "Create API key", "Copy API key", "Edit", "Rotate", "Delete"; fields "API key name", "Find permissions"; option "Full access (all permissions)"; dialog "Your new API key". The name placeholder in the build is "Photo importer"; type "Laptop upload" over it.
- Doc vs UI: command-line-interface.md says the key comes from "the user setting panel"; user-settings.md and server-migration.md say "Account settings → API keys". The current build puts API keys under Settings → Access & security. The VO uses the build path.
- Permissions are verified in source, not stated in the CLI doc: `login` requires `user.read` and `upload` requires `asset.upload` (`packages/cli/src/commands/auth.ts`, `asset.ts`); the album options call endpoints that require `album.read`, `album.create` and `albumAsset.create` (`server/src/controllers/album.controller.ts`). If the build's permission list changes, update beat 4.
- Keys and ownership (server-migration.md): an API key can only read and write the library of the account it belongs to; uploads are owned by that account. A new or rotated key is shown once; a rotated key's old value stops working at once (user-settings.md).
- Install and login follow command-line-interface.md: Node.js 22 or above, `npm i -g @immich/cli`, or the documented Docker image. The published package and the `immich` command carry another product's name; they appear only in the TERMINAL and are not read aloud. `login` stores the URL and key in `auth.yml` under `~/.config/immich/` (or `-d` / IMMICH_CONFIG_DIR); `logout` removes it. Server-to-server `migrate` needs the tool built from Frameleaf source (OPS-20); upload does not.
- Doc vs CLI: the doc's option list shows `-h, --skip-hash`; the current CLI source defines `--skip-hash` with no short form (`packages/cli/src/index.ts`). Beat 9 shows the long form only.
- Options shown are from the doc's upload option list: `--recursive`, `--dry-run`, `--album` (albums from folder names), `--album-name` (one named album; cannot be combined with `--album`), `--ignore` (glob, e.g. `**/Raw/**`), `--visibility` (archive, timeline, hidden, locked), `--skip-hash`, `--watch`. The server always deduplicates by hash, so skipping local hashing only affects speed. `--delete` and `--delete-duplicates` remove local files and are deliberately not shown.
- Sample folders reuse album names from the sample library; use photo copies that are not already in the library, or the dry run reports them all as duplicates.
- Takeout pointer: command-line-interface.md recommends the community tool immich-go for Google Photos Takeout; Frameleaf's own Google Photos import is covered in CARE-10. The tool name is on the card only; the VO says "a community tool".
