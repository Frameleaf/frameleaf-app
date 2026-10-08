# MKT-04 · AI that knows your family

| Field | Value |
| --- | --- |
| Series | Meet Frameleaf |
| Type | Marketing |
| Target length | 1:15 |
| Audience | Families who want the discovery features of a big-tech photo app without handing the photos over |
| Features demonstrated | AI descriptions that name recognized people (identity injection), People naming, Pets with Suggestions, Smart albums, Best photos, Memories (Year in review, Moments with a pet) |
| Source docs | docs/docs/features/descriptions-and-smart-albums.md, docs/docs/features/image-enrichment.md |
| Capture checklist | Dark theme as Taylor; viewer on Family hike with the information card description badged AI and reading "Jamie, Emma and Taylor on the ridge trail above Lake Louise, with Max ahead on the path"; Explore → People with Jamie, Emma and Taylor named; Explore → Pets with Max and three photos waiting in Suggestions; Albums page filtered to Smart with Travel, Pets and Nature populated; Library → Best photos populated; Memories with a Year in review card and Moments with Max |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "AI that knows your family · Meet Frameleaf". SCREEN: viewer on Family hike, information card open. ZOOM on the description with its AI badge: "Jamie, Emma and Taylor on the ridge trail above Lake Louise, with Max ahead on the path." HIGHLIGHT pulses on each name as the VO says it. | AI | "This photo describes itself, and it uses the names you know. Jamie, Emma and Taylor on the ridge trail. Not a family. Not a group." |
| 3 | 0:13–0:22 | SCREEN: Explore → People. CURSOR types "Jamie" into the inline name field on the first card and presses Enter (0:15). Cut at 0:18 back to the viewer description; CALLOUT on the AI badge: "Names come from the people you named." | People | "Name a face once in People and every new description can use it. A name it was not given never gets in." |
| 4 | 0:22–0:32 | SCREEN: Explore → Pets. CURSOR clicks "New pet", types Max, saves (0:24). Opens Max, clicks "Mark a pet" on Dad and Max and draws a box around him (0:27). Cut to the "Suggestions" tab with three more photos; CURSOR confirms the first. | Pets · Suggestions | "Pets get the same care. Add Max under Pets, mark him in a photo or two, and Suggestions brings the rest of him to you." |
| 5 | 0:32–0:40 | SCREEN: Albums page, filter "Smart". Shelves Travel, Pets and Nature with cover mosaics; three more (Documents & Receipts, Food, Screenshots) sit below. CURSOR opens Pets: a grid of Max. | Smart albums | "Smart albums fill themselves from those tags. Travel, Pets, Nature and three more, sorted as the descriptions come in." |
| 6 | 0:40–0:49 | SCREEN: sidebar Library → Best photos. Grid of Summit view, Emma portrait, Moraine Lake, Glacier creek. CALLOUT: "Scored on this server". | Best photos | "Best photos ranks your sharpest, best-lit pictures. It is scored on your server, with no album made and no favorite changed." |
| 7 | 0:49–0:58 | SCREEN: Explore → Memories. Cards "Year in review 2025" and "Moments with Max". CURSOR opens Year in review; the Memories player runs with Ken Burns over Summer in the Rockies photos. | Year in review · Moments with Max | "And Memories brings it all back. A year in review. Moments with Max. The days you would have forgotten to look for." |
| 8 | 0:58–1:06 | CARD "Each part has its own switch" with bullets per clause: "Descriptions and tags", "People and Pets", "Smart albums and Best photos". Cut at 1:03 to SCREEN: Settings → Search & intelligence area with the Image Description accordion in view; no cursor. | Settings → Search & intelligence | "All of it runs on your own hardware unless you choose otherwise, and each part has its own switch in Settings." |
| 9 | 1:06–1:12 | TITLE over Dad and Max dimmed to 40%. | AI that knows your family. | "AI that knows your family, because your family taught it." |
| 10 | 1:12–1:15 | LOGO OUTRO with the tagline lockup; the leaf sways 4° once. | YOUR MEMORIES GROW FURTHER | "Frameleaf. Your memories grow further." |

## Voice-over (clean)

This photo describes itself, and it uses the names you know. Jamie, Emma and Taylor on the ridge trail. Not a family. Not a group.

Name a face once in People and every new description can use it. A name it was not given never gets in.

[beat]

Pets get the same care. Add Max under Pets, mark him in a photo or two, and Suggestions brings the rest of him to you.

Smart albums fill themselves from those tags. Travel, Pets, Nature and three more, sorted as the descriptions come in.

Best photos ranks your sharpest, best-lit pictures. It is scored on your server, with no album made and no favorite changed.

And Memories brings it all back. A year in review. Moments with Max. The days you would have forgotten to look for.

[pause]

All of it runs on your own hardware unless you choose otherwise, and each part has its own switch in Settings.

[beat]

AI that knows your family, because your family taught it.

[beat]

Frameleaf. Your memories grow further.

## Production notes

- Prerequisites, in the order descriptions-and-smart-albums.md recommends: a Qwen2.5-VL or Phi-3.5-vision description model (Florence-2 ignores identity injection); Facial Recognition run and Jamie, Emma and Taylor named; identity injection on (Prompt & Vocabulary → Identity injection, defaults Max names 5, Min face confidence 0.7); descriptions re-queued so Family hike names everyone; Smart albums enabled and "Re-evaluate all assets" run; the "Best Photos backfill" job run (Settings → Compute & jobs → Create a maintenance job); Memory generation run so Memories has a Year in review card; Max confirmed under Pets with a few photos left in Suggestions for beat 4.
- Beat 2 wording follows the doc: the prompt requires every recognized person to be named and forbids generic group nouns such as "a family" or "a group". Beat 3's "A name it was not given never gets in" is the post-validator, which replaces proper nouns that are not on the asset with "Someone" (Identity injection — tuning and limits).
- Beat 4 labels are from the integration inventory (Pets): "New pet", "Mark a pet" (draw a region or Whole photo), "Suggestions", "Recognition". Pets need a processing destination.
- Beat 5: the six built-in kinds are Travel, Documents & Receipts, Screenshots, Food, Pets and Nature. Smart albums are real per-user albums, populated by the evaluator as descriptions complete. The narration names three and says "three more" to keep within the three-item rule.
- Beat 6: README.md (Best Photos) states scoring is local, creates no album, duplicates no file and changes no favorite. The first version scores images; do not show or claim video scoring.
- Beat 7 memory labels ("Year in review", "Moments with {pet}") are from the integration inventory. Do not show a birthday card, because the sample library does not state ages.
- ⚠ Defaults: the fork-features inventory notes that "Generate image descriptions and tags" is on by default in code while the docs say off; Smart albums are off by default; Best photos needs its backfill job. The narration therefore says "each part has its own switch" rather than "everything is off until you turn it on".
- Descriptions can optionally run on Frameleaf Cloud (CLOUD-05); "unless you choose otherwise" covers that. Faces never leave the server in any configuration.
- The README describes video descriptions as depending on Enhanced Video Duplicate Detection; the integration inventory says videos now use six reusable moment frames. Neither is shown here.
