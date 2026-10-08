# EDIT-04 · Video quick editor

| Field | Value |
| --- | --- |
| Series | Editing and Studio |
| Type | How-to |
| Target length | 2:45 |
| Audience | Anyone who trims and tidies videos in Frameleaf on the web |
| Features demonstrated | Video quick editor: Trim (drag handles, I and O keys, Set in at playhead, Trim mode Precise or Fast · keyframes), Speed (Whole clip, Ranges), Adjust (histogram, Auto, Light, Color, Effects, Detail), Crop and straighten, Audio (Clip gain, Mute clip), Text (Add text, position, Start and End, Size, colour, Shadow), Enhance (Stabilize, Auto-enhance), Presets (Looks with strength, B&W, Social formats), Export frame as photo, Save version, the Versions menu (Export master, Download edited master) |
| Source docs | docs/docs/features/editing.mdx, README.md (Built-in video editor, GPU-aware rendering), i18n/en.json (frameleaf_video_editor_*, editor_video_*), web/src/lib/components/frameleaf/editor (VideoQuickEditor, VideoVersionsMenu), web/src/lib/frameleaf/video-edit.ts |
| Capture checklist | Taylor signed in on frameleaf.home, dark theme. "Lake morning.mov" (0:24, ordinary SDR, never edited) in the Timeline layout. Filmstrip frames generated. A Speed range staged at 0:08–0:12. A Text overlay "Lake Louise, 6:14 am". After saving, the Versions menu with Original and one Saved version, and a ready master so "Download edited master" is enabled. Activity open in a second tab to show the edit job. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD; SCREEN: Library. CURSOR selects "Lake morning.mov" and clicks "Quick edit". The editor opens: header "Lake morning.mov" with "Video · 3840 × 2160 · 0:24"; the clip plays on the stage; transport, filmstrip and ruler below. HIGHLIGHT sweeps down the rail: Trim, Speed, Adjust, Crop, Audio, Text, Enhance, Presets. | Video quick editor · Editing and Studio | "Videos open in the same quick editor as photos. Select a clip and choose Quick edit, and the rail switches to video tools: Trim, Speed, Adjust, Crop, Audio, Text, Enhance and Presets." |
| 3 | 0:16–0:30 | SCREEN: Trim panel. CURSOR drags the "Trim in" handle on the filmstrip to 0:02, then moves the playhead to 0:20 and presses O; the "Trim out" handle jumps there. The dimmed ends of the filmstrip update; the summary reads "Clip 0:02 – 0:20 · 0:18 selected". CALLOUT on "Press I or O to mark the playhead." | Trim · Press I or O to mark the playhead | "Start with Trim. Drag the handles on the filmstrip, or move the playhead and press I or O to mark the in and out points. The panel shows exactly how much is selected." |
| 4 | 0:30–0:44 | ZOOM on "Trim mode": Precise and Fast · keyframes. CURSOR clicks Fast · keyframes; help "Cuts snap to keyframes, roughly 2s to 20s, and finish in seconds without re-encoding." CURSOR clicks Precise; help "Frame-accurate cuts. The clip is re-encoded from the original." | Precise · Fast · keyframes | "Trim mode has two choices. Precise cuts on the exact frame and re-encodes from the original. Fast snaps to the nearest keyframes and finishes in seconds without re-encoding." |
| 5 | 0:44–0:58 | SCREEN: Speed panel. "Whole clip" row 0.25×, 0.5×, 1×, 2×, 4×. Under "Ranges", CURSOR clicks "Add range at playhead"; "Range 1" appears as a blue band on the filmstrip from 0:08 to 0:12; CURSOR sets its speed to 0.5×. Summary "Output … · playback rate at the playhead 0.5×. Audio pitch is preserved up to 2×." | Speed · Whole clip · Ranges | "Speed sets the whole clip from a quarter speed to four times. Ranges change just part of it and show as blue bands on the filmstrip. Audio pitch holds up to twice the speed." |
| 6 | 0:58–1:10 | SCREEN: Adjust panel with the histogram, "Auto" and the groups Light, Color, Effects, Detail. CURSOR clicks Auto, then drags Temperature to +6; the morning light warms. | Adjust · Auto | "Adjust has the photo editor's groups, Light, Color, Effects and Detail, with a histogram and an Auto button. A touch of Temperature warms the morning light." |
| 7 | 1:10–1:20 | SCREEN: "Crop and straighten" panel: Aspect, Straighten dial, Orientation (Rotate left, Rotate right, Flip horizontal, Flip vertical). CURSOR turns Straighten to +1.5°; the shoreline levels. | Crop and straighten | "Crop and straighten works as it does for photos, with an aspect, a straighten dial, and buttons to rotate and flip." |
| 8 | 1:20–1:31 | SCREEN: Audio panel. CURSOR drags "Clip gain" from 100% to 80%. HIGHLIGHT on the "Mute clip" switch (left off). CALLOUT on "Original channels are preserved: stereo stays stereo and surround stays surround when the clip is saved." | Clip gain · Mute clip | "Audio sets the clip gain or mutes the clip. The original channels are kept, so stereo stays stereo and surround stays surround." |
| 9 | 1:31–1:46 | SCREEN: Text panel. CURSOR clicks "Add text"; "Text 1" appears. CURSOR types "Lake Louise, 6:14 am" in Content, picks "Bottom left" in the three-by-three position grid, sets Start 0:02 and End 0:06, Size 32 pt, the white swatch, and turns on Shadow. The caption appears over the stage. | Add text · Text 1 | "Text adds titles and captions. Type the words, pick one of nine positions, set when it starts and ends, then choose a size, a colour and a shadow." |
| 10 | 1:46–1:57 | SCREEN: Enhance panel with two switches. CURSOR turns on "Stabilize"; the status "Applied when the version is saved" appears. HIGHLIGHT on "Auto-enhance" and its help line (left off). | Stabilize · Auto-enhance · Applied when the version is saved | "Enhance has two switches. Stabilize smooths handheld shake and crops the edges slightly. Auto-enhance lifts contrast, colour and midtones. Both are applied when you save." |
| 11 | 1:57–2:07 | SCREEN: Presets panel. The Looks row now ends with B&W. CURSOR clicks Natural and sets "Natural strength" to 70%. The Social formats row is visible below. | Presets · Natural strength · 70% | "Presets has the same looks as photos, plus B&W for video, each with a strength slider, and the same social formats." |
| 12 | 2:07–2:18 | SCREEN: CURSOR drags the playhead to 0:10 and clicks "Export frame" on the transport (tooltip "Export frame as photo"); toast "Frame at 0:10 saved as a new photo". | Export frame as photo | "To pull a still, move the playhead and choose Export frame. The frame, with your crop and look, becomes a new photo beside the clip." |
| 13 | 2:18–2:32 | SCREEN: CURSOR clicks "Save version"; toast "Version saved. Rendering the edited video…"; the editor closes and Activity shows an Edit job running. Cut to the reopened editor: CURSOR opens "Versions": Original, one "Saved version" marked Current, then "Export master" and "Download edited master". | Save version · Versions · Export master | "Save version renders the edited video in the background, from the original. Versions lists the original and each saved version. Pick one to load its recipe, or choose Export master for a full-quality copy." |
| 14 | 2:32–2:42 | CARD headline "Video quick editor"; bullets one per clause: "Trim, speed and crop" · "Adjust, looks, text and audio" · "Export frame as photo". | Video quick editor | "Trim, speed and crop, then adjust the look, add text and set the audio. Every version renders from the original, which is never changed." |
| 15 | 2:42–2:45 | LOGO OUTRO | Next: EDIT-05 · Restoration: Faithful and Creative | "Next up: Restoration: Faithful and Creative." |

## Voice-over (clean)

Videos open in the same quick editor as photos. Select a clip and choose Quick edit, and the rail switches to video tools: Trim, Speed, Adjust, Crop, Audio, Text, Enhance and Presets.

Start with Trim. Drag the handles on the filmstrip, or move the playhead and press I or O to mark the in and out points. The panel shows exactly how much is selected.

Trim mode has two choices. Precise cuts on the exact frame and re-encodes from the original. Fast snaps to the nearest keyframes and finishes in seconds without re-encoding.

[beat]

Speed sets the whole clip from a quarter speed to four times. Ranges change just part of it and show as blue bands on the filmstrip. Audio pitch holds up to twice the speed.

Adjust has the photo editor's groups, Light, Color, Effects and Detail, with a histogram and an Auto button. A touch of Temperature warms the morning light.

Crop and straighten works as it does for photos, with an aspect, a straighten dial, and buttons to rotate and flip.

Audio sets the clip gain or mutes the clip. The original channels are kept, so stereo stays stereo and surround stays surround.

[beat]

Text adds titles and captions. Type the words, pick one of nine positions, set when it starts and ends, then choose a size, a colour and a shadow.

Enhance has two switches. Stabilize smooths handheld shake and crops the edges slightly. Auto-enhance lifts contrast, colour and midtones. Both are applied when you save.

Presets has the same looks as photos, plus B&W for video, each with a strength slider, and the same social formats.

To pull a still, move the playhead and choose Export frame. The frame, with your crop and look, becomes a new photo beside the clip.

[pause]

Save version renders the edited video in the background, from the original. Versions lists the original and each saved version. Pick one to load its recipe, or choose Export master for a full-quality copy.

Trim, speed and crop, then adjust the look, add text and set the audio. Every version renders from the original, which is never changed.

[pause]

Next up: Restoration: Faithful and Creative.

## Production notes

- Prerequisites: Taylor signed in; Lake morning.mov uploaded and transcoded, never edited, and an ordinary SDR clip. An HDR clip shows "This is an HDR video. Your edited version is made in standard range; the HDR original is kept as it is.", and a Dolby Vision profile 5 clip turns Save version off with "Dolby Vision profile 5 videos can't be edited on this server yet. The original is kept as it is." (editing.mdx lists the accepted and refused sources). Keep both out of this episode.
- Rail order in the build: Trim, Speed, Adjust, Crop, Audio, Text, Enhance, Presets, Restore (VideoQuickEditor.svelte `tools`). Restore is on the rail but restoration is HOLD (EDIT-05); do not open it and do not name it in this episode.
- Trim: the Trim panel also has "In (seconds)", "Out (seconds)", "Set in at playhead", "Set out at playhead" and "Reset trim". With Fast · keyframes chosen and other edits present, the panel says "Your other edits re-encode the clip, so this cut is frame accurate." Timecode strings on screen come from the build; the figures in the visual column are capture guidance.
- Speed: whole-clip speeds 0.25×, 0.5×, 1×, 2×, 4× (`SPEEDS` in web/src/lib/frameleaf/video-edit.ts). Up to 20 ranges and 20 text overlays (`MAX_SPEED_RANGES`, `MAX_TEXT_OVERLAYS`); the shortest span is 0.1 s. The empty Ranges state reads "Speed ranges slow down or speed up part of the clip. They appear as blue bands on the filmstrip."
- Audio: "Mute clip" help reads "Silences the source track. Gain above 100% is limited to avoid clipping."
- Text: nine positions (Top left … Bottom right, "Centre" in the middle), five colour swatches plus a custom colour, Size in points, Shadow switch.
- Presets: a clip is offered the photo looks plus B&W (`presetsFor('video')`). Social formats are Portrait 4:5, Shorts 9:16 and Wide 16:9.
- Export frame: the button on the transport reads "Export frame", tooltip "Export frame as photo". The still is drawn with the edit's turns, flips, crop and look and uploaded as a JPEG named after the clip and the time; a clip in Locked keeps its frame in Locked. Toast "Frame at {time} saved as a new photo".
- Versions (VideoVersionsMenu.svelte): heading "Versions"; entries "Original" and "Saved version" with a date, "Rendering", "Failed" or "Current". Choosing an entry with unsaved edits asks "Discard edits?". "Export master" queues a separate full-quality render ("Export queued. Download it from Versions when it is ready."); "Download edited master" appears once a master is ready. The top-bar "Revert" (tooltip "Revert to original") loads the original recipe; Save version then publishes it.
- Save version closes the editor and shows "Version saved. Rendering the edited video…". The render is a background job on the server. It reuses the server's hardware transcoding settings when safe and falls back to software for CPU-only filters (README, GPU-aware rendering). A quarter or half turn alone is written as display metadata without re-encoding (editing.mdx); do not claim every edit re-encodes.
- Doc mismatch: README's list says Filters, Auto enhance, Stabilization, and Mute and volume controls; the build's labels are Presets (Looks), Enhance → Auto-enhance and Stabilize, and Audio → Clip gain and Mute clip. i18n/en.json still holds strings from an earlier video editor (`editor_video_*`, for example Brightness, Black point, HDR effect, Skin tone); they are not in the current editor and must not appear. A clip edited in that earlier editor shows "This clip has adjustments from the earlier editor. They are kept until you change Adjust or Presets."; use a never-edited clip.
