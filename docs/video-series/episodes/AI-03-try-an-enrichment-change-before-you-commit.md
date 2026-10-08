# AI-03 · Try an enrichment change before you commit

| Field | Value |
| --- | --- |
| Series | Frameleaf AI |
| Type | How-to |
| Target length | 2:30 |
| Audience | Administrators about to change a description model or prompt |
| Features demonstrated | Preview a description, Try an enrichment change (Choose sample, Compare, Scope), Processing destination, draft preview note, Current versus Candidate, frames seen, nothing saved, plan stages (Descriptions and tags, Locked-content check, Reusable video frames, Moment search index, Moment captions), Queue plan, plans in Activity, Pause, Cancel, Retry |
| Source docs | docs/docs/features/descriptions-and-smart-albums.md, docs/docs/administration/system-settings.md |
| Capture checklist | Signed in as Taylor (admin). Settings → Search & intelligence → Image Description with an unsaved change to Custom vocabulary so the draft note appears. "Try an enrichment change" dialog: sample picker with recent items including "Hiking with Jamie", "Elk in meadow" and "Kayaking.mov"; Processing destination reading "Default"; Compare view with Current and Candidate for each sample; Scope step with all five stages; Activity page with the queued plan moving to Running, then Completed; one item shown as Skipped with a reason. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD "Try an enrichment change before you commit · Frameleaf AI"; SCREEN Settings → Search & intelligence → Image Description; HIGHLIGHT the "Preview a description" button; CURSOR clicks | Preview a description | "A prompt or model change can re-describe your whole library. Try it on a few samples first. In Image Description, choose Preview a description." |
| 3 | 0:16–0:27 | SCREEN dialog "Try an enrichment change"; ZOOM on the step strip "Choose sample · Compare · Scope"; CALLOUT on the intro line "Understand a prompt change before it reaches your library." | Choose sample · Compare · Scope | "The Try an enrichment change dialog has three steps: Choose sample, Compare and Scope. Understand a change before it reaches your library." |
| 4 | 0:27–0:39 | SCREEN Choose sample grid of recent items; CURSOR ticks "Hiking with Jamie", "Elk in meadow" and "Kayaking.mov"; COUNTER "3 of 6 chosen" | 3 of 6 chosen | "Choose up to six of your own photos or videos. Pick Hiking with Jamie, Elk in meadow and the Kayaking video." |
| 5 | 0:39–0:53 | CALLOUT on the "Processing destination" row reading "Default"; a second CALLOUT shows the cloud help text "This destination sends the samples off your network." greyed as an example | Processing destination | "Processing destination names where the preview runs. Default is the destination routed for descriptions. A cloud destination is marked and sends the samples off your network." |
| 6 | 0:53–1:00 | ZOOM on the note "You are previewing settings you have not saved yet." | Unsaved settings preview | "You can preview settings you have not saved yet. The dialog says so." |
| 7 | 1:00–1:13 | SCREEN Compare step; the three samples run one after another; ZOOM on "Hiking with Jamie": Current on the left, Candidate on the right, tags beneath, a "Names" line | Current · Candidate | "Compare runs the samples one at a time. Current sits beside Candidate, with the tags and any names the check removed." |
| 8 | 1:13–1:21 | ZOOM on the "Kayaking.mov" row; CALLOUT on "6 frames from the video" | 6 frames from the video | "For a video, it also says how many frames the model saw." |
| 9 | 1:21–1:32 | CALLOUT on the footer line "Nothing was saved. Existing descriptions are unchanged." | Nothing was saved | "Nothing is written. Descriptions, tags, the Locked state, search embeddings and frames stay exactly as they were." |
| 10 | 1:32–1:47 | SCREEN Scope step; CURSOR hovers each stage checkbox in order: Descriptions and tags, Locked-content check, Reusable video frames, Moment search index, Moment captions | Scope | "Scope chooses what a plan runs on those samples: Descriptions and tags and the Locked-content check for photos; Reusable video frames, Moment search index and Moment captions for videos." |
| 11 | 1:47–2:02 | ZOOM on the Moment captions help "Adds one model request per frame"; CALLOUT on "The plan uses your saved model and prompt. Save your settings first to run the version you previewed." | Save first | "Moment captions are never ticked for you, because they add one model request per frame. The plan uses your saved settings, so save first to run what you previewed." |
| 12 | 2:02–2:15 | HIGHLIGHT "Queue plan"; CURSOR clicks; SCREEN cuts to Activity where the plan row shows Queued, then Running | Queue plan → Activity | "Choose Queue plan. It runs in the background one item at a time and appears in Activity. It survives closing the browser or restarting the server." |
| 13 | 2:15–2:27 | SCREEN back in the dialog: item rows with states Completed, Completed, Skipped ("This video is too short for moments"); CALLOUT on the Pause, Cancel and Retry controls | Pause · Cancel · Retry | "The dialog follows each item: queued, running, skipped, failed or completed, with a reason. Pause and Cancel act between items, and Retry reruns only what failed." |
| 14 | 2:27–2:30 | LOGO OUTRO | Next: AI-04 · Tuning the description prompt | "Next up: Tuning the description prompt." |

## Voice-over (clean)

A prompt or model change can re-describe your whole library. Try it on a few samples first. In Image Description, choose Preview a description. [pause]

The Try an enrichment change dialog has three steps: Choose sample, Compare and Scope. Understand a change before it reaches your library. [beat] Choose up to six of your own photos or videos. Pick Hiking with Jamie, Elk in meadow and the Kayaking video. [beat] Processing destination names where the preview runs. Default is the destination routed for descriptions. A cloud destination is marked and sends the samples off your network. [beat] You can preview settings you have not saved yet. The dialog says so. [pause]

Compare runs the samples one at a time. Current sits beside Candidate, with the tags and any names the check removed. [beat] For a video, it also says how many frames the model saw. [beat] Nothing is written. Descriptions, tags, the Locked state, search embeddings and frames stay exactly as they were. [pause]

Scope chooses what a plan runs on those samples: Descriptions and tags and the Locked-content check for photos; Reusable video frames, Moment search index and Moment captions for videos. [beat] Moment captions are never ticked for you, because they add one model request per frame. The plan uses your saved settings, so save first to run what you previewed. [pause]

Choose Queue plan. It runs in the background one item at a time and appears in Activity. It survives closing the browser or restarting the server. [beat] The dialog follows each item: queued, running, skipped, failed or completed, with a reason. Pause and Cancel act between items, and Retry reruns only what failed. [pause]

Next up: Tuning the description prompt.

## Production notes

- Prerequisites: "Generate image descriptions and tags" on; a description destination routed under Processing destinations (otherwise the dialog shows "No processing destination can describe photos yet"); the three sample items already have thumbnails; the Kayaking clip is long enough to yield frames. Make one unsaved edit to Custom vocabulary before opening the dialog so the draft note is real.
- The cloud help text in beat 5 is shown as an illustration only; the server is not linked to Frameleaf Cloud, so no cloud destination is selectable. Keep the "Default" destination selected. Never show the Cloud processing page.
- Docs say "up to six of your own photos or videos" and that a video without frames is cut into a temporary folder for the preview and removed afterwards; the VO leaves that detail to the notes.
- Stage labels are the build's: "Descriptions and tags", "Locked-content check", "Reusable video frames", "Moment search index", "Moment captions". The frames help text reads "Six evenly spaced frames per video, ranked and kept for reuse."
- The skipped reason in beat 13 is an example ("This video is too short for moments"); use whichever reason the capture produces, or seed a two-frame clip to force it.
- Every failure is retried once automatically before Retry is needed; the VO keeps to "Retry reruns only what failed".
- Locked items are processed like any other but listed only in their owner's unlocked session; no Locked items in the sample set.
- Outro card: "Next: AI-04 · Tuning the description prompt".
