---
title: Generative edit model spike
---

FL-775 chooses the model behind Generative Develop (FL-748): edit by instruction, extend, relight, replace the sky, and move a person or object in from a second photo. This page records the comparison, the recommendation, the hardware floor, and the cost of one Cloud edit. The 50 reference edits that gate a release are in `machine-learning/test/generative-edit/`.

## Recommendation

| Question                 | Answer                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default model            | **Qwen-Image-2.1**, one checkpoint for all five modes.                                                                                            |
| Lighter fallback         | FLUX 3 Image Klein, only if Qwen-Image-2.1 fails the quality set on 16 GB cards.                                                                  |
| Runtime                  | PyTorch with `diffusers` on NVIDIA, in the existing ML service. No ONNX export.                                                                   |
| Local floor              | NVIDIA with 16 GB VRAM and 32 GB system memory. 24 GB VRAM keeps the whole model on the card.                                                     |
| Falls to Cloud           | Everything else: NVIDIA under 16 GB, CPU, OpenVINO, ARM NN, RKNN, and Apple Silicon.                                                              |
| Desktop worker           | Not in the first release. The Desktop app runs ONNX Runtime only and has no diffusion runtime.                                                    |
| Maximum generated size   | 4 megapixels (2048 × 2048). Larger photos are edited at a working size and the result is put back at full size.                                   |
| Does Extend need tiling? | No, up to a 4 megapixel canvas. Above that, Extend runs on a scaled-down canvas; the original pixels are put back untouched at full size.         |
| Cloud GPU class          | 48 GB (`gpu48pro`).                                                                                                                               |
| Cloud cost of one edit   | About $0.03 at 1 megapixel and $0.12 at 4 megapixels in GPU time, plus one start fee per job. These are estimates; see [Cloud cost](#cloud-cost). |

The roadmap named Qwen-Image-Edit-2509 and FLUX.1 Kontext [dev]. Both have been overtaken by newer open-weight editors that are smaller, faster and rank higher, so neither is recommended.

The owner agreed Qwen-Image-2.1 as the default on FL-775 on 2026-11-22.

## What was measured and what was not

No NVIDIA card and no Cloud GPU was available to this spike. **Every NVIDIA and Cloud figure on this page is a published figure from the model's maker or a named third party, or an estimate scaled from one.** Each table says which. They must be replaced by measured numbers when FL-823 first runs the model on a real card and FL-871 first runs it on Cloud.

One thing was measured, on an Apple M2 Max with 32 GB of memory, using MLX:

| Model, quantisation      | Task                                   | Time                    | Peak process memory |
| ------------------------ | -------------------------------------- | ----------------------- | ------------------- |
| FLUX.2 [klein] 4B, 4-bit | Generate one 1216 × 832 photo, 4 steps | 41.9 s (37 s denoising) | 8.5 GB              |

That run had the machine to itself. With other work running on the same Mac the same step took between 51 and 334 seconds. A long run that produced many photos of different shapes in one process grew far beyond the single-run peak before it was stopped; that growth was seen in the system's process list, not instrumented.

Edit timings for the candidates were **not** measured on the Mac. Qwen-Image-2.1 has a published peak of 46 GB at 16-bit on a Mac and its 4-bit files are 10 GB; FLUX 3 Image Klein has a published peak of 18.5 GB at 4 bits; Qwen-Image-Edit-2509 at 4 bits is 29 GB on disk. None of these fits a 32 GB Mac that other work is sharing. The Mac result is recorded because it bears on the Desktop decision, not on the choice of model.

## Candidates

All figures in this table are published, not measured here. Edit rank is the Artificial Analysis image editing Elo for open-weight models, read in November 2026.

| Model                          | Licence                | Size                         | Steps                   | Edit rank | Masks and extend                                                |
| ------------------------------ | ---------------------- | ---------------------------- | ----------------------- | --------- | --------------------------------------------------------------- |
| **Qwen-Image-2.1**             | Qwen Research License  | 7B model + 8B text encoder   | 40, or 8 with Turbo     | 1082      | Takes a mask directly. Up to 10 reference photos.               |
| Fibo 2.0                       | Bria non-commercial    | 8.1B model + 4B text encoder | Not recorded            | 1086      | Expects a long structured description. No mask input published. |
| FLUX 3 Image Klein             | FLUX Kommunity License | 5.6B model + 4B text encoder | 16                      | 1068      | No mask. Boxes guide placement. Extend needs an add-on.         |
| FLUX.2 [klein] 9B              | FLUX non-commercial    | 9B                           | 4                       | 1012      | No mask.                                                        |
| Qwen-Image-Edit-2511           | Apache-2.0             | 20B                          | 40, or 4 with an add-on | 996       | No mask. About 1 megapixel output.                              |
| Qwen-Image-Edit-2509 (roadmap) | Apache-2.0             | 20B                          | 40, or 4 with an add-on | 962       | No mask. About 1 megapixel output.                              |
| FLUX.2 [klein] 4B (lighter)    | Apache-2.0             | 4B + 4B text encoder         | 4                       | 941       | No mask. Extend needs an add-on.                                |
| FLUX.1 Kontext [dev] (roadmap) | FLUX non-commercial    | 12B                          | 28                      | 882       | No mask.                                                        |

H3-Image ranks higher (1136) but is a 204 GB download, so it was ruled out on size.

### Memory and speed

Published figures at 1 megapixel (1024 × 1024). "Resident" means the whole model stays on the card; "offloaded" means the text encoder is moved off the card before the image model runs.

| Model                | Files on disk                   | VRAM                                                  | Seconds per edit                                                |
| -------------------- | ------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| Qwen-Image-2.1       | 33 GB at 16-bit, 17 GB at 8-bit | 34 GB resident at 16-bit; 28 GB with an 8-bit encoder | 7.1 s on an RTX 5090 (8-bit model, encoder offloaded, 40 steps) |
| FLUX 3 Image Klein   | 20 GB at 16-bit, 11 GB at 8-bit | "As little as 8 GB" at 8-bit (maker's claim)          | 4.1 s on an RTX 5090, 8.9 s on an RTX 4070 (8-bit, 16 steps)    |
| FLUX.2 [klein] 4B    | Not recorded                    | 13 GB (maker), 8.4 GB (ComfyUI, offloaded)            | About 1.2 s on an RTX 5090 (4 steps)                            |
| Qwen-Image-Edit-2509 | 41 GB at 16-bit, 20 GB at 8-bit | More than 24 GB without offload                       | No figure on the same card; the model is three times the size   |
| FLUX.1 Kontext [dev] | 24 GB at 16-bit, 12 GB at 8-bit | 16 GB minimum (8-bit)                                 | About 10 s on an RTX 5090 (8-bit, 28 steps)                     |

At 4 megapixels expect four to five times the 1 megapixel time: the work grows a little faster than the pixel count. No maker publishes a 12 megapixel figure, and the FLUX 3 reference code refuses a single photo above 4 megapixels.

## Why Qwen-Image-2.1

- **It takes the words people type.** "Remove the cars" works as written. FLUX 3 Image Klein expects a full description of the finished picture; a short instruction makes it reframe the shot. Using it would mean shipping and running a second 9B model that rewrites every prompt.
- **It takes a mask.** Extend, sky and "put it here" are all "change only this part". Qwen-Image-2.1 accepts the mask as an input. The FLUX models do not: placement is a box in the prompt that the model may ignore, and Extend relies on a community add-on that moved the original picture by 86 pixels in its own example.
- **One checkpoint covers all five modes**, with up to 10 reference photos for object transfer. FL-823 loads one model, not five.
- **It ranks level with the best open editor that fits a 24 GB card** (4 points behind Fibo 2.0, which is within the leaderboard's noise), and it is the best open model on a second public leaderboard (arena.ai, November 2026).
- **Its size is native 2048 × 2048**, where the two roadmap Qwen models stop near 1 megapixel.

FLUX 3 Image Klein is about 40% faster and 40% smaller. It is the fallback if Qwen-Image-2.1 cannot pass the quality set at 8-bit on a 16 GB card.

## Hardware floor

Estimates from the published file sizes and VRAM figures above; none measured.

| Hardware                       | How the model runs                                                                          | 1 megapixel edit (estimate) |
| ------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------- |
| NVIDIA, 24 GB or more          | 8-bit model and 8-bit encoder both resident (17 GB of weights).                             | 8 to 12 s                   |
| NVIDIA, 16 GB                  | 8-bit model. The encoder runs first, then leaves the card. Decode in tiles at 4 megapixels. | 20 to 40 s                  |
| NVIDIA under 16 GB             | Not offered locally. Cloud.                                                                 |                             |
| CPU, OpenVINO, ARM NN, RKNN    | Not offered locally. Cloud.                                                                 |                             |
| Apple Silicon (Desktop worker) | Not offered in the first release. Cloud.                                                    |                             |
| Cloud                          | 16-bit, fully resident on a 48 GB card.                                                     | About 13 s                  |

The server needs 32 GB of system memory for the local path, because the encoder waits in system memory while the image model has the card.

**Desktop worker.** The Desktop app is built on ONNX Runtime and removes PyTorch. These models have no ONNX export, so running them on a Mac means adding MLX and a second model format to the Desktop app. The one MLX measurement above also shows the cost: 8.5 GB and 40 seconds for the smallest candidate at 4 bits, on a machine with nothing else running. Processing order for this workload is therefore Local (NVIDIA) then Cloud, with Desktops left out.

## Size, Extend and tiling

- The model generates at up to 4 megapixels. Above 1 megapixel the picture decoder runs in tiles on 16 GB cards; that is a `diffusers` setting, not our code.
- A photo larger than 4 megapixels is edited at a working size of at most 4 megapixels. For an edit with a region, only the region plus a margin is sent, so most masked edits on a 12 megapixel photo run at full detail. For a whole-photo edit (relight, season) the result is scaled back up with the existing upscaler.
- Extend adds canvas around the photo, masks the new area, and generates it. The original pixels are then put back over the result, as the existing eraser already does with its mask. This guarantees the photo itself does not change, whatever the model does.
- Extend needs no tiling up to a 4 megapixel canvas. For a larger canvas the scene is scaled down to fit, generated, and scaled back; only the new area carries generated pixels.

## Mirror and container image

- **Mirror.** Not published yet; FL-823 publishes it. The local profile is the 8-bit set, about 17 GB, as `frameleaf/qwen-image-2.1` on the models mirror; the Cloud image bakes in the 16-bit set, about 33 GB. Together they are five times the size of the largest model on the mirror today (4.6 GB), and a mirror release holds two copies while it switches, so check free space on the 150 GB models volume before publishing.
- **ML container image.** Only the NVIDIA image changes. It gains the `diffusers` package (tens of megabytes); PyTorch and `transformers` are already there at versions the model accepts. The base image does not change. Weights are downloaded on first use, as for every other model, and are not in the image.
- **Server.** A local install that turns this on needs about 17 GB more model storage.
- **Cloud worker image.** About 33 GB of weights baked in. Set `containerDiskGb` to 60, as the 34 GB restoration model already does.

## Cloud cost

For FL-840. Rates are the current `gpu48pro` rates; seconds are estimates scaled from the published RTX 5090 figure (a 48 GB L40S is taken as a little over half its speed). FL-871 must replace the seconds with measured p50 and p90 before a price is shown to anyone.

| Edit                          | Seconds (estimate) | Our cost | Customer charge for GPU time |
| ----------------------------- | ------------------ | -------- | ---------------------------- |
| 1 megapixel, 40 steps         | 13                 | $0.0063  | $0.025                       |
| 4 megapixels, 40 steps        | 60                 | $0.029   | $0.117                       |
| 1 megapixel, Turbo (8 steps)  | 3                  | $0.0015  | $0.006                       |
| 4 megapixels, Turbo (8 steps) | 12                 | $0.0058  | $0.023                       |

- Customer rate: $0.00195052 per second, the Frameleaf Cloud tariff for `gpu48pro` (asserted in `apps/api/test/unit/ml-model-ladder.test.ts` in the Cloud repository). Provider rate: $0.00048611 per second.
- A job also pays one start fee per worker start, however many edits it holds. The nearest existing size class on a 48 GB card (`vlm-7b`) charges $0.37 on the same tariff. Loading the model is covered by the start fee and is not metered.
- The settled charge is never less than one start fee, so a single 1 megapixel edit costs the customer about $0.40 and ten in one job about $0.62.
- **The app's own catalogue disagrees with the tariff.** `web/src/lib/frameleaf/gpu-model-catalog.ts` gives `gpu48pro` as $0.00130035 per second and `vlm-7b` as $0.20, which would make the GPU charges in the table a third lower ($0.017 and $0.078 at 40 steps). Cloud is what bills, so this page uses the tariff. FL-840 should settle which is right and bring the other into line.
- Turbo is a separate 8-step checkpoint of the same model. It is five times cheaper; whether it passes the quality set is for the owner's scoring to decide.

Cloud has no workload for this yet. FL-871 adds one (`generative-edit`) to the workload list, the model manifest schema, the estimate maths and the worker runtime.

## Sources

Read in November 2026. Links were not kept; each figure can be found on the page named.

- Model size, steps, licence, file sizes and maker's VRAM and speed figures: each model's own card and release notes (Qwen-Image-2.1 and Qwen-Image-Edit from Qwen; FLUX 3 Image Klein, FLUX.2 [klein] and FLUX.1 Kontext [dev] from Black Forest Labs; Fibo 2.0 from Bria; H3-Image from MiniMax).
- Edit rank: the Artificial Analysis image editing leaderboard, open-weights filter. Second leaderboard: arena.ai image edit, 16 November 2026.
- RTX 5090 timing for Qwen-Image-2.1 (7.1 s): the LightX2V benchmark notes for that model.
- FLUX.2 [klein] 4B at 8.4 GB: ComfyUI's model notes.
- FLUX.1 Kontext [dev] per-step time and 16 GB minimum: NVIDIA's notes for its packaged version of the model.
- Mac figures other than our own run: the mflux project's notes for each model.
- Cloud rates and fees: the Frameleaf Cloud tariff, as above.

## What the next issues take from this

- **FL-823** adds a `generative-edit` task to the ML service beside the existing eraser: a PyTorch model class that loads `frameleaf/qwen-image-2.1` from the mirror, takes the photo, the words, an optional mask and optional reference photos, and returns a PNG. It refuses to load below 16 GB of VRAM.
- **FL-825** routes the task Local then Cloud, and never to Desktops.
- **FL-871** registers the Cloud workload and manifest, bakes the 16-bit weights, and measures the seconds per megapixel that replace the estimates above.
- **Release gate.** Before a release ships a model for this feature, the owner scores it on the 50 edits; 40 must be accepted. The steps are in `machine-learning/test/generative-edit/README.md`.
