# EDIT-03 · Looks, presets and versions

| Field | Value |
| --- | --- |
| Series | Editing and Studio |
| Type | How-to |
| Target length | 2:45 |
| Audience | Anyone who edits photos in Frameleaf on the web and wants to reuse a look or go back to an earlier edit |
| Features demonstrated | Presets panel: Looks (Original, Vivid, Natural, Warm, Cool, Mono, Silvertone, Noir, Fade) with the strength slider, Your presets (Preset name, Save as preset, apply, replace, delete), Save version, the Versions menu and All versions and renders, Load settings, Compare with original, Make current, Download edited master, Revert, Edit in another app (Export original, Bring back as a version) |
| Source docs | docs/docs/features/editing.mdx, i18n/en.json (frameleaf_editor_preset_*, frameleaf_editor_version_*, frameleaf_editor_roundtrip_*), web/src/lib/components/frameleaf/editor (QuickEditor, PresetStrip, UserPresets, RoundTripPanel) |
| Capture checklist | Taylor signed in on frameleaf.home, dark theme. "Cabin at dusk" with one earlier saved version (Version 1, a crop, Rendered) so the new save becomes Version 2. "Lake reflection" unedited. "Moraine Lake" (Sony α7 IV) with Version 1 from EDIT-01. Your presets empty at the start ("No saved presets yet."). A finished JPEG of Moraine Lake developed off camera from the exported original, saved as "Moraine Lake.jpg". The Versions panel with Original, Version 1 and Version 2 visible, and the Edit in another app section below them. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:15 | LOWER-THIRD; SCREEN: Library, Timeline layout. CURSOR selects "Cabin at dusk" and clicks "Quick edit" in the selection bar; the editor opens on Adjust. HIGHLIGHT then CURSOR click on "Presets" in the tool rail (Adjust, Crop, Masks, Presets, Restore). | Looks, presets and versions · Editing and Studio | "A look changes the mood of a photo in one click, and a version keeps every edit you save. Open a photo in Quick edit and choose Presets in the tool rail." |
| 3 | 0:15–0:30 | ZOOM on the "Looks" row: nine thumbnails of Cabin at dusk, each showing its look: Original, Vivid, Natural, Warm, Cool, Mono, Silvertone, Noir, Fade. CURSOR clicks Warm; the stage shows "Rendering preview…" for a moment, then the warm render. | Looks · Warm | "The row at the top is Looks. Each thumbnail shows this photo with the look applied: Original, Vivid, Natural, Warm and Cool, then Mono, Silvertone and Noir in black and white, and Fade. Choose Warm." |
| 4 | 0:30–0:42 | ZOOM on the slider "Warm strength". CURSOR drags it from 100% to 60%; the orange cast eases. CALLOUT "Double-click a slider to reset". | Warm strength · 60% | "Below the row, the strength slider scales the look from zero to one hundred percent. Sixty keeps the warmth without losing the blue of the evening sky." |
| 5 | 0:42–0:57 | SCREEN: CURSOR clicks Adjust, lifts Shadows to +20, returns to Presets and scrolls past Social formats to "Your presets" ("No saved presets yet."). CURSOR types "Evening glow" in "Preset name" and clicks "Save as preset"; toast "Saved Evening glow". CALLOUT on the help line "A preset keeps your light, color, effects, detail, look and masks. The crop never changes when you apply one." | Your presets · Save as preset · Saved Evening glow | "Under Your presets, type a name such as Evening glow and choose Save as preset. A preset keeps your light, color, effects, detail, look and masks, but never the crop." |
| 6 | 0:57–1:09 | SCREEN: Quick edit on "Lake reflection" → Presets. CURSOR clicks the chip "Evening glow"; toast "Evening glow applied". HIGHLIGHT on the two icons beside the chip, tooltips "Replace Evening glow with the current settings" and "Delete Evening glow" (not clicked). | Evening glow applied | "Open another photo, choose Presets, and select Evening glow. The whole recipe lands at once. The icons beside a preset replace it with the current settings or delete it." |
| 7 | 1:09–1:22 | SCREEN: back on Cabin at dusk. HIGHLIGHT then CURSOR click on "Save version" (tooltip "Save the recipe as a new version and render it. The original is kept."). The editor closes; toast "Version 2 saved. Rendering the edited master…", then toast "Version 2 rendered". | Save version · Version 2 rendered | "Choose Save version. The editor closes, and Frameleaf renders an edited master from the original plus your recipe. When it finishes, the new version is the one your library shows." |
| 8 | 1:22–1:36 | SCREEN: Quick edit on Cabin at dusk again; header reads "Photo · … · Showing version 2". CURSOR opens the "Versions" menu in the top bar: Original, Version 1 (Rendered), Version 2 (Current), then "All versions and renders". CURSOR clicks "All versions and renders"; the Versions panel opens with its help line. | Versions · All versions and renders | "Open Quick edit again and choose Versions in the top bar. Each entry loads its recipe. All versions and renders opens the full list, with the original at the top." |
| 9 | 1:36–1:52 | ZOOM on the Version 1 row: status "Rendered", date, renderer and size, the line "Original … · Master …" with short checksums, and buttons Load settings, Compare with original, Make current, Download edited master. CURSOR clicks "Compare with original": the stage splits into Original and Version 1. CURSOR clicks "Make current"; toast "Version 1 is now current". | Compare with original · Make current · Version 1 is now current | "Each version shows when it was saved, its size, and checksums that tie it to the original. Compare with original splits the stage. Make current shows that version in your library instead." |
| 10 | 1:52–2:05 | SCREEN: CURSOR clicks "Download edited master" on Version 2; the file downloads. CURSOR scrolls to the "Original" row, "The file as it was imported. It is never changed by editing.", and clicks "Make current"; toast "The original is current again". CALLOUT on "Revert" in the top bar: "Revert the settings to the original". | Download edited master · The original is current again · Revert | "Download edited master saves the full-quality render. To show the original again, choose Make current on Original. Revert in the top bar only resets the settings you are editing." |
| 11 | 2:05–2:18 | SCREEN: Versions panel on "Moraine Lake", scrolled to "Edit in another app" and its help line "Export the original, develop it in your RAW editor, then bring the finished file back as a new version. The original is never replaced." CURSOR clicks "Export original"; the original downloads; toast "Original exported. Bring the finished file back when you are done."; the "Exported originals" list shows the export with "Matches the original" and "SHA-256 …". | Edit in another app · Export original · Matches the original | "For a RAW developer, scroll to Edit in another app and choose Export original. Frameleaf records the original's checksum and downloads the file." |
| 12 | 2:18–2:31 | SCREEN: CURSOR picks "Moraine Lake.jpg" in "Finished file (JPEG, TIFF, PNG, WebP or HEIF)", leaves "Edited with (optional)" empty and clicks "Bring back as a version"; the button reads "Checking file…" then "Uploading…"; toast "Version 2 added. It becomes current once its preview is ready."; a new row "Version 2 · Brought back from Moraine Lake.jpg". | Bring back as a version | "When you are done, choose the finished file and Bring back as a version. Frameleaf checks it came from this original and adds it as a new version, current once its preview is ready." |
| 13 | 2:31–2:42 | CARD headline "Looks, presets and versions"; bullets one per clause: "Looks with a strength slider" · "Presets for your own recipes" · "Versions to compare, make current or download". | Looks, presets and versions | "Looks for a quick mood, presets for your own recipes, and versions you can compare, make current or download. The original is never touched." |
| 14 | 2:42–2:45 | LOGO OUTRO | Next: EDIT-04 · Video quick editor | "Next up: Video quick editor." |

## Voice-over (clean)

A look changes the mood of a photo in one click, and a version keeps every edit you save. Open a photo in Quick edit and choose Presets in the tool rail.

The row at the top is Looks. Each thumbnail shows this photo with the look applied: Original, Vivid, Natural, Warm and Cool, then Mono, Silvertone and Noir in black and white, and Fade. Choose Warm.

Below the row, the strength slider scales the look from zero to one hundred percent. Sixty keeps the warmth without losing the blue of the evening sky.

[beat]

Under Your presets, type a name such as Evening glow and choose Save as preset. A preset keeps your light, color, effects, detail, look and masks, but never the crop.

Open another photo, choose Presets, and select Evening glow. The whole recipe lands at once. The icons beside a preset replace it with the current settings or delete it.

[pause]

Choose Save version. The editor closes, and Frameleaf renders an edited master from the original plus your recipe. When it finishes, the new version is the one your library shows.

Open Quick edit again and choose Versions in the top bar. Each entry loads its recipe. All versions and renders opens the full list, with the original at the top.

Each version shows when it was saved, its size, and checksums that tie it to the original. Compare with original splits the stage. Make current shows that version in your library instead.

Download edited master saves the full-quality render. To show the original again, choose Make current on Original. Revert in the top bar only resets the settings you are editing.

[pause]

For a RAW developer, scroll to Edit in another app and choose Export original. Frameleaf records the original's checksum and downloads the file.

When you are done, choose the finished file and Bring back as a version. Frameleaf checks it came from this original and adds it as a new version, current once its preview is ready.

Looks for a quick mood, presets for your own recipes, and versions you can compare, make current or download. The original is never touched.

[pause]

Next up: Video quick editor.

## Production notes

- Prerequisites: Taylor signed in; Cabin at dusk, Lake reflection and Moraine Lake processed. Give Cabin at dusk one earlier rendered version (a crop is enough) so the save in beat 7 is Version 2, and Moraine Lake its Version 1 from EDIT-01 so the returned file in beat 12 is Version 2. No server settings are involved; rendering runs on the server itself.
- Looks: a photo is offered nine looks (web/src/lib/frameleaf/develop.ts `PRESETS`, `presetsFor('photo')`): Original, Vivid, Natural, Warm, Cool, Mono, Silvertone, Noir, Fade. "B&W" is a video-only look (EDIT-04). The row is labelled "Looks"; each thumbnail is a CSS approximation, and the stage then shows the server-rendered preview ("Rendering preview…"). The strength slider is labelled "{look} strength", runs 0–100% with 100 as the default, and is disabled while Original is chosen.
- Social formats (Portrait 4:5, Shorts 9:16, Wide 16:9) sit in the same Presets panel, between the strength slider and Your presets; beat 5 scrolls past them. EDIT-02 describes them as sitting below the crop, but in the current build they are in Presets, not in Crop and straighten. Flag for EDIT-02's owner.
- Your presets (UserPresets.svelte): belong to the signed-in account; empty state "No saved presets yet."; field "Preset name" (80 characters); button "Save as preset"; toasts "Saved {name}", "{name} applied", "Updated {name}". Deleting asks "Delete the preset {name}? Versions already saved with it keep their settings." Not shown on camera.
- Save version closes the editor (QuickEditor `saveVersion`). The toasts are "Version {n} saved. Rendering the edited master…" and "Version {n} rendered". When the render finishes, the server makes that version the working one (server asset-develop.service: "Rendering a version makes it the working version"). Statuses: Queued, Rendering {progress}%, Rendered, Render failed, Cancelled, Saved, not rendered; a busy version has "Cancel render", a failed one "Render".
- Versions: the top-bar "Versions" menu lists Original and each saved version with its status or "Current", and "All versions and renders" opens the panel. The panel help reads "Every saved version keeps its recipe and its rendered files. Make one current to show it; revert to the original at any time. Nothing here changes the original file." Each row offers Load settings, Compare with original (when a preview exists), Make current (rendered and not current), Download edited master (when a master exists).
- Two kinds of revert: the top-bar "Revert" (tooltip "Revert the settings to the original") resets the draft only; "Make current" on the Original row makes the original current again, with the toast "The original is current again". EDIT-01's closing line says "Revert makes the original current again"; in the current build that is the Original row's Make current. Flag for EDIT-01's owner.
- Edit in another app (RoundTripPanel.svelte): "Export original" records the original's SHA-256 and downloads it. The finished file must be JPEG, TIFF, PNG, WebP or HEIF. The file is accepted only when it names an export whose original still matches ("Matches the original"); an export marked "Original has changed" cannot be used. Before any export the form says "Export the original first, then bring the finished file back here." Keep the RAW developer off screen and unnamed; leave "Edited with (optional)" empty.
- Doc mismatch: docs/docs/features/editing.mdx lists only Cropping, Rotation and Mirroring under "Supported Edits" and shows the previous edit interface. Looks, presets, the Versions panel and Edit in another app are described from the current UI and i18n strings. The doc's sections on originals, edited masters and the `.lineage.json` record are accurate and support beats 7, 9 and 13.
- Do not open the Restore tool; restoration is EDIT-05 (HOLD).
