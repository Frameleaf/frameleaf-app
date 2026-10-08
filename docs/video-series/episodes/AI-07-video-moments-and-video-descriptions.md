# AI-07 · Video moments and video descriptions

| Field | Value |
| --- | --- |
| Series | Frameleaf AI |
| Type | How-to |
| Target length | 2:45 |
| Audience | Frameleaf users with videos in their library, and administrators who run descriptions |
| Features demonstrated | Six reusable moment frames (evenly spaced, scored, ranked best first), video descriptions from a time-ordered frame grid, names from faces on the video's preview, Moments section (Frames best first, Best label, play from a frame), Use as cover, Use the best frame, No moments yet, Find moments and Refresh moments as a background plan in Activity, Add captions with its request count, Add moment (Time, Title, Transcript), Generated and Yours moments, Moments in your videos in search, three-hour limit |
| Source docs | docs/docs/features/descriptions-and-smart-albums.md, docs/docs/features/searching.md |
| Capture checklist | Signed in as Taylor (admin), dark theme. Descriptions on with Qwen2.5-VL 3B; smart search on. Kayaking.mov (0:18) already described, its six frames cut and indexed, cover still the best frame. Lake morning.mov (0:24) never processed, so its Moments section reads "No moments yet." and Max jumps off the end of the dock at about 0:12. Activity page open in a second tab. Search palette with no recent searches. Emma named on the People page and recognised on the Kayaking.mov preview. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "Video moments and video descriptions · Frameleaf AI"; SCREEN viewer playing Kayaking.mov with the information card open, scrolled so Description and the Moments section are both in view | Kayaking.mov | "Videos get descriptions and moments too. Both are built from six frames that Frameleaf cuts from each video and keeps." |
| 3 | 0:13–0:28 | DIAGRAM: a video timeline bar with six evenly spaced ticks; six frame thumbnails drop from the ticks, each gains a small score bar (exposure, contrast, detail), then they re-order left to right with a "Best" chip on the first; three teal arrows lead out to nodes "Description", "Moment search", "Moment captions" as the VO names reuse | Six frames, best first | "The frames are evenly spaced through the video, scored for exposure, contrast and detail, and ranked best first. They are cut once and reused, and cut again only if the original is replaced." |
| 4 | 0:28–0:43 | DIAGRAM continues: the six frames return to time order and tile into a 2×3 grid with timestamps in each cell; green arrow into node "Description model"; a chip "Emma" slides in from a node "Faces on the preview" | One grid, in time order | "To describe a video, the frames are laid out as one grid in time order, and the model reads the whole clip at once. Names come from faces on the video's preview, as with a photo." |
| 5 | 0:43–0:56 | SCREEN information card on Kayaking.mov; ZOOM on the Description: "Emma paddles a kayak out from the shore of Lake Louise, then turns and heads back toward the dock."; inset top right: Settings → Compute & jobs → Job manager with the "Descriptions & tags" queue row | Descriptions & tags | "Kayaking now reads as one clip: Emma paddles out from the shore, then turns back. Videos are described whenever the Descriptions & tags queue runs, such as after a re-queue." |
| 6 | 0:56–1:08 | SCREEN scrolls to the Moments section; ZOOM on the grid labelled "Frames, best first": six 16:9 frames with time chips, the first with the "Best" chip and the cover outline; CURSOR clicks the frame at 0:11 and the player jumps to 0:11 | Moments · Frames, best first | "Below the description, Moments shows those frames, best first, with a Best label on the top one. Choose any frame and the video plays from there." |
| 7 | 1:08–1:22 | HIGHLIGHT "Use as cover" under the frame at 0:14; CURSOR clicks; the cover outline moves to that frame and its label reads "Cover"; the button "Use the best frame" appears below the grid; CURSOR clicks it and the outline returns to the first frame | Use as cover · Use the best frame | "Use as cover under a frame makes it the video's cover. It is saved as a time in the video, so it survives new frames. Use the best frame goes back to the top one." |
| 8 | 1:22–1:38 | SCREEN viewer on Lake morning.mov; Moments reads "No moments yet."; HIGHLIGHT then CURSOR clicks "Find moments"; status line "Updating moments. You can keep browsing."; cut to the Activity tab with the plan row running; back to the viewer as frames fill in, status "Moments are up to date." and the button now reads "Refresh moments" | No moments yet → Find moments | "A video that has not been processed says No moments yet. Choose Find moments. It cuts the frames and builds the moment search index in the background, shows in Activity, and keeps going if you close the page." |
| 9 | 1:38–1:49 | ZOOM on "Add captions" and the line beneath it: "Captions add up to 6 model requests for this video."; CURSOR hovers, does not click | Add captions | "Add captions is optional. It describes each frame separately, one model request per frame, and the panel says how many requests that is." |
| 10 | 1:49–2:07 | CURSOR clicks "Add moment"; form with Time (types "0:12"), Title (types "Max jumps off the dock") and Transcript (types "Go on, Max!") with the help line "Typed by you. Transcripts are never generated."; CURSOR clicks Save; the moment appears in the list at 0:12 labelled "Yours", below the generated ones labelled "Generated" | Add moment · Yours | "You can add your own moments. On Lake morning, choose Add moment, enter a time and a title, and type a transcript if you like. Nothing is transcribed automatically. Your moments are marked Yours and are never removed by a refresh." |
| 11 | 2:07–2:24 | SCREEN search palette; types "Max jumps"; Show results; above the photo results the strip "Moments in your videos" shows Lake morning.mov at 0:12 with "Max jumps off the dock"; CURSOR clicks it and the viewer opens Lake morning.mov playing from 0:12 | Moments in your videos | "Now search. Type Max jumps, and Moments in your videos appears above the results: frames that match by meaning, and moments whose words match. Choose one and the video opens at that moment. Only your own videos are searched." |
| 12 | 2:24–2:42 | CARD headline "Good to know"; bullets: "Six evenly spaced frames per video", "Add your own moment for anything in between", "Over three hours: not cut" | Good to know | "Every video gets the same six evenly spaced frames. If what you care about falls between them, add your own moment there. Videos longer than three hours are not cut, and a video with no usable frames is skipped with a reason." |
| 13 | 2:42–2:45 | LOGO OUTRO | Next: AI-08 · Status and re-generation | "Next up: Status and re-generation." |

## Voice-over (clean)

Videos get descriptions and moments too. Both are built from six frames that Frameleaf cuts from each video and keeps.

[pause]

The frames are evenly spaced through the video, scored for exposure, contrast and detail, and ranked best first. They are cut once and reused, and cut again only if the original is replaced.

To describe a video, the frames are laid out as one grid in time order, and the model reads the whole clip at once. Names come from faces on the video's preview, as with a photo.

Kayaking now reads as one clip: Emma paddles out from the shore, then turns back. Videos are described whenever the Descriptions & tags queue runs, such as after a re-queue.

[pause]

Below the description, Moments shows those frames, best first, with a Best label on the top one. Choose any frame and the video plays from there.

Use as cover under a frame makes it the video's cover. It is saved as a time in the video, so it survives new frames. Use the best frame goes back to the top one.

A video that has not been processed says No moments yet. Choose Find moments. It cuts the frames and builds the moment search index in the background, shows in Activity, and keeps going if you close the page.

Add captions is optional. It describes each frame separately, one model request per frame, and the panel says how many requests that is.

[pause]

You can add your own moments. On Lake morning, choose Add moment, enter a time and a title, and type a transcript if you like. Nothing is transcribed automatically. Your moments are marked Yours and are never removed by a refresh.

Now search. Type Max jumps, and Moments in your videos appears above the results: frames that match by meaning, and moments whose words match. Choose one and the video opens at that moment. Only your own videos are searched.

[pause]

Every video gets the same six evenly spaced frames. If what you care about falls between them, add your own moment there. Videos longer than three hours are not cut, and a video with no usable frames is skipped with a reason.

Next up: Status and re-generation.

## Production notes

- Labels verified in the build (VideoMomentsPanel, VideoMomentResults): section "Moments"; grid "Frames, best first"; chip "Best"; per-frame "Use as cover" / "Cover"; "Use the best frame" (shown only after a custom cover has been chosen, so beat 7 must pick a cover first); "No moments yet."; "Add moment"; "Find moments", which reads "Refresh moments" once the index is ready; "Add captions" with "Captions add up to {n} model requests for this video."; status lines "Updating moments. You can keep browsing." and "Moments are up to date."; form fields "Time" (placeholder 0:42), "Title", "Transcript" with "Typed by you. Transcripts are never generated."; source labels "Generated" and "Yours"; footer "Frames from {date} · indexed with {model} on {date}". Moment actions are owner-only.
- Search strip title "Moments in your videos" appears only for a text query that has hits; hit labels are "Caption match", "Transcript match" and "Similar moment". The VO's "moments whose words match" covers caption, title and transcript matches (the docs say "caption or transcript"; the add form labels the caption field "Title").
- Doc vs build: the docs' maintenance note says new videos are described "with no manual intervention". In the current build only images queue a description after upload; videos are described when the Descriptions & tags queue runs (Run missing in Job manager, or a re-queue). The VO says exactly that and makes no automatic-on-upload claim.
- Doc vs build: an older admin string still says a video without frames needs "enhanced video duplicate detection"; the docs and the viewer ("No frames could be taken from this video") say duplicate detection plays no part. Do not capture the old string.
- The Kayaking.mov description in beat 5 is illustrative. Use the model's real output and adjust the VO's paraphrase to match it.
- Each frame also has "Find similar" (frame-to-moment search across your own videos). It is not narrated here; keep it out of the zooms.
- The moment search index uses the smart search model; captions use the description model and cost one request per frame, and are never ticked for you in a plan (see AI-03). Locked videos' moments are shown only in their owner's unlocked session.
- "Nothing is transcribed automatically" paraphrases the docs' "There is no automatic speech recognition."
- Outro card: "Next: AI-08 · Status and re-generation".
