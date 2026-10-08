# MKT-03 · Find anything

| Field | Value |
| --- | --- |
| Series | Meet Frameleaf |
| Type | Marketing |
| Target length | 1:10 |
| Audience | People with large libraries who are used to big-tech search and expect to type a sentence |
| Features demonstrated | Search palette (Smart search), Ask about your photos with What Frameleaf searched for, Documents and Text in this photo (Show text regions, Copy text), Moments in your videos |
| Source docs | docs/docs/features/searching.md, docs/docs/features/documents.md |
| Capture checklist | Dark theme as Taylor; search palette opened with `/`; Smart search "campfire by a lake" returning Campfire evening and Lake reflection; /search Ask about your photos with "Jamie hiking in August 2026" and "receipts from 2024"; Explore → Documents listing Trailhead directions; viewer on Trailhead directions with Text in this photo reading "LAKE AGNES / 3.4 km"; a search for "kayaking" showing Moments in your videos from Kayaking.mov |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:10 | LOWER-THIRD "Find anything · Meet Frameleaf". SCREEN: Library, Timeline layout, Years grouping; the year scrubber runs from 2026 back to 2009. COUNTER bottom right ticks 0 → 153,792 over 800 ms. CURSOR presses `/` at 0:08 and the search palette opens. | 153,792 items | "A hundred and fifty thousand photos are only useful if you can find the one you mean." |
| 3 | 0:10–0:20 | SCREEN: search palette in Smart search mode. "campfire by a lake" types in. Results: Campfire evening first, then Lake reflection. ZOOM on the Campfire evening tile; HIGHLIGHT shows no tag chip on it. | Smart search: campfire by a lake | "Search understands pictures, not just file names. Ask for a campfire by a lake, and Campfire evening comes back, with no tag on it." |
| 4 | 0:20–0:31 | SCREEN: /search, the "Ask about your photos" box. "Jamie hiking in August 2026" types in and Enter is pressed. Results: Hiking with Jamie, Ridge trail, Family hike. ZOOM on the "What Frameleaf searched for" line: Person Jamie · August 2026 · hiking. | Ask about your photos | "Ask about your photos takes a whole sentence. Jamie hiking in August 2026 becomes a person, a month and a scene, and Frameleaf shows what it searched for." |
| 5 | 0:31–0:38 | SCREEN: same box, "receipts from 2024" types in. Results are document photos only (paper receipts on a table). CALLOUT on "What Frameleaf searched for": Text in photos · 2024. | receipts from 2024 | "Receipts from 2024 uses the text it has already read, so the paperwork you photographed turns up too." |
| 6 | 0:38–0:49 | SCREEN: Explore → Documents, a grid of photos with text; CURSOR opens Trailhead directions. The information card scrolls to "Text in this photo" showing "LAKE AGNES" and "3.4 km". CURSOR clicks "Show text regions" (boxes draw over the sign), then "Copy text". Cut at 0:46 to the search palette in Text in photos mode with "LAKE AGNES" and the same photo as the only result. | Text in this photo | "Documents lists every photo with words in it. Text in this photo shows what was read; copy it, or search for LAKE AGNES and land on the sign." |
| 7 | 0:49–0:58 | SCREEN: search palette, Smart search "kayaking". Above the results, the "Moments in your videos" strip shows three frames from Kayaking.mov with timestamps. CURSOR clicks the second frame (0:54); the viewer opens and plays from 0:09. | Moments in your videos | "Videos are searchable inside. Moments in your videos finds the frame that matches, and one click plays from that second." |
| 8 | 0:58–1:07 | CARD "On your server" with bullets per clause: "Search", "Faces", "Text reading". Cut at 1:03 to TITLE on the dark canvas. | Find anything. | "Search, faces and text reading all run on your own server. What you look for stays yours." |
| 9 | 1:07–1:10 | LOGO OUTRO with the tagline lockup; the leaf sways 4° once. | YOUR MEMORIES GROW FURTHER | "Frameleaf. Your memories grow further." |

## Voice-over (clean)

A hundred and fifty thousand photos are only useful if you can find the one you mean.

Search understands pictures, not just file names. Ask for a campfire by a lake, and Campfire evening comes back, with no tag on it.

Ask about your photos takes a whole sentence. Jamie hiking in August 2026 becomes a person, a month and a scene, and Frameleaf shows what it searched for.

Receipts from 2024 uses the text it has already read, so the paperwork you photographed turns up too.

[beat]

Documents lists every photo with words in it. Text in this photo shows what was read; copy it, or search for LAKE AGNES and land on the sign.

Videos are searchable inside. Moments in your videos finds the frame that matches, and one click plays from that second.

[pause]

Search, faces and text reading all run on your own server. What you look for stays yours.

[beat]

Frameleaf. Your memories grow further.

## Production notes

- Prerequisites: Smart Search enabled with the default CLIP model and the Smart Search job complete; OCR job complete so Documents lists Trailhead directions; Facial Recognition run with Jamie named so the Ask query resolves to a real person filter; "Ask about your photos" left on (an administrator can turn it off); Find moments run on Kayaking.mov so Moments in your videos has frames.
- Beat 3 (Smart search) shows semantic search on Campfire evening, which must carry no tag; check the tile before capture.
- Beat 4: searching.md (Ask Search) states the server turns the phrase into filters for people, named months and semantic prompts, and that a matched name uses the real person filter. The "What Frameleaf searched for" line is the integration build's label; if a name does not match, the line reports the match as approximate, so make sure Jamie is named.
- Beat 5: receipts, documents and screenshots use metadata and text-recognition search rather than semantic search (searching.md). Seed a few plain paper receipts on a table; document examples only, per STYLE-GUIDE.md section 6.
- Beat 6 labels are from documents.md: "Text in this photo", "Show text regions", "Select text", "Copy text". The search palette mode is "Text in photos". The sign reads "LAKE AGNES / 3.4 km".
- Beat 7: the doc states a search shows "Moments in your videos" above the results and that choosing a frame plays the video from there. Only the viewer's own videos are searched.
- Beat 8 claim is scoped to search, faces and text reading, which workers-and-endpoints.md says never run on Frameleaf Cloud. Descriptions are not claimed here.
- The 153,792 COUNTER is the sample library size from STYLE-GUIDE.md section 6.
