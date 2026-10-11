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
[florence-models.json](immich_ml/models/florence-models.json) pins their immutable
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
credentials. The default source serves `frameleaf/Florence-2-<variant>`; an
administrator explicitly selecting `https://huggingface.co` uses the corresponding
`florence-community` repository. A mirror must publish those exact bytes and
revisions before offering these presets; there is no fallback to another host.
The checked-in manifest is the application trust root. Hosted manifest signing
and mirror publication remain separate release checks.

Caches live under `<existing model cache>/<revision>` so an older unpinned snapshot
cannot bypass verification. Both cached `download()` and native load verify the
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
