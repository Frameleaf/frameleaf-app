# EDIT-05 · Restoration: Faithful and Creative

| Field | Value |
| --- | --- |
| Series | Editing and Studio |
| Type | How-to |
| Target length | 2:30 |
| Audience | People with noisy, compressed or small photos who want a cleaner version without losing the original |
| Features demonstrated | Restore tool in the quick editor, Restoration (Faithful, Creative), Size (Same size, 2×, 4×, capped at 4K), Keep film grain, Preview area (Centre of the frame, Current crop), Destination and Process on, Estimate (Preview, Full restoration, Output, Cloud cost), Preview restoration, Restorations list, Compare and Loupe, Accept and restore, Reject, Use for playback, Download restored file |
| Source docs | docs/docs/features/editing.mdx, docs/docs/administration/workers-and-endpoints.md, i18n/en.json (frameleaf_restoration_*), web/src/lib/components/frameleaf/editor (RestorationPanel, RestorationCompare), web/src/lib/frameleaf/restoration.ts |
| Capture checklist | HOLD. Capture the panel from a build of the integration branch against a mock network, with the on-screen label "Preview" in every UI beat. Taylor signed in, dark theme. One mocked restoration destination on the home network named "Home workstation", allowed restoration only, admissible, with measured runs so the Estimate shows times. Quick edit on "Campfire evening" (iPhone 16 Pro, low light, visible noise). A staged restoration that moves Preview queued → Rendering preview → Preview ready to review, then Accepted · queued → Restoring → Restored. No Frameleaf Cloud destination in the mock. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD; SCREEN: quick editor on "Campfire evening". HIGHLIGHT then CURSOR click on "Restore" in the tool rail; the panel heading "Restoration" appears with its lead line "Preview a small area first, then accept it to restore the whole file at full resolution as a new version." Label "Preview" top right from here on. | Restoration: Faithful and Creative · Editing and Studio · Preview | "Restoration cleans up a noisy, compressed or small photo and saves the result as a new version. Open the photo in Quick edit and choose Restore." |
| 3 | 0:14–0:25 | CARD headline "Before you start"; bullets one per clause: "A restoration worker on this server or your home network" · "Added by an administrator under Processing destinations" · "Not ready for general use yet: Preview". | Before you start · Preview | "Restoration runs on a restoration worker that an administrator adds under Processing destinations. That worker is not ready for general use yet, so these screens are marked Preview." |
| 4 | 0:25–0:39 | ZOOM on "Restoration": the choices Faithful and Creative. CURSOR clicks Faithful; the help line reads "Removes noise and compression while keeping the original look." CURSOR hovers Creative; the help line changes to "Rebuilds fine detail and may invent texture. Best for very small sources." CURSOR returns to Faithful. | Faithful · Creative | "First choose the kind. Faithful removes noise and compression while keeping the original look. Creative rebuilds fine detail and may invent texture, so keep it for very small sources." |
| 5 | 0:39–0:50 | ZOOM on "Size": Same size, 2×, 4×. CURSOR clicks 2×, then back to Same size; the line below reads "Output {width} × {height}" and, at 2×, adds "· capped at 4K". | Size · Same size · 2× · 4× | "Size keeps the photo the same size or enlarges it two or four times. The line below gives the output size and says when it is capped at 4K." |
| 6 | 0:50–1:01 | ZOOM: CURSOR ticks "Keep film grain" (note "Preserves fine grain instead of smoothing it"). Then "Preview area": Centre of the frame (selected) and Current crop, with the hint "Set a crop on the Crop tool to preview that area". | Keep film grain · Preview area | "Tick Keep film grain to keep fine grain instead of smoothing it. Preview area picks the part to test: the centre of the frame, or your current crop." |
| 7 | 1:01–1:15 | ZOOM on "Destination": the "Process on" menu opens with the placeholder "Choose where to process" and the option "Home workstation · A computer on your network". CURSOR chooses it; the note "Media stays on your network." appears. | Process on · Media stays on your network. | "Under Destination, choose where to process. Nothing runs until you pick one. Here it is a restoration worker on the home network, and the panel confirms that media stays on your network." |
| 8 | 1:15–1:28 | ZOOM on "Estimate": Preview "about 20 seconds", Full restoration "about 3 minutes", Output "{width} × {height}", Cloud cost "None"; below it "From 12 measured runs on this destination in the last 30 days." | Estimate | "Estimate shows how long the preview and the full restoration should take, based on runs measured on that destination. When nothing has been measured yet, it says so instead of guessing." |
| 9 | 1:28–1:40 | SCREEN: CURSOR clicks "Preview restoration"; toast "Restoration preview 1 queued. It appears under Activity." Under "Restorations", the row "Restoration 1 · Faithful · Same size" moves from "Preview queued" to "Rendering preview" with a progress bar to "Preview ready to review". CALLOUT on "A small preview is restored first. Nothing is uploaded to a cloud destination unless you choose one here." | Preview restoration · Preview ready to review | "Choose Preview restoration. Only the preview area is restored at first, and the job appears in Activity while it runs." |
| 10 | 1:40–1:54 | SCREEN: CURSOR clicks "Compare" on Restoration 1; the stage splits into the original and "After · preview" with a divider. CURSOR drags the divider across the embers, then turns on "Loupe"; a magnified circle follows the cursor over the faces by the fire. | Compare · Loupe | "When the preview is ready, choose Compare and drag the divider across the stage. Loupe magnifies the detail, so you can judge the grain and the edges." |
| 11 | 1:54–2:07 | SCREEN: CURSOR clicks "Accept and restore"; toast "Restoration 1 accepted. The full version is rendering."; the status moves "Accepted · queued" → "Restoring" → "Restored". HIGHLIGHT on "Reject" (not clicked). | Accept and restore · Reject | "If you like it, choose Accept and restore. The whole photo is restored at full resolution, on the same destination, with the same settings. If not, choose Reject and try the other kind." |
| 12 | 2:07–2:19 | SCREEN: the restored row offers "Use for playback", "Download restored file" and "Discard". CURSOR clicks "Use for playback"; the row reads "Used for playback"; toast "Restoration 1 is now used for playback." CALLOUT on the footnote "Restorations are saved as new versions. The original file is never changed, and a restored version is only used for playback when you choose it." | Use for playback · Download restored file | "The result is a new version. Choose Use for playback to show it, or Download restored file. The original file is never changed." |
| 13 | 2:19–2:27 | CARD headline "Restore, step by step"; bullets one per clause: "Choose the kind and size" · "Preview a small area where you choose" · "Accept only what you like". Label "Preview". | Restore, step by step · Preview | "Choose the kind and size, preview a small area on a destination you pick, and accept only what you like." |
| 14 | 2:27–2:30 | LOGO OUTRO | Next: EDIT-06 · Studio: projects and the editor | "Next up: Studio: projects and the editor." |

## Voice-over (clean)

Restoration cleans up a noisy, compressed or small photo and saves the result as a new version. Open the photo in Quick edit and choose Restore.

Restoration runs on a restoration worker that an administrator adds under Processing destinations. That worker is not ready for general use yet, so these screens are marked Preview.

[pause]

First choose the kind. Faithful removes noise and compression while keeping the original look. Creative rebuilds fine detail and may invent texture, so keep it for very small sources.

Size keeps the photo the same size or enlarges it two or four times. The line below gives the output size and says when it is capped at 4K.

Tick Keep film grain to keep fine grain instead of smoothing it. Preview area picks the part to test: the centre of the frame, or your current crop.

[beat]

Under Destination, choose where to process. Nothing runs until you pick one. Here it is a restoration worker on the home network, and the panel confirms that media stays on your network.

Estimate shows how long the preview and the full restoration should take, based on runs measured on that destination. When nothing has been measured yet, it says so instead of guessing.

[pause]

Choose Preview restoration. Only the preview area is restored at first, and the job appears in Activity while it runs.

When the preview is ready, choose Compare and drag the divider across the stage. Loupe magnifies the detail, so you can judge the grain and the edges.

If you like it, choose Accept and restore. The whole photo is restored at full resolution, on the same destination, with the same settings. If not, choose Reject and try the other kind.

The result is a new version. Choose Use for playback to show it, or Download restored file. The original file is never changed.

Choose the kind and size, preview a small area on a destination you pick, and accept only what you like.

[pause]

Next up: Studio: projects and the editor.

## Production notes

- HOLD. docs/docs/administration/workers-and-endpoints.md: "The restoration worker is not qualified yet". Without a restoration destination the panel shows "No processing destination is set up. An administrator adds them under Processing destinations." Every UI beat carries the on-screen label "Preview", and beat 3 is the one sentence of narration that says so. Publish only after a qualified restoration worker ships.
- Capture source: the Restore panel exists in the current build (web/src/lib/components/frameleaf/editor/RestorationPanel.svelte), so capture it from a build of the integration branch with a mocked restoration destination and staged results (the README's "mock network" route). Do not use the design prototype's photo-editor restore tab: it shows an older "Enhance & upscale" layout with a model slider and a cloud upscale button that no longer matches the build. The prototype's Studio Restore workspace uses the same labels as the build (Restoration, Faithful and Creative, Process on, Estimate, Keep film grain) but is a Studio surface; use it only as a look reference.
- Administrator side (not shown): the restoration worker is a separate container started with docker-compose.restoration.yml and added as a home-network destination allowed restoration only; library analysis and restoration never share a worker (workers-and-endpoints.md). Workers & endpoints has a "Restoration models" dialog. OPS-04 and OPS-06 cover destinations.
- Destination choices: the menu lists admissible destinations first, then this server, the home network and Frameleaf Cloud, and shows a refused destination with its reason instead of hiding it. A cloud destination is never chosen by default (restoration.ts `defaultDestinationId`); if one is chosen the panel says "Media leaves your network for this job." with an AI Wallet cost note. Frameleaf Cloud restoration is not shown here (CLOUD-05 to CLOUD-07).
- Estimate rows are Preview, Full restoration, Output and Cloud cost ("None" on your own hardware). With nothing measured: "Not measured yet" and "Nothing has run on this destination yet, so there is no measured time to show." The figures in the visual column are capture guidance.
- Statuses (frameleaf_restoration_status_*): Preview queued, Rendering preview, Preview ready to review, Preview failed, Preview cancelled, Preview expired, Rejected, Accepted · queued, Restoring, Restored, Restoration failed, Restoration cancelled, Discarded. A ready preview is kept until a stated date ("Preview kept until {date} unless you decide sooner."). Discard asks "Discard this restoration?" and says the original is not affected.
- Video: the same panel appears in the video quick editor with "Preview starts at (seconds)", "Use current frame", "Preview 5 seconds" and "Restore full video". Not shown in this episode.
- Never show a GPU model name or a model file name; crop the worker details if the mock prints them.
- Doc gap: docs/docs/features/editing.mdx does not mention restoration. Labels come from i18n/en.json (frameleaf_restoration_*) and the build.
