# Frameleaf machine learning

- CLIP embeddings
- Facial recognition

## Privacy

Telemetry is hard-disabled at package initialization for every ML entry point. Deployment
variables cannot opt back into Hugging Face, ONNX Runtime, or OpenVINO reporting. Downloads
remain online and Transformers loads the downloaded files locally. See the
[fork telemetry policy](../docs/docs/features/fork-privacy-suite.md#telemetry-and-automatic-reporting)
for coverage, tests, and remaining functional network requests.

# Setup

This project uses [uv](https://docs.astral.sh/uv/getting-started/installation/), so be sure to install it first.
Running `uv sync --extra cpu` will install everything you need in an isolated virtual environment.
CUDA, ROCM and OpenVINO are supported as acceleration APIs. To use them, you can replace `--extra cpu` with either of `--extra cuda`, `--extra rocm` or `--extra openvino`. In the case of CUDA, a [compute capability](https://developer.nvidia.com/cuda-gpus) of 5.2 or higher is required.

To add or remove dependencies, you can use the commands `uv add $PACKAGE_NAME` and `uv remove $PACKAGE_NAME`, respectively.
Be sure to commit the `uv.lock` and `pyproject.toml` files with `uv lock` to reflect any changes in dependencies.

## Native desktop inference

The foreground sidecar starts with `python -m frameleaf_ml.native_runtime --cache-dir
<private-cache> --port <loopback-port> --provider CPUExecutionProvider`. Supply
`FRAMELEAF_ML_AUTH_TOKEN` through its environment as a random alphanumeric value of
at least 48 characters. Only authenticated `/ping` and library `/predict` requests
are accepted. Model acquisition is separate: stop inference before running
`python -m frameleaf_ml.staging` against the private cache. Runtime downloads are disabled.

Run qualification in a fresh process:

```sh
python -m frameleaf_ml.native_qualification --spec approved-fixture.json \
  --cache-dir private-cache --output qualification.json
```

`QualificationSpec` in `frameleaf_ml/native_qualification.py` defines the strict
versioned JSON contract. The supervisor must supply approved model artifact,
preprocessing and fixture hashes, expected production output, the selected provider,
a memory floor and a deadline. The report binds the exact spec bytes and runtime
fingerprint. Accept a report only after exit code zero and exact binding validation;
exit 1 refuses qualification, and exit 124 terminates an exceeded deadline.
The report alone never grants NAS model permission.

Qualification currently executes ONNX CLIP, face and OCR library pipelines.
Every selected model must execute; an empty face fixture cannot qualify an unrun
recognizer. Provider availability alone does not qualify acceleration. CPU execution
and CUDA graph execution are distinguished from mixed CUDA/CPU partitioning.
CoreML, OpenVINO and MIGraphX device execution still require additional qualification
and are reported incompatible. Native Python provider fallback is disabled.
Offline face batching writes a derived graph in private runtime storage and preserves
approved source weights. Torch enrichment qualification and desktop supervisor
integration remain pending.

# Image Enrichment Models

This fork adds two optional image enrichment tasks:

- Image descriptions and searchable tags
- NSFW detection

Image enrichment has hardware profiles for OpenVINO/iGPU and CUDA/NVIDIA deployments:

| Task | Default setting | Runtime note |
| --- | --- | --- |
| Image descriptions and tags | `Qwen/Qwen2.5-VL-3B-Instruct` | Uses OpenVINO GenAI for the Intel iGPU profile and Transformers/PyTorch for the NVIDIA CUDA profile. |
| OpenVINO internal mapping | `llmware/qwen2.5-vl-3b-ov` | The Intel iGPU profile maps the Qwen default to this OpenVINO-converted model. |
| Image description fallback | `microsoft/Florence-2-base-ft` | Lower-resource fallback for CUDA deployments through Transformers/PyTorch. |
| NSFW detection | `onnx-community/nsfw_image_detection-ONNX` | ONNX Runtime model. Uses CUDA when running the CUDA machine-learning image/extra and CUDA is available; uses OpenVINO when running the OpenVINO image/extra. |

## CUDA Model Notes

Existing ONNX tasks keep their NVIDIA support. The provider order still prefers `CUDAExecutionProvider` before `OpenVINOExecutionProvider` when the CUDA runtime is installed.

For CUDA deployments:

- Smart search, facial recognition, OCR, and NSFW detection can continue using their normal model settings.
- NSFW detection should use `onnx-community/nsfw_image_detection-ONNX`.
- Image descriptions and tags should use the NVIDIA CUDA hardware profile in the admin machine-learning settings.

| Use case | CUDA model setting | Backend |
| --- | --- | --- |
| Higher quality descriptions/tags | `Qwen/Qwen2.5-VL-3B-Instruct` | Transformers/PyTorch |
| Lower-resource fallback | `microsoft/Florence-2-base-ft` | Transformers/PyTorch |

### Florence artifacts and custom models

The four built-in settings `microsoft/Florence-2-base`, `-base-ft`, `-large` and
`-large-ft` retain their names. They load the corresponding native
`florence-community` checkpoints through the existing Hub-compatible model source.
[florence-models.json](frameleaf_ml/models/florence-models.json) pins their immutable
revisions and SHA-256 digests for every weight, tokenizer, processor, configuration
and model-card file. Native loading uses local files, safetensors and
`trust_remote_code=False`; no model-repository Python is downloaded or executed.
Caption, OCR and object-detection tasks remain available.

Florence needs the Torch/Transformers runtime from the CPU or CUDA extra. With
`acceleration=cuda`, `device=cpu` selects CPU explicitly, and an unavailable CUDA
device falls back to CPU. Built-ins always use the native Torch loader, including
when acceleration resolves to OpenVINO; the OpenVINO-only image needs a CPU/CUDA
runtime for Florence. Qwen and Phi retain their OpenVINO paths.

Model staging calls `download()` without importing model Python or loading weights.
Cold downloads request only the pinned files and revision, with no implicit Hub
credentials. With neither `MACHINE_LEARNING_MODEL_SOURCE_URL` nor `HF_ENDPOINT`
configured, this description path retains its public Hugging Face source, using
the corresponding pinned `florence-community` repository. An explicit model source
takes precedence over `HF_ENDPOINT`; either overrides that default. A configured
Hub-compatible mirror serves `frameleaf/Florence-2-<variant>`, while a configured
`https://huggingface.co` uses the native upstream repository. A mirror must publish
those exact bytes and revisions before offering these presets. A source failure
never falls back to another host. Download hosts see normal request metadata such
as IP address, model/file/revision paths and user agent; these downloads send no
photos or image descriptions. Inference reads the staged files locally.
The checked-in manifest is the application trust root. Hosted manifest signing
and mirror publication remain separate release checks.

Description caches are keyed by SHA-256 of the complete resolved repository name
under `<cache>/image-description-tagging/repositories/<repository hash>/<acceleration>`.
This prevents differently named repositories from sharing a cache or another model's
custom-code consent. Existing description caches remain on disk and must be downloaded
or staged again. A caller supplying an explicit `cache_dir` must provide a separate
destination for each repository and acceleration backend.

Built-in Florence snapshots add `<revision>` beneath that cache so an older unpinned
snapshot cannot bypass verification. Both cached `download()` and native load verify the
complete file set. A missing, modified or unexpected loader file, including Python,
stops loading with a verification error. The worker does not repair corrupt caches
or remove old caches automatically. Restage a complete reviewed revision to recover;
retain the previous revision when preparing an update or rollback. A warm verified
cache reloads offline. Staged inference caches should be mounted read-only so files
cannot change between verification and load.

Custom Florence repositories can still execute their own Python after a worker
administrator names each exact repository in
`MACHINE_LEARNING_IMAGE_DESCRIPTION__TRUSTED_CUSTOM_MODELS`, for example
`["my-org/Florence-2-custom"]`. This worker setting defaults to an empty list;
selecting a model through the server API does not grant code trust. Only approve
code you reviewed, and confine that worker's network and mounts before loading it.
Custom repositories are outside the built-in artifact guarantee. The Microsoft MIT
notice and native-conversion attribution remain in the model cards and
[third-party notices](../licenses/THIRD-PARTY-NOTICES.md).

In short: CUDA users can use NVIDIA acceleration for NSFW detection and for description/tag generation in this branch. Intel iGPU users should use the OpenVINO profile, which keeps the admin-facing Qwen model name but maps it internally to `llmware/qwen2.5-vl-3b-ov`.

# Load Testing

To measure inference throughput and latency, you can use [Locust](https://locust.io/) using the provided `locustfile.py`.
Locust works by querying the model endpoints and aggregating their statistics, meaning the app must be deployed.
You can change the models or adjust options like score thresholds through the Locust UI.

To get started, you can simply run `locust --web-host 127.0.0.1` and open `localhost:8089` in a browser to access the UI. See the [Locust documentation](https://docs.locust.io/en/stable/index.html) for more info on running Locust.

Note that in Locust's jargon, concurrency is measured in `users`, and each user runs one task at a time. To achieve a particular per-endpoint concurrency, multiply that number by the number of endpoints to be queried. For example, if there are 3 endpoints and you want each of them to receive 8 requests at a time, you should set the number of users to 24.

# Aesthetic head qualification

Run `python scripts/qualify-aesthetic-head.py HEAD.json FIXTURE.json` in the ML environment to evaluate a candidate before adding it to the model mirror. Use 500 or more held-out photos with human ratings and their current Library v1 aesthetic scores. Export only the approved numeric data for the qualification host.

The head and fixture both name the admitted `producerModelKey`. The head's `layers` list contains dense `weights` in input-by-output order and a `bias` array per layer, with ReLU between layers and one final logit. The fixture's `samples` list contains each photo's unique `id`, numeric `embedding`, `v1` score, and human `rating`. Keep training and evaluation photos separate. The script reports the Spearman improvement and content hashes and exits unsuccessfully below an improvement of 0.15.

## Shipped aesthetic heads (FL-978)

The server reads one head per visual search model from `server/resources/aesthetic-heads/<model>.json` and scores Library aesthetic version 2 as `sigmoid(head(embedding))` in Node. A model with no head keeps version 1 and the server logs that once. `scripts/build-aesthetic-head.py` built both heads on 2026-11-14:

1. `embed` ran the shipped `OpenClipVisualEncoder` on the CPU provider over files from the Frameleaf model mirror. The script resolves the producer key from the release catalogue by the visual ONNX SHA-256.
2. `train` fitted ridge regression (alpha from 5-fold cross-validation) to the mean human rating. It then calibrated the logit so the median training photo scores 0.5 and the top 2% score 0.96. About 2% of photos then clear the Best Photos threshold, as with version 1.
3. `fixture` joined the held-out embeddings and ratings with Library v1 aesthetic scores. The v1 scores came from the server's own `SharpOperations.measureImageQuality` and image-quality formula.

Ratings come from AVA (Murray et al., CVPR 2012): photography-challenge photos with at least 50 human votes each, from the stratified 10% subset `trojblue/AVA-aesthetics-10pct-min50-10bins`. Training used 10,219 photos from its train split. Evaluation used 1,500 photos from its separate test split, with no shared image IDs. AVA reflects the taste of one online photography community, so the score can undervalue some styles and cultures. Best Photos says so under its heading.

| Model | Producer key | Head SHA-256 | Spearman v1 → v2 (1,500 held out) |
| --- | --- | --- | --- |
| `ViT-B-16-SigLIP-384__webli` | `clip:723da31128e971640a42abb5301ca19adfe7a01248d90029e12e5325f492699d` | `34b3d58bd766eec3359a088e07d1fca85e2a4838575bb8d3589b7b5b8afed495` | 0.159 → 0.700 (+0.541) |
| `ViT-B-32__openai` | `clip:c4410149fb53f66b0eb32c730448d479117f74227628fe1ca0b98737f21c74e7` | `1d00114c25e6c8146eeb2352ab84091ec66ebb374a671ce1994ff63f29847d24` | 0.159 → 0.665 (+0.506) |

The SigLIP-384 fixture SHA-256 is `2cf4f62c92875d72fe663db8d9744a7005f50b15a98fdcb8b28a9029206bbec8`. The ViT-B-32 fixture SHA-256 is `ddc911d3e2c342715b300945344aee64ab82b6d8d43c247553aa1a65c56280f1`. Rerun the steps above to regenerate the fixtures; they are too large for the repository.

# Facial Recognition

## Acknowledgements

This project utilizes facial recognition models from the [InsightFace](https://github.com/deepinsight/insightface/tree/master/model_zoo) project. We appreciate the work put into developing these models, which have been beneficial to the machine learning part of this project.

### Used Models

- antelopev2
- buffalo_l
- buffalo_m
- buffalo_s

## License and Use Restrictions

We have received permission to use the InsightFace facial recognition models in our project, as granted via email by Jia Guo (guojia@insightface.ai) on 18th March 2023. However, it's important to note that this permission does not extend to the redistribution or commercial use of their models by third parties. Users and developers interested in using these models should review the licensing terms provided in the InsightFace GitHub repository.

For more information on the capabilities of the InsightFace models and to ensure compliance with their license, please refer to their [official repository](https://github.com/deepinsight/insightface). Adhering to the specified licensing terms is crucial for the respectful and lawful use of their work.
