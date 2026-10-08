# AI-06 · Descriptions that name people

| Field | Value |
| --- | --- |
| Series | Frameleaf AI |
| Type | Learn |
| Target length | 2:30 |
| Audience | Administrators and curious users who want descriptions to use real names |
| Features demonstrated | Identity injection concept, prerequisites (facial recognition, named people, Qwen or Phi), required-naming prompt and forbidden group nouns, post-validator and "Someone", allow-list, single-person substitution, Enable identity injection, Max names, Min face confidence, re-queue for older descriptions |
| Source docs | docs/docs/features/descriptions-and-smart-albums.md |
| Capture checklist | Signed in as Taylor (admin). People page with Jamie, Emma and Taylor named. Viewer on "Emma at the lake" with a before description ("a family at the lake") and after ("Jamie and Emma at Lake Louise"); viewer on "Family hike" with the description naming Jamie, Emma and Taylor and the People list expanded. Settings → Search & intelligence → Image Description → Prompt & Vocabulary → Identity injection with Enable identity injection on, Max names 5, Min face confidence 0.7. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD "Descriptions that name people · Frameleaf AI"; SPLIT on "Emma at the lake": left description "A family at the lake", right description "Jamie and Emma at Lake Louise" | A family at the lake → Jamie and Emma at Lake Louise | "Identity injection turns a family at the lake into Jamie and Emma at Lake Louise. This episode explains how it works and what it needs." |
| 3 | 0:14–0:26 | CARD headline "It needs three things"; bullets: "Facial recognition has run", "People are named", "Description model is Qwen or Phi" | Prerequisites | "It needs three things. Facial recognition has run. You have named the people you photograph most. And the description model is Qwen or Phi, because Florence-2 ignores it." |
| 4 | 0:26–0:37 | DIAGRAM: node "Photo" → node "Named faces" (chips Jamie · centre, Emma · right) → node "Prompt" → node "Model"; nodes appear as the VO names them, green path | Named faces → Prompt | "For each photo, Frameleaf looks up the named faces on it. It adds each name and its position in the frame to the prompt." |
| 5 | 0:37–0:51 | CARD headline "The prompt is strict"; bullets: "Name each listed person at least once", "No a family, a group, everyone, the kids", "Do not invent names" | Required naming | "The prompt is strict. It requires the model to name each listed person at least once. It forbids group nouns such as a family, a group, everyone or the kids when names are known." |
| 6 | 0:51–1:02 | DIAGRAM extends: node "Model" → node "Validator" → node "Description"; a red-outlined chip "Sarah" is swapped for a chip "Someone" | Validator | "A validator then checks the result. Any proper noun that is not a known person on that photo is replaced with Someone. It cannot be turned off." |
| 7 | 1:02–1:11 | CARD headline "Allowed through"; bullets: "Days and months", "Holidays", "Well-known places such as Banff" | Allow-list | "Day names, months, holidays and well-known places are allowed through, so Christmas and Banff are never mistaken for people." |
| 8 | 1:11–1:24 | CARD headline "One person or several"; bullets: "One known person: the woman becomes Emma", "Several people: the text is left alone", "The strict prompt does the work" | One person or several | "When exactly one known person is on the photo and the model writes the woman, the validator swaps in the name. With several people it leaves the text alone." |
| 9 | 1:24–1:33 | SCREEN Settings → Search & intelligence → Image Description → Prompt & Vocabulary; CURSOR expands "Identity injection"; HIGHLIGHT "Enable identity injection" (on) | Identity injection | "The controls live under Prompt & Vocabulary, then Identity injection. Enable identity injection is on by default." |
| 10 | 1:33–1:45 | ZOOM on "Max names" showing 5; CALLOUT reads the help "Maximum number of named persons to inject into a single prompt (1–20)" | Max names | "Max names caps how many people go into one prompt. The default is five. Raise it for large groups; lower it to one or two for crowd photos." |
| 11 | 1:45–1:57 | ZOOM on "Min face confidence" showing 0.7; CALLOUT "Named faces currently count as confirmed" | Min face confidence | "Min face confidence defaults to zero point seven. Today named faces count as confirmed, so this behaves as an on-off switch until per-face scores are stored." |
| 12 | 1:57–2:06 | SCREEN viewer on "Family hike"; ZOOM on the description naming Jamie, Emma and Taylor; People list expanded beside it | Family hike | "Family hike now reads Jamie, Emma and Taylor on the ridge, not a family on a hike." |
| 13 | 2:06–2:27 | CARD headline "If names are missing"; bullets: "Check the People list on the photo", "Check Max names covers everyone", "Re-queue: older descriptions keep their old wording" | If names are missing | "If names are missing, check the People list on the photo, check that Max names covers everyone, then re-queue. Older descriptions keep their old wording until you do." |
| 14 | 2:27–2:30 | LOGO OUTRO | Guide: Configurable Descriptions, Identity, Videos, and Smart Albums | "The written guide is linked below." |

## Voice-over (clean)

Identity injection turns a family at the lake into Jamie and Emma at Lake Louise. This episode explains how it works and what it needs. [pause]

It needs three things. Facial recognition has run. You have named the people you photograph most. And the description model is Qwen or Phi, because Florence-2 ignores it. [pause]

For each photo, Frameleaf looks up the named faces on it. It adds each name and its position in the frame to the prompt. [beat] The prompt is strict. It requires the model to name each listed person at least once. It forbids group nouns such as a family, a group, everyone or the kids when names are known. [beat] A validator then checks the result. Any proper noun that is not a known person on that photo is replaced with Someone. It cannot be turned off. [beat] Day names, months, holidays and well-known places are allowed through, so Christmas and Banff are never mistaken for people. [beat] When exactly one known person is on the photo and the model writes the woman, the validator swaps in the name. With several people it leaves the text alone. [pause]

The controls live under Prompt & Vocabulary, then Identity injection. Enable identity injection is on by default. [beat] Max names caps how many people go into one prompt. The default is five. Raise it for large groups; lower it to one or two for crowd photos. [beat] Min face confidence defaults to zero point seven. Today named faces count as confirmed, so this behaves as an on-off switch until per-face scores are stored. [pause]

Family hike now reads Jamie, Emma and Taylor on the ridge, not a family on a hike. [beat] If names are missing, check the People list on the photo, check that Max names covers everyone, then re-queue. Older descriptions keep their old wording until you do. [pause]

The written guide is linked below.

## Production notes

- Prerequisites: Face detection and Face recognition run on the sample library; Jamie, Emma and Taylor named on the People page; descriptions enabled on Qwen2.5-VL 3B; Identity injection on with defaults (5, 0.7). Seed the "before" description on "Emma at the lake" by describing it with identity injection off, then re-describe with it on for the "after".
- Default state: the docs' control table lists identity injection as enabled by default (5, 0.7); the Basic Setup step says to turn it on. The VO says "on by default" and asks the viewer to confirm; if the build shows it off, change the VO to "Turn on Enable identity injection."
- The "Min face confidence" caveat quotes the docs: named faces are treated as confirmed (confidence 1.0), so the control acts as an on/off knob until per-face scores are stored. Do not promise when that changes.
- Max names range in the build's help text is 1–20; the docs suggest 10–15 for large groups and 1–2 for crowds.
- The validator's allow-list (day names, months, holidays, well-known geography) and the single-person substitution are documented; "Sarah" in the diagram is an invented name being stripped, not a sample-library person.
- Videos also receive identity injection from faces on the preview thumbnail; AI-07 covers it.
- No rhetorical questions in this Learn episode; keep the diagram nodes appearing exactly as the VO names them.
- Outro CTA on screen: `Guide: Configurable Descriptions, Identity, Videos, and Smart Albums`; producer fills the public URL.
