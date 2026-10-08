# OPS-02 · Overview and Library analytics

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:30 |
| Audience | Administrators who want a daily health check of their server and a long-term picture of their library |
| Features demonstrated | Overview health line, tiles (items, Library filesystem, Latest database backup, Frameleaf version), Viewing scope, Needs your attention, storage meter and breakdown, Processing snapshot, System at a glance, Recovery readiness (Record a restore test), Library analytics (Date range, Library scope, sections, View data table, Export CSV, About these numbers) |
| Source docs | docs/docs/administration/system-settings.md, docs/docs/administration/server-stats.md |
| Capture checklist | Taylor signed in as administrator on frameleaf.home, dark theme. Settings → Overview with the health line "Library available · 2 things need attention · Snapshot · 26 Sep 2026, 09:14". Tiles: "All accounts & libraries" 153,792 "Photos, videos & RAW originals"; Library filesystem 2.42 TiB, "1.58 TiB available"; Latest database backup from 02:00 on 19 September; Frameleaf version with "Updates & build information". Needs your attention seeded with "Prove your backup can restore" (No restore test has been recorded.) and "Review failed jobs" (3 · Server); no worker-compatibility item. Storage card "2.42 TiB of 4.00 TiB used" with Physical originals, Thumbnails & proxies and Database & other measured (a nightly collection has run). Maintenance → Database backups → Recovery readiness with Database and Original files "Not recorded" and Next test "Due now". Library analytics with at least two nightly collections so Library growth has history; Viewing options Server, Taylor, Jamie, Emma and Taylor's uploads. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD "Overview and Library analytics · Running Frameleaf". SCREEN: Settings opens on Overview. ZOOM on the health line: green dot "Library available", "2 things need attention", "Snapshot · 26 Sep 2026, 09:14". | Library available · 2 things need attention | "The Overview is the first page administrators see in Settings. Its top line says whether the library is available, how many things need attention, and when this snapshot was taken." |
| 3 | 0:16–0:31 | ZOOM on the four tiles, HIGHLIGHT each as named: "All accounts & libraries · 153,792 · Photos, videos & RAW originals"; "Library filesystem · 2.42 TiB · 1.58 TiB available"; "Latest database backup" (19 September, 02:00) with "Database backups"; "Frameleaf version" with "Updates & build information". CURSOR opens the "Viewing" picker in the context bar: Server, Taylor, Jamie, Emma, Taylor's uploads; closes it on Server. | Viewing | "Four tiles follow: your items, the library filesystem, the latest database backup and the Frameleaf version. Each opens the page behind it. Viewing, at the top, narrows the page to one account or one library." |
| 4 | 0:31–0:44 | ZOOM on "Needs your attention": rows "Prove your backup can restore · No restore test has been recorded." and "Review failed jobs · 3 · Server"; footer "Only actionable issues appear here." HIGHLIGHT each row. | Needs your attention | "Needs your attention lists only issues you can act on, such as a missing or overdue restore test, or failed jobs. Each item opens the place to fix it." |
| 5 | 0:44–0:59 | ZOOM on the "Storage" card, subtitle "Photo archive · library filesystem". COUNTER fills the meter to "2.42 TiB of 4.00 TiB used". CALLOUTs on the key as named: "Physical originals · All accounts & libraries", "Thumbnails & proxies", "Database & other". HIGHLIGHT "Manage ›". | 2.42 TiB of 4.00 TiB used | "The storage meter covers the whole filesystem, here 2.42 of 4 tebibytes used. Below it, physical originals, thumbnails and proxies, and the database are listed apart. Thumbnails and the database are measured each night." |
| 6 | 0:59–1:08 | SCREEN scrolls: "Processing · Server · Snapshot" with two queue rows ("Thumbnails · 2 active · 118 waiting", "Visual search · 1 active · 40 waiting") and "Queues ›"; "System at a glance" with "API & database · Responded to this snapshot", "ML endpoint · Reachable", "Cloud destination · Local preferred". | Processing · System at a glance | "Processing shows the busy queues, and System at a glance checks the database, the machine-learning endpoint and the cloud destination." |
| 7 | 1:08–1:20 | SCREEN: back to Needs your attention. HIGHLIGHT "Prove your backup can restore"; CURSOR clicks. Page changes to Maintenance → Database backups; ZOOM on the panel "Recovery readiness": "Database · Not recorded", "Original files · Not recorded", "Next test · Due now". | Recovery readiness | "Now fix the first item. Prove your backup can restore opens Recovery readiness, under Maintenance and Database backups. A backup only counts once you know it restores." |
| 8 | 1:20–1:38 | CURSOR clicks "Record a restore test". Dialog: "Restore into an isolated destination and verify checksums. Then record what restored correctly." CURSOR ticks "The database restored and its albums, people and edits were checked" and "Original files restored and their checksums were verified". ZOOM on "This records your statement; Frameleaf does not run the test. A new test is due every 90 days." CURSOR clicks "Record restore test". Panel updates: both rows "Restore proved 26 Sep 2026, 09:20", "Next test · Due 25 Dec 2026", "Last recorded by Taylor." | Record a restore test · Due every 90 days | "Restore a backup into an isolated place and verify the checksums. Then choose Record a restore test, tick what restored correctly, and save. Frameleaf records your statement; it does not run the test. The next one is due in ninety days." |
| 9 | 1:38–1:53 | SCREEN: Overview again; HIGHLIGHT "Explore analytics ›" beside Library growth; then the rail item "Library analytics". Page header "Library analytics · How it grows, what it holds, and the work behind it." CURSOR switches "Date range" between "12 months" and "90 days", then opens "Library scope" and hovers Emma. | Date range · Library scope | "For the long view, choose Explore analytics, or Library analytics in the rail. Pick a date range of twelve months or ninety days, and a scope: the whole server, one account or one library." |
| 10 | 1:53–2:06 | SCREEN scrolls slowly through the sections; a small CALLOUT names each heading as it passes: "Library growth", "Photo and video arrivals", "Processing outcomes", "How much the library knows", "Where your photos live", "Albums, owned and shared", "Under the hood". | Library growth · Arrivals · Processing · Metadata · Views · Albums · Under the hood | "The page reads top to bottom: library growth, arrivals, processing outcomes, how much the library knows, where your photos live, albums, and storage details under the hood." |
| 11 | 2:06–2:19 | CURSOR clicks "View data table" under Library growth; the table opens with Period and Items columns. CURSOR clicks "Export CSV" in the header; notice "CSV download started. Your selected dates, library and chart values are included." ZOOM on "About these numbers": "Locked items are never counted here" and "nothing is sent anywhere". | View data table · Export CSV | "Every chart has a data table, and Export CSV downloads what you see. Locked items are never counted, and everything is computed and kept on this server." |
| 12 | 2:19–2:27 | SPLIT: left, a fresh server's growth panel: "Growth history starts with the first nightly collection on this server. Come back tomorrow, or run “Collect library analytics now” from Jobs."; right, the populated Library growth chart. | Growth starts with the first nightly collection | "Growth history starts with the first nightly collection, so a new server fills in from the next day." |
| 13 | 2:27–2:30 | LOGO OUTRO | Next: OPS-03 · How processing works: queues and Activity | "Next up: How processing works: queues and Activity." |

## Voice-over (clean)

The Overview is the first page administrators see in Settings. Its top line says whether the library is available, how many things need attention, and when this snapshot was taken.

Four tiles follow: your items, the library filesystem, the latest database backup and the Frameleaf version. Each opens the page behind it. Viewing, at the top, narrows the page to one account or one library.

Needs your attention lists only issues you can act on, such as a missing or overdue restore test, or failed jobs. Each item opens the place to fix it.

[beat]

The storage meter covers the whole filesystem, here 2.42 of 4 tebibytes used. Below it, physical originals, thumbnails and proxies, and the database are listed apart. Thumbnails and the database are measured each night.

Processing shows the busy queues, and System at a glance checks the database, the machine-learning endpoint and the cloud destination.

[pause]

Now fix the first item. Prove your backup can restore opens Recovery readiness, under Maintenance and Database backups. A backup only counts once you know it restores.

Restore a backup into an isolated place and verify the checksums. Then choose Record a restore test, tick what restored correctly, and save. Frameleaf records your statement; it does not run the test. The next one is due in ninety days.

[pause]

For the long view, choose Explore analytics, or Library analytics in the rail. Pick a date range of twelve months or ninety days, and a scope: the whole server, one account or one library.

The page reads top to bottom: library growth, arrivals, processing outcomes, how much the library knows, where your photos live, albums, and storage details under the hood.

Every chart has a data table, and Export CSV downloads what you see. Locked items are never counted, and everything is computed and kept on this server.

Growth history starts with the first nightly collection, so a new server fills in from the next day.

[pause]

Next up: How processing works: queues and Activity.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. The source docs predate this screen: server-stats.md describes the old "Server Stats" page (per-user photos, videos, usage and quota). Its successor is the Overview plus Library analytics in the Command Center; per-account usage and quota now also appear in Users (OPS-12). Narrate the current screens.
- Labels verified in the build: "Library available", "{n} things need attention", "Snapshot · {time}", "Photos, videos & RAW originals", "Library filesystem", "{size} available", "Latest database backup", "Database backups", "Frameleaf version", "Updates & build information", "Library growth", "Last 12 months", "Explore analytics ›", "Needs your attention", "Prove your backup can restore", "Review failed jobs", "Only actionable issues appear here.", "Storage", "Photo archive · library filesystem", "Manage ›", "Physical originals", "Thumbnails & proxies", "Database & other", "Processing", "Queues ›", "System at a glance", "API & database", "ML endpoint", "Cloud destination", "Local preferred".
- The Latest database backup tile prints the backup file name, which starts with the legacy prefix `immich-db-backup-`. Frame the zoom on the date and time, or blur the prefix.
- Do not seed the "Check worker compatibility" attention item or call out the "GPU Studio" row of System at a glance: both report Studio render workers, which belong to the HOLD Studio episodes.
- The storage key reads "Not yet measured" until the nightly collector has measured thumbnails, proxies and the database, and "Not measured" outside the whole-server scope. Capture on the Server scope after a nightly run. The VO reads "2.42 of 4 tebibytes"; the screen shows TiB.
- Recovery readiness lives in Maintenance → Database backups (it is not a separate area). Strings: "Recovery readiness", "A successful database backup is only one part of recovery. Prove that the database and the original files restore.", "Record a restore test", "Record restore test", "Restore proved {date}", "Not recorded", "Next test", "Due now", "Due {date}", "Last recorded by {name}." The interval is 90 days (server constant). The restore itself is shown in OPS-11.
- Analytics labels: header eyebrow "Command center", title "Library analytics", subtitle "How it grows, what it holds, and the work behind it.", "Date range" (12 months, 90 days), "Library scope", "Export CSV", "View data table", "About these numbers". Section headings in order: "Library growth", "Coming into the library / Photo and video arrivals", "Work happening in the background / Processing outcomes", "How much the library knows / Metadata completeness", "Where your photos live", "Albums, owned and shared", "Under the hood". Processing outcomes appear only in the "All accounts & libraries" scope.
- The empty-history message says "run “Collect library analytics now” from Jobs"; the Job manager's task is actually named "Collect library analytics" (OPS-03). Show the message as the build prints it.
- "Locked items are never counted" and "nothing is sent anywhere" quote the About these numbers text.
