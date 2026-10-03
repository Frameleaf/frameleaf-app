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
