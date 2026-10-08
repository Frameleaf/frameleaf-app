# MKT-10 · Studio

| Field | Value |
| --- | --- |
| Series | Meet Frameleaf |
| Type | Marketing |
| Target length | 1:15 |
| Audience | Families who want to turn a trip's clips into a film without leaving their own library |
| Features demonstrated | Open in Studio from the selection bar, Studio projects (Projects, Archive, Trash), the multitrack editor with saving, Editing mode Basic / Advanced, Review comments, History and Restore, the Export dialog with Render on your own hardware, Export bundle and Import bundle |
| Source docs | studio/README.md, docs/docs/overview/acknowledgements.md, integration inventory section 2 (Studio) |
| Capture checklist | HOLD: capture from the design prototype (design/frameleaf/template, Studio mock "Summer in the Rockies / A FAMILY ADVENTURE", sequences Main film and Opening titles, music "Mountain Dreams - Instrumental.mp3") with the on-screen label Preview in every UI beat; selection bar with Lake morning.mov, Kayaking.mov, Forest trail.mov and Campfire evening selected; Studio projects page; the editor with the prototype's six tracks T1 Titles, V2 Overlays, V1 Video, A1 Camera, A2 Music, A3 Voice; Editing mode toggle; Review panel with one comment from Jamie; History panel; Export dialog; Export bundle |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:11 | LOWER-THIRD "Studio · Meet Frameleaf". SCREEN: Library with Lake morning.mov, Kayaking.mov, Forest trail.mov and Campfire evening selected; the selection bar shows "4 selected". HIGHLIGHT then CURSOR click on "Open in Studio" (0:08). "Preview" label top right for the whole beat. | Preview · Open in Studio | "Some memories want to be a film. Select the clips from a summer, choose Open in Studio, and cut them together." |
| 3 | 0:11–0:19 | SCREEN: Studio projects. Shelves Projects, Archive, Trash; the card "Summer in the Rockies" with the subtitle "A FAMILY ADVENTURE"; buttons "New project" and "Import bundle". CURSOR hovers the card's menu: Open project, Duplicate, Rename, Archive. "Preview" label. | Preview · Studio projects | "Studio projects keep every film you are working on in one place, with an archive for the finished ones." |
| 4 | 0:19–0:28 | SCREEN: the editor. Timeline tracks T1 Titles, V2 Overlays, V1 Video, A1 Camera, A2 Music, A3 Voice; the sequence "Main film". CURSOR drags Kayaking.mov onto V1 Video after Lake morning.mov (0:21), trims its tail (0:24); the title clip "Summer in the Rockies" sits on T1 Titles over the first clip and the music runs along A2 Music; the header flips "Saving…" → "All changes saved" (0:26). "Preview" label. | Preview · All changes saved | "The editor is a real multitrack timeline. Layer titles over video, mix the audio underneath, and every change is saved as you go." |
| 5 | 0:28–0:36 | SCREEN: header control "Editing mode: Basic". CURSOR switches it to Advanced (0:30); keyframe diamonds appear on the title clip's opacity lane and an effects list opens beside the timeline. "Preview" label. | Preview · Editing mode: Advanced | "Start in Basic and switch to Advanced when you want keyframes and effects. The tools grow with you." |
| 6 | 0:36–0:43 | SCREEN: "Review" panel. A comment from Jamie pinned at 0:42 on the playhead: "Hold this shot a second longer". Buttons Resolve / Reopen. CURSOR clicks the comment; the playhead jumps to 0:42. "Preview" label. | Preview · Review | "Share a project into a space, and Review lets Jamie pin a comment to the exact second." |
| 7 | 0:43–0:49 | SCREEN: "History" panel listing saved versions with times; CURSOR hovers "Restore" on the version from an hour ago. "Preview" label. | Preview · History | "History keeps every saved version. Restore an earlier one at any time." |
| 8 | 0:49–0:57 | SCREEN: "Export" dialog. Format "MP4 · H.264"; Resolution "2160p · 4K"; Colour "Preserve source"; "Render on" shows "This server" and "Home workstation" (home-network worker) only. CURSOR clicks Export (0:54); the top-bar Activity indicator shows the render Running. "Preview" label. | Preview · Render on: this server | "Export renders on your own hardware, this server or another computer on your home network, never in the cloud." |
| 9 | 0:57–1:05 | SCREEN: project menu "Export bundle"; the option "Include copies of my photos and videos" ticked; a file "Summer in the Rockies.bundle" downloads. Cut at 1:02 to a second server's Studio projects page: "Import bundle" → review list with rows Already here / Matched / Missing. "Preview" label. | Preview · Export bundle | "Export bundle packs the whole project, with your clips if you choose, so it opens on another Frameleaf server." |
| 10 | 1:05–1:12 | TITLE on the dark canvas: "Studio", with "Preview" beneath it in the muted colour; the three verbs appear one per VO word at 1:09. | Studio · Preview · Organize. Enhance. Create. | "Studio is a preview of what Frameleaf is building. Organize. Enhance. Create." |
| 11 | 1:12–1:15 | LOGO OUTRO with the tagline lockup; the leaf sways 4° once. | YOUR MEMORIES GROW FURTHER | "Frameleaf. Your memories grow further." |

## Voice-over (clean)

Some memories want to be a film. Select the clips from a summer, choose Open in Studio, and cut them together.

Studio projects keep every film you are working on in one place, with an archive for the finished ones.

The editor is a real multitrack timeline. Layer titles over video, mix the audio underneath, and every change is saved as you go.

Start in Basic and switch to Advanced when you want keyframes and effects. The tools grow with you.

[beat]

Share a project into a space, and Review lets Jamie pin a comment to the exact second.

History keeps every saved version. Restore an earlier one at any time.

Export renders on your own hardware, this server or another computer on your home network, never in the cloud.

Export bundle packs the whole project, with your clips if you choose, so it opens on another Frameleaf server.

[pause]

Studio is a preview of what Frameleaf is building. Organize. Enhance. Create.

[beat]

Frameleaf. Your memories grow further.

## Production notes

- HOLD. Studio needs an enrolled, qualified render worker and none ships; on a real server the route shows "Studio is not available on this server" with a Missing capabilities list (integration inventory, Studio). studio/README.md states the engine build is isolated, supplies no engine adapter, deploys no rendering worker and qualifies no hardware, and that the bridge answers not-implemented for most commands. Capture every UI beat from the design prototype (design/frameleaf/template) and carry the on-screen label "Preview" in each. Publish only after the dependency ships.
- The prototype badge "Interaction prototype · rendering unavailable" and the Restore workspace with its destination dropdown must be cropped or hidden: the destination list names a cloud GPU provider, and restoration is a separate HOLD (EDIT-05). Do not show the Restore workspace, the Captions or Motion workspaces, or any AI tool.
- Labels in beats 2 to 9 are the current build's (integration inventory, Studio): "Open in Studio" (up to 200 items; Locked items are never passed), "Studio projects" with shelves Projects / Archive / Trash, "New project", "Import bundle", project menu Open project / Duplicate / Rename / Archive / Move to trash / Export bundle, header "Saving… / All changes saved", "Editing mode: Basic / Advanced", "History" with "Restore", "Review" with Resolve / Reopen, "Export", "Export bundle" with "Include copies of my photos and videos" (owned items only, never Locked), bundle import review Already here / Matched / Missing.
- Export dialog: Format MP4 · H.264, MP4 · H.265 Main10, WebM · AV1, ProRes 422 HQ; Resolution 720p to 2160p · 4K; Colour Preserve source, HDR10, Dolby Vision. Show MP4 · H.264 with Preserve source. Dolby Vision is refused today and unproven options are disabled with a reason; keep them out of the zoom. "Render on" is this server or another computer on your home network, never the cloud (Studio export is in the "never" list in workers-and-endpoints.md). Progress shows in Activity.
- Beat 6: sharing a project into a shared space is listed in the integration inventory (Sharing: "Studio projects shareable"). Review comments are pinned to the playhead.
- Beat 10's "preview" is the one required HOLD mention in narration. Do not use the word elsewhere in the VO; the editor's "Server preview" control is not shown for that reason.
- acknowledgements.md credits the bundled Freecut editor (MIT) as the Studio engine; no engine, model or vendor name is spoken in a marketing cut. Studio AI tools, transcription, music and motion features are not shipped and are not shown.
- Correction (checked against design/frameleaf/template): the prototype's Studio timeline has six tracks, labelled T1 Titles, V2 Overlays, V1 Video, A1 Camera, A2 Music and A3 Voice (`TRACK_META` in src/Studio.jsx, `defaultTracks` in src/studio-project.mjs). The earlier "V2 Titles, V1 Video, A1 Source audio" matches the prototype's video editor timeline (src/Editor.jsx), not Studio. Beat 4 and the capture checklist now use the Studio names; the VO is unchanged.
- No timeline or ship date is promised; the narration says "a preview of what Frameleaf is building".
