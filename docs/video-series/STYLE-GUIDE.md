# Frameleaf video series: style guide and script template

Every episode in `episodes/` follows this guide. Producers, animators and voice talent should read this once; the episode files then stand on their own.

## 1. Format rules

| Rule | Value |
| --- | --- |
| Length | Under 3:00 including logo beats. Marketing episodes 0:45–1:30. Learn and how-to episodes 1:45–2:45. |
| Narration pace | 150 words per minute. A 2:30 episode holds at most 360 VO words; aim for 250–330. |
| Aspect | 16:9, 1920×1080, 30 fps. Phone captures are shown inside a device frame on the same canvas. |
| Opening | LOGO INTRO, 3 s (section 2). |
| Closing | LOGO OUTRO, 3 s, with one call to action (section 2). |
| Theme | Dark UI captures by default (the product is dark-first). Light mode appears only when the episode is about themes. |
| Fictional data | Every capture uses the sample library in section 7. Never show a real customer library. |
| Product name | "Frameleaf" in narration and on screen. Never say "fork". Never name Immich as the product; the "Built on Immich" credit appears only as a small line in the outro of the Start-here and Operations episodes that touch compatibility. The episode about running the official Immich image may name "official Immich" as the other system. |
| Cloud | GPU processing, backup and remote access through the cloud are always "Frameleaf Cloud". Never name a GPU, storage or hosting provider. Show only the client side: the cloud pages inside the Frameleaf app and the customer account site. The staff console and super-admin tooling never appear. |
| Mobile | Say "the Frameleaf mobile app". Captures come from the current mobile app; frame the phone so store listings and app-store names stay out of shot. |
| Shipped only | Narration describes only behaviour the documentation states as available. Anything the docs mark planned, preview or unqualified is scripted only inside an episode whose index status is HOLD, with the on-screen label "Preview". |
| Prices | USD only, and only figures the documentation states. |

## 2. Animated logo beats

The mark is three shapes from `design/frameleaf/brand-kit/frameleaf-symbol.svg`: a rounded-square **frame** that is open at its lower-left corner, a **leaf** growing out of that opening into the frame's lower half, and a **dot** at the upper right. Use the supplied SVG paths directly; do not redraw them.

Gradients (from the SVG, use as-is):

| Element | Gradient stops |
| --- | --- |
| Frame | `#86F345` → `#36EC72` → `#00C4D6` → `#00C7B0` → `#00D874` (top-left to bottom-right) |
| Leaf | `#56F260` → `#21DE73` → `#00BC9E` (top to bottom) |
| Dot | `#57F482` → `#09DFA5` → `#00BEDC` |
| Canvas | `#111D26` → `#091219` vertical |

Wordmark: `frameleaf-logo-dark.svg` (white "Frame", gradient "leaf"). Tagline: "YOUR MEMORIES GROW FURTHER" from `frameleaf-logo-dark-tagline.svg`, outlined, only at sizes where it stays legible.

### LOGO INTRO (0:00–0:03)

| Time | Animation |
| --- | --- |
| 0.0–0.3 s | Canvas fades from black to the dark gradient. A faint radial glow (12% teal) sits centre-left. |
| 0.3–1.2 s | The **frame** path draws on as a stroke, starting at the open lower-left corner and travelling clockwise. Stroke colour follows the frame gradient. At 1.2 s the stroke fills with the gradient. |
| 1.0–1.8 s | The **leaf** grows out of the frame's open corner: scale 0→1 from its stem point (lower-left), slight overshoot (spring, 1.08 then settle). |
| 1.6–1.9 s | The **dot** pops in at the upper right: scale 0→1.15→1 with a soft 200 ms glow pulse. |
| 1.9–2.6 s | Wordmark "Frameleaf" slides in from behind the symbol, left to right, letters revealed with a 20 px soft mask. The symbol settles to the wordmark's left. |
| 2.6–3.0 s | Hold. Sound: one short rising two-note sting (leaf then dot). Then a 12-frame cross-dissolve into beat 2. |

Reduced-motion variant for accessibility cuts: skip the draw-on and grow; fade the finished lockup in over 0.6 s.

### LOGO OUTRO (last 3 s)

| Time | Animation |
| --- | --- |
| −3.0 s | Screen content dips to 20% and blurs 8 px. The symbol scales up from the centre of the last frame (0.6→1) while the wordmark fades in beside it. |
| −2.4 s | Below the lockup, the call-to-action line fades in (see below). For marketing episodes the tagline "YOUR MEMORIES GROW FURTHER" replaces the CTA and the leaf performs one gentle 4° sway. |
| −0.5 s | Everything fades to the dark canvas, then to black. Sound: the two-note sting reversed and softened. |

Default CTA lines (pick one per episode, recorded as the final VO sentence):

- Learn series: "The written guide is linked below." (on screen: `Guide: <doc title>`; the producer fills in the public docs URL, which the repository does not yet state)
- Marketing: "Frameleaf. Your memories grow further." (on screen: tagline lockup)
- Help articles: "Next up: <next episode title>." (on screen: next episode card)

## 3. Animation vocabulary

Use these names in storyboards so the editor's motion library maps one to one.

| Name | Meaning |
| --- | --- |
| SCREEN | Full-bleed screen capture of the web app or a phone frame. State what page, what is selected and what the cursor does. |
| ZOOM | Push in on a region (give the element name); 400 ms ease-out; hold; pull back. |
| CALLOUT | Rounded 6 px label with a 1 px `#22C55E` border pointing at an element; slides in 250 ms. |
| HIGHLIGHT | 2 px green ring around a control, 600 ms pulse, used before a click. |
| CURSOR | Cursor path with click ripple; keep every click on screen for at least 500 ms. |
| CARD | Dark panel (`#171D21`, radius 6, border `#303940`) carrying a headline and up to three bullets; bullets appear one per VO clause. |
| DIAGRAM | Simple node-and-arrow drawing on the dark canvas: rounded nodes, 2 px lines, green for the active path, teal for data, blue for the internet or cloud. Nodes appear as the VO names them. |
| TERMINAL | Monospace panel (`#101416`, 16 px), typed at 25 characters per second, prompt then output; blur secrets. |
| SPLIT | Two captures side by side (before/after, phone/web). |
| COUNTER | Number ticking up over 800 ms. |
| TITLE | Large centred heading on the dark canvas with a one-line subheading; 2 s minimum. |
| LOWER-THIRD | Episode title and series name, bottom-left, first 4 s after the intro. |

Colour rules: green `#22C55E` for selection, focus and "on"; teal `#0EA5A0` for data and progress; blue `#3B82F6` for the internet, cloud and links; text `#E5E7EB` on panels; muted `#A1ADB8`. Fine 1 px separators, radii 4–6 px, Inter for UI text, a monospace face for commands.

## 4. Voice-over rules

- Second person, present tense, plain words. One idea per sentence. No exclamation marks.
- Say the exact on-screen label the first time a control is named, for example "open Utilities, then Media Health".
- Do not read commands aloud character by character; say what the command does while TERMINAL shows it.
- Marketing episodes: benefit first, then proof, then invitation. No feature lists longer than three items.
- Learn episodes: concept, why it matters, how it works, what to do. Name prerequisites before steps.
- Never promise cloud features, pricing or timelines that the documentation does not state. If the documentation calls something alpha or unsupported, the VO says so in one short sentence.
- Pause cues in the VO attachment: `[pause]` for a one-second beat, `[beat]` for half a second.

## 5. Episode file template

Each file in `episodes/` is named `<ID>-<slug>.md` and must contain exactly these sections in this order. `check-episodes.mjs` parses them.

```markdown
# <ID> · <Title>

| Field | Value |
| --- | --- |
| Series | <series name> |
| Type | Marketing | Learn | How-to |
| Target length | m:ss |
| Audience | <who> |
| Features demonstrated | <comma-separated feature names> |
| Source docs | <repo-relative paths> |
| Capture checklist | <pages, states and sample data to prepare> |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:10 | LOWER-THIRD; SCREEN ... | ... | "..." |
| n | m:ss–m:ss | LOGO OUTRO | <CTA> | "<CTA sentence>" |

## Voice-over (clean)

<The complete narration as paragraphs, exactly matching the storyboard column, with [pause] and [beat] cues only.>

## Production notes

- <sample data, prerequisites, caveats, alternates>
```

The matching `voiceover/<ID>.txt` file contains a short header, a `---` line, then the identical clean narration. The check script fails when the two differ.

## 6. Sample library

All episodes share one fictional library so captures cut together and help articles look consistent. It is the library from the Frameleaf design prototype.

| Item | Value |
| --- | --- |
| Signed-in admin | Taylor (`taylor@example.test`) |
| Other users | Jamie (`jamie@example.test`), Emma (`emma@example.test`) |
| People | Jamie, Emma, Taylor, and Max the golden retriever |
| Places | Banff, Lake Louise, Jasper, Alberta |
| Albums | Summer in the Rockies, Family, Everyday, Winter 2026 |
| Photos | Hiking with Jamie, Moraine Lake, Campfire evening, Ridge trail, Emma at the lake, Cabin life, Wildflowers, Dad and Max, Lake reflection, Glacier creek, Summit view, Family hike, Evening light (archived), Elk in meadow, Emma portrait, Through the forest (locked), Cabin at dusk, Trailhead directions (sign reads "LAKE AGNES / 3.4 km") |
| Videos | Lake morning.mov (0:24), Forest trail.mov (0:15), Kayaking.mov (0:18) |
| Cameras | iPhone 16 Pro, Sony α7 IV |
| Library size | 153,792 items, 2.42 of 4.00 TiB used, latest database backup 02:00 on 19 September |
| Example searches | "Jamie hiking in August 2026", "videos at Lake Louise", "LAKE AGNES", "receipts from 2024" |
| Servers | Home server "frameleaf.home", second server "old-server" for migration episodes |

Sensitive-content episodes use only landscape and document photos for the "hidden" examples; nothing suggestive is ever shown.

## 7. Series and numbering

| Prefix | Series | Purpose |
| --- | --- | --- |
| MKT | Marketing | Customer-facing, benefit-led, 0:45–1:30 |
| START | Start here | Install, first sign-in, first backup |
| LIB | Library basics | Timeline, albums, search, people, map, sharing |
| AI | AI and discovery | Descriptions, tags, smart albums, Best Photos, Ask Search |
| PRIV | Private by design | Locked, sensitive-content detection, location privacy |
| CARE | Library Care | Health scans, missing and damaged media, duplicates, Live Photo pairing, iCloud, Google Photos import, preservation |
| EDIT | Editing and Studio | Photo and video quick editors, restoration, Studio |
| MOBILE | On your phone | Backup, album sync, Free Up Space, read-only mode |
| OPS | Running Frameleaf | Settings Command Center, processing, storage, backups, users, access, remote access, migration |
| CLOUD | Frameleaf Cloud | Account link, sign-in, plans, cloud processing, AI Wallet, backup, remote access, account site |

Episode IDs are `<PREFIX>-<two digits>`. Playlists follow the series; the `README.md` index lists every episode with its status, and `VOICEOVER-MASTER.md` collects the narration in watch order.
