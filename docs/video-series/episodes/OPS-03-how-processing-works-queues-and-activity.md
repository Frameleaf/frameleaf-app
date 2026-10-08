# OPS-03 · How processing works: queues and Activity

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | Learn |
| Target length | 2:45 |
| Audience | Administrators who want to understand what the server does after an upload and where to watch or fix background work |
| Features demonstrated | Upload pipeline and job order, Job manager (Queues & jobs: metrics, queue table, queue detail tabs, pause and resume, run missing and reprocess all, command review), Queue concurrency, Retry failed jobs, Create a maintenance job, Nightly work & model cache, Activity page (filters, progress, pause, cancel, retry, top-bar indicator) |
| Source docs | docs/docs/administration/jobs-workers.md |
| Capture checklist | Taylor signed in as administrator on frameleaf.home, dark theme. Upload of the sample videos and photos (Lake morning.mov, Kayaking.mov, Moraine Lake, Summit view) so queues have work. Settings → Compute & jobs → Job manager showing the four metrics and the queue table with Thumbnails and Visual search active. The Thumbnails queue opened with jobs in Active, Waiting and History. Queue concurrency dialog with Thumbnails at 3. A Visual search failed job (for example after turning the machine-learning worker off briefly) with its Last error. Create a maintenance job dialog. Nightly work & model cache section. Activity page with an Upload row (Lake morning.mov, Done), a Library scan row running, and a Download row (Summer in the Rockies) ready; the top-bar activity indicator showing one running job. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:15 | LOWER-THIRD "How processing works: queues and Activity · Running Frameleaf". TITLE "What happens after an upload" with subheading "Queues, jobs and where to watch them". A thumbnail of Moraine Lake drops into the frame. | What happens after an upload | "When a photo arrives, Frameleaf does its work in the background as jobs. This episode follows an upload through the queues and shows where to watch it." |
| 3 | 0:15–0:34 | DIAGRAM, left to right, nodes appearing as named: "Upload" → "Metadata" → "Storage organization" (dashed, label "if the storage template is on") → "Thumbnails" → fan-out of five teal nodes: "Visual search", "Face detection", "Text recognition", "Playback videos" (label "videos only"), "Descriptions & tags" (small sub-label "and Locked-content detection"). The Moraine Lake thumbnail travels along the green path. | Metadata → Storage organization → Thumbnails → … | "First the server reads metadata, such as the capture date and camera. If a storage template is on, the file is organized. Then thumbnails are made. From there the work fans out: visual search, face detection, text recognition, playback videos, and descriptions and tags." |
| 4 | 0:34–0:43 | DIAGRAM adds a second column: "Visual search" → "Photo duplicates"; "Face detection" → "Face recognition". Both new arrows pulse green. | Some jobs wait for others | "Some jobs wait for others. Duplicate detection uses the search index, and face recognition matches the faces that detection found." |
| 5 | 0:43–0:56 | SCREEN: Settings → Compute & jobs; CURSOR clicks "Job manager". Page "Queues & jobs" with the metrics "Processing", "Waiting & scheduled", "Failed", "Completed in activity"; the queue table with columns Queue, Status, Active, Waiting, Failed, Workers. HIGHLIGHT the Thumbnails row (Processing) and the Visual search row. | Settings → Compute & jobs → Job manager | "Open Settings, then Compute & jobs, then Job manager. Queues & jobs shows what is processing, waiting and failed, with a row for every queue and its status." |
| 6 | 0:56–1:10 | CURSOR opens Thumbnails. Tabs Active, Waiting, Failed, History with job rows; the "Jobs over time" graph. HIGHLIGHT "Pause queue", then "Run missing" and "Reprocess all". CURSOR clicks Reprocess all; the review dialog "Reprocess all" reads "Queue a library-wide scan including previously processed assets. This can require substantial processing time.", with "Scope · All accounts" and "Keep current state"; CURSOR clicks Keep current state. | Active · Waiting · Failed · History | "Open a queue to see its jobs under Active, Waiting, Failed and History. You can pause or resume it, run missing work, or reprocess everything. Every command shows a review first." |
| 7 | 1:10–1:29 | CURSOR clicks "Concurrency" in the header. Dialog "Queue concurrency": "Set simultaneous jobs per server worker. Higher limits can compete for CPU, GPU memory, and storage bandwidth." CURSOR changes Thumbnails from 3 to 4; the row shows "Pending". ZOOM on Face recognition: "Fixed at one to keep operations ordered". Footer "Concurrency changes join the settings review. They do not change a job’s destination or retry a failure." HIGHLIGHT "Review 1 pending settings". | Queue concurrency · Stay within your CPU cores | "Concurrency sets how many jobs of each kind run at once on a server worker. Higher is faster only if the hardware keeps up, so stay within your processor cores. Changes join the settings review, and running jobs are never cancelled. Face recognition is fixed at one." |
| 8 | 1:29–1:43 | SCREEN: Visual search → Failed tab. Rows with Job, Account, Worker. CURSOR opens one job: detail with "Last error · The destination did not answer.". CURSOR clicks "Retry failed"; review "Retry failed jobs": "Put failed jobs back in the queue with their saved inputs. Each runs on the worker its kind of work is routed to when it starts. Resolve the reported problem first." CURSOR confirms. | Failed · Last error · Retry failed | "When jobs fail, open the Failed tab and read the last error. Fix the cause first, then choose Retry failed. The jobs go back in the queue with their saved inputs." |
| 9 | 1:43–1:56 | CURSOR clicks "Create job". Dialog "Create a maintenance job · Choose a task. Maintenance jobs run across the server." List: Clean up unused people, Clean up unused tags, Generate memories, Back up the database, Collect library analytics, Find missing files. CURSOR selects "Clean up unused tags", clicks "Review job"; review dialog; CURSOR clicks "Clean up unused tags". | Create job → Create a maintenance job | "Create job opens Create a maintenance job: one-off tasks such as generating memories, cleaning up unused tags or backing up the database. Pick one, review it, and start it." |
| 10 | 1:56–2:04 | SCREEN: Compute & jobs → "Nightly work & model cache"; HIGHLIGHT "Start time" showing 00:00, then the toggles "Database cleanup tasks", "Generate memories", "Sync quota usage", "Generate missing thumbnails" and "Cluster new faces". | Nightly work & model cache | "Scheduled work, like memories, runs each night from midnight; set the time in Nightly work & model cache." |
| 11 | 2:04–2:17 | SCREEN: top bar; CURSOR clicks "Activity" in the Library / Studio / Activity switcher. Activity page with rows: "Upload · Lake morning.mov · Done", "Library scan · Running · 42%", "Download · Summer in the Rockies · Ready". CURSOR clicks the filter chips All, Running, Done, Failed in turn. | Activity · All · Running · Done · Failed | "Queues are the server's plumbing. Activity, in the top bar, shows the tasks people start: uploads, downloads, imports, library scans and edits. Filter by All, Running, Done or Failed." |
| 12 | 2:17–2:33 | ZOOM on the Library scan row: "Running · 42% · about 3 min left" with Pause and Cancel. ZOOM on the footnote "Renders and background jobs run on your server and keep going when you leave this page." Then ZOOM on the top-bar activity indicator with a small progress ring; tooltip "1 job running, 42% done. Open Activity." | Keeps going when you leave | "Each row shows progress and, where it applies, pause, cancel or retry. Background jobs run on your server, so they keep going when you leave the page. The indicator in the top bar counts what is running." |
| 13 | 2:33–2:42 | CARD "Where to look": bullet 1 "Job manager: every queue, every account"; bullet 2 "Failed tab: the error to fix"; bullet 3 "Activity: tasks people start". | Where to look | "Use Job manager for the server's queues, and Activity for the tasks people start." |
| 14 | 2:42–2:45 | LOGO OUTRO | Guide: Jobs and Workers | "The written guide is linked below." |

## Voice-over (clean)

When a photo arrives, Frameleaf does its work in the background as jobs. This episode follows an upload through the queues and shows where to watch it.

[pause]

First the server reads metadata, such as the capture date and camera. If a storage template is on, the file is organized. Then thumbnails are made. From there the work fans out: visual search, face detection, text recognition, playback videos, and descriptions and tags.

Some jobs wait for others. Duplicate detection uses the search index, and face recognition matches the faces that detection found.

[pause]

Open Settings, then Compute & jobs, then Job manager. Queues & jobs shows what is processing, waiting and failed, with a row for every queue and its status.

Open a queue to see its jobs under Active, Waiting, Failed and History. You can pause or resume it, run missing work, or reprocess everything. Every command shows a review first.

Concurrency sets how many jobs of each kind run at once on a server worker. Higher is faster only if the hardware keeps up, so stay within your processor cores. Changes join the settings review, and running jobs are never cancelled. Face recognition is fixed at one.

[beat]

When jobs fail, open the Failed tab and read the last error. Fix the cause first, then choose Retry failed. The jobs go back in the queue with their saved inputs.

Create job opens Create a maintenance job: one-off tasks such as generating memories, cleaning up unused tags or backing up the database. Pick one, review it, and start it.

Scheduled work, like memories, runs each night from midnight; set the time in Nightly work & model cache.

[pause]

Queues are the server's plumbing. Activity, in the top bar, shows the tasks people start: uploads, downloads, imports, library scans and edits. Filter by All, Running, Done or Failed.

Each row shows progress and, where it applies, pause, cancel or retry. Background jobs run on your server, so they keep going when you leave the page. The indicator in the top bar counts what is running.

Use Job manager for the server's queues, and Activity for the tasks people start.

[pause]

The written guide is linked below.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. jobs-workers.md still says "Administration -> Jobs" and "System Settings -> Nightly Tasks Settings"; the current build is Settings → Compute & jobs, with the sections "Job manager" (page heading "Queues & jobs") and "Nightly work & model cache". Queue concurrency is edited only in the Job manager's Concurrency dialog, not on a settings page (system-settings.md "Job Settings").
- The diagram uses the build's queue names rather than the doc's job names: Metadata extraction → "Metadata", Storage Template Migration → "Storage organization", Thumbnail Generation → "Thumbnails", Smart Search → "Visual search", Face Detection → "Face detection", OCR → "Text recognition", Video Transcoding → "Playback videos", Image Enrichment → "Descriptions & tags" (with "Locked-content detection", the build's name for NSFW detection), Duplicate Detection → "Photo duplicates", Facial Recognition → "Face recognition". The order follows the doc's "Job processing order" diagram.
- Job manager strings: metrics "Processing", "Waiting & scheduled", "Failed", "Completed in activity"; tabs "Active", "Waiting", "Failed", "History"; commands "Pause queue", "Resume queue", "Run missing", "Reprocess all"; review "Scope", "All accounts", "Affected now", "Keep current state"; "Retry failed" and the review title "Retry failed jobs"; header buttons "Concurrency" and "Create job"; dialog "Create a maintenance job", "Search maintenance tasks…", "Review job". Some queues use their own start wording ("Start task", "Rescan libraries", "Scan missing").
- Concurrency (system-settings.md "Job Settings"): do not raise limits past your available CPU cores, especially for thumbnails. The dialog notes "Saved limits control the next jobs admitted. Active jobs continue; reducing the limit does not cancel them." Face recognition is fixed at one (the doc's DBSCAN note); the dialog shows fixed queues with "Fixed at one to keep operations ordered".
- For the failed-job beat, the build's refusal text for an unreachable worker is "The destination did not answer." Any real failure works; keep the error free of file paths from a real library.
- Nightly work: the doc says scheduled jobs run "every night at midnight by default"; the build's default start time is 00:00. The VO names memories because the doc does.
- Activity kinds seen in the build include Upload, Download, Library scan, Google Photos import, iCloud Photos sync, Library Care, Edit, Photo edit, Video edit and Preservation export. Uploads are tracked in the browser tab ("This browser tab only"); background jobs continue on the server, as the footnote says. The Studio item in the top-bar switcher is out of scope here.
- Outro CTA on screen: `Guide: Jobs and Workers`; the producer fills in the public docs URL.
