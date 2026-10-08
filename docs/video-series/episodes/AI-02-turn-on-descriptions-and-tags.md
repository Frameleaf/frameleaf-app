# AI-02 · Turn on descriptions and tags

| Field | Value |
| --- | --- |
| Series | Frameleaf AI |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators enabling image descriptions for the first time |
| Features demonstrated | Image enrichment hardware, Generate image descriptions and tags, Description model, Fallback model, Review changes and Save changes, Re-queue all image descriptions, running-jobs indicator, Descriptions & tags queue, AI / Yours badge, Rewrite with AI, Check again with AI |
| Source docs | docs/docs/features/descriptions-and-smart-albums.md, docs/docs/features/image-enrichment.md |
| Capture checklist | Signed in as Taylor (admin). Settings → Search & intelligence → Image Description with "Generate image descriptions and tags" off at the start; Description model dropdown showing "Qwen2.5-VL 3B (default)" and "Qwen2.5-VL 7B (balanced)" with their memory estimates; Fallback model set to Florence-2. Status & Re-generation panel with counts for a small seeded library (about 40 items) so the re-queue finishes during capture. Viewer on "Moraine Lake" with no user description (AI badge) and on "Emma at the lake" with a typed description (Yours badge). Sensitive content section visible for the "Check again with AI" beat. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "Turn on descriptions and tags · Frameleaf AI"; SCREEN Settings; CURSOR clicks the "Search & intelligence" area, then scrolls to the Image Description panel | Settings → Search & intelligence → Image Description | "Descriptions and tags make every photo searchable by what is in it. Open Settings, then Search & intelligence, then Image Description." |
| 3 | 0:13–0:26 | ZOOM on the "Image enrichment hardware" dropdown; CURSOR opens it showing "Auto-detect", "Intel iGPU (OpenVINO)", "NVIDIA GPU (CUDA)"; leaves Auto-detect selected | Image enrichment hardware | "Start with Image enrichment hardware. Auto-detect is fine for most servers. Pick Intel iGPU (OpenVINO) or NVIDIA GPU (CUDA) only when you need to pin a device." |
| 4 | 0:26–0:32 | HIGHLIGHT the "Generate image descriptions and tags" toggle; CURSOR clicks it on (green) | Generate image descriptions and tags | "Turn on Generate image descriptions and tags." |
| 5 | 0:32–0:46 | CURSOR opens the "Description model" dropdown; ZOOM on the list with memory estimates; HIGHLIGHT "Qwen2.5-VL 3B (default)" and "Qwen2.5-VL 7B (balanced)" | Description model | "Description model lists curated models with a memory estimate each. Qwen2.5-VL 3B is the default and suits most GPUs. Qwen2.5-VL 7B needs about sixteen gigabytes." |
| 6 | 0:46–1:00 | CALLOUT on "Fallback model" showing Florence-2; a second CALLOUT reads the help text "Used on this server when the primary model cannot run." | Fallback model | "Leave Fallback model on Florence-2. It only steps in on this server when the main model fails. It writes captions only, so do not pick it as the main model." |
| 7 | 1:00–1:07 | SCREEN save bar at the bottom of Settings; CURSOR clicks "Review changes" (list of three changes), then "Save changes" | Review changes → Save changes | "Choose Review changes to see every change, then Save changes." |
| 8 | 1:07–1:20 | SCREEN scrolls to "Status & Re-generation"; HIGHLIGHT the "Re-queue all image descriptions" button; CURSOR clicks | Status & Re-generation | "Scroll to Status & Re-generation. Choose Re-queue all image descriptions to describe the library with the settings you just saved." |
| 9 | 1:20–1:31 | SCREEN modal "Re-queue image descriptions" with rows Total eligible assets, Already have a description, Missing a description, Estimated total time; HIGHLIGHT then CURSOR clicks "Re-queue now"; toast "Re-queue job started." | Re-queue now | "The modal shows Total eligible assets, how many already have a description and an Estimated total time. Choose Re-queue now." |
| 10 | 1:31–1:45 | SPLIT: left, ZOOM on the top-bar running-jobs indicator counting down; right, SCREEN Compute & jobs → Job manager with the "Descriptions & tags" queue and its waiting count | Descriptions & tags queue | "The running-jobs indicator in the top bar counts the work down. Job manager under Compute & jobs shows the Descriptions & tags queue." |
| 11 | 1:45–2:00 | SCREEN viewer on "Moraine Lake"; CURSOR opens the information card; ZOOM on Description with the "AI" badge and "Written by AI"; quick cut to "Emma at the lake" showing the "Yours" badge | AI · Yours | "Open Moraine Lake once the queue clears. The Description now carries the AI badge. A description you typed yourself shows Yours instead, and your text is never overwritten." |
| 12 | 2:00–2:09 | ZOOM on the tag chips under the description: lake, mountain, canoe | Tags | "Tags arrive with it, lowercase and searchable, so lake, mountain and canoe now find this photo." |
| 13 | 2:09–2:17 | HIGHLIGHT the "Rewrite with AI" control beside the description; CURSOR clicks; the description refreshes | Rewrite with AI | "Choose Rewrite with AI to generate this one photo again with the current prompt." |
| 14 | 2:17–2:29 | SCREEN scrolls to the "Sensitive content" section; CALLOUT on "Check again with AI"; ZOOM on the "% likely sensitive" line | Check again with AI | "Check again with AI reruns the sensitive-content check on the same photo and shows how likely sensitive it is." |
| 15 | 2:29–2:42 | CARD headline "From now on"; bullets: "New uploads are described after thumbnails", "Existing text is never overwritten", "Alpha quality today, improving" | From now on | "From now on, new uploads are described after their thumbnails are made. Generated text is alpha quality today and improves over time." |
| 16 | 2:42–2:45 | LOGO OUTRO | Next: AI-03 · Try an enrichment change before you commit | "Next up: Try an enrichment change before you commit." |

## Voice-over (clean)

Descriptions and tags make every photo searchable by what is in it. Open Settings, then Search & intelligence, then Image Description. [pause]

Start with Image enrichment hardware. Auto-detect is fine for most servers. Pick Intel iGPU (OpenVINO) or NVIDIA GPU (CUDA) only when you need to pin a device. [beat] Turn on Generate image descriptions and tags. [beat] Description model lists curated models with a memory estimate each. Qwen2.5-VL 3B is the default and suits most GPUs. Qwen2.5-VL 7B needs about sixteen gigabytes. [beat] Leave Fallback model on Florence-2. It only steps in on this server when the main model fails. It writes captions only, so do not pick it as the main model. [pause]

Choose Review changes to see every change, then Save changes. [beat] Scroll to Status & Re-generation. Choose Re-queue all image descriptions to describe the library with the settings you just saved. [beat] The modal shows Total eligible assets, how many already have a description and an Estimated total time. Choose Re-queue now. [beat] The running-jobs indicator in the top bar counts the work down. Job manager under Compute & jobs shows the Descriptions & tags queue. [pause]

Open Moraine Lake once the queue clears. The Description now carries the AI badge. A description you typed yourself shows Yours instead, and your text is never overwritten. [beat] Tags arrive with it, lowercase and searchable, so lake, mountain and canoe now find this photo. [beat] Choose Rewrite with AI to generate this one photo again with the current prompt. [beat] Check again with AI reruns the sensitive-content check on the same photo and shows how likely sensitive it is. [pause]

From now on, new uploads are described after their thumbnails are made. Generated text is alpha quality today and improves over time. [pause]

Next up: Try an enrichment change before you commit.

## Production notes

- Prerequisites: the machine-learning container reachable and "Model ready"; the description model already downloaded so the re-queue completes during capture; thumbnails generated for every seeded item. Seed a short user description on "Emma at the lake" to show the "Yours" badge.
- Path mismatch: the docs say "Administration → System Settings → Machine Learning → Image Description"; the current build is Settings → Search & intelligence, and the panel heading reads "Image descriptions and tags". The VO says "Image Description" per the series convention; the on-screen text shows the heading as built.
- Default state: image-enrichment.md says descriptions are disabled by default, while the inventory notes the code default may already be on. Capture with the toggle off first so the click is real; if it is already on in the build, cut beat 4 to a HIGHLIGHT with the VO changed to "Confirm Generate image descriptions and tags is on."
- Memory estimates come from the docs table (3B about 6 GB, 7B about 16 GB). Do not read any other number.
- The modal button label is "Re-queue now" in the build; the docs call it "Re-queue". Toast text is "Re-queue job started."
- "Rewrite with AI" reruns image descriptions and tags for one asset; "Check again with AI" reruns the sensitive-content (NSFW) check and sits in the "Sensitive content" section of the information card. Keep the sensitive example a landscape.
- Tag values (lake, mountain, canoe) are illustrative; use whatever the model actually generates for "Moraine Lake" and adjust the VO's three tags to match.
- The "AI description:" block wording from the docs is represented in the current card by the AI / Yours badge; do not show raw "AI description:" text.
- Outro card: "Next: AI-03 · Try an enrichment change before you commit".
