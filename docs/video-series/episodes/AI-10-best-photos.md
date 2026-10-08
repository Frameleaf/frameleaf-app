# AI-10 · Best photos

| Field | Value |
| --- | --- |
| Series | Frameleaf AI |
| Type | How-to |
| Target length | 2:00 |
| Audience | Frameleaf users who want to find their strongest shots quickly, and administrators scoring an existing library |
| Features demonstrated | Best Photos view in the sidebar, local quality score (sharpness and blur, exposure, contrast and detail, usable resolution, faces, penalty for screenshots and documents), ranking never by star rating, what Best Photos leaves alone, Best moments in your videos (Play from, Use as cover), Explore Best Photos card, automatic scoring after upload, face detection and edits, empty state, Create job → Recalculate Best Photos |
| Source docs | README.md (Best Photos), docs/docs/administration/jobs-workers.md |
| Capture checklist | Signed in as Taylor (admin), dark theme. Sample library fully scored. Best Photos showing Moraine Lake, Summit view, Emma portrait, Lake reflection and Elk in meadow near the top; Moraine Lake rated 3 stars so the rating-versus-rank point is visible. Kayaking.mov and Lake morning.mov scored, with moment frames cut for both (as in AI-07). Explore page with the Library highlights card. A second, freshly upgraded test server with nothing scored, for the empty state. Job manager under Compute & jobs. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:12 | LOWER-THIRD "Best photos · Frameleaf AI"; SCREEN library; HIGHLIGHT the sidebar entry "Best Photos" just below "Recently added"; CURSOR clicks; the ranked grid loads | Best Photos | "Best Photos ranks your strongest pictures by quality. Open it from the sidebar, just below Recently added." |
| 3 | 0:12–0:27 | CARD headline "What the score looks at"; bullets: "Sharpness and blur", "Exposure, contrast and detail", "Usable resolution"; a second line fades in: "Faces: a gentle bonus · Screenshots and documents: a small penalty" | What the score looks at | "Each item is scored on your server from its preview. The score looks at sharpness, exposure, contrast and detail, and usable resolution. Faces add a gentle bonus, and screenshots and document-like images lose a little." |
| 4 | 0:27–0:37 | SCREEN Best Photos grid; ZOOM on the Moraine Lake tile at the top showing its own 3-star rating; CALLOUT "Order: quality · Stars: your rating" | Ranked by quality, not stars | "The order is the quality ranking, never your stars. Each tile still shows your own rating, so the two aren't confused." |
| 5 | 0:37–0:49 | CARD headline "Nothing else changes"; bullets: "No album, no copies", "Favorites untouched", "Only your own items; never Locked or archived" | Nothing else changes | "Nothing else changes. Best Photos makes no album, copies no files and leaves your favorites alone. It lists only your own items, and never Locked or archived ones." |
| 6 | 0:49–1:04 | SCREEN scrolls to the top row "Best moments in your videos" with the line "The strongest frame of each ranked video."; cards Kayaking.mov with a ▶ 0:11 chip and Lake morning.mov with ▶ 0:07; a small DIAGRAM inset: a video bar with five sample ticks, one lit green | Best moments in your videos | "Videos are ranked too. Frameleaf scores five frames from each video up to fifteen minutes long and keeps the best one. Best moments in your videos shows it for each ranked video." |
| 7 | 1:04–1:16 | CURSOR clicks "Play from 0:07" under Lake morning.mov; the viewer opens playing from 0:07; back to the row, CURSOR clicks "Use as cover" under Lake morning.mov and the label changes to "Cover" | Play from · Use as cover | "Choose Play from, and the video starts at that moment. Use as cover makes the moment the video's cover, once its moment frames have been cut." |
| 8 | 1:16–1:25 | SCREEN Explore; ZOOM on the Library highlights card: "Best Photos", "A few worth another look", "{n} quality suggestions in your library"; CURSOR clicks it and Best Photos opens | Explore → Best Photos | "Explore has a Best Photos card too, counting the strongest suggestions in your library." |
| 9 | 1:25–1:36 | CARD headline "Scored automatically"; bullets: "New upload: once thumbnails are made", "Again after face detection", "Again after an edit" | Scored automatically | "Scoring is automatic. A new upload is scored once its thumbnails are made, and again after face detection or an edit." |
| 10 | 1:36–1:57 | SCREEN the test server's Best Photos showing "No best photos have been scored yet."; cut to Settings → Compute & jobs → Job manager; CURSOR clicks "Create job"; dialog "Create a maintenance job"; types "best" in the search; selects "Recalculate Best Photos" ("Score the library again, including previously scored assets." · Background tasks); CURSOR clicks "Review job", then "Recalculate Best Photos" in the review | Create job → Recalculate Best Photos | "On a library that was never scored, the page says No best photos have been scored yet. To score everything, an administrator opens Job manager under Compute & jobs, chooses Create job, then Recalculate Best Photos. It rescores every item, including ones already scored." |
| 11 | 1:57–2:00 | LOGO OUTRO | Next: AI-11 · Ask about your photos | "Next up: Ask about your photos." |

## Voice-over (clean)

Best Photos ranks your strongest pictures by quality. Open it from the sidebar, just below Recently added.

[pause]

Each item is scored on your server from its preview. The score looks at sharpness, exposure, contrast and detail, and usable resolution. Faces add a gentle bonus, and screenshots and document-like images lose a little.

The order is the quality ranking, never your stars. Each tile still shows your own rating, so the two aren't confused.

Nothing else changes. Best Photos makes no album, copies no files and leaves your favorites alone. It lists only your own items, and never Locked or archived ones.

[pause]

Videos are ranked too. Frameleaf scores five frames from each video up to fifteen minutes long and keeps the best one. Best moments in your videos shows it for each ranked video.

Choose Play from, and the video starts at that moment. Use as cover makes the moment the video's cover, once its moment frames have been cut.

Explore has a Best Photos card too, counting the strongest suggestions in your library.

[pause]

Scoring is automatic. A new upload is scored once its thumbnails are made, and again after face detection or an edit.

On a library that was never scored, the page says No best photos have been scored yet. To score everything, an administrator opens Job manager under Compute & jobs, chooses Create job, then Recalculate Best Photos. It rescores every item, including ones already scored.

Next up: Ask about your photos.

## Production notes

- Labels verified in the build: sidebar entry "Best Photos" (Library section, after "Recently added"); page title "Best Photos"; empty state "No best photos have been scored yet."; row "Best moments in your videos" with "The strongest frame of each ranked video.", per video "Play from {time}" and "Use as cover" (or "Cover"); Explore card "Best Photos", "A few worth another look", "{count} quality suggestions in your library" (counts items scoring 0.9 or more); Job manager "Create job" → "Create a maintenance job" → "Recalculate Best Photos" / "Score the library again, including previously scored assets." in "Background tasks" → "Review job" → review dialog whose confirm button repeats the task name ("Keep current state" cancels).
- Doc vs build: README.md says videos "are not scored ... in this version". The current server scores videos from five sampled frames (videos up to 15 minutes; longer ones are skipped) and keeps the best frame's time, which the "Best moments in your videos" row uses. The narration follows the build; flag README.md for an update.
- The index calls the job the "Best Photos backfill job"; its admin string is "Best Photos backfill", and the Job manager's maintenance list shows it as "Recalculate Best Photos". It runs a forced rescore of every eligible item.
- Scoring triggers are from the server: after thumbnails for a new upload (photos and videos), again after face detection when facial recognition is on, and again after an edit is saved. Eligible items are the owner's active items in the timeline or archive; the view excludes archived items by default, Locked and hidden items always, and partners' items.
- "Use as cover" appears only for a video whose moment frames have been cut (AI-07), and reads "Cover" when that moment already is the cover; otherwise the card shows Play from only.
- The score itself is never displayed; tiles show the owner's star rating. Do not add a score overlay in the edit.
- Outro card: "Next: AI-11 · Ask about your photos".
