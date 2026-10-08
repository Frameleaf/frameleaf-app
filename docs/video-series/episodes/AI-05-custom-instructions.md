# AI-05 · Custom instructions

| Field | Value |
| --- | --- |
| Series | Frameleaf AI |
| Type | How-to |
| Target length | 2:30 |
| Audience | Administrators who want descriptions to follow house rules |
| Features demonstrated | Custom instructions textarea, documented examples (vehicles, sports, documents, pets), stacking rules, the 2000-character limit, what custom instructions cannot do, Enable raw prompt override interaction, Save changes, Rewrite with AI |
| Source docs | docs/docs/features/descriptions-and-smart-albums.md |
| Capture checklist | Signed in as Taylor (admin). Settings → Search & intelligence → Image Description → Prompt & Vocabulary with the "Custom instructions" textarea empty, then with each example typed in turn; the help text under the field visible. Advanced — raw prompt editor with "Enable raw prompt override" off. Viewer on "Dad and Max" before and after "Rewrite with AI" (description changing from "dog" to "golden retriever"). |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD "Custom instructions · Frameleaf AI"; SCREEN Image Description → Prompt & Vocabulary; CURSOR scrolls to the empty "Custom instructions" textarea; ZOOM on its help text "Free-form natural-language guidance the model should follow." | Custom instructions | "Custom instructions teach the model new behaviour in plain sentences, without touching the prompt template. In Prompt & Vocabulary, find Custom instructions." |
| 3 | 0:14–0:26 | CARD headline "Write it like a briefing"; bullets: "Full sentences", "Say what to do and when not to", "Up to 2000 characters" | Write it like a briefing | "Write it like a short briefing for a careful assistant. Full sentences. Say what to do and when not to. The limit is two thousand characters." |
| 4 | 0:26–0:40 | SCREEN textarea; TERMINAL-style typing into it: "If you can clearly see a car, truck, or motorcycle, identify the make and model. If you are uncertain, just say a red car rather than guessing." | Vehicles | "Vehicles first. If you can clearly see a car, truck or motorcycle, identify the make and model. If you are uncertain, say a red car rather than guessing." |
| 5 | 0:40–0:48 | CARD headline "Effect"; bullets: "Before: a red car parked in a driveway at dusk", "After: the same sentence with the make and model named" | Before → After | "A car photo then reads with its make and model instead of just a red car." |
| 6 | 0:48–1:00 | SCREEN textarea cleared; typing: "When people are clearly playing a sport, name the sport and mention the visible equipment. Do not guess the sport from clothing alone." | Sports | "Sports. When people are clearly playing a sport, name the sport and the visible equipment. Do not guess the sport from clothing alone." |
| 7 | 1:00–1:14 | SCREEN typing: "When the photo is a document, receipt, or screenshot of text, transcribe the store name, total amount, date, and document type. Do not transcribe full account numbers or card numbers; refer to them as redacted." | Documents | "Documents. For a receipt or a screenshot of text, transcribe the store name, total, date and document type. Never transcribe full account or card numbers; say the number is redacted." |
| 8 | 1:14–1:29 | SCREEN typing: "For pets: identify the breed when you can recognize it. For dogs, note the activity. Do not guess a breed from coat color alone."; SPLIT to the viewer on "Dad and Max" with the description reading "golden retriever" | Pets | "Pets. Identify the breed when you can recognise it, and note what a dog is doing. Do not guess a breed from coat colour alone. Dad and Max then reads golden retriever, not dog." |
| 9 | 1:29–1:40 | CARD headline "Stack rules"; bullets: "One rule per line", "Vehicles, sports, pets, travel", "Never guess; use a generic description if unsure" | Stack rules | "You can stack rules in one box. End with a line such as: never guess; if you are not confident, use a generic description." |
| 10 | 1:40–1:54 | CARD headline "What it cannot do"; bullets: "Override safety rules", "Invent names or change the output shape", "Remember one photo when describing the next" | What it cannot do | "Custom instructions cannot override safety rules, cannot invent names the face library does not know, cannot change the output shape and cannot remember one photo when describing the next." |
| 11 | 1:54–2:04 | SCREEN scrolls to "Advanced — raw prompt editor"; CALLOUT on the "Enable raw prompt override" toggle (off) | Enable raw prompt override | "They are also ignored while Enable raw prompt override is on. Turn Advanced off, or paste the text into your template." |
| 12 | 2:04–2:17 | SCREEN save bar; CURSOR clicks "Save changes"; cut to the viewer on "Dad and Max"; CURSOR clicks "Rewrite with AI"; the description refreshes | Save changes → Rewrite with AI | "Save changes, then rewrite a few photos to check the effect. If a rule is not followed, use simpler, more direct wording." |
| 13 | 2:17–2:30 | LOGO OUTRO | Next: AI-06 · Descriptions that name people | "Next up: Descriptions that name people." |

## Voice-over (clean)

Custom instructions teach the model new behaviour in plain sentences, without touching the prompt template. In Prompt & Vocabulary, find Custom instructions. [beat] Write it like a short briefing for a careful assistant. Full sentences. Say what to do and when not to. The limit is two thousand characters. [pause]

Vehicles first. If you can clearly see a car, truck or motorcycle, identify the make and model. If you are uncertain, say a red car rather than guessing. [beat] A car photo then reads with its make and model instead of just a red car. [pause]

Sports. When people are clearly playing a sport, name the sport and the visible equipment. Do not guess the sport from clothing alone. [beat] Documents. For a receipt or a screenshot of text, transcribe the store name, total, date and document type. Never transcribe full account or card numbers; say the number is redacted. [beat] Pets. Identify the breed when you can recognise it, and note what a dog is doing. Do not guess a breed from coat colour alone. Dad and Max then reads golden retriever, not dog. [pause]

You can stack rules in one box. End with a line such as: never guess; if you are not confident, use a generic description. [beat] Custom instructions cannot override safety rules, cannot invent names the face library does not know, cannot change the output shape and cannot remember one photo when describing the next. [beat] They are also ignored while Enable raw prompt override is on. Turn Advanced off, or paste the text into your template. [pause]

Save changes, then rewrite a few photos to check the effect. If a rule is not followed, use simpler, more direct wording. [pause]

Next up: Descriptions that name people.

## Production notes

- Prerequisites: descriptions enabled on a Qwen or Phi model (Florence ignores instructions); "Dad and Max" already described once so the rewrite shows a visible change.
- The four typed examples are shortened from the documented examples 1, 2, 4 and 6 in descriptions-and-smart-albums.md; the on-screen text may use the full documented wording. The docs' "Expected effect" for vehicles names a specific car brand; the VO and card avoid the brand and describe the effect generically.
- The sample library has no car or sports photo; those two examples stay as typed text and a CARD, not captures. The pets example is captured on "Dad and Max" (Max the golden retriever).
- Documented limits: 2000-character cap (Save rejects longer text); instructions are ignored when "Enable raw prompt override" is on; they cannot override safety rules, identity injection's no-hallucinate rule or the output schema, and do not persist between assets.
- "Rewrite with AI" is the per-asset rerun in the information card; the docs call the same action "Rerun image descriptions and tags".
- The "Documents" example must never be captured with a real card or account number in frame; use a plain grocery receipt if a document is shown.
- Outro card: "Next: AI-06 · Descriptions that name people".
