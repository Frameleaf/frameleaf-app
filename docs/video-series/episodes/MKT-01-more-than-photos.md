# MKT-01 · More than photos

| Field | Value |
| --- | --- |
| Series | Meet Frameleaf |
| Type | Marketing |
| Target length | 1:15 |
| Audience | Anyone who keeps photos on a phone or in a big-tech cloud and has never heard of self-hosting |
| Features demonstrated | Timeline, viewer information card, People, Pets, Map, Ask about your photos, photo and video quick editors, the Frameleaf mobile app backup, brand tagline |
| Source docs | README.md, design/frameleaf/brand-kit (frameleaf-symbol.svg, frameleaf-logo-dark.svg, frameleaf-logo-dark-tagline.svg), design/frameleaf styleboard copy |
| Capture checklist | Dark theme; signed in as Taylor; Library in Timeline layout grouped by Months with August 2026 in view; viewer on Moraine Lake with the information card open; Explore → People with Jamie, Emma and Taylor named; Explore → Pets with Max; Explore → Map showing Banff, Lake Louise and Jasper clusters; /search Ask about your photos with "Jamie hiking in August 2026"; video quick editor on Lake morning.mov; photo quick editor on Cabin at dusk; phone frame on the mobile app backup screen; Library → Recently added |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:12 | LOWER-THIRD "More than photos · Meet Frameleaf". SCREEN: Library, Timeline layout, Months grouping, August 2026 at the top; slow scroll down through Hiking with Jamie, Moraine Lake, Campfire evening and Ridge trail. Cursor idle. | — | "Your photos are more than files. They are the days you want to keep, and the people you want to keep them with." |
| 3 | 0:12–0:21 | SCREEN: viewer on Moraine Lake with the information card open. ZOOM on the card: the description line, the place line "Lake Louise, Alberta", the camera line "Sony α7 IV" and the people chips Jamie and Emma. Pull back at 0:19. | — | "Frameleaf keeps them on a server you own, in a library that knows who is in them and where they were taken." |
| 4 | 0:21–0:28 | SCREEN: Explore → People, named cards Jamie, Emma and Taylor. CURSOR hovers Jamie (0:22), then the page cuts to Explore → Pets and HIGHLIGHT rings the Max card (0:26). | — | "Open People, and every face has the name you gave it, from Jamie to Max the dog." |
| 5 | 0:28–0:35 | SCREEN: Explore → Map, dark style, clusters over Banff, Lake Louise and Jasper. ZOOM on the Lake Louise cluster; it expands into thumbnails of Moraine Lake, Emma at the lake and Lake reflection. | — | "Open Map, and a whole summer sits on the shore of Lake Louise, waiting to be opened again." |
| 6 | 0:35–0:42 | SCREEN: /search with the "Ask about your photos" box. The question types in at 25 characters per second: "Jamie hiking in August 2026". Results fill with Hiking with Jamie, Ridge trail and Family hike; the "What Frameleaf searched for" line appears under the box. | Jamie hiking in August 2026 | "Ask for Jamie hiking in August, in plain words, and the right days come straight back." |
| 7 | 0:42–0:48 | SCREEN: video quick editor on Lake morning.mov, Trim tool; CURSOR drags the end handle in by two seconds (0:43). Cut at 0:45 to the photo quick editor on Cabin at dusk, Adjust → Light; CURSOR nudges Shadows up. The top bar (Library, Studio, Activity) stays visible throughout. | — | "Trim a clip, brighten a photo, save a version. The original is never touched." |
| 8 | 0:48–0:56 | SPLIT: left, a phone frame on the Frameleaf mobile app backup screen (cloud icon top right, album list, upload progress ticking); right, web Library → Recently added filling with the same photos as they arrive. | — | "The Frameleaf mobile app backs up your phone to that same server, so every picture you take lands at home." |
| 9 | 0:56–1:01 | TITLE: the five words appear one at a time on the dark canvas, each on its VO word, with a leaf-green full stop. | Organize. Enhance. Create. Relive. Grow. | "Organize. Enhance. Create. Relive. Grow." |
| 10 | 1:01–1:12 | TITLE over a slow push-in on Family hike dimmed to 40%: the headline first, the subheading beneath it at 1:04. The handwritten "Good memories grow." fades in bottom right at 1:09. | More than photos. A brighter tomorrow. | "More than photos. A brighter tomorrow. Frameleaf is a photo and video library with real editing, intelligent enhancement and effortless organization, so your memories can grow with you." |
| 11 | 1:12–1:15 | LOGO OUTRO with the tagline lockup; the leaf sways 4° once. | YOUR MEMORIES GROW FURTHER | "Frameleaf. Your memories grow further." |

## Voice-over (clean)

Your photos are more than files. They are the days you want to keep, and the people you want to keep them with.

Frameleaf keeps them on a server you own, in a library that knows who is in them and where they were taken.

Open People, and every face has the name you gave it, from Jamie to Max the dog.

Open Map, and a whole summer sits on the shore of Lake Louise, waiting to be opened again.

Ask for Jamie hiking in August, in plain words, and the right days come straight back.

Trim a clip, brighten a photo, save a version. The original is never touched.

The Frameleaf mobile app backs up your phone to that same server, so every picture you take lands at home.

[pause]

Organize. Enhance. Create. Relive. Grow.

[beat]

More than photos. A brighter tomorrow. Frameleaf is a photo and video library with real editing, intelligent enhancement and effortless organization, so your memories can grow with you.

[beat]

Frameleaf. Your memories grow further.

## Production notes

- Capture from a build of the integration branch in dark theme, signed in as Taylor. Seed the sample library from STYLE-GUIDE.md section 6: named people Jamie, Emma and Taylor, pet Max, photos geocoded to Banff, Lake Louise and Jasper, albums Summer in the Rockies and Family.
- Jobs that must have run before capture: Extract metadata (reverse geocoding for Map and the place line), Face detection and Facial Recognition with names assigned, Pets recognition with Max confirmed, Smart Search so the beat 6 question returns results.
- Beat 6 uses "Ask about your photos" on /search, which is the documented sentence search (searching.md, Ask Search). It needs Smart Search enabled and a processing destination; an administrator can turn Ask off, so confirm it is on.
- Studio is HOLD (see MKT-10). In this episode it appears only as the Studio tab in the top bar during beat 7. Do not open the Studio projects page or the editor, and do not show the first-run "What's new" card.
- Beat 8: the current mobile app is the upstream app and still carries the upstream name on its sign-in and about screens. Frame the phone on the backup screen only (cloud icon, album list, progress) so no product name, store listing or app-store badge is in shot. Say "the Frameleaf mobile app" in narration only.
- Beat 7 shows the shipped quick editors (integration inventory, Editors): the video quick editor Trim tool and the photo quick editor Adjust → Light. "Save a version" refers to the Save version control in both editors.
- Brand copy is taken from the design-brand inventory: headline "More than photos. A brighter tomorrow.", the verbs "Organize. Enhance. Create. Relive. Grow.", the handwritten "Good memories grow." and a shortened body sentence (the styleboard's "AI-first" wording is dropped to keep the narration plain). Use the SVG brand files as supplied; do not flatten the gradients.
- No "Built on Immich" credit in marketing outros; the index reserves it for Start-here and Operations episodes.
