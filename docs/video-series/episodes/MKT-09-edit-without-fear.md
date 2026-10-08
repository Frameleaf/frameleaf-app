# MKT-09 · Edit without fear

| Field | Value |
| --- | --- |
| Series | Meet Frameleaf |
| Type | Marketing |
| Target length | 1:10 |
| Audience | People who edit on their phone today and have lost originals to overwrites |
| Features demonstrated | Quick edit for photos (Adjust with compare, Looks with strength, Crop and straighten with social formats), versions (Save version, Make current, Revert), the video quick editor (Trim, Adjust, Text, Export frame as photo), originals never written |
| Source docs | docs/docs/features/editing.mdx |
| Capture checklist | Dark theme as Taylor; Quick edit on Cabin at dusk with Adjust → Light, the histogram and split compare; Presets (Looks) panel with Warm at 60% strength; Crop and straighten on Emma portrait with Social formats; the Versions panel with a version rendering; the video quick editor on Lake morning.mov with Trim, Adjust, Text and Export frame as photo |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:10 | LOWER-THIRD "Edit without fear · Meet Frameleaf". SCREEN: viewer on Cabin at dusk. CURSOR clicks "Quick edit" (0:05); the editor opens on Adjust. CALLOUT on the original's file name in the header: "Original: never written to". | Quick edit | "Open Quick edit, and every change starts from one promise: the original file is never written to. Not once." |
| 3 | 0:10–0:16 | SCREEN: Adjust → Light. CURSOR drags Shadows to +35, then Highlights to −20; the histogram shifts. At 0:14 the `\` key is held: split before/after wipes across the photo, then releases. | Hold \ to compare | "Lift the shadows, pull the highlights back, and hold a key to compare." |
| 4 | 0:16–0:24 | SCREEN: Presets panel "Looks": Original, Natural, Vivid, Warm, Cool, B&W. CURSOR clicks Warm (0:17), then drags the strength slider from 100 to 60. "Save as preset" button visible below; CURSOR hovers it. | Looks · Warm 60% | "Looks give you a starting point in one click, with a strength slider so it stays your photo." |
| 5 | 0:24–0:32 | SCREEN: Emma portrait in Crop and straighten. CURSOR clicks Social formats → "Shorts 9:16" (0:26); the crop frame snaps to portrait. CURSOR turns the Straighten dial 1.5° and the horizon levels. | Crop and straighten · Shorts 9:16 | "Crop and straighten, or pick a social format like Shorts, and the picture is ready for wherever it is going." |
| 6 | 0:32–0:42 | SCREEN: Versions panel. CURSOR clicks "Save version" (0:33); status Queued → Rendering 40% → Rendered (0:37). Two versions listed; CURSOR clicks "Make current" on the older one (0:39), then hovers "Revert". "Download edited master" visible. | Save version · Make current · Revert | "Save version keeps the edit as a full-quality master, rendered from the original. Make current, step back, or revert. Nothing is lost either way." |
| 7 | 0:42–0:53 | SCREEN: video quick editor on Lake morning.mov. Trim: CURSOR drags the end handle from 0:24 to 0:18 (0:43). Adjust: warmth up slightly (0:46). Text: a caption "Lake Louise, 6:14 am" set from 0:02 to 0:06 (0:48). CURSOR clicks "Export frame as photo" (0:51); a toast confirms. Activity indicator in the top bar shows one job running. | Trim · Adjust · Text · Export frame as photo | "Video works the same way. Trim, adjust, add a line of text, or pull one frame out as a photo, all rendered in the background on your server." |
| 8 | 0:53–1:01 | CARD "Three files, never confused" with bullets per clause: "Original: what you uploaded", "Edited master: full quality, rendered from the original", "Playback copies: small, safe to delete". | Original · Edited master · Playback copies | "Change the edit later and the master is rendered again from the original, so edits never pile loss on loss." |
| 9 | 1:01–1:07 | TITLE on the dark canvas; behind it Cabin at dusk crossfades edited → original → edited. | Edit without fear. | "Edit without fear. The photo you took is always still there." |
| 10 | 1:07–1:10 | LOGO OUTRO with the tagline lockup; the leaf sways 4° once. | YOUR MEMORIES GROW FURTHER | "Frameleaf. Your memories grow further." |

## Voice-over (clean)

Open Quick edit, and every change starts from one promise: the original file is never written to. Not once.

Lift the shadows, pull the highlights back, and hold a key to compare.

Looks give you a starting point in one click, with a strength slider so it stays your photo.

Crop and straighten, or pick a social format like Shorts, and the picture is ready for wherever it is going.

[beat]

Save version keeps the edit as a full-quality master, rendered from the original. Make current, step back, or revert. Nothing is lost either way.

Video works the same way. Trim, adjust, add a line of text, or pull one frame out as a photo, all rendered in the background on your server.

[pause]

Change the edit later and the master is rendered again from the original, so edits never pile loss on loss.

[beat]

Edit without fear. The photo you took is always still there.

[beat]

Frameleaf. Your memories grow further.

## Production notes

- editing.mdx lists only crop, rotation and mirroring under "Supported Edits"; the Adjust sliders, Looks, masks, social formats and the video tools are the integration build's editors (integration inventory, Editors). The originals / edited master / playback copies model, the `.lineage.json` record and "changing the recipe re-renders from the original, so repeated edits do not stack up generation loss" are documented in editing.mdx and are the basis of beats 2, 6 and 8.
- Beat 3: Adjust → Light sliders are Exposure, Contrast, Highlights, Shadows, Whites, Blacks; double-click resets a slider; hold `\` or `Y` to compare. Only Shadows and Highlights are moved on screen.
- Beat 4: the Presets panel is labelled "Looks": Original, Natural, Vivid, Warm, Cool, B&W, Mono, Noir, Silvertone, Fade, each with a strength slider; "Save as preset" adds to "Your presets".
- Beat 5: Crop and straighten offers Free, Original, Square, Straighten, Rotate left/right, Flip, and Social formats Portrait 4:5, Shorts 9:16, Wide 16:9, Feed, Vertical, Landscape.
- Beat 6: Versions controls are "Save version", "Make current", "Revert", "Download edited master"; statuses Queued / Rendering % / Rendered / Failed. The edited master keeps the original's resolution and is never re-edited in place (editing.mdx).
- Beat 7: the video quick editor tools are Trim, Speed, Adjust, Crop, Audio, Text, Enhance, Presets and Restore; "Export frame as photo" is its label. Rendering runs as a background job (AssetVideoEditGeneration) and reuses hardware transcoding settings where safe (README). Do not open the Restore tool: restoration is HOLD (EDIT-05).
- A quarter- or half-turn rotation is written as display metadata without re-encoding (editing.mdx); not shown, but do not claim every edit re-encodes.
- Dolby Vision profile 5 sources are refused before editing; keep Lake morning.mov as an ordinary SDR clip.
