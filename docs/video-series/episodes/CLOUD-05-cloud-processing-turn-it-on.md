# CLOUD-05 · Cloud processing: turn it on

| Field | Value |
| --- | --- |
| Series | Frameleaf Cloud |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators of a linked server who want Frameleaf Cloud GPUs for heavy jobs |
| Features demonstrated | Settings → Frameleaf Cloud → Cloud processing, Use Frameleaf Cloud for chosen jobs, Cloud processing terms dialog (five promises, region, faces never sent), optional features (Use recognised names in descriptions, Describe health and medical details), Accept and turn on, Save changes, consent facts and Review terms and features, terms-changed banner, Where each job runs (Local only, Both, Cloud only), When a job can run in both places, start with, rows that always stay on this server, Compute & jobs → Workload destinations, nothing falls back |
| Source docs | docs/docs/administration/workers-and-endpoints.md, docs/docs/administration/frameleaf-cloud.md |
| Capture checklist | frameleaf.home signed in as Taylor (admin), linked (CLOUD-02), cloud processing off and no terms accepted yet. Settings → Frameleaf Cloud → Cloud processing with the chip "Off"; the "Cloud processing terms · version …" dialog with both optional features off; the "Terms … accepted. Save to turn cloud processing on." banner and the settings bar "Unsaved settings" with "Save changes"; the card with the chip "On" and its facts; the "The processing terms have changed" banner (separate capture with a newer required version); the "Where each job runs" card with Descriptions & tags on Both and Video restoration on Cloud only; Settings → Compute & jobs → Workload destinations showing the same card with model sliders. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:17 | LOWER-THIRD "Cloud processing: turn it on · Frameleaf Cloud". SCREEN: frameleaf.home as Taylor; CURSOR traces Settings → Frameleaf Cloud → Cloud processing. The card "Frameleaf Cloud" shows the chip "Off". | Settings → Frameleaf Cloud → Cloud processing | "Cloud processing lets Frameleaf Cloud GPUs take on heavy work, like detailed descriptions or video restoration, when you ask. You need a linked server. Open Settings, Frameleaf Cloud, then Cloud processing." |
| 3 | 0:17–0:29 | ZOOM on the card's line "Your own computers stay the default, and nothing goes to the cloud without asking." HIGHLIGHT the toggle "Use Frameleaf Cloud for chosen jobs" and its line "Each job still shows its model and cost before it starts. When this is off, every cloud job is refused."; CURSOR turns it on. | Use Frameleaf Cloud for chosen jobs | "The page opens with a promise: your own computers stay the default, and nothing goes to the cloud without asking. Turn on Use Frameleaf Cloud for chosen jobs." |
| 4 | 0:29–0:44 | SCREEN: dialog "Cloud processing terms · version …". CALLOUT beside each promise as the VO names it: "Only previews are sent, never originals. Location and camera metadata are stripped first." and "Zero retention: files are deleted as soon as the job finishes, and within 24 hours at most." | Only previews are sent, never originals · Zero retention | "The cloud processing terms open first. Only previews are sent, never originals, and location and camera metadata are stripped. Files are deleted as soon as the job finishes, within 24 hours at most." |
| 5 | 0:44–0:52 | CALLOUT on "Nothing you send is used to train models." and "Jobs run in your account's region; files never leave it." ZOOM on the facts Region "… · your account's region" and Faces "Never sent; recognition stays on this server". | No training · Your account's region · Faces never sent | "Nothing you send trains models, and jobs run in your account's region. Faces are never sent." |
| 6 | 0:52–1:02 | ZOOM on "Optional features": the toggles "Use recognised names in descriptions" and "Describe health and medical details", both off. | Optional features · off unless you choose them | "Two optional features stay off unless you choose them: Use recognised names in descriptions, and Describe health and medical details." |
| 7 | 1:02–1:13 | CURSOR ticks "I have read these terms. I can turn cloud processing off at any time." and clicks "Accept and turn on". Banner "Terms … accepted. Save to turn cloud processing on." The settings bar "Unsaved settings" slides up; CURSOR clicks "Save changes"; the chip changes to "On". | Accept and turn on · Save changes · On | "Tick I have read these terms, then choose Accept and turn on. Save changes in the settings bar, and the chip changes to On." |
| 8 | 1:13–1:27 | ZOOM on the facts: Terms "Version … accepted", Recognised names "Never sent", Medical signals "Never described", Faces "Always recognised on this server". HIGHLIGHT "Review terms and features". Inset: the banner "The processing terms have changed" with "Review terms". | Review terms and features · The processing terms have changed | "The card now lists what you agreed to. Review terms and features changes the optional features later. If the terms change, cloud jobs are refused until you accept the new version." |
| 9 | 1:27–1:35 | SCREEN: scroll to the card "Where each job runs"; ZOOM on the switch Local only · Both · Cloud only on the row "Descriptions & tags". | Where each job runs · Local only · Both · Cloud only | "Next, Where each job runs. For each kind of work, choose Local only, Both, or Cloud only." |
| 10 | 1:35–1:51 | CURSOR sets Descriptions & tags to "Both"; its summary reads "Each job lets you pick this server or Frameleaf Cloud." CURSOR sets Video restoration to "Cloud only"; its summary reads "Jobs run on Frameleaf Cloud and show the cost first." | Both · Cloud only · cost shown first | "Both means each job lets you pick this server or Frameleaf Cloud, and a job never moves to the cloud on its own. Cloud only sends that work to Frameleaf Cloud, with the cost shown first." |
| 11 | 1:51–2:03 | ZOOM on "When a job can run in both places, start with" (This server / Frameleaf Cloud) and its help "Each job still shows both choices, and you can switch before it starts." CURSOR leaves "This server" and clicks "Save changes". | When a job can run in both places, start with | "When a job can run in both places, start with decides which choice comes first. You can still switch before a job starts. Save changes when you're done." |
| 12 | 2:03–2:18 | HIGHLIGHT the rows Smart search, Face recognition, Text in photos and Studio export: their Both and Cloud only buttons are disabled. CALLOUT on each reason: "Search runs on this server so results always match your own index.", "Faces never leave this server.", "Runs quickly on this server.", "Exports render on this server or another computer on your home network." | Always on this server: Smart search · Face recognition · Text in photos · Studio export | "Some rows never change. Smart search, Face recognition and Text in photos always run on this server, and Studio exports render at home or on another computer on your network." |
| 13 | 2:18–2:28 | SCREEN: Settings → Compute & jobs → Workload destinations: the same "Where each job runs" card, each routable row with its model slider. | Compute & jobs → Workload destinations | "You'll find the same table under Compute & jobs, in Workload destinations, with a model slider on each row." |
| 14 | 2:28–2:42 | SCREEN: back on Cloud processing; CURSOR rests on the toggle "Use Frameleaf Cloud for chosen jobs" without clicking. CARD overlay headline "Nothing falls back silently"; bullets: "Off means every cloud job is refused", "Originals, faces and your search index stay home", "Every job shows its model and cost first". | Nothing falls back silently | "Turn the switch off at any time, and every cloud job is refused. Nothing falls back to the cloud silently, and your originals, faces and search index stay at home either way." |
| 15 | 2:42–2:45 | LOGO OUTRO | Next: CLOUD-06 · Models, estimates and the AI Wallet | "Next up: Models, estimates and the AI Wallet." |

## Voice-over (clean)

Cloud processing lets Frameleaf Cloud GPUs take on heavy work, like detailed descriptions or video restoration, when you ask. You need a linked server. Open Settings, Frameleaf Cloud, then Cloud processing.

The page opens with a promise: your own computers stay the default, and nothing goes to the cloud without asking. Turn on Use Frameleaf Cloud for chosen jobs.

The cloud processing terms open first. Only previews are sent, never originals, and location and camera metadata are stripped. Files are deleted as soon as the job finishes, within 24 hours at most.

Nothing you send trains models, and jobs run in your account's region. Faces are never sent.

Two optional features stay off unless you choose them: Use recognised names in descriptions, and Describe health and medical details.

Tick I have read these terms, then choose Accept and turn on. Save changes in the settings bar, and the chip changes to On.

The card now lists what you agreed to. Review terms and features changes the optional features later. If the terms change, cloud jobs are refused until you accept the new version.

[pause]

Next, Where each job runs. For each kind of work, choose Local only, Both, or Cloud only.

Both means each job lets you pick this server or Frameleaf Cloud, and a job never moves to the cloud on its own. Cloud only sends that work to Frameleaf Cloud, with the cost shown first.

When a job can run in both places, start with decides which choice comes first. You can still switch before a job starts. Save changes when you're done.

Some rows never change. Smart search, Face recognition and Text in photos always run on this server, and Studio exports render at home or on another computer on your network.

You'll find the same table under Compute & jobs, in Workload destinations, with a model slider on each row.

[pause]

Turn the switch off at any time, and every cloud job is refused. Nothing falls back to the cloud silently, and your originals, faces and search index stay at home either way.

Next up: Models, estimates and the AI Wallet.

## Production notes

- Narration tone: Step-by-step and reassuring; every label spoken as printed.
- Prerequisites: the server is linked (CLOUD-02) and Taylor is an administrator. Until the server is linked, the toggle is disabled with "Link this server first." and the routing card says "Link this server to Frameleaf to choose Frameleaf Cloud or both."
- Capture: the page is the shipped build, but it shows what Frameleaf Cloud answers (link state, required terms version, data region). Frameleaf Cloud is not live, so capture against a mock of those answers. `e2e/src/ui/mock-network/cloud-network.ts` scripts the link only; the cloud processing status (`/api/admin/cloud/ml`) needs the same kind of mock, shaped as in `web/src/lib/components/frameleaf/cloud/CloudMlSection.spec.ts`. Print the terms version and region exactly as the mock returns them; do not invent a version.
- Accepting the terms also adds the Frameleaf Cloud destination if it does not exist yet, and cloud processing is on only after "Save changes".
- Doc discrepancy: workers-and-endpoints.md says an administrator uses "Add Frameleaf Cloud" in "Frameleaf Cloud processing" to create the destination, and lists three optional features (people names, medical signals, the text-recognition add-on). The shipped dialog has no separate Add button and offers two optional features; text recognition is not a cloud workload in v1 (frameleaf-cloud `docs/cloud-ml.md`). The VO follows the UI.
- Doc discrepancy: workers-and-endpoints.md names the area "Administration > Processing destinations". The shipped navigation is Settings → Compute & jobs → Workers & endpoints and Workload destinations, plus the cloud copy of the routing card on Settings → Frameleaf Cloud → Cloud processing.
- Every routable row starts on Local only. Both and Cloud only stay disabled until the server is linked and cloud processing is on.
- Beat 13 is a short establishing shot. Model sliders, prices and the AI Wallet are CLOUD-06; do not zoom on amounts here.
- The note at the top of "Where each job runs" names this server's own graphics card (from Hardware & GPU). That is Taylor's hardware, not a Frameleaf Cloud GPU; the VO never names a GPU, and no cloud GPU class appears in this episode.
- No prices are spoken or shown. Never show the staff console or any GPU, storage or hosting provider.
