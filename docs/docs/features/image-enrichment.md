# Image Enrichment

Image enrichment adds optional machine learning jobs that can generate searchable descriptions and tags for image assets, detect NSFW images, or do both. Description generation is enabled by default; sensitive-content detection is disabled by default. Review and configure them independently in `Settings → Compute & jobs → Machine learning`.

Image enrichment processes image assets only. It skips deleted and hidden assets, processes locked ones like any other (background work always reaches them), and it does not change album membership. A detection locks an asset only while `Hide detected NSFW assets` is enabled; see [Locked](./locked.md).

To try a model or prompt on a few samples before it reaches the library, and to run chosen stages on chosen items as a background plan, see [Sample-first enrichment and plans](./descriptions-and-smart-albums.md#sample-first-enrichment-and-plans). Videos are described from their reusable moment frames; see [Video moments](./descriptions-and-smart-albums.md#video-moments).

## Recommended Rollout

For an existing library, enable and backfill one task at a time:

1. Enable `Detect NSFW images` first and run `Administration > Jobs > NSFW Detection > All`.
2. Review the private classifier result in the information panel and tune the threshold if needed. Visible tags do not control access.
3. Enable `Generate AI descriptions and tags` and run `Administration > Jobs > Image descriptions and tags > All`.
4. Enable `Hide detected NSFW assets` only after the classifier results look acceptable for your library.

New uploads are queued automatically after thumbnail generation when the relevant setting is enabled.

## Review and Repair

Admins can review enrichment results from the asset detail panel. The `Image enrichment` section shows the stored model status, model name, NSFW score, labels, review state, and last error when a task fails.

Available single-asset repair actions are:

- Rerun image descriptions and tags.
- Rerun NSFW detection.
- Accept the current NSFW classifier result.
- Mark an asset as safe or NSFW using a private review override.
- Clear the generated `AI description:` block without removing user-written description text.
- Clear generated tags from the asset without deleting the tag definitions.

Review overrides are stored in private enrichment metadata and become the effective NSFW source of truth for hiding. Generated tags remain visible search metadata only.

Admins can also use the search filter modal to find enrichment review sets, including NSFW assets, assets needing NSFW review, reviewed or overridden NSFW assets, failed enrichment jobs, and image assets missing description or NSFW results. If `Hide detected NSFW assets` is enabled, unlock the locked folder PIN session before searching hidden NSFW review sets.

## Descriptions and Tags

When description and tag generation is enabled, Frameleaf sends the asset preview image to the machine learning service and stores the model result as private enrichment metadata. Frameleaf then applies visible metadata according to the admin settings:

- Descriptions are written to the asset description field.
- Existing user descriptions are preserved, with a generated block appended once.
- Tags are plain searchable tags, deduplicated against existing tags.
- Sidecar write jobs are queued after visible description or tag changes.

The default description model setting is `Qwen/Qwen2.5-VL-3B-Instruct`. On OpenVINO, that model is mapped to the OpenVINO-converted `llmware/qwen2.5-vl-3b-ov` model. The lower-resource fallback setting is `microsoft/Florence-2-base-ft`. See [Hardware and Model Notes](#hardware-and-model-notes) below for the full curated model dropdown, VRAM estimates per model, and local fallback behavior.

## NSFW Detection

When NSFW detection is enabled, Frameleaf sends the asset preview image to a dedicated classifier. The private enrichment metadata stores the NSFW flag, score, labels, model name, status, and timestamps.

The default NSFW model is `onnx-community/nsfw_image_detection-ONNX`, with a default threshold of `0.85`. When an image is detected as NSFW, Frameleaf can add an `nsfw` tag and specific visible reason tags when they are supported by the classifier result and the visible image content.

The private NSFW flag is the source of truth for privacy features. Tags are searchable metadata, not a security boundary.

When `Hide detected NSFW assets` is enabled, a detection locks the asset (see [Locked](./locked.md)): it is hidden from library views such as the timeline, search results, albums, album thumbnails and counts, maps, shared-link payloads, downloads, and direct asset access unless the current session has been unlocked with the PIN, and it is listed in Locked.

Sync streams apply the same private NSFW filter to asset payloads, album asset payloads, album-to-asset relations, exif, edit, face, memory, partner, and stack payloads, album thumbnails, person face thumbnails, and generic asset metadata. Private `ml-enrichment` metadata is never exposed through generic asset metadata sync.

People views apply the private NSFW filter to visible faces. A person who only appears in private NSFW assets is hidden from non-elevated sessions. If a person also appears in non-NSFW assets, the person can still be returned, but person statistics count only non-NSFW assets and the person thumbnail endpoint will not serve a thumbnail generated from a private NSFW feature face.

Derived data surfaces apply the same private NSFW filter. Duplicate groups are hidden unless at least two non-NSFW assets remain visible, memory cards are hidden when all linked assets are private NSFW, stack APIs omit private NSFW child assets and deny stacks whose primary asset is private NSFW, and album activity/comment statistics exclude private NSFW asset activity.

Album membership is preserved; hiding only changes what is returned to a non-elevated session. Sync clients should treat hidden assets as privacy-filtered results, not album membership removals.

Locked-folder behavior is session based. Unlocking the locked folder elevates the current session so flagged NSFW assets can be returned again; logging out or using another session requires unlocking again.

## Running Both Jobs

If both settings are enabled, Frameleaf runs NSFW detection first and passes the result into the description and tag prompt. This allows the generated description and tags to remain factual while including visible NSFW reasons when they are supported.

To process existing libraries, go to `Administration > Jobs` and run the `All` action for the specific enrichment task you want to backfill. Use `NSFW Detection` first if you want classifier results available before description/tag generation, then run `Image descriptions and tags`. The legacy `Image Enrichment` queue command still queues every enabled enrichment task for API compatibility, but the admin Jobs page exposes the two backfills separately.

Backfills skip images that already have a successful result for the selected task unless the job is forced. A forced run recalculates the selected task, but visible descriptions and tags are still protected by stored applied hashes so generated metadata is not appended repeatedly.

Single-asset jobs also re-check eligibility before calling machine learning. If an asset is deleted, trashed, hidden, missing a preview, or no longer an image, the job is skipped or failed without applying metadata.

## Visible Metadata

Descriptions and tags are applied after the private model result is stored:

- Descriptions are appended to the existing description as an `AI description:` block.
- Existing user text is never overwritten.
- Tags are normalized to lowercase searchable values.
- NSFW images receive `nsfw` plus classifier-supported reason tags when visible evidence supports them.
- Sidecar write jobs are queued after visible metadata changes.

## Hardware and Model Notes

NSFW detection is an ONNX Runtime task. It can use CUDA in the CUDA machine-learning image and OpenVINO in the OpenVINO machine-learning image.

Description and tag generation has two hardware profiles in the admin machine-learning settings:

- `Intel iGPU (OpenVINO)` uses OpenVINO GenAI and maps the admin-facing `Qwen/Qwen2.5-VL-3B-Instruct` setting to the OpenVINO-converted `llmware/qwen2.5-vl-3b-ov` model.
- `NVIDIA GPU (CUDA)` uses Transformers/PyTorch with the CUDA machine-learning image.

The admin UI provides a **curated dropdown** of image-description models. Each entry lists an estimated VRAM footprint so you can match it to your hardware. The dropdown also offers a **Custom…** sentinel that reveals a free-text input for any Hugging Face model ID (use with caution — only the families listed below are loadable).

| Model (admin dropdown label)       | VRAM (FP16) | Recommended hardware                           | Notes                                                                                                           |
| ---------------------------------- | ----------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Qwen2.5-VL 3B (default)            | ~6 GB       | 24 GB GPU (RTX A4000/A5000) or Intel iGPU      | Solid for object/scene recognition. The default; resolves to `llmware/qwen2.5-vl-3b-ov` on OpenVINO.            |
| Qwen2.5-VL 7B (balanced)           | ~16 GB      | 24 GB GPU                                      | Better at composition, text in images, and nuanced scenes. Resolves to `llmware/qwen2.5-vl-7b-ov` on OpenVINO.  |
| Qwen2.5-VL 32B (quality)           | ~64 GB      | 80 GB GPU (A100 / L40S)                        | Excellent at complex scenes, fine details, cultural context. CUDA only (no OpenVINO alias).                     |
| Qwen2.5-VL 72B (top tier)          | ~144 GB     | Multi-GPU (2× A100 80 GB or 1× H100 80 GB AWQ) | Best quality in the 2.5 family. CUDA only.                                                                      |
| Qwen3-VL 30B-A3B (MoE)             | ~60 GB      | 80 GB GPU                                      | Mixture-of-experts; only ~3B params active per token, so it runs near 7B speed. CUDA only.                      |
| _(legacy)_ Phi-3.5-vision-instruct | ~5 GB       | Intel iGPU                                     | Smaller alternative on OpenVINO; resolves to `OpenVINO/Phi-3.5-vision-instruct-int4-ov`.                        |
| _(legacy)_ Phi-3-vision-128k       | ~5 GB       | Intel iGPU                                     | Older Phi build, smaller still.                                                                                 |
| Florence-2-base-ft _(fallback)_    | ~1 GB       | Any CUDA box (local fallback only)             | Caption-only; not a chat-style VLM. Used only as fallback for local URLs — see "Fallback model behavior" below. |
| Florence-2-large-ft _(fallback)_   | ~3 GB       | Any CUDA box (local fallback only)             | Same caveat as base-ft.                                                                                         |

Only the **Qwen2.5-VL**, **Qwen3-VL**, **Phi-3/3.5-vision**, and **Florence-2** families are loadable on the CUDA path. Other Hugging Face model IDs pasted into the **Custom…** field will fail at load time with `Failed to load model 'X'` in the worker logs.

On OpenVINO, the 3B/7B Qwen entries resolve transparently to pre-quantized int4 builds (`llmware/qwen2.5-vl-Nb-ov`). The 32B, 72B, and Qwen3-VL 30B-A3B entries are CUDA only — there is no OpenVINO alias.

The same description models, with Florence-2 base and large, are the white and green stops of the descriptions slider in **Where each job runs**. The slider colours each one by the last Hardware & GPU check and changes the same description model setting, saved with the settings bar. A model the machine-learning container doesn't have yet downloads the first time a job uses it. See [Hardware acceleration → Model licences](/features/ml-hardware-acceleration#model-licences).

### Fallback model behavior

The dropdown also exposes a **fallback model** field. Florence-2 is the typical choice for local CUDA setups, since it's small enough to fit alongside other models on the same GPU.

For local URLs, if the primary model fails (HTTP 5xx), Frameleaf retries the same request with the fallback model name. Local Florence-2 then takes the call.

For Intel iGPU deployments, use the OpenVINO machine-learning image/extra and keep the description device at `AUTO` unless you need to pin it. `AUTO` lets OpenVINO choose the best available device and fall back when the GPU is unavailable.

For NVIDIA deployments, use the CUDA machine-learning image/extra and select the NVIDIA hardware profile. `AUTO` uses the first available CUDA device for description/tag generation, while ONNX Runtime continues to use `CUDAExecutionProvider` for Smart Search, facial recognition, OCR, duplicate detection, and NSFW detection.
