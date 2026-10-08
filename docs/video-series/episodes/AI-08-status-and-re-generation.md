# AI-08 · Status and re-generation

| Field | Value |
| --- | --- |
| Series | Frameleaf AI |
| Type | How-to |
| Target length | 2:15 |
| Audience | Administrators who have changed the description model or prompt and need to bring existing descriptions up to date |
| Features demonstrated | Status & Re-generation panel (Last config change, Pending re-queue scheduled, Total eligible image assets, Already described, Pending re-description, Estimated re-queue time), Re-queue all image descriptions, Re-queue image descriptions modal (counts, Estimated seconds per asset, Estimated total time, Active backend, Active model), Cancel / Re-queue later / Re-queue now, pending re-queue banner with Re-queue now, Job manager reminder and Enrichment tasks, already-in-flight protection, out-of-date descriptions |
| Source docs | docs/docs/features/descriptions-and-smart-albums.md |
| Capture checklist | Signed in as Taylor (admin), dark theme. Settings → Search & intelligence with the "Image descriptions and tags" group; descriptions on and at least 100 description jobs completed since the last restart so the estimate is real. A saved prompt change made just before capture, so Last config change is today. Job manager (Compute & jobs) reachable. Viewer on "Moraine Lake" with an AI description made before the prompt change, for the out-of-date line. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD "Status and re-generation · Frameleaf AI"; SCREEN Settings → Search & intelligence; the "Image descriptions and tags" group with its prompt fields; a just-saved change highlighted green for a moment | Image descriptions and tags | "Changing the description model or prompt changes nothing that is already written until you re-queue. Status & Re-generation shows how much there is and how long it will take." |
| 3 | 0:16–0:30 | CURSOR scrolls to the bottom of the group; the sub-panel "Status & Re-generation" comes into view; ZOOM on "Last config change" with today's time | Status & Re-generation | "Open Settings, then Search & intelligence, and scroll to the bottom of Image descriptions and tags. Last config change records when the saved settings really changed; saving without a change leaves it alone." |
| 4 | 0:30–0:42 | ZOOM moves down the rows: "Pending re-queue scheduled" (—), "Total eligible image assets" 12,480, "Already described" 11,902, "Pending re-description" 578 | Eligible · Described · Pending | "Total eligible image assets is what the pipeline can describe, split into Already described and Pending re-description. Pending re-queue scheduled shows a reminder you have set." |
| 5 | 0:42–0:56 | CALLOUT on "Estimated re-queue time" reading about 5 h; a small CARD beside it: "Average of the last 100 jobs", "1.5 s each after a restart" | Estimated re-queue time | "Estimated re-queue time covers every eligible image, from the average of the last hundred description jobs on this server. After a restart it assumes one and a half seconds each until new jobs finish." |
| 6 | 0:56–1:09 | HIGHLIGHT then CURSOR clicks "Re-queue all image descriptions"; modal "Re-queue image descriptions" with Total eligible assets, Already have a description, Missing a description, Estimated seconds per asset, Estimated total time, Active backend, Active model | Re-queue image descriptions | "Choose Re-queue all image descriptions. The modal repeats the counts and adds the seconds per asset, the total time, and the backend and model that will do the work." |
| 7 | 1:09–1:19 | ZOOM on the modal footer: "Cancel", "Re-queue later", "Re-queue now"; HIGHLIGHT pulses on the last two in turn | Re-queue now · Re-queue later | "Re-queue now starts straight away and describes every eligible image again with the saved settings. Re-queue later sets a reminder instead." |
| 8 | 1:19–1:33 | CURSOR clicks "Re-queue later"; toast "We'll remind you to re-queue in the Image Description settings"; Pending re-queue scheduled fills with the time; SCREEN scrolls to the top of the group, where a yellow banner reads "Description config changed on {date}. 12,480 assets will be re-described." with a "Re-queue now" button | Re-queue later → reminder | "Re-queue later suits a session of tuning. A banner appears at the top of Image descriptions and tags with the date of the change and how many assets will be described again." |
| 9 | 1:33–1:45 | SCREEN Settings → Compute & jobs → Job manager; message row "Description regeneration is waiting for your review." with "Review reminder"; CURSOR clicks it; dialog "Enrichment tasks" with Task "Regenerate descriptions" and When "Queue now" / "Remind me later"; CURSOR closes it | Review reminder → Enrichment tasks | "Job manager, under Compute & jobs, shows the same reminder. Review reminder opens Enrichment tasks, where Regenerate descriptions can be queued now or left for later." |
| 10 | 1:45–1:57 | Back in Image descriptions and tags; CURSOR clicks "Re-queue now" in the banner; the modal loads fresh counts; CURSOR clicks "Re-queue now"; toast "Re-queue job started."; the banner disappears and Pending re-queue scheduled returns to — | Re-queue job started. | "When you are ready, choose Re-queue now in the banner. The modal opens with the latest counts. Once the job starts, the banner and the reminder clear." |
| 11 | 1:57–2:04 | CURSOR clicks "Re-queue all image descriptions" again and confirms; toast "A re-queue job is already in flight." | Already in flight | "Clicking again while it runs does not duplicate work; Frameleaf says a re-queue job is already in flight." |
| 12 | 2:04–2:12 | SCREEN viewer on "Moraine Lake", information card Enrichment section; ZOOM on the line "Out of date: the saved prompt has changed since this was generated."; quick cut to "Emma at the lake" with "Written by you" | Out of date | "Until then, older generated descriptions are marked out of date. Text you wrote yourself is never touched." |
| 13 | 2:12–2:15 | LOGO OUTRO | Next: AI-09 · Smart albums | "Next up: Smart albums." |

## Voice-over (clean)

Changing the description model or prompt changes nothing that is already written until you re-queue. Status & Re-generation shows how much there is and how long it will take.

[pause]

Open Settings, then Search & intelligence, and scroll to the bottom of Image descriptions and tags. Last config change records when the saved settings really changed; saving without a change leaves it alone.

Total eligible image assets is what the pipeline can describe, split into Already described and Pending re-description. Pending re-queue scheduled shows a reminder you have set.

Estimated re-queue time covers every eligible image, from the average of the last hundred description jobs on this server. After a restart it assumes one and a half seconds each until new jobs finish.

[pause]

Choose Re-queue all image descriptions. The modal repeats the counts and adds the seconds per asset, the total time, and the backend and model that will do the work.

Re-queue now starts straight away and describes every eligible image again with the saved settings. Re-queue later sets a reminder instead.

Re-queue later suits a session of tuning. A banner appears at the top of Image descriptions and tags with the date of the change and how many assets will be described again.

Job manager, under Compute & jobs, shows the same reminder. Review reminder opens Enrichment tasks, where Regenerate descriptions can be queued now or left for later.

[pause]

When you are ready, choose Re-queue now in the banner. The modal opens with the latest counts. Once the job starts, the banner and the reminder clear.

Clicking again while it runs does not duplicate work; Frameleaf says a re-queue job is already in flight.

Until then, older generated descriptions are marked out of date. Text you wrote yourself is never touched.

Next up: Smart albums.

## Production notes

- Labels verified in the build (ImageDescriptionSection, ImageDescriptionRequeueModal, JobsManager): group heading "Image descriptions and tags"; sub-panel "Status & Re-generation" with "Last config change", "Pending re-queue scheduled", "Total eligible image assets", "Already described", "Pending re-description", "Estimated re-queue time"; button "Re-queue all image descriptions"; modal "Re-queue image descriptions" with "Total eligible assets", "Already have a description", "Missing a description", "Estimated seconds per asset", "Estimated total time", "Active backend", "Active model", and buttons "Cancel", "Re-queue later", "Re-queue now"; banner "Description config changed on {date}. {count} assets will be re-described." with "Re-queue now"; toasts "Re-queue job started.", "A re-queue job is already in flight.", "We'll remind you to re-queue in the Image Description settings"; Job manager message "Description regeneration is waiting for your review." with "Review reminder", opening "Enrichment tasks" (Task: Regenerate descriptions; When: Queue now, Remind me later).
- Doc vs build: the docs name the rows "Total eligible assets" and "Already described" / "Pending re-description" in one place and "Total eligible image assets" in another, and call the modal's primary button "Re-queue"; the build's labels are the ones above. The docs' path "Administration → System Settings → Machine Learning → Image Description" is Settings → Search & intelligence in the build. AI-02 says "Image Description" in narration; this episode narrates the group heading as built.
- The counts and estimate cover images only (the build's label says "image assets"), and the estimate multiplies all eligible images by the rolling average, because a re-queue re-describes everything with the saved settings (force). Videos are still described by the queue (AI-07) but are not in these counts; do not claim they are.
- The banner's count is the total eligible figure, not the pending figure. Capture numbers are illustrative; keep whatever the capture server shows and do not read a number the screen does not show.
- Beat 12: the out-of-date line appears on generated descriptions after a saved prompt change ("What makes a result out of date" in the docs). A typed description shows "Written by you" and is never changed.
- Outro card: "Next: AI-09 · Smart albums".
