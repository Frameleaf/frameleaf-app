# Frameleaf privacy suite

This page explains what is different in Frameleaf compared with the upstream project, and how to roll it out safely in a home lab.

Frameleaf independently maintains the privacy and image-enrichment features described here. Supported Immich installations are a frozen, read-only source for a one-time offline content import into a fresh Frameleaf database.

## Who Frameleaf is for

Use Frameleaf if you want it to help with one or more of these jobs:

- Generate searchable AI descriptions and tags for photos.
- Detect likely NSFW images and review the result before hiding anything.
- Hide sensitive content unless the current session is unlocked with the locked-folder PIN.
- Suppress selected tags or people, such as medical, legal, family, work, or private project content.
- Keep private content in albums without showing it during normal browsing.
- Reduce physical disk usage in family libraries when multiple users upload the exact same photos or videos.
- Run image-enrichment ML on common home-lab hardware, including Intel iGPU/OpenVINO and NVIDIA/CUDA setups.

Frameleaf is not a replacement for backups, access control, or careful human review. ML results can be wrong, and visible tags are search metadata, not a security boundary.

## What Changed

### Telemetry and Automatic Reporting

Telemetry is disabled in code and cannot be enabled through application settings or deployment
variables. This applies to every machine-learning image built from Frameleaf.

- Hugging Face reporting is disabled before importing ML libraries. Its direct telemetry sender
  is also blocked, including when the host imported the Hub first. Download headers use a
  fixed user agent without dependency versions, session IDs, model metadata, or deployment IDs.
- The native Xet downloader and its separate transfer telemetry are disabled. Model downloads
  use the Hub's standard HTTPS fallback, including for models stored in Xet.
- ONNX Runtime telemetry is disabled before inference, and its public enable function is blocked.
- OpenVINO telemetry always declines consent and cannot submit reports through its sender,
  including forced events, error reports, and reports about opting out. No user consent files
  are changed.
- Server OpenTelemetry dependencies, automatic instrumentation, exporters, metrics listeners,
  and user/job collectors are removed. Legacy telemetry environment variables have no effect.
- The version check is off by default. When an administrator turns it on, it asks only
  Frameleaf's release feed (`api.frameleaf.cloud`), falling back to Frameleaf's GitHub releases,
  and sends no instance identifier. Local version history and client/server compatibility information remain.
- Transformers loads downloaded model files locally. Required model downloads remain enabled;
  no global offline mode or network block is imposed.

Photo uploads, sharing, model downloads, configured remote ML, OAuth, email,
and map tiles remain functional. Nothing is fetched from upstream-hosted services. Where each download
comes from:

- Map styles and tiles: `tiles.frameleaf.cloud`.
- Landmark brand icons: one file from `static.frameleaf.cloud`, fetched when the server starts and does
  not have it yet. It is the whole set, the same for every server, so the request does not say which
  places you have photos of. Turning reverse geocoding off stops the download; landmarks then show a
  plain icon for their kind.
- Smart search, face recognition and text recognition (OCR) models (`frameleaf/<model>`): the model source, which is
  `MACHINE_LEARNING_MODEL_SOURCE_URL` if set, otherwise `HF_ENDPOINT` if set, otherwise
  `models.frameleaf.cloud`. A Hugging Face token is only ever sent to `huggingface.co`.
- Image descriptions (on by default) and NSFW detection (off by default): their models come
  straight from `huggingface.co`, or from `HF_ENDPOINT` if you set it. To keep these downloads off
  `huggingface.co`, point `HF_ENDPOINT` at your own mirror, or fill the model cache yourself and set
  `HF_HUB_OFFLINE=1` so nothing is downloaded. Turning the feature off also stops its download.

Download hosts necessarily receive the requested model/file,
network address, and any required download credentials. Configured remote inference providers
receive the images/prompts needed for that inference. These are functional requests, not usage
or library analytics.

Console logs, local job progress, and health checks remain available. The policy covers this
Frameleaf's application and bundled dependencies; it is not a network sandbox for administrator-added
plugins, arbitrary downloaded Python code, host agents, or the infrastructure provider.
Rebuild and redeploy both server and ML images to apply this policy.
If an older bundled Compose stack started Prometheus or Grafana, stop and remove those orphaned
containers when updating the stack; removing their service definitions does not stop an already
running container.

The ML regression tests exercise blocked reporting and an authenticated model download using
a mock HTTP transport. Run `uv run --extra cpu pytest test_privacy.py`; install the locked
`openvino-telemetry==2025.2.0` package in the test environment as well to exercise the optional
OpenVINO sender test without GPU hardware.

### Image Descriptions and Tags

Admins can enable an optional machine-learning job that looks at image previews and adds:

- an `AI description:` block to the asset description field;
- searchable tags based on visible objects, context, text, and scene details.

Existing user-written descriptions are preserved. Generated descriptions are appended once instead of replacing your own text.

### NSFW Detection

Admins can enable a separate NSFW detection job. The private classifier result is stored separately from visible tags, so privacy decisions are based on private enrichment metadata rather than the public `nsfw` tag.

Admins can review each result, rerun detection, mark an asset safe, mark an asset NSFW, or accept the classifier result.

### PIN-Gated Hiding

Sensitive marks, detections (when **Hide flagged photos until unlocked** is on) and items from an imported Locked folder are one lock per asset; see [Locked](./locked.md). Locked assets are hidden from normal browsing until the current session is unlocked with the PIN, and **Locked** lists them all.

Hidden assets are filtered from timelines, search, albums, map markers, downloads, shared-link payloads, sync streams, people, tags, memories, duplicate groups, stacks, and related derived views. Album membership is preserved; the asset is hidden from responses, not removed from the album.

### Suppressed Content

Users can choose tags and people to suppress from normal browsing. This is useful for content that is private but not necessarily NSFW, such as medical photos, legal documents, family situations, private projects, or anything else you tag intentionally.

Suppressed content uses the locked-folder PIN:

1. Locked session: normal views hide ML-detected NSFW content plus selected suppressed tags or people.
2. PIN-unlocked session: normal views can show that content again.
3. Suppressed-only view: `/suppressed` shows only hidden/suppressed content so you can review and organize it.

Suppressing a person is separate from hiding a person card. A suppressed person is used as a privacy browsing filter.

### Navigation Lock

The main navigation includes a lock/unlock control near Upload:

- Locked means sensitive content is hidden.
- Unlocking opens the existing locked-folder PIN flow.
- Unlocked means the current session can view sensitive content.
- Locking again drops elevated access and refreshes views so hidden content disappears.

### Mobile Actions

The Frameleaf iPhone and Android apps can mark your own items sensitive or safe again. Server-side filtering applies to every client.

### Universal Storage

Frameleaf automatically stores one physical copy of an exact file when several accounts upload the same photo or video. Each account keeps its own library record, albums, favorites, metadata, permissions and Locked state, and its quota is charged the full size. This is different from partner sharing: it shares no library ownership or visibility. See [Universal Storage](./physical-deduplication.md).

## Recommended Home-Lab Rollout

Start slowly. Do not enable automatic hiding until you have reviewed classifier behavior on your own library.

1. Make a backup and confirm your normal Frameleaf backup plan works. DO NOT SKIP THIS.
2. Deploy Frameleaf using Frameleaf's server, web, and machine-learning images or build outputs. Do not mix upstream containers with Frameleaf server or web code.
3. Create a fresh canonical PostgreSQL 19 database. If you have an existing library to import, follow the [offline import](../administration/import-immich.md), then open **Settings → Search & intelligence**.
4. On **Descriptions & tags**, under **Advanced: caption model and hardware**, choose the **Kind of graphics card** that matches your server:
   - **Automatic** for most users;
   - **Intel (OpenVINO)** for Intel integrated graphics;
   - **NVIDIA (CUDA)** for NVIDIA GPU hosts.
5. On **Locked-content detection**, turn on **Suggest photos to lock**.
6. Run the **Locked-content detection** queue for all items from **Settings → Computers & background work → Background work**.
7. Review results in the asset detail panel and tune the threshold if needed.
8. Turn on **Hide flagged photos until unlocked** only after results look acceptable.
9. Confirm **Write captions for photos** is on (it is by default) if you want AI descriptions and searchable generated tags.
10. Run the **Descriptions & tags** queue for all items from **Settings → Computers & background work → Background work**.
11. Create or confirm your PIN in **Settings → Access & security → Locked folder PIN**.
12. Use **Settings → Access & security → Locked tags & people** to add tags or people you want hidden from normal browsing.
13. Use `/suppressed` after PIN unlock to review and organize hidden/suppressed content.

## Suggested Model Settings

For most home-lab installs, start with the defaults selected by the hardware profile.

| Hardware            | Description and tag model                                                     | NSFW model                                 | Device |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ | ------ |
| Intel iGPU/OpenVINO | `Qwen/Qwen2.5-VL-3B-Instruct` mapped internally to `llmware/qwen2.5-vl-3b-ov` | `onnx-community/nsfw_image_detection-ONNX` | `AUTO` |
| NVIDIA/CUDA         | `Qwen/Qwen2.5-VL-3B-Instruct` through Transformers/PyTorch                    | `onnx-community/nsfw_image_detection-ONNX` | `AUTO` |

If Qwen has trouble on Intel iGPU/OpenVINO, try these description/tag fallbacks in order:

1. `CelesteImperia/MiniCPM-V-2.6-OpenVINO-INT4`
2. `OpenVINO/Qwen2.5-VL-7B-Instruct-int4-ov`
3. `microsoft/Phi-3.5-vision-instruct`

For CUDA/NVIDIA deployments, `microsoft/Florence-2-base-ft` is the lower-resource fallback model.

For NSFW discovery, prefer improving the dedicated NSFW classifier before relying on captions. A classifier with labels such as `porn`, `sexy`, and `hentai` is usually more direct than a general image description model.

## Safe Operating Notes

- Keep regular backups. Privacy filtering is not a backup strategy.
- Review ML results before enabling hiding.
- Use manual overrides when the classifier is wrong.
- Keep visible tags and private classifier state conceptually separate.
- Do not treat generated tags as a security boundary.
- Expect first backfills to take time on large libraries.
- Watch machine-learning container logs during early setup, especially when testing GPU acceleration.
- Keep Frameleaf updated with Frameleaf releases.

## More Detailed Docs

- [One-time offline Immich import](../administration/import-immich.md)
- [Image Enrichment](image-enrichment.md)
- [Hardware-Accelerated Machine Learning](ml-hardware-acceleration.md)
- [Universal Storage](physical-deduplication.md)
- [Administration: System Settings](../administration/system-settings.md)
- [Administration: Jobs and Workers](../administration/jobs-workers.md)
