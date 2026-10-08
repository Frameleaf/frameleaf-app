# CLOUD-06 · Models, estimates and the AI Wallet

| Field | Value |
| --- | --- |
| Series | Frameleaf Cloud |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators with cloud processing on who want to choose models and control spending |
| Features demonstrated | Models card and model slider (white processor, green your GPU, blue Frameleaf Cloud only), cloud readout, Local only crossing out blue models, licence-blocked models, How cloud jobs are billed, Estimate a job (likely, at most, held, could start now), AI Wallet (Balance, Held for running jobs, Available, Spent today), Daily spending cap, Add credit and the Add AI credit dialog, top-up range, Top up automatically, empty wallet refuses |
| Source docs | docs/docs/administration/workers-and-endpoints.md, /Users/adamtaylor/Github/frameleaf-cloud/docs/ai-wallet.md, /Users/adamtaylor/Github/frameleaf-cloud/docs/cloud-ml.md |
| Capture checklist | frameleaf.home signed in as Taylor (admin), linked, cloud processing On with terms accepted (CLOUD-05), and a graphics card found by Settings → Compute & jobs → Hardware & GPU so the sliders show white, green and blue. Settings → Frameleaf Cloud → Cloud processing: the Models card with the Descriptions & tags slider on a green stop, then on a blue stop; "How cloud jobs are billed." with "GPU rates" closed; "Estimate a job" with a Descriptions model and 500 photos showing "This job could start now."; the AI Wallet card with a balance, a held amount and some spending today; the "Add AI credit" dialog; the "Top up automatically" toggle. Settings → Compute & jobs → Workload destinations with Descriptions & tags on Local only. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:15 | LOWER-THIRD "Models, estimates and the AI Wallet · Frameleaf Cloud". SCREEN: Settings → Frameleaf Cloud → Cloud processing with the chip "On"; CURSOR scrolls past the AI Wallet card to the Models card. | Models · Estimate a job · AI Wallet | "With cloud processing on, three things shape a cloud job: the model, the estimate, and your AI Wallet. All three are on the Cloud processing page." |
| 3 | 0:15–0:29 | ZOOM on the Models card: the slider for Descriptions & tags from "Lighter" to "Heavier", its stops banded white, green and blue; below it the key "White · processor, no GPU", "Green · your GPU (…)" and "Blue · Frameleaf Cloud only, cost shown first". | White · processor · Green · your GPU · Blue · Frameleaf Cloud only | "Models has a slider for each kind of work, from lighter to heavier. White runs on the processor, green on your GPU, and blue only on Frameleaf Cloud." |
| 4 | 0:29–0:43 | CURSOR drags the Descriptions & tags knob from a green stop to a blue stop; the readout changes to "… · Cloud · about … per photo" with the model's one-line note. Amounts and the cloud GPU class in the readout are blurred. | Cloud · about … per photo | "Slide to a heavier model, and the readout says where it runs and about what it costs per photo. Any single job can still use a different model." |
| 5 | 0:43–0:57 | SCREEN: Settings → Compute & jobs → Workload destinations, the row Descriptions & tags set to "Local only". ZOOM on its slider: the blue stops are crossed out and the reason reads "This work is set to run on this server only. Choose Both or Cloud only in Where each job runs." | Local only · Choose Both or Cloud only | "If that work is set to Local only in Where each job runs, the blue models are crossed out, and the slider says to choose Both or Cloud only." |
| 6 | 0:57–1:08 | CARD headline "Licence comes first"; bullets: "Hosted use not allowed: never blue", "It stays on your server", "The slider says why". | Licence comes first | "A model whose licence does not allow hosted use never turns blue. It stays on your server, and the slider says why." |
| 7 | 1:08–1:23 | SCREEN: back on Cloud processing. ZOOM on "How cloud jobs are billed." and its paragraph; the "GPU rates" disclosure stays closed. | How cloud jobs are billed. | "How cloud jobs are billed explains the rule. You pay for the GPU time a job uses, per second, plus a start fee for each worker that loads the model. Per-photo prices are estimates." |
| 8 | 1:23–1:39 | ZOOM on "Estimate a job": CURSOR picks a Descriptions model in "Model" and types 500 in "Quantity" ("500 photos"). The lines "Likely …, at most about …. … is held until the job settles." and "This job could start now." appear; amounts and the billing line's GPU class are blurred. | Estimate a job · Likely · at most · held · This job could start now. | "Estimate a job tries a model and a quantity before you commit. It shows the likely cost, the most it should cost, the amount held until the job settles, and whether the job could start now." |
| 9 | 1:39–1:55 | CURSOR scrolls up to the AI Wallet card. ZOOM on the chip "… available" and the figures Balance, Held for running jobs and Available; CALLOUT on "Prepaid credit for cloud jobs. Each job holds its estimate, then settles at the actual cost." | AI Wallet · Balance · Held for running jobs · Available | "The AI Wallet is prepaid credit in US dollars. It shows your balance, what is held for running jobs, and what is available. Each job holds its estimate, then settles at the actual cost." |
| 10 | 1:55–2:05 | ZOOM on the meter "Spent today · … of … daily cap" and the field "Daily spending cap" (USD) with "Jobs that would pass the cap wait until tomorrow instead of starting." | Daily spending cap | "Daily spending cap sets a limit for each day. Jobs that would pass it wait until tomorrow instead of starting." |
| 11 | 2:05–2:22 | CURSOR clicks "Add credit"; dialog "Add AI credit": Amount $25 (Suggested), $50, $100 and "Other amount" (USD); the note "Payment happens on frameleaf.cloud in a new tab…"; buttons Cancel and "Continue on frameleaf.cloud". CURSOR chooses Cancel. Back on the card, ZOOM on "Top-ups from $20 to $500; no bonus credit. Card fees are included; the full amount becomes AI credit." | Add AI credit · $25 · $50 · $100 · $20 to $500 | "Add credit offers $25, $50 or $100, or any amount from $20 to $500. There is no bonus credit, and card fees are included. Payment happens on frameleaf.cloud in a new tab." |
| 12 | 2:22–2:42 | HIGHLIGHT the toggle "Top up automatically" and its help line. Then CARD headline "An empty wallet refuses the job"; bullets: "Never lower quality", "Never another destination". | Top up automatically · An empty wallet refuses the job | "Top up automatically adds credit when it runs low, using the payment method saved on frameleaf.cloud. An empty wallet refuses a job. It never lowers quality or moves the work elsewhere." |
| 13 | 2:42–2:45 | LOGO OUTRO | Next: CLOUD-07 · Running a cloud job | "Next up: Running a cloud job." |

## Voice-over (clean)

With cloud processing on, three things shape a cloud job: the model, the estimate, and your AI Wallet. All three are on the Cloud processing page.

Models has a slider for each kind of work, from lighter to heavier. White runs on the processor, green on your GPU, and blue only on Frameleaf Cloud.

Slide to a heavier model, and the readout says where it runs and about what it costs per photo. Any single job can still use a different model.

If that work is set to Local only in Where each job runs, the blue models are crossed out, and the slider says to choose Both or Cloud only.

A model whose licence does not allow hosted use never turns blue. It stays on your server, and the slider says why.

[pause]

How cloud jobs are billed explains the rule. You pay for the GPU time a job uses, per second, plus a start fee for each worker that loads the model. Per-photo prices are estimates.

Estimate a job tries a model and a quantity before you commit. It shows the likely cost, the most it should cost, the amount held until the job settles, and whether the job could start now.

[pause]

The AI Wallet is prepaid credit in US dollars. It shows your balance, what is held for running jobs, and what is available. Each job holds its estimate, then settles at the actual cost.

Daily spending cap sets a limit for each day. Jobs that would pass it wait until tomorrow instead of starting.

Add credit offers $25, $50 or $100, or any amount from $20 to $500. There is no bonus credit, and card fees are included. Payment happens on frameleaf.cloud in a new tab.

Top up automatically adds credit when it runs low, using the payment method saved on frameleaf.cloud. An empty wallet refuses a job. It never lowers quality or moves the work elsewhere.

Next up: Running a cloud job.

## Production notes

- Narration tone: Practical and exact; money in plain words. Read "frameleaf.cloud" as "frameleaf dot cloud" and the amounts as "twenty-five", "fifty", "a hundred", "twenty" and "five hundred dollars".
- Prerequisites: cloud processing on with the terms accepted (CLOUD-05). The green band needs a graphics card found by Hardware & GPU; on a processor-only server the sliders show white and blue only.
- Capture: the page is the shipped build, but the wallet, the terms state and the region come from Frameleaf Cloud's answer. Capture against the same mock as CLOUD-05 (the `/api/admin/cloud/ml` status shaped as in `CloudMlSection.spec.ts`). Wallet figures are mock values. "Add credit" is enabled only when the wallet answer carries a top-up link; never follow "Continue on frameleaf.cloud".
- Blur every per-unit price, estimate, hold and GPU rate. They come from the build's rate table, which frameleaf-cloud `docs/cloud-ml.md` calls estimates, re-measured monthly (the same decision as MKT-11). Keep "GPU rates" closed. The blue readout's detail line ("Runs on a …") and the estimate's billing line name a cloud GPU class: blur them. No cloud GPU name ever appears.
- Spoken figures: the $25, $50 and $100 presets and the $20 to $500 range, no bonus credit and card fees included are stated in frameleaf-cloud `docs/ai-wallet.md` (owner decision 2026-09-25) and printed by the UI. The daily cap default ($20 in ai-wallet.md) is not spoken.
- The "Top up automatically" help prints "When available credit drops below $5, add $25…". ai-wallet.md treats threshold and amount as the account's own settings and states no defaults, so the VO does not repeat those figures. The line stays on screen as printed.
- Licence-blocked models (beat 6): the rule is in cloud-ml.md (licence gate) and the UI has the reason "… is not offered on Frameleaf Cloud because its licence does not allow hosted use." Every model on the shipped sliders is licensed for hosted use today (`web/src/lib/frameleaf/gpu-model-catalog.ts`), and the local-only models are not on the sliders, so the beat is a CARD. If a catalogue answer marks a model, capture its reason line instead.
- "An empty wallet refuses the work; it never lowers quality or moves the work elsewhere" is from workers-and-endpoints.md.
- The New photos card ("Describe new photos automatically" with "Daily budget") and "Recent cloud jobs" are not in this episode; running and settling a job is CLOUD-07.
- Never show the staff console or any GPU, storage or hosting provider.
