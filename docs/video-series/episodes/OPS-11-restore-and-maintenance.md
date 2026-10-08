# OPS-11 · Restore and Maintenance

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators who need to take the server offline for work, restore a database backup, or check the library for missing and changed files |
| Features demonstrated | Maintenance area (Maintenance mode, Database backups, Integrity checks), Start maintenance with a reason, maintenance page and End maintenance, maintenance sign-in link and server commands, backup list (Download, Restore, Delete, Select from computer), Restore this backup? dialog (consequences, version check, Create a safety backup of the current database first, Type RESTORE to confirm, Restore backup), restore steps and rollback, integrity checks and reports (Run check, Run all checks, View report, filter, Download CSV, Recheck findings), fresh-install restore (Restore From Backup, folder checks) |
| Source docs | docs/docs/administration/backup-and-restore.md, docs/docs/administration/maintenance-mode.md, docs/docs/administration/system-integrity.md |
| Capture checklist | Taylor signed in as administrator on frameleaf.home, dark theme. Settings → Maintenance with maintenance mode off. Database backups listing nightly dumps with the newest from 02:00 on 19 September, all made by the running version. A second browser signed in as Jamie to show the maintenance page. Integrity checks with Untracked Files "No issues", Missing Files "Issues found · 2 findings" (move Ridge trail and Glacier creek out of library storage before the check) and Checksum Mismatch "No issues". A fresh second install ("old-server" data copied to a new host) at its welcome screen for beats 12 and 13, its upload location already holding the copied folders. Blur tokens and URLs with tokens. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:12 | LOWER-THIRD "Restore and Maintenance · Running Frameleaf". SCREEN: Settings → Maintenance directory with three rows, HIGHLIGHT each as named: "Maintenance mode", "Database backups", "Integrity checks". | Settings → Maintenance | "Open Settings, then Maintenance. It has three sections: Maintenance mode, Database backups and Integrity checks." |
| 3 | 0:12–0:29 | SCREEN: Maintenance mode card, status "Off"; facts "Administrators · Sign in on the maintenance page to end maintenance or restore a backup." and "Everyone else · Sees the maintenance page and is signed out of sessions."; the preview "What people see during maintenance". CURSOR clicks "Start maintenance"; dialog "Start maintenance mode": "Everyone except administrators will see the maintenance page and be signed out. Uploads, mobile backups and shared links pause until maintenance mode ends." CURSOR types "Replacing the library disk" into "Reason shown on the maintenance page (optional)" and confirms. | Start maintenance · Reason | "Maintenance mode pauses the library for everyone but administrators. Others see a maintenance page and are signed out, and uploads, mobile backups and shared links pause. Choose Start maintenance and, if you like, add a reason for the page." |
| 4 | 0:29–0:39 | SPLIT: left, Jamie's browser shows "Frameleaf is being looked after · Your photos are safe. The library will be back shortly." with "Reason: Replacing the library disk"; right, Taylor on the maintenance page with "End maintenance" and "Ending maintenance lets everyone sign in again straight away." HIGHLIGHT End maintenance. | End maintenance | "The maintenance page shows your reason. Administrators sign in there and choose End maintenance when the work is done." |
| 5 | 0:39–0:51 | TERMINAL: `docker compose logs immich-server` scrolled to the line "…in maintenance mode, you can log in using the following URL:" and a URL ending `/maintenance?token=` (token blurred). Then `docker compose exec immich-server immich-admin enable-maintenance-mode` and `… disable-maintenance-mode`. CALLOUT "Links expire after 4 hours". | Sign-in link · server commands | "Signed out by accident? The server log prints a maintenance sign-in link, valid for four hours, and the server command line can turn maintenance mode on or off." |
| 6 | 0:51–1:04 | SCREEN: Maintenance → Database backups ("A backup holds metadata, albums, people, edits and settings. Original files are not included; keep their own protected copy."). Rows newest first: "19 Sep 2026, 02:00 · Version … · Complete · … MB" with Download, Restore, Delete. HIGHLIGHT "Create backup now", "Schedule", then "Upload database backup file · Select from computer". | Download · Restore · Delete · Select from computer | "Database backups lists every dump, newest first, with its version and size. You can download or delete one, or upload a backup file from another server with Select from computer." |
| 7 | 1:04–1:23 | CURSOR clicks Restore on the 19 September 02:00 row. Dialog "Restore this backup?": "Backup from 19 Sep 2026, 02:00 · … MB"; the list appears line by line: "Metadata, albums, people, edits and settings return to the state in this backup.", "Changes made after the backup are lost unless you create a backup first.", "Original files on disk are not touched.", "Everyone is signed out, and the server stays in maintenance mode until you end it."; the version note below. | Restore this backup? | "Choose Restore on the backup you want. The dialog says what changes: metadata, albums, people, edits and settings return to that moment, later changes are lost, original files are not touched, and everyone is signed out. It also compares the backup's version with this server." |
| 8 | 1:23–1:40 | ZOOM on "The restore runs in 4 steps: enter maintenance mode, restore the database, run migrations, verify the library." CURSOR ticks "Create a safety backup of the current database first". CURSOR types RESTORE into "Type RESTORE to confirm"; "Restore backup" becomes active (HIGHLIGHT); CURSOR clicks it. | Type RESTORE to confirm · Restore backup | "Tick Create a safety backup of the current database first to keep a copy of today's database. Type RESTORE to confirm, then choose Restore backup. Either way, Frameleaf takes a restore point and rolls back if anything fails." |
| 9 | 1:40–1:51 | SCREEN: the maintenance page with a progress list stepping through the four steps; then "Maintenance is finished · Everything completed. Your library is ready." CURSOR opens the library in a new tab (timeline intact), then clicks "End maintenance". | Maintenance is finished | "The server enters maintenance mode, restores, runs migrations and verifies the library. When it finishes, check your library, then end maintenance." |
| 10 | 1:51–2:05 | SCREEN: Maintenance → Integrity checks ("Checks read the library and never change files. Each check keeps a report you can review, download or act on."). Rows: "Untracked Files · No issues", "Missing Files · Issues found · 2 findings", "Checksum Mismatch · No issues", each with "Last run …", "Run check" and "View report". HIGHLIGHT "Run all checks". | Run check · Run all checks · View report | "Integrity checks read the library and never change files. They look for untracked files, missing files and checksum mismatches, nightly by default. Run one check or all of them, then open a report." |
| 11 | 2:05–2:21 | CURSOR clicks "View report" on Missing Files. Page "Missing Files report · 2 findings" with the Path column (paths for Ridge trail and Glacier creek). CURSOR types into "Filter by path…"; HIGHLIGHT "Download CSV" and "Recheck findings". CALLOUT "Untracked thumbnails: safe to regenerate"; CALLOUT "Missing or mismatched originals: investigate". | Filter · Download CSV · Recheck findings | "A report lists each finding by path. Filter it, download it, or recheck only those findings. Untracked leftovers are often old thumbnails that can be regenerated; missing files and checksum mismatches need a closer look." |
| 12 | 2:21–2:36 | TERMINAL on the new host: `ls "$UPLOAD_LOCATION"` prints `backups  encoded-video  library  profile  thumbs  upload` (copied from old-server). SCREEN: the new server's welcome page "Welcome to Frameleaf" with "Getting Started" and "Restore From Backup"; CURSOR clicks Restore From Backup. "Restore Your Library" lists each folder with "readable and writable" and "has … folder(s)"; "If this looks correct, continue to restoring a backup!"; CURSOR clicks Next, picks the 19 September backup (or "Select from computer" for a `.sql.gz`) and clicks Restore. | Restore From Backup · Restore Your Library | "On a new server, first copy the old upload location's folders into the new one. On the welcome screen, choose Restore From Backup. Frameleaf checks each folder; then pick a backup, or upload one, and restore." |
| 13 | 2:36–2:42 | TERMINAL: the new `docker-compose.yml` with the same external-library mount line as before (`- /mnt/nas/family-archive:/mnt/media/family-archive:ro`) HIGHLIGHTED. | Same mounts as before | "Keep external library mounts the same, so every path still points at a file." |
| 14 | 2:42–2:45 | LOGO OUTRO | Next: OPS-12 · Users, quotas and accounts | "Next up: Users, quotas and accounts." |

## Voice-over (clean)

Open Settings, then Maintenance. It has three sections: Maintenance mode, Database backups and Integrity checks.

Maintenance mode pauses the library for everyone but administrators. Others see a maintenance page and are signed out, and uploads, mobile backups and shared links pause. Choose Start maintenance and, if you like, add a reason for the page.

The maintenance page shows your reason. Administrators sign in there and choose End maintenance when the work is done.

Signed out by accident? The server log prints a maintenance sign-in link, valid for four hours, and the server command line can turn maintenance mode on or off.

[pause]

Database backups lists every dump, newest first, with its version and size. You can download or delete one, or upload a backup file from another server with Select from computer.

Choose Restore on the backup you want. The dialog says what changes: metadata, albums, people, edits and settings return to that moment, later changes are lost, original files are not touched, and everyone is signed out. It also compares the backup's version with this server.

Tick Create a safety backup of the current database first to keep a copy of today's database. Type RESTORE to confirm, then choose Restore backup. Either way, Frameleaf takes a restore point and rolls back if anything fails.

The server enters maintenance mode, restores, runs migrations and verifies the library. When it finishes, check your library, then end maintenance.

[pause]

Integrity checks read the library and never change files. They look for untracked files, missing files and checksum mismatches, nightly by default. Run one check or all of them, then open a report.

A report lists each finding by path. Filter it, download it, or recheck only those findings. Untracked leftovers are often old thumbnails that can be regenerated; missing files and checksum mismatches need a closer look.

[pause]

On a new server, first copy the old upload location's folders into the new one. On the welcome screen, choose Restore From Backup. Frameleaf checks each folder; then pick a backup, or upload one, and restore.

Keep external library mounts the same, so every path still points at a file.

[pause]

Next up: Users, quotas and accounts.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. The docs describe the older administration page ("Administration > Maintenance", "Restore database backup" section, one-click Restore and Confirm, "Switch to maintenance mode"). The current build puts all of it in Settings → Maintenance, with the sections "Maintenance mode", "Database backups" (which also holds Recovery readiness, see OPS-02) and "Integrity checks"; the old `/admin/maintenance` address redirects there.
- Restore dialog strings verified: title "Restore this backup?", summary "Backup from {date} · {size}", the four consequence lines quoted in beat 7, the steps line in beat 8, "Create a safety backup of the current database first" (off by default), "Type RESTORE to confirm", "Restore backup". The server always takes a restore point and rolls back to it on failure (doc "Restore Process"); the checkbox only decides whether that copy is kept after a successful restore. Version notes: an older backup is migrated forward; a backup from a newer server cannot be restored ("Update the server before restoring it."); an unreadable version is stated.
- Backup rows show the date, version, a status pill ("Complete"), the size and Download, Restore and Delete. The dialog also prints the file name, which starts with the legacy prefix `immich-db-backup-`; crop or blur it.
- Maintenance mode strings: "Start maintenance", "Start maintenance mode", "Reason shown on the maintenance page (optional)" (placeholder "Replacing the library disk", at most 200 characters), "Frameleaf is being looked after", "End maintenance", "Ending maintenance lets everyone sign in again straight away.", "Maintenance is finished", "Everything completed. Your library is ready." Sign-in links "expire after 4 hours; get a new one from the server log".
- The server's log line (maintenance-mode.md) still reads "🚧 Immich is in maintenance mode, you can log in using the following URL:" in the current build. Crop the TERMINAL so only "…in maintenance mode, you can log in using the following URL:" and the blurred URL show. The commands `enable-maintenance-mode` and `disable-maintenance-mode` are from server-commands.md; they appear on screen only (OPS-24 covers the command line).
- Integrity (system-integrity.md): the three checks run nightly at 3 am by default, with extra time and progress limits for checksums; schedules live in Library care → Media health & integrity (CARE-01). Check names in the build: "Untracked Files", "Missing Files", "Checksum Mismatch"; statuses "No issues", "Issues found", "Not recorded", "Running…"; report page "{title} report", "Filter by path…", "Download CSV", "Recheck findings", "Delete report". The advice in beat 11 paraphrases the doc's "Common causes"; the doc also suggests running the missing thumbnails and playback-video jobs afterwards.
- Fresh-install restore (doc "Restore from Onboarding"): copy `backups`, `encoded-video`, `library`, `profile`, `thumbs` and `upload` into the new `UPLOAD_LOCATION`; keep external-library mounts identical; start the stack; on the welcome page choose "Restore From Backup" (the build's casing), review "Restore Your Library" folder checks, "Next", choose or upload a `.sql.gz`, "Restore". The welcome page's other button, "Getting Started", opens the first-run setup (START series).
- The doc's command-line restore stays in the written guide; it is destructive and not shown.
