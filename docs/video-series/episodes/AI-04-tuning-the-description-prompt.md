# AI-04 · Tuning the description prompt

| Field | Value |
| --- | --- |
| Series | Frameleaf AI |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators shaping the length and focus of generated descriptions |
| Features demonstrated | Prompt & Vocabulary accordion, Description style, Sentence count target, Look for, Custom vocabulary, Forbidden inferences, NSFW indicators and Medical indicators defaults restore, Advanced raw prompt editor (mention), Review changes and Save changes, Last config change, Preview a description |
| Source docs | docs/docs/features/descriptions-and-smart-albums.md |
| Capture checklist | Signed in as Taylor (admin). Settings → Search & intelligence → Image Description with "Prompt & Vocabulary" expanded and Qwen2.5-VL 3B selected (no Florence banner). Description style dropdown open; Sentence count target at 3; Look for with the ten defaults; Custom vocabulary empty then with Banff, Lake Louise, Jasper typed; Forbidden inferences defaults; NSFW indicators and Medical indicators sub-accordions collapsed; Advanced — raw prompt editor collapsed. Status & Re-generation with a fresh "Last config change" timestamp. "Try an enrichment change" Compare view on "Ridge trail". |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "Tuning the description prompt · Frameleaf AI"; SCREEN Settings → Search & intelligence → Image Description; CURSOR expands the "Prompt & Vocabulary" accordion | Prompt & Vocabulary | "The prompt decides how long descriptions are and what they notice. In Image Description, expand Prompt & Vocabulary." |
| 3 | 0:13–0:25 | CALLOUT on the Description model field reading "Qwen2.5-VL 3B (default)"; CARD headline "Works with Qwen and Phi"; bullet "Florence-2 ignores every prompt control (a banner says so)" | Qwen and Phi only | "These controls work with the Qwen and Phi models. Florence-2 ignores every one of them, and a banner says so when it is selected." |
| 4 | 0:25–0:37 | ZOOM on "Description style"; CURSOR opens the dropdown showing "Terse — one or two sentences", "Balanced — a short paragraph", "Rich — detailed multi-sentence description"; leaves Balanced | Description style | "Description style sets the length. Terse is one or two sentences. Balanced is a short paragraph. Rich is a detailed multi-sentence description." |
| 5 | 0:37–0:48 | ZOOM on "Sentence count target" showing 3; CURSOR nudges to 4 and back to 3 | Sentence count target | "Sentence count target is a soft target from one to six. The default is three, and the model sometimes goes over by one." |
| 6 | 0:48–1:03 | ZOOM on the "Look for" textarea listing brands, signage, screens, documents, uniforms, tools, vehicles, animals, food, landmarks; CURSOR types two new lines "hiking trail" and "mountain range" | Look for | "Look for lists categories to call out when they are visible: brands, signage, screens, documents, uniforms, tools, vehicles, animals, food and landmarks. Add hiking trail and mountain range for this library." |
| 7 | 1:03–1:15 | ZOOM on "Custom vocabulary"; CURSOR types "Banff", "Lake Louise", "Jasper" on three lines | Custom vocabulary | "Custom vocabulary is the spelling to reuse in tags. One entry per line. Add Banff, Lake Louise and Jasper so tags match your place names." |
| 8 | 1:15–1:28 | CARD headline "Three fields, three jobs"; bullets: "Look for: what to notice", "Custom vocabulary: how to spell a tag", "Custom instructions: how to write" | Three fields, three jobs | "The three fields do different jobs. Look for says what to notice. Custom vocabulary says how to spell a tag. Custom instructions, in the next episode, says how to write." |
| 9 | 1:28–1:40 | ZOOM on "Forbidden inferences" listing diagnoses, medication names, procedures, pregnancy, disability | Forbidden inferences | "Forbidden inferences are things the model must never guess, even when the picture hints at them. The defaults are diagnoses, medication names, procedures, pregnancy and disability." |
| 10 | 1:40–1:51 | CURSOR expands "NSFW indicators" then "Medical indicators"; CALLOUT on the help text "Clear the box and save to restore defaults." | Clear the box and save to restore defaults | "NSFW indicators and Medical indicators are allow-lists of terms a description may use. Clear a box and save to restore its defaults." |
| 11 | 1:51–1:59 | CALLOUT on the collapsed "Advanced — raw prompt editor" sub-accordion; CURSOR hovers but does not open it | Advanced — raw prompt editor | "Advanced, the raw prompt editor, replaces all of this with one template. Most libraries never need it." |
| 12 | 1:59–2:11 | SCREEN save bar; CURSOR clicks "Review changes" (Look for and Custom vocabulary listed with old and new values), then "Save changes"; ZOOM on Status & Re-generation "Last config change" updating | Review changes → Save changes | "Choose Review changes, then Save changes. Existing descriptions keep the old prompt until you re-queue them. Status & Re-generation records the Last config change." |
| 13 | 2:11–2:22 | SCREEN "Try an enrichment change" Compare view on "Ridge trail"; ZOOM on the Candidate text mentioning the hiking trail and a tag "banff" | Preview on Ridge trail | "Preview a description on Ridge trail before a full run. The candidate now names the trail and uses your vocabulary." |
| 14 | 2:22–2:33 | CARD headline "Short cycles"; bullets: "Edit, save, rewrite a few photos", "Check the result", "Re-queue the library once" | Short cycles | "Iterate in short cycles: edit, save, rewrite a handful of photos, check, repeat. Re-queue the whole library once you are happy." |
| 15 | 2:33–2:45 | LOGO OUTRO | Next: AI-05 · Custom instructions | "Next up: Custom instructions." |

## Voice-over (clean)

The prompt decides how long descriptions are and what they notice. In Image Description, expand Prompt & Vocabulary. [beat] These controls work with the Qwen and Phi models. Florence-2 ignores every one of them, and a banner says so when it is selected. [pause]

Description style sets the length. Terse is one or two sentences. Balanced is a short paragraph. Rich is a detailed multi-sentence description. [beat] Sentence count target is a soft target from one to six. The default is three, and the model sometimes goes over by one. [pause]

Look for lists categories to call out when they are visible: brands, signage, screens, documents, uniforms, tools, vehicles, animals, food and landmarks. Add hiking trail and mountain range for this library. [beat] Custom vocabulary is the spelling to reuse in tags. One entry per line. Add Banff, Lake Louise and Jasper so tags match your place names. [beat] The three fields do different jobs. Look for says what to notice. Custom vocabulary says how to spell a tag. Custom instructions, in the next episode, says how to write. [pause]

Forbidden inferences are things the model must never guess, even when the picture hints at them. The defaults are diagnoses, medication names, procedures, pregnancy and disability. [beat] NSFW indicators and Medical indicators are allow-lists of terms a description may use. Clear a box and save to restore its defaults. [beat] Advanced, the raw prompt editor, replaces all of this with one template. Most libraries never need it. [pause]

Choose Review changes, then Save changes. Existing descriptions keep the old prompt until you re-queue them. Status & Re-generation records the Last config change. [beat] Preview a description on Ridge trail before a full run. The candidate now names the trail and uses your vocabulary. [pause]

Iterate in short cycles: edit, save, rewrite a handful of photos, check, repeat. Re-queue the whole library once you are happy. [pause]

Next up: Custom instructions.

## Production notes

- Prerequisites: descriptions enabled with Qwen2.5-VL 3B selected so no Florence banner shows; the Prompt & Vocabulary accordion is expanded at the start of beat 2.
- Accordion name: the docs call it the "Prompt" accordion; the build labels it "Prompt & Vocabulary". The VO uses the build label.
- Description style option labels in the build include their hints ("Terse — one or two sentences", "Balanced — a short paragraph", "Rich — detailed multi-sentence description"); the docs describe the same three presets as terse, balanced, rich.
- The Look for defaults are the ten documented entries; "hiking trail" and "mountain range" are documented example additions. Custom vocabulary example "Banff" is from the docs' travel-library example; Lake Louise and Jasper are sample-library places.
- Sentence count target range is 1–6 in both docs and build. Max sentence overrun ("goes over by one") is from the docs.
- Saving does not raise the re-queue banner by itself; the banner appears only after "Re-queue later" (covered in AI-08). The VO therefore points at "Last config change" instead.
- Beat 13 shows the Compare step from AI-03; capture it with the saved prompt so the candidate reflects the new vocabulary. Adjust the VO's "banff" tag if the model produces a different tag.
- Never show NSFW indicator terms on screen; keep both indicator textareas out of focus or blurred, and read only the help text.
- Outro card: "Next: AI-05 · Custom instructions".
