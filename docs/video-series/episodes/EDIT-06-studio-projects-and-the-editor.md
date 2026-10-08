# EDIT-06 · Studio: projects and the editor

| Field | Value |
| --- | --- |
| Series | Editing and Studio |
| Type | How-to |
| Target length | 2:45 |
| Audience | Families and hobbyists who want to cut a trip's clips and photos into a film inside their own library |
| Features demonstrated | Studio in the top bar, Studio projects (Projects, Archive, Trash shelves, Search projects, Order, New project, Import bundle, card actions), Open in Studio from a selection and from the quick editor, the editor (media bin, program monitor, timeline tracks, save indicator), Editing mode Basic and Advanced, Back to quick edit, the render worker requirement ("Studio is not available on this server", Missing capabilities) |
| Source docs | studio/README.md, docs/docs/administration/workers-and-endpoints.md, i18n/en.json (frameleaf_studio_*), web/src/lib/components/frameleaf (StudioProjectLibrary, StudioHost), web/src/lib/frameleaf/studio (handoff.ts, capabilities.ts), design/frameleaf/template/src/Studio.jsx |
| Capture checklist | HOLD. Taylor signed in, dark theme. Studio projects page from a build of the integration branch against a mock network, seeded with "Summer in the Rockies" (saved) and one archived project; label "Preview". Library with Lake morning.mov, Kayaking.mov, Forest trail.mov and Campfire evening. The editor from the design prototype (design/frameleaf/template, Studio mock "Summer in the Rockies", sequence "Main film"), label "Preview", with the prototype's "Preview · sample data" note left visible. A quick edit open on Lake morning.mov with an unsaved Trim for the Back to quick edit beat. The real unavailable state from a build with no render worker (no Preview label on that beat). |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD; SCREEN: the top bar with Library, Studio and Activity. HIGHLIGHT then CURSOR click on "Studio"; the page "Studio projects" opens. Label "Preview" top right. | Studio: projects and the editor · Editing and Studio · Preview | "Studio is where clips and photos become a film. It sits in the top bar beside Library and Activity, and opens on Studio projects." |
| 3 | 0:14–0:30 | ZOOM on Studio projects: heading "Studio projects", "Import bundle" and "New project" buttons, shelves Projects, Archive and Trash, "Search projects", the "Order" menu (Recently changed, Recently opened, Name). The card "Summer in the Rockies" shows "Version 12 · Changed …" and the buttons Open project, Rename, Duplicate, Export bundle, Archive, Move to trash. | Studio projects · Projects · Archive · Trash | "Every project lives here, on three shelves: Projects, Archive and Trash. Search by name, change the order, and use the buttons on each project to open, rename, duplicate, archive or move it to the trash." |
| 4 | 0:30–0:41 | SCREEN: CURSOR clicks the Archive shelf, note "Archived projects are read-only and hidden from reviewers until you bring them back."; then the Trash shelf, note "Projects in the trash are deleted for good after 30 days. Photos and videos they use are never touched." | Archive · Trash | "Archived projects are read-only until you bring them back. Projects in the trash are deleted for good after thirty days, and the photos and videos they use are never touched." |
| 5 | 0:41–0:54 | SCREEN: Library. CURSOR selects Lake morning.mov, Kayaking.mov, Forest trail.mov and Campfire evening in that order; the selection bar shows "4 selected". HIGHLIGHT then CURSOR click on "Open in Studio". | Open in Studio | "To start a film, select clips and photos in the library and choose Open in Studio. They arrive in the order you picked them, up to two hundred at a time." |
| 6 | 0:54–1:08 | SCREEN (prototype): the editor fills the page. Header: "Library", project name "Summer in the Rockies", "All changes saved", "Editing mode" Basic and Advanced, "Editing as Taylor", "Review", "Export". CALLOUT on the media bin (Library and Project tabs), the program monitor and the timeline in turn. Label "Preview". | Preview · All changes saved | "The editor fills the page. The media bin is on the left, the program monitor is in the middle, and the timeline runs along the bottom. The header shows the project name and whether every change is saved." |
| 7 | 1:08–1:24 | ZOOM on the timeline (prototype): track heads T1 Titles, V2 Overlays, V1 Video, A1 Camera, A2 Music, A3 Voice. CURSOR drags Kayaking.mov from the bin onto V1 after Lake morning.mov, then trims its tail; the header flips "Saving…" → "All changes saved". Label "Preview". | T1 Titles · V1 Video · A1 Camera · A2 Music | "Titles and overlays sit above the video track, with camera sound, music and voice below. Drag a clip from the bin onto the video track and trim its end. Studio saves as you go." |
| 8 | 1:24–1:36 | SCREEN (prototype): CURSOR clicks "Advanced" in "Editing mode"; keyframe lanes appear under the title clip and the inspector shows more controls. CURSOR clicks "Basic" again. Label "Preview". | Editing mode · Basic · Advanced | "Editing mode starts on Basic, which keeps the controls simple. Switch to Advanced for keyframes and the finer controls. The project is the same in both." |
| 9 | 1:36–1:52 | SCREEN: quick editor on Lake morning.mov with an unsaved Trim; CURSOR clicks "Open in Studio" in the editor's top bar. Studio opens with "Back to quick edit" beside "Library" in the header. CURSOR clicks "Back to quick edit"; the quick editor returns with toast "Your unsaved edits are back where you left them." Label "Preview" on the Studio frames. | Back to quick edit · Your unsaved edits are back where you left them. | "You can also open Studio from the quick editor. Your unsaved edits are kept, and Back to quick edit returns you to the clip with them still in place." |
| 10 | 1:52–2:10 | SCREEN (current build, no Preview label): the Studio page on a server without a render worker. Heading "Studio is not available on this server", body "Studio needs a graphics worker this server does not have. Browsing your library and quick edits are unaffected.", list "Missing capabilities": GPU worker, Render worker. Buttons "Try again" and "Library". ZOOM on the list. | Studio is not available on this server · Missing capabilities | "Studio needs a render worker, a qualified graphics worker that an administrator adds. Without one, Studio says it is not available and lists what is missing. Your library and quick edits keep working." |
| 11 | 2:10–2:21 | TITLE on the dark canvas: "Studio", with "Preview" beneath it in the muted colour. | Studio · Preview | "Render workers are not available yet, so the Studio editor in this episode is a preview." |
| 12 | 2:21–2:42 | CARD headline "Studio in brief"; bullets one per clause: "Studio projects on three shelves" · "Open in Studio from a selection or the quick editor" · "Basic or Advanced on a multitrack timeline". | Studio in brief | "Projects on three shelves, Open in Studio from a selection or from the quick editor, and Basic or Advanced editing on a multitrack timeline. Review, history and export come next." |
| 13 | 2:42–2:45 | LOGO OUTRO | Next: EDIT-07 · Studio: review, history, export and bundles | "Next up: Studio: review, history, export and bundles." |

## Voice-over (clean)

Studio is where clips and photos become a film. It sits in the top bar beside Library and Activity, and opens on Studio projects.

Every project lives here, on three shelves: Projects, Archive and Trash. Search by name, change the order, and use the buttons on each project to open, rename, duplicate, archive or move it to the trash.

Archived projects are read-only until you bring them back. Projects in the trash are deleted for good after thirty days, and the photos and videos they use are never touched.

[pause]

To start a film, select clips and photos in the library and choose Open in Studio. They arrive in the order you picked them, up to two hundred at a time.

The editor fills the page. The media bin is on the left, the program monitor is in the middle, and the timeline runs along the bottom. The header shows the project name and whether every change is saved.

Titles and overlays sit above the video track, with camera sound, music and voice below. Drag a clip from the bin onto the video track and trim its end. Studio saves as you go.

Editing mode starts on Basic, which keeps the controls simple. Switch to Advanced for keyframes and the finer controls. The project is the same in both.

[beat]

You can also open Studio from the quick editor. Your unsaved edits are kept, and Back to quick edit returns you to the clip with them still in place.

[pause]

Studio needs a render worker, a qualified graphics worker that an administrator adds. Without one, Studio says it is not available and lists what is missing. Your library and quick edits keep working.

Render workers are not available yet, so the Studio editor in this episode is a preview.

[pause]

Projects on three shelves, Open in Studio from a selection or from the quick editor, and Basic or Advanced editing on a multitrack timeline. Review, history and export come next.

[pause]

Next up: Studio: review, history, export and bundles.

## Production notes

- HOLD. studio/README.md: the production Studio host is present, but this build "does not supply its engine adapter, deploy a rendering worker, qualify hardware or provide licensed Dolby tools", and the command bridge answers not-implemented until each story lands. Capture the editor beats (6 to 9) from the design prototype and the Studio projects beats (2 to 4) from the build against a mock network; every one of those frames carries the on-screen label "Preview". Beat 10 is the shipped behaviour and is captured from a real build without a render worker, with no Preview label. Publish only after render workers ship.
- Studio projects (StudioProjectLibrary.svelte) is in the current build: top-bar "Studio" opens it (web/src/lib/frameleaf/navigation.ts). Owner card actions on the Projects shelf are Open project, Rename, Duplicate, Export bundle (saved projects only), Archive, Move to trash; on Archive: Open project, Bring back, Export bundle, Duplicate, Move to trash; on Trash: Restore, Delete forever, plus "Empty trash". A project shared with you shows "Review only" and only Open project. The empty state reads "No projects yet. Start one, or make a movie from a memory or an album." The prototype has no projects page, so seed the build instead.
- Open in Studio: up to 200 items (`maxStudioHandoffAssets`), in the order selected. Locked items never cross into Studio, and from the Locked view nothing is offered (LibraryView.svelte). Items the session can no longer read are dropped with a count in the header ("{count} items you chose are not available here").
- Editor layout and tracks come from the prototype (design/frameleaf/template/src/Studio.jsx): track heads T1 Titles, V2 Overlays, V1 Video, A1 Camera, A2 Music, A3 Voice; workspace tabs Edit, Color, Audio, Motion, Captions, Restore. Stay on the Edit tab. Do not open Captions, Motion or Restore, the music dialog, or any AI tool; none of those is shipped. MKT-10's capture notes name the tracks "V2 Titles, V1 Video, A1 Source audio"; the prototype's labels above are the ones to capture.
- Editing mode: the build's header offers Basic and Advanced only while the editor is running ("Basic and Advanced change the engine's layout"). In the prototype, Advanced adds keyframe lanes and extra controls in each panel.
- Back to quick edit (StudioHost.svelte) appears only when Studio was opened from the quick editor. The unsaved draft is carried to Studio and offered back on return; the toast is "Your unsaved edits are back where you left them." If the clip changed meanwhile: "This item was changed since you left, so your unsaved edits from before were not reapplied."
- Unavailable state: heading "Studio is not available on this server", body "Studio needs a graphics worker this server does not have. Browsing your library and quick edits are unaffected." The Missing capabilities list shows whatever the server's capability snapshot lacks (for example GPU worker, Render worker); render worker admission is only reported for a live, qualified worker session (web/src/lib/frameleaf/studio/capabilities.ts). A build without the engine at all says "The Studio editor is not part of this build. The library, the quick editor and project review are unaffected." Capture whichever the build shows and match the list on screen.
- No engine, vendor or model name is spoken. acknowledgements.md credits the bundled editor engine; it is not named in this episode. No date is promised.
