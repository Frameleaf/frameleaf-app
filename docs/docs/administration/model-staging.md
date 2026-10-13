# Staging models for local inference

Use the release's `docker-compose.ml-isolated.yml` overlay to separate model acquisition from local inference. It requires Compose with `!override`/`!reset` support and Docker's bridge `isolated` gateway mode. Validate it on the target host before starting the worker; unsupported options must fail rather than be removed. On NAS systems without that driver mode, use an equivalent host firewall and qualify the denied connections before treating inference as isolated. The ordinary online and remote-worker installations remain available.

The inference container joins only `ml-inference`, shared with `frameleaf-server`. The network is internal and has no host bridge address. The server also keeps its usual network for database, backup and administrator-consented cloud services. The downloader runs separately on `ml-downloads`, never joins the inference network, never receives images, and mounts only the model cache. Inference mounts that cache read-only, disables downloads, and verifies the acquisition receipt before loading. Accelerator compilation and tuning caches use temporary storage keyed by the staged file hashes, including external weights. Model-specific pinned manifests establish artifact origin; the receipt detects subsequent changes and is not a signature or a replacement for those manifests. Telemetry suppression still runs before model imports in both processes.

## Set up and acquire

Keep the existing Compose project name and cache. Move only ML runtime variables from the server `.env` to `.env.ml`, including preloads, device/thread settings, ML authentication and explicit custom-model trust decisions. Put only model-source settings and an intentional private-source token in `model-staging.env`. Do not put backup, database, cloud provisioning credentials or media paths in either file. Both files are optional when using defaults.

For the rootless Compose file, set `FRAMELEAF_ML_CACHE=./ml-model-cache` in `.env` and add `user: "1000:1000"` to the staging service in a local override; its UID must match the existing cache owner. For any custom cache, set `FRAMELEAF_ML_CACHE` to the existing `/cache` volume or host path; declare custom named volumes in your local override. Preserve required hardware device/library mounts. Set the staging service's `image` in a local override to the exact same release/hardware variant as inference (for example `frameleaf-vX.Y.Z-N-cuda`); use `--format armnn` to stage ARMNN artifacts without that hardware. RKNN staging requires the matching runtime and detected SoC so it can verify the SoC-specific model path. No image downgrade or volume migration is required.

Examples below run from the installation directory and use the regular release Compose file. Substitute the rootless file when applicable. Stop inference before acquisition, refresh or rollback; this prevents it seeing the brief directory swap and avoids changing files used by an active model. Other server services can keep running.

```sh
docker compose -f docker-compose.yml -f docker-compose.ml-isolated.yml config
docker compose -f docker-compose.yml -f docker-compose.ml-isolated.yml stop frameleaf-machine-learning
docker compose -f docker-compose.yml -f docker-compose.ml-isolated.yml run --rm frameleaf-model-staging --task image-description-tagging --type visual --model microsoft/Florence-2-base-ft --options '{"acceleration":"cuda"}'
docker compose -f docker-compose.yml -f docker-compose.ml-isolated.yml up -d frameleaf-machine-learning
```

Stage each configured task and model, including fallback models. Use the task's existing options, especially image-description acceleration. Description caches use the exact resolved repository identity and backend, with built-in artifacts in an immutable revision subdirectory. Existing legacy description directories remain preserved and need one-time restaging. Staging calls acquisition and verification only, without loading a model, custom repository Python or processing media. Existing built-in Florence allowlists, immutable revisions, hashes and attribution are preserved. If a chosen mirror does not serve the pinned files, acquisition fails; it never falls back to another source. For private/custom repositories, use an exact worker-side trust decision where required; inference API selection alone does not grant trust.

| Task                        | Types                      | Example model                              |
| --------------------------- | -------------------------- | ------------------------------------------ |
| `clip`                      | `visual`, `textual`        | `ViT-B-16-SigLIP-384__webli`               |
| `facial-recognition`        | `detection`, `recognition` | `buffalo_l`                                |
| `ocr`                       | `detection`, `recognition` | `PP-OCRv5_mobile`                          |
| `image-description-tagging` | `visual`                   | `microsoft/Florence-2-base-ft`             |
| `nsfw-detection`            | `classification`           | `onnx-community/nsfw_image_detection-ONNX` |
| `inpaint`                   | `visual`                   | `frameleaf-inpaint`                        |
| `transcribe`                | `audio`                    | `frameleaf-transcribe`                     |

Stage both types where a task has two. The transcription alias chooses the staging machine's runtime/device unless `MACHINE_LEARNING_TRANSCRIPTION_MODEL` names the same concrete model configured for inference. Semantic masks retain their separate pinned provisioning command: run the staging service with `--entrypoint python` and command `scripts/provision-semantic-models.py --download`; it verifies the Florence/SAM manifests without inference. Restoration remains a separate worker and model-provisioning workflow.

Warm verified caches work without an internet connection. Staging an old cache reacquires and verifies its artifacts; the original unverified directory is retained as a sibling ending in `.unverified` and is never automatically removed or used for rollback. Missing or changed files produce an actionable error, and offline inference does not clear a failed cache. To fetch an update, rerun acquisition with `--refresh`; a failed download or verification retains the active cache. A successful replacement retains one previous staged copy. Rerun with `--rollback` to swap it back, using the same task/model/options. A changed pinned revision uses a different directory: retain the previous matching release and cache for recovery. This does not roll back the application database.

## Credentials and metadata

Public downloads explicitly suppress `HF_TOKEN` and saved Hugging Face logins, including image-description and NSFW model downloads. An intentional private model source requires `MACHINE_LEARNING_MODEL_SOURCE_URL` and `MACHINE_LEARNING_MODEL_SOURCE_TOKEN` in the staging environment. That token is limited to the source's exact HTTPS scheme, hostname and port and is removed from cross-origin redirects, direct CDN requests and resumed range requests. A private Hugging Face source uses `https://huggingface.co` explicitly. Existing `HF_ENDPOINT` mirrors continue to work. Tokens are not printed by configuration or staging receipts.

The acquisition host, its CDN, DNS resolver and network intermediaries can observe ordinary download metadata: source IP, requested repository/revision/file, timing, byte ranges, TLS/HTTP metadata and the fixed model-download user agent. A deliberately configured private source receives its token. No telemetry event or photo/description payload is part of acquisition. Offline flags support local loading; Docker's network isolation enforces the connection boundary even for code that ignores those flags.

Administrator-configured remote ML still receives image previews as configured, and the standalone online worker can still acquire models. Apply equivalent isolation and staging on that worker's own host when desired. Managed cloud AI requires its separate administrator consent and processing destination; this overlay neither enables it nor changes its routing.

## Qualify the host

Inspect the resolved Compose configuration and running containers. Inference must have only the isolated ML network, no published port, no media/backup/secret/socket mounts and no provisioning environment variables. Acquisition must have only its download network and model-cache mount. Verify the expected Frameleaf peer works, and that direct internet, other containers and host services cannot be reached, including IPv6 where enabled. The [Docker gateway-mode documentation](https://docs.docker.com/engine/network/port-publishing/#gateway-modes) explains why `internal` alone does not exclude host services.

Then exercise the actual staged models and device: detailed caption, OCR, detections and every enabled local task, followed by offline restart and an update/rollback rehearsal. Synthetic tests prove their tested boundary and transaction behavior; they do not qualify a NAS filesystem, GPU driver, mirror publication or model output quality. Retain those runtime receipts with the exact image digest and network configuration.
