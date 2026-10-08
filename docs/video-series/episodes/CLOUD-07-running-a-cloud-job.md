# CLOUD-07 · Running a cloud job

| Field | Value |
| --- | --- |
| Series | Frameleaf Cloud |
| Type | Learn |
| Target length | 2:45 |
| Audience | Administrators and editors who will send work to Frameleaf Cloud and want to know what happens to a job and its cost |
| Features demonstrated | Per-job confirmation (model, estimate range, Billed as, Held from AI credit, Send this job to Frameleaf Cloud, Run on Frameleaf Cloud · hold), Activity stages Queued, Starting and Running, start fee and cold start, cost so far and held, chunks and workers for long videos, refusal reasons with nothing sent and no fallback, settled cost with the hold returned, no charge on failure and Retry, Recent cloud jobs, previews only and deleted after the job |
| Source docs | /Users/adamtaylor/Github/frameleaf-cloud/docs/cloud-ml.md, docs/docs/administration/workers-and-endpoints.md |
| Capture checklist | HOLD: capture from the design prototypes with the on-screen label "Preview" on every beat. App prototype (design/frameleaf/template), Taylor signed in with cloud processing on and AI credit available: the video editor on "Lake morning.mov" with Restore controls and Destination "Frameleaf Cloud"; the "Restore on Frameleaf Cloud" dialog in its confirm, refused (not enough AI credit) and running states; Activity with the job moving Queued → Starting → Running → Done, its cost block, and a failed cloud job with "No charge"; Settings → Frameleaf Cloud → Cloud processing → "Recent cloud jobs". Account-site prototype (frameleaf-cloud/design/prototype): Cloud processing → Jobs → job_1W9F4 with "Chunks and workers". |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:18 | LOWER-THIRD "Running a cloud job · Frameleaf Cloud". SCREEN (app prototype): the video editor on "Lake morning.mov" (0:24), Restore controls with Restoration mode "Faithful" and Destination "Frameleaf Cloud", and the line "Frameleaf Cloud asks you to confirm the model, cost and what leaves this server for every job." CURSOR starts the restoration; the dialog "Restore on Frameleaf Cloud" opens. | Preview · Restore on Frameleaf Cloud | "This is a preview of running a job on Frameleaf Cloud. Every cloud job follows the same path: you confirm it, it runs, and it settles. Here, Lake morning is restored on Frameleaf Cloud." |
| 3 | 0:18–0:35 | ZOOM down the dialog: the summary line "Video restoration · … · Lake morning.mov", the slider "Model · lighter to heavier", then the facts Estimate ("Typical to high end, start fees included"), Billed as, Per source minute, Held from AI credit and AI credit available. Amounts and the GPU class under Billed as are blurred. | Preview · Estimate · Billed as · Held from AI credit | "The confirmation comes first. It shows the model, and an estimate from typical to high end with start fees included. It shows how the job is billed, and how much is held from your AI credit." |
| 4 | 0:35–0:48 | CURSOR ticks "Send this job to Frameleaf Cloud"; ZOOM on its line "Previews leave this server; metadata is removed; nothing is kept after the job." CURSOR clicks "Run on Frameleaf Cloud · hold …". | Preview · Send this job to Frameleaf Cloud · Run on Frameleaf Cloud | "Tick Send this job to Frameleaf Cloud. Only previews leave your server, metadata is removed, and nothing is kept after the job. Then choose Run on Frameleaf Cloud." |
| 5 | 0:48–1:04 | SCREEN: Activity. The job card's stage chip moves Queued → Starting → Running. While Starting, ZOOM on "Starting a Frameleaf Cloud worker · loading the model" and the note "… covers starting the worker and loading the model. A cold start can take up to a minute; GPU time is billed only once work begins." | Preview · Queued · Starting · Running | "In Activity, the job moves through Queued, Starting and Running. Starting means a Frameleaf Cloud worker is loading the model. The start fee covers that, and GPU time is billed only once work begins." |
| 6 | 1:04–1:15 | ZOOM on the job's cost block: Model, Estimated, Billed as, So far and Held, the amounts blurred. Inset: the dialog's "Continue in Activity" closing it. | Preview · Estimated · So far · Held | "While it runs, Activity shows the estimate, the cost so far and the amount held. You can close the dialog; the job keeps going." |
| 7 | 1:15–1:36 | SCREEN (account-site prototype): account.frameleaf.cloud → Cloud processing → Jobs → job_1W9F4, a Faithful restoration. ZOOM on "Chunks and workers": the grid of 40 chunks, 25 done and 5 running, and "… chunks of 30 s across 5 GPU workers (at most 5 per job). Each chunk is saved as it finishes, so a lost worker costs at most one chunk." DIAGRAM overlay: a long video bar splits into chunks that fan out to five worker nodes, each with a small "start fee" tag. | Preview · Chunks and workers · up to 5 workers | "Long videos are cut into chunks of twenty to thirty seconds and spread across up to five workers, so they finish sooner. Each chunk is saved as it finishes, so a lost worker costs at most one chunk. Each worker adds a start fee, and the estimate includes them." |
| 8 | 1:36–1:54 | SCREEN (app prototype): the dialog in its refused state, "Add AI credit: this job needs … available. Nothing is sent, and the job does not move to another worker.", with the buttons "Add credit" and "Open Frameleaf Cloud settings". CARD beside it, headline "Why a job can't start"; bullets: "Not enough AI credit, or today's cap reached", "Terms not accepted", "Frameleaf Cloud did not answer". | Preview · Nothing is sent · never moves to another worker | "Sometimes a job cannot start. The dialog says why: the wallet needs credit, today's spending cap is reached, the terms need accepting, or Frameleaf Cloud did not answer. Nothing is sent, and the job never moves to another worker." |
| 9 | 1:54–2:08 | SCREEN: Activity, the restoration finished: "Finished". ZOOM on "Settled … · Within the estimate · … returned to AI credit" and the line "Previews and results are deleted from Frameleaf Cloud now that the job is done." | Preview · Settled · returned to AI credit | "When the job finishes, it settles at the metered cost. The rest of the hold returns to your AI credit, and previews and results are deleted from Frameleaf Cloud." |
| 10 | 2:08–2:17 | SCREEN: a failed cloud job in Activity: "Stopped", Settled "No charge", and "Nothing moved to another worker. Retry it from Activity."; HIGHLIGHT "Retry · hold …". | Preview · No charge · Retry | "If a job fails on Frameleaf Cloud's side, you pay nothing, not even the start fee. Retry it from Activity." |
| 11 | 2:17–2:29 | SCREEN: Settings → Frameleaf Cloud → Cloud processing → "Recent cloud jobs" ("Estimates next to what each job cost: GPU time at the job's rate plus its start fees."). ZOOM on a restoration row with "… GPU time · 5 workers". | Preview · Recent cloud jobs | "On the Cloud processing page, Recent cloud jobs puts each estimate next to what the job cost, with its GPU time and workers." |
| 12 | 2:29–2:42 | CARD headline "Every cloud job"; bullets: "Cost shown before it starts", "Previews only, deleted after", "Never falls back silently". | Every cloud job | "Every cloud job shows its cost first, sends only previews, and never falls back silently." |
| 13 | 2:42–2:45 | LOGO OUTRO | Guide: Workers and Endpoints | "The written guide is linked below." |

## Voice-over (clean)

This is a preview of running a job on Frameleaf Cloud. Every cloud job follows the same path: you confirm it, it runs, and it settles. Here, Lake morning is restored on Frameleaf Cloud.

The confirmation comes first. It shows the model, and an estimate from typical to high end with start fees included. It shows how the job is billed, and how much is held from your AI credit.

Tick Send this job to Frameleaf Cloud. Only previews leave your server, metadata is removed, and nothing is kept after the job. Then choose Run on Frameleaf Cloud.

[pause]

In Activity, the job moves through Queued, Starting and Running. Starting means a Frameleaf Cloud worker is loading the model. The start fee covers that, and GPU time is billed only once work begins.

While it runs, Activity shows the estimate, the cost so far and the amount held. You can close the dialog; the job keeps going.

Long videos are cut into chunks of twenty to thirty seconds and spread across up to five workers, so they finish sooner. Each chunk is saved as it finishes, so a lost worker costs at most one chunk. Each worker adds a start fee, and the estimate includes them.

[pause]

Sometimes a job cannot start. The dialog says why: the wallet needs credit, today's spending cap is reached, the terms need accepting, or Frameleaf Cloud did not answer. Nothing is sent, and the job never moves to another worker.

When the job finishes, it settles at the metered cost. The rest of the hold returns to your AI credit, and previews and results are deleted from Frameleaf Cloud.

If a job fails on Frameleaf Cloud's side, you pay nothing, not even the start fee. Retry it from Activity.

On the Cloud processing page, Recent cloud jobs puts each estimate next to what the job cost, with its GPU time and workers.

[beat]

Every cloud job shows its cost first, sends only previews, and never falls back silently.

The written guide is linked below.

## Production notes

- Narration tone: Calm, explanatory; the job's life in order, confirm → run → settle.
- HOLD dependency: cloud jobs are not built yet. The shipped app has no estimate or job client; a job routed to Frameleaf Cloud is refused (frameleaf-cloud `docs/app-integration-as-built.md` §10). Capture every beat from the design prototypes and carry the on-screen label "Preview" on every beat: the app prototype `design/frameleaf/template` (`CloudJobDialog.jsx`, `Activity.jsx`, `FrameleafCloud.jsx` "Recent cloud jobs") and the account-site prototype `frameleaf-cloud/design/prototype` (`#/processing/jobs?job=job_1W9F4`). Publish only after cloud jobs ship.
- Blur every amount (estimate, hold, so far, settled, start fee, per-minute rate): cloud-ml.md calls them estimates from planning throughput. Blur every GPU class too; the dialog's "Billed as" line and the account site's job detail print GPU class names and models. No GPU, storage or hosting provider appears.
- Crop the prototype line "Model estimates and quality comparisons require a qualified worker. This prototype simulates the flow." from beat 2. Never show a "Studio render" cloud job: Studio exports always render at home (cloud-ml.md, owner decision 2026-09-25).
- Chunk length: cloud-ml.md and the account site say 20–30 s chunks on at most 5 workers; the app's billing text says 30-second chunks. The VO says "twenty to thirty seconds".
- Refusal reasons are the app's admission reasons (workers-and-endpoints.md: not configured, not linked or unavailable, consent missing or out of date, wallet empty, limit reached, model no longer offered) and the shipped strings "Add AI credit: this job needs … available.", "This job would pass today's spending cap.", "Review and accept the current cloud processing terms." and "Frameleaf Cloud did not answer. Nothing is sent anywhere else."
- Settlement follows frameleaf-cloud `docs/ai-wallet.md`: the hold is sized from the high-end estimate, the job is charged its metered cost, the rest is released, and a failure on the cloud's side is refunded in full, start fee included. The budget-ceiling case (the account site's job_1K8V5) is left for the written guide.
- Sample data: "Lake morning.mov" from the sample library for the restored video. The long-video example is the account-site prototype's job_1W9F4 (a 20-minute Faithful restoration); the app prototype's "Recent cloud jobs" rows are prototype data, and a row title that is not in the sample library can be cropped to its Model, Status, Estimate and Cost columns.
- Only the client side appears: the app and the customer account site. Never show the staff console.
