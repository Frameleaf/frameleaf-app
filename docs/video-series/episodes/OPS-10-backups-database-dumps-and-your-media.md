# OPS-10 · Backups: database dumps and your media

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | Learn |
| Target length | 2:45 |
| Audience | Anyone running Frameleaf who needs to know what to back up, what Frameleaf does for them, and what they must do themselves |
| Features demonstrated | Automatic nightly database backups (Enable database dumps, Cron expression presets, Cron expression, Amount of previous dumps to keep), manual dump (Create job → Back up the database; Create backup now), backups folder, critical folders (library, upload, profile), 3-2-1 strategy, backup ordering, the Borg backup script pattern, Recovery readiness pointer |
| Source docs | docs/docs/administration/backup-and-restore.md, docs/docs/guides/template-backup-script.md |
| Capture checklist | Taylor signed in as administrator on frameleaf.home, dark theme. Settings → Import & protection → Database backups at defaults (enabled, "Every night at 2am", `0 02 * * *`, 14 kept). Job manager → Create job dialog. Maintenance → Database backups showing the latest backup from 02:00 on 19 September. A terminal on the host with `UPLOAD_LOCATION` listing `backups`, `encoded-video`, `library`, `profile`, `thumbs`, `upload`, and the backups folder holding a few nightly dumps. A text editor showing the backup script. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD "Backups: database dumps and your media · Running Frameleaf". TITLE "Two things to protect" with subheading "The database and your files". Two icons fade in: a database cylinder (teal) and a stack of photos (green). | Two things to protect | "A Frameleaf backup has two parts: the database, and the files in your upload location. You need both, and Frameleaf only takes care of the first." |
| 3 | 0:14–0:29 | DIAGRAM: node "Database" with labels appearing as named: "Albums", "People", "Edits", "Settings", "File paths"; dashed arrows from File paths to a node "Originals on disk". A small "no scan" icon over the originals node. | The database knows where every file is | "The database holds your albums, people, edits, settings and the path to every file. Frameleaf does not rediscover files by scanning, so without the database, your originals are just a pile of files." |
| 4 | 0:29–0:46 | SCREEN: Settings → Import & protection → "Database backups" ("Back up albums, people and edits. Originals need their own backup."). HIGHLIGHT "Enable database dumps" (on). CURSOR opens "Cron expression presets": Every night at midnight, Every night at 2am (selected), Every day at 1pm, Every 6 hours. ZOOM on "Cron expression" `0 02 * * *` and "Amount of previous dumps to keep" 14. | Every night at 2am · 14 kept | "Database backups are on by default. Open Settings, then Import & protection, then Database backups. A dump is made every night at two, and the last fourteen are kept. Change the schedule with a preset or a cron expression." |
| 5 | 0:46–1:00 | SCREEN: Compute & jobs → Job manager; CURSOR clicks "Create job"; in "Create a maintenance job" selects "Back up the database" ("Back up library records; original media needs its own backup."); clicks "Review job", then "Back up the database". Cut to Maintenance → Database backups; HIGHLIGHT "Create backup now". | Create job → Back up the database · Create backup now | "Before a big change, make one yourself. In Job manager, choose Create job, then Back up the database, review it and start it. Maintenance has a Create backup now button too." |
| 6 | 1:00–1:11 | TERMINAL: `ls "$UPLOAD_LOCATION/backups"` prints several nightly dumps ending `…20260917T020000….sql.gz`, `…20260918T020000….sql.gz`, `…20260919T020000….sql.gz`. CALLOUT "Metadata only · no photos or videos". | UPLOAD_LOCATION/backups | "Dumps land in the backups folder of your upload location and count toward the fourteen. They hold no photos or videos, only the database." |
| 7 | 1:11–1:28 | TERMINAL: `ls "$UPLOAD_LOCATION"` prints `backups  encoded-video  library  profile  thumbs  upload`. DIAGRAM overlay colours them: `library`, `upload`, `profile` green with "Critical"; `thumbs`, `encoded-video` grey with "Can be rebuilt"; `backups` teal. CALLOUT "Moved a folder to another disk? Back up that path too". | Critical: library · upload · profile | "Now the files. Three folders are critical: library, upload and profile. Thumbnails and encoded videos can be rebuilt, but backing up the whole upload location is simplest. If you moved a folder to another disk, include that path." |
| 8 | 1:28–1:42 | CARD "3-2-1": bullet 1 "3 copies of your data"; bullet 2 "2 different kinds of storage"; bullet 3 "1 copy off-site". DIAGRAM beside it: "frameleaf.home" → "USB drive" (teal) and → "Remote machine" (blue). | 3 copies · 2 kinds of storage · 1 off-site | "Follow the three-two-one rule: three copies of your data, on two different kinds of storage, with one copy off-site. A second drive at home plus a remote copy covers it." |
| 9 | 1:42–1:57 | DIAGRAM timeline: "Stop the server" (green, preferred); else "1 · Database" → "2 · Files". A red variant "Files first" leads to "Missing files after restore" with a cross. | Database first, files second | "Order matters. Stop the server during the backup if you can. If not, back up the database first and the files second, so at worst a restore has extra files, never missing ones." |
| 10 | 1:57–2:15 | TERMINAL showing the template script, lines typed in turn: `docker compose exec -T database pg_dump --clean --if-exists --dbname=<DB_DATABASE_NAME> --username=<DB_USERNAME> > "$UPLOAD_LOCATION"/database-backup/frameleaf-database.sql`, then `borg create "$BACKUP_PATH/frameleaf-borg::{now}" "$UPLOAD_LOCATION" --exclude "$UPLOAD_LOCATION"/thumbs/ --exclude "$UPLOAD_LOCATION"/encoded-video/`, then `borg prune --keep-weekly=4 --keep-monthly=3 …`, then the same `borg create` to `"$REMOTE_HOST:$REMOTE_BACKUP_PATH/frameleaf-borg::{now}"`. HIGHLIGHT each line as the VO describes it. | Template backup script · Borg | "The guide includes a template script for Borg, run from cron. It dumps the database into the upload location, then snapshots that folder to a second drive and a remote machine, skipping thumbnails and encoded videos, and prunes old snapshots." |
| 11 | 2:15–2:28 | DIAGRAM: snapshots stacked as cards, each containing a small database icon and a photo icon together; a "versioned" badge. Then SCREEN: Database backups with "Enable database dumps" HIGHLIGHTED (still on) and CALLOUT "Safe to turn off when the script runs". | Always in sync | "Because the dump and the files are captured together, every snapshot is in sync, and versioning saves space. With the script in place, you can turn off the built-in dumps." |
| 12 | 2:28–2:42 | SCREEN: Maintenance → Database backups → "Recovery readiness" with "Record a restore test". CALLOUT "OPS-11 · Restore and Maintenance". | Test your backups | "Then test it. Restore into a separate place, check it, and record it under Recovery readiness. The next episode shows the restore." |
| 13 | 2:42–2:45 | LOGO OUTRO | Guide: Backup and Restore | "The written guide is linked below." |

## Voice-over (clean)

A Frameleaf backup has two parts: the database, and the files in your upload location. You need both, and Frameleaf only takes care of the first.

The database holds your albums, people, edits, settings and the path to every file. Frameleaf does not rediscover files by scanning, so without the database, your originals are just a pile of files.

[pause]

Database backups are on by default. Open Settings, then Import & protection, then Database backups. A dump is made every night at two, and the last fourteen are kept. Change the schedule with a preset or a cron expression.

Before a big change, make one yourself. In Job manager, choose Create job, then Back up the database, review it and start it. Maintenance has a Create backup now button too.

Dumps land in the backups folder of your upload location and count toward the fourteen. They hold no photos or videos, only the database.

[pause]

Now the files. Three folders are critical: library, upload and profile. Thumbnails and encoded videos can be rebuilt, but backing up the whole upload location is simplest. If you moved a folder to another disk, include that path.

Follow the three-two-one rule: three copies of your data, on two different kinds of storage, with one copy off-site. A second drive at home plus a remote copy covers it.

Order matters. Stop the server during the backup if you can. If not, back up the database first and the files second, so at worst a restore has extra files, never missing ones.

[pause]

The guide includes a template script for Borg, run from cron. It dumps the database into the upload location, then snapshots that folder to a second drive and a remote machine, skipping thumbnails and encoded videos, and prunes old snapshots.

Because the dump and the files are captured together, every snapshot is in sync, and versioning saves space. With the script in place, you can turn off the built-in dumps.

Then test it. Restore into a separate place, check it, and record it under Recovery readiness. The next episode shows the restore.

[pause]

The written guide is linked below.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. backup-and-restore.md says "Administration > Settings > Backup" and "Administration > Job Queues → Create job → Create Database Dump → Confirm". The current build is Settings → Import & protection → "Database backups" (group "Protection") for the schedule, and Job manager → "Create job" → "Back up the database" → "Review job" → "Back up the database" for a manual dump. Maintenance → Database backups also has "Create backup now" (OPS-11).
- Settings labels verified: "Enable database dumps", "Cron expression presets" (Every night at midnight, Every night at 2am, Every day at 1pm, Every 6 hours), "Cron expression", "Amount of previous dumps to keep". Defaults verified in the server config: enabled, `0 02 * * *`, keep 14. The doc's "keep last 14 backups, create daily at 2:00 AM" matches.
- Backup file names start with the legacy prefix `immich-db-backup-` followed by the date, version and PostgreSQL version. Crop or blur the prefix in beat 6, as the storyboard shows. The sample's latest backup is the 19 September 02:00 dump.
- Critical folders and ordering follow the doc's "Filesystem" and "Backup ordering" sections. If only the three critical folders are backed up, thumbnails and playback videos must be regenerated after a restore (doc); the VO keeps it to "can be rebuilt".
- 3-2-1 wording follows the doc's link and the install partial ("at least two local copies and one copy offsite in cold storage"). The VO reads "three-two-one".
- Backup script (template-backup-script.md): the guide's pattern is kept, with two on-screen changes. The guide addresses the database with `docker exec -t immich_postgres`; the Frameleaf container is now `frameleaf_postgres`, and docker/README.md recommends service-based commands, so the script line uses `docker compose exec -T database` (run it from the Compose folder, as backup-and-restore.md's own CLI example does). The Borg repository and dump file names are renamed to `frameleaf-borg` and `frameleaf-database.sql`; they are free choices. The guide's `borg init` set-up, `borg compact` lines and the `--rsyncable` gzip variant stay in the written guide.
- "You can turn off the built-in dumps" quotes the guide's note that it is safe when the script backs up the database. Keep the toggle on in the capture.
- The Recovery readiness beat points ahead only; OPS-02 shows recording a restore test and OPS-11 shows the restore.
- Outro CTA on screen: `Guide: Backup and Restore`; the producer fills in the public docs URL.
