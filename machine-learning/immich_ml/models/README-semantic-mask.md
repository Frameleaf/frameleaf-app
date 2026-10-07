# Local semantic mask engine

The `semantic-mask` visual task serves the fixed `frameleaf-florence2-sam2.1` model name through the
existing local ML `/predict` protocol. It generates subject/sky Florence-2 box proposals and refines
those boxes with SAM2.1. Returned PNGs are grayscale, cover the supplied unrotated active-sensor
canvas and carry `coordinates: sensor-active`. The server validates dimensions and stores them via
its existing owner-bound mask artifact admission. No media enters Frameleaf Cloud routing.

`semantic-mask-models.json` pins every native Transformers configuration/tokenizer file by its source
Git blob address, and every safetensors weight by SHA256. It records Florence's MIT and SAM's
Apache-2.0 model-card license metadata. The native Transformers Florence conversion is the checkpoint
linked by the [official Florence-2 documentation](https://huggingface.co/docs/transformers/model_doc/florence2),
not remote Python from Microsoft's older custom-code checkpoint. SAM uses the
[official SAM2 native loader](https://huggingface.co/docs/transformers/model_doc/sam2) and
[Meta checkpoint](https://huggingface.co/facebook/sam2.1-hiera-small).

Inference loads only pre-provisioned snapshots from
`$MACHINE_LEARNING_CACHE_FOLDER/semantic-mask/frameleaf-florence2-sam2.1/hub` (normally
`/cache/semantic-mask/frameleaf-florence2-sam2.1/hub`). An administrator can provision the two pinned
repositories/revisions with the existing Hugging Face snapshot_download utility and the manifest's
file list, then verify them with `semantic_mask_manifest.verify_snapshot`. The inference loader uses
`local_files_only=True`, `trust_remote_code=False`, `use_safetensors=True`, and checks every pinned
file before loading. It never downloads weights during a media request or executes model repository
Python/pickle. Missing or tampered weights produce a model-unavailable error. Existing Torch and
Transformers dependencies are used; no new package is introduced.

Source verification is a trust-boundary audit, not independent model safety, licensing clearance or
rendered quality qualification. The source packet has no ML runtime/weights on its host. Launch still
requires actual offline CPU inference against both exact snapshots, representative subject/sky edge
quality and no-proposal behavior, peak memory/time, optional CUDA and server architectures, painted
refinement and native crop/rotation/lens alignment, and egress-denied inference proof. The bounded
box/hash tests are stdlib tests that can run without loading the ML runtime.

## Standard CPU image and explicit provisioning

The standard `DEVICE=cpu` image now includes frozen Torch 2.5.1, Torchvision 0.20.1 and Transformers
5.16.1. Linux amd64 uses the explicit [official CPU wheel index](https://download.pytorch.org/whl/cpu);
arm64 uses the already supported PyPI CPU wheel. The existing CUDA extra retains its own wheel choice;
CPU/CUDA extras conflict explicitly, following [uv's accelerator selection](https://docs.astral.sh/uv/guides/integration/pytorch/).
CPU builder/runtime use the repository's already digest-pinned Python 3.12 slim image, matching Torch's
wheel ABI. OpenVINO/ArmNN retain their previous Python 3.13 bases; ROCm/RKNN/CUDA bases are unchanged.
The existing pinned uv 0.8.15 consumes the refreshed frozen lock. No package or weights were installed
locally. The image build runs `verify-semantic-runtime.py` for CPU/CUDA: native class imports, exact
runtime versions, Torch/NumPy interchange and CPU wheel isolation, without loading checkpoints.

On an explicit build/provision host, from repository root:

```sh
docker buildx build --platform linux/amd64 --load --build-arg DEVICE=cpu -f machine-learning/Dockerfile -t frameleaf-machine-learning:raw-development machine-learning
docker buildx build --platform linux/arm64 --load --build-arg DEVICE=cpu -f machine-learning/Dockerfile -t frameleaf-machine-learning:raw-development-arm64 machine-learning
# MODEL_CACHE_VOLUME identifies the existing deployment's model-cache volume.
docker run --rm --entrypoint python -v "$MODEL_CACHE_VOLUME:/cache" \
  frameleaf-machine-learning:raw-development scripts/provision-semantic-models.py --download
docker run --rm --network none --entrypoint python -v "$MODEL_CACHE_VOLUME:/cache" \
  frameleaf-machine-learning:raw-development scripts/provision-semantic-models.py
```

The first provisioning invocation is an explicit administrator-only network download of the exact
manifest files. It does not accept media or unpinned repository revisions. Omitting `--download` verifies
locally and sets Hub offline mode. A fully verified receipt is written beside the hub cache; inference
independently rechecks every content hash. Rootless installations can substitute their existing cache
bind mount and numeric user. Use the same owned volume for worker inference. Neither image builds nor
media requests provision weights. There is no Cloud/media fallback.

For automated real-model qualification, mount consented annotated fixtures plus a separate output
folder. The truth PNGs must match an unrotated sensor-canvas image of at most 2048 pixels per edge:

```sh
docker run --rm --network none --entrypoint timeout \
  -v "$MODEL_CACHE_VOLUME:/cache:ro" -v "$MASK_FIXTURES:/fixtures:ro" -v "$MASK_RESULTS:/results" \
  frameleaf-machine-learning:raw-development 300 python scripts/qualify-semantic-models.py \
  /fixtures/sensor-canvas.jpg --subject-truth /fixtures/subject.png --sky-truth /fixtures/sky.png --output /results
```

This loads the real manifest-verified models, additionally refuses socket connections, requires
nonempty shape-aligned `sensor-active` PNGs, checks annotated IoU >=0.75 and each cold/warm proposal's
120-second server deadline, and records mask PNGs, model revisions, timings and peak RSS. Run on both
CPU architectures; optional CUDA uses the existing `DEVICE=cuda` build and `--device cuda` qualification.
After CUDA qualification, set `MACHINE_LEARNING_SEMANTIC_MASK_DEVICE=auto` on that local ML worker
and restart it. Application requests leave device selection to the worker: `auto` uses CUDA when
Torch reports it available and falls back to CPU otherwise. The default remains `cpu`; `cuda`
requires CUDA and fails visibly when it is unavailable. The explicit `--device cuda` qualification
therefore cannot silently pass on CPU. Model loading or inference failures (including GPU memory
exhaustion) remain errors, rather than being retried on another destination. No models are downloaded.
The gate fails visibly for absent/tampered models, unsupported imports/ABI, no proposals, poor fixture
IoU, timeout or egress attempts. A passed fixture cannot establish general subject/sky/thin-edge quality;
representative photographer, native transform/refinement, failure/retry and resource qualification
remain required. None of these image/model execution commands were run in this source packet.
