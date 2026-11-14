# Native model catalogue

This release-owned catalogue pins Frameleaf's default `ViT-B-16-SigLIP-384__webli` model for image encoding and text requests with empty options or `language: en`. All three profiles produce 768-dimensional embeddings. Other models, configurations, providers or runtime source revisions remain unsupported until separately approved; selection never replaces a configured model.

The catalogue includes complete staged artifact hashes/sizes, the immutable model snapshot revision, preprocessing identity, project-generated text/PNG fixtures, CPU reference outputs and conservative memory floors. Text profiles share the larger measured text floor (1.75 GiB); the visual floor is 1 GiB. These are initial admission floors, not maximum memory guarantees or performance claims. Raw hardware receipts remain outside source control.

References were generated and passed through the production native qualifier using the signed private CPU runtime at source `fc1a63223ccfe43f5f9d8dd4e27c9d977f5c9176`. Each client must complete fresh qualification for its runtime, provider and device. Current reference evidence is macOS CPU; installed Windows/Linux and GPU acceptance remain required.

The desktop compiles an identical copy at `runtime/model-catalogue.json`. TypeScript and Rust tests assert identical canonical challenge digests: a fresh NAS UUID changes only the fixture filename and raw-spec binding. Catalogue parsing and challenge construction do not issue worker grants or change routes. Durable challenge state, authorization/revocation checks, result admission and the automatic worker loop remain separate required integrations.

To requalify a profile, decode its `fixtureBase64` into `spec.fixtureFile`, write `spec` as UTF-8 JSON, and run the existing `immich_ml.native_qualification` entrypoint with that spec and a cache matching every approved artifact. Retain successful reports privately before changing reference outputs, memory floors, snapshot revisions or runtime bindings.

## Epoch 13: every selectable model a desktop runtime can run

Epoch 13 appends profiles for the other models the server's settings offer and the native qualifier supports: `ViT-B-32__openai` and `ViT-SO400M-16-SigLIP2-384__webli` (smart search, each with its image and both text profiles and its own space in `model-spaces.json` epoch 7), `antelopev2`, `buffalo_s` and `buffalo_m` (faces) and `PP-OCRv5_server` (text recognition). Each is qualified on CPU for the factory desktop runtime `25b22c16` and for `f2c451a6`, with CoreML, CUDA and OpenVINO twins of the `f2c451a6` profiles. The fixtures and request options are those of the existing profile of the same workload. Memory floors are the larger of that workload's existing floor and the measured peak resident memory plus 25%, rounded up to a quarter GiB (SigLIP2 SO400M: 4.25 GiB image, 2.75 GiB text). `desktopImageModelKeys` names the released `f2c451a6` face and OCR key of each model; the earlier runtimes still serve only smart search.

The `ViT-B-32__openai` image profile and the `antelopev2` profile have the model keys of their Cloud pins below, so they replace those pins without changing stored producer keys. `ViT-SO400M-16-SigLIP2-384__webli` is pinned at its upstream snapshot `immich-app/ViT-SO400M-16-SigLIP2-384__webli@19baa26af70bd3639ca0ca17d1560cb8056dd983`. The model mirror must serve that revision before a desktop can download it. Not qualified: the PP-OCRv5 language variants (their mirror repositories hold only the recognizer, while a desktop stages every file of a profile from one repository), PP-OCRv6 (no released runtime has its code), and photo descriptions and safety (the native qualifier covers search, faces and text only).

## Epoch 14: a runtime that verifies the model bytes it loads

Epoch 14 appends a twin of every `f2c451a6` profile (15 models on CPU, CoreML, CUDA and OpenVINO; 60 profiles) for runtime source `c2203495` (`c2203495fa2400e369604347557473d81f0b9b6b`, branch `aj/fl-1509-runtime-source`: `f2c451a6` plus three commits). Nothing before them changes. That source changes no file of the preprocessing identity, so every twin has the model key, files, fixture and reference output of its original and the stored producer keys stay the same.

What the source changes, in `sessions/ort.py`, `native_device.py`, `native_ort.py`, `native_hardware.py` and `native_qualification.py`:

- Under a device observer (CoreML) the model is read once, hashed, and the ONNX Runtime session is created from those bytes, so the digest in the device evidence is the digest of what ran and nothing is hashed around a run. External weights of an in-memory model would be resolved against the working directory (onnxruntime 1.31.0), so such a model, and one given custom session options, is loaded from its file and hashed around every run as before. The face recognizer's batch-axis copy stands for its approved model only after the two models are compared (same nodes and weights; only declared input and output shapes may differ).
- OpenVINO can qualify. It was always reported `native_device_execution_evidence_required` because only CUDA could qualify without a device collector. The runtime now states `openvinoDevices` among its facts where it has that provider, and a report needs one of OpenVINO's graphics devices (`GPU…`) there; on the processor or an NPU it stays incompatible. The server requires the same and accepts `onnxruntime-openvino` as the package that provides `ort`.
- CUDA and, on Windows, OpenVINO libraries are loaded from the wheels a desktop runtime carries (`onnxruntime.preload_dlls`, `add_openvino_libs_to_path`), since a desktop has no system installation of them.

Only the CoreML twins have been qualified on hardware (Apple Silicon). The CUDA and OpenVINO twins are unverified on NVIDIA and Intel hardware. Desktop builds no Windows OpenVINO runtime: `onnxruntime-openvino` 1.24.1 on Windows needs the OpenVINO 2025.4 libraries it was built with, the lock has only `openvino` 2026.4.1, and with those its provider library does not load (Windows error 127, seen in Desktop CI). The server's request-time checks (`binding.check`: staged files, preprocessing, runtime facts) still run before and after every prediction on every provider.

## Epoch 15: the runtime source that works on every provider

Epoch 15 re-points the 60 epoch 14 twins from runtime source `c2203495` to `a70fd7dc` (`a70fd7dcee16526cb913308e9ea9596489b24ff6`, the head of `aj/fl-1509-runtime-source`: `c2203495` plus three commits). No pack was ever built or signed from `c2203495`, so its profiles are not kept beside the new ones; everything before them is unchanged, and so are the model keys, fixtures and reference outputs (no file of the preprocessing identity changes).

What the three commits fix:

- Faces on CoreML. After CoreML shape specialization the face recognizer's batch-axis copy was not proven against its approved model again, so the session named the copy's digest and the device collector refused every run (fail closed, processor used). The proof is repeated.
- CUDA on Windows. `onnxruntime_providers_cuda.dll` of onnxruntime-gpu 1.29.0 imports `cudaKernelSetAttributeForDevice`, `cudaLibraryGetKernel`, `cudaLibraryLoadData` and `cudaLibraryUnload` from `cudart64_12.dll`, which `nvidia-cuda-runtime-cu12` 12.6.77 (the version the torch build pins) does not export: Windows error 127 at load. The same functions are missing on Linux, where the failure would only show when they are first called.
- OpenVINO on Windows. `onnxruntime_providers_openvino.dll` of onnxruntime-openvino 1.24.1 is built for OpenVINO 2025.4.1 and imports 40 functions that `openvino.dll` 2026.4.1 does not export.

- CUDA precision and silent failures. A native CUDA session now turns TF32 off (onnxruntime turns it on by default; on cards that have it, convolutions and matrix products keep 10 bits of mantissa, and native fixtures are compared with a float32 reference). A qualification that fails writes the cause to stderr and a `detail` into its refused report instead of leaving only a code. On an RTX 4090 the previous source qualified smart search on CUDA and failed faces and text recognition without saying why; whether TF32 was the cause is not yet confirmed on hardware.

`pyproject.toml` gains two extras for desktop runtime packs, `desktop-cuda` and `desktop-openvino`, which lock what each provider library was built against (CUDA runtime 12.9.79; on Windows `openvino` 2025.4.1, whose metadata is restated without its numpy cap because only its native libraries are used). No existing pin moves. `runtime-profiles.json` names those extras for `cuda-ort` and `openvino-ort`.

Checked from the import and export tables of the locked Windows files: with these versions every import of both provider libraries is satisfied. Not run on NVIDIA or Intel hardware.

## Epoch 16: a failed Windows qualification says why

Epoch 16 re-points the same 60 twins from runtime source `a70fd7dc` to `b3905b4a` (`b3905b4aebd22e48a1a3843c2831efcef543336e`, branch `aj/fl-1581-windows-qualification-profiles-source`: `a70fd7dc` plus one commit). No released desktop carries a pack built from `a70fd7dc`. Model keys, fixtures and reference outputs are unchanged (no file of the preprocessing identity changes).

What the commit fixes: ONNX Runtime opens a session's profile when it creates the session. Without a card the CUDA provider fails, ONNX Runtime retries on the processor, and the native policy refuses that session (`native_provider_not_loaded`) without closing it; the refusal kept the profile open while qualification removed its folder. Windows cannot delete an open file, so every such qualification reported `PermissionError` (WinError 32) instead of its reason. A refused session is now closed before the refusal is raised, every tracked profile is closed before the folder is removed (also after a failure), a sharing violation is waited out briefly, and a removal failure never replaces the error of a failed qualification. A qualification that passes was not affected: each profile is closed by `end_profiling()` before the folder goes, which is why processor qualification already passed on Windows.

## Cloud pins (`model-pins.json`)

A model Frameleaf Cloud may run for smart search or faces must be exactly the model this server would run (FL-455): the server compares the Cloud catalogue entry and every result with its release pin. A qualified profile above is that pin. A model the mirror serves but no signed runtime has qualified yet is pinned in `model-pins.json` instead: the same model name, snapshot revision, every model file with its size and SHA-256 (hashed from the bytes `models.frameleaf.cloud` serves), request entries, the current runtime's preprocessing identity and the producer model key, with no fixture or reference output. Epoch 1 pins `ViT-B-32__openai` (image encoder, 512 dimensions; the text tower is listed for the server) and `antelopev2` (512 dimensions). A pin only lets the Cloud identity guard match and ingest; it never issues a desktop challenge, and a catalogue profile for the same model comes first. To promote a pin, qualify the model as described above with the same preprocessing identity and append the profile; the model key, and so the stored producer keys, stay the same.

## GPU runtime profiles

`runtime-profiles.json` approves `cuda-ort` (`CUDAExecutionProvider`, the `cuda` extra, Windows and Linux x86_64) and `openvino-ort` (`OpenVINOExecutionProvider`, the `openvino` extra, Windows and Linux x86_64) next to `cpu-ort` and `coreml-ort`. Epoch 12 of the catalogue adds a CUDA and an OpenVINO twin of each current CPU profile (runtime `f2c451a6`), the way the CoreML twins were added: the same model, fixture and CPU reference output under the other provider, so a signed GPU runtime can be challenged and its report validated. An OpenVINO report is validated like a CUDA one (no device collector; mixed when nodes stay on the processor); CoreML keeps its signed-collector proof. A GPU qualification still requires a signed runtime built for that provider; none is claimed here.

The NAS release trust and runtime profile files match the desktop's public
release authority. Runtime attestation verifies the existing Ed25519 signature
over the exact decompressed manifest, then checks epoch, approved OS/architecture,
complete bounded inventory shape and exact catalogue source/provider identity.
The transport accepts at most 2 MiB of canonical gzip bytes and decompresses at
most 8 MiB. It carries no user files or release private keys.

A valid signature establishes factory release identity. It does not prove that
a computer executed that runtime, validate its qualification report, authorize
a model grant, or resolve legacy embedding-index compatibility. Session-bound
challenge/admission must perform those additional checks before issuing work.

Desktop qualification challenges are persisted with a NAS-generated nonce,
credential generation, exact approved profile/specification, factory runtime
identity and expiry. Issuance retries must keep the same profile/runtime binding.
Each device retains at most 16 current challenges, for at most ten minutes and
never beyond the worker credential's expiry. Rotation, revocation and photo
logout fence pending evidence.

Validated receipts bind provider execution, stable runtime facts, fixture/model/
preprocessing identity and inference deadline. The fingerprint encoder matches
Python's sorted ASCII-escaped JSON, including UTF-16 surrogates. Only the report
digest and runtime fingerprint are retained; database errors redact challenge
parameters. Recording a receipt does not grant model scope. Selected NAS model/
index authority, admission endpoints and automatic worker orchestration remain
required before inference can be enabled.

Signed qualification HTTP operations use the existing worker credential and
installation proof, over the exact UTF-8 payload string:

- POST `/desktop/worker/challenges`, operation `challenge`: request ID, compiled
  model key/provider/source and factory manifest envelope. The NAS verifies the
  signature and chooses a release-owned profile matching its current enabled
  model. It returns the nonce, exact spec/fixture, manifest binding and expiry.
- GET `/desktop/worker/challenges/:id`, operation `challenge:<id>`: recover the
  current credential's unexpired challenge and any recorded report digest.
- POST `/desktop/worker/challenges/:id/report`, operation
  `qualification:<id>`: validate and record the exact qualification report.
  An accepted acknowledgment means evidence was recorded; inference scope
  still requires separate admission and expiring model grants.

API arrival and edge forwarding preserve only the explicitly permitted desktop
proof header; the worker authentication layer validates it. Client-supplied
arrival claims continue to be stripped or rejected.

Worker sign-in replaces the session ID under the device lock and deletes prior qualification challenges. Ordinary token renewal preserves that session ID and existing leases. Reapproving the same model after a new sign-in cannot revive an earlier attempt or staged result; orphaned running attempts remain bounded by their existing lease deadline.

Validated challenge reports now persist a separate accepted-runtime qualification with a one-hour absolute lifetime. Token renewal neither replaces nor extends it. Fresh sign-in removes it; a new qualification for the same model replaces its UUID. Broker claims require current model scope plus live qualification matching the exact model/configuration/input kind. Every attempt and staged-result adoption stays bound to that UUID and cannot be revived by replacement evidence. Qualification storage alone still does not issue model scope or enable worker readiness; NAS model/index and routing admission remain separate.

`GET /api/desktop/worker/qualifications/:id` uses signed operation `accepted-qualification:<id>`. It returns only accepted identity/configuration/report digests and absolute times after rechecking current worker, selected profile and release epoch. It does not grant processing scope. Claims carry the exact `qualificationId` and `qualificationExpiresAt`; the native runtime binds these to its sealed local qualification before starting inference or fetching input.

The NAS ML service exposes `POST /predict-bound` for producer evidence. The server's `encodeBoundClip` sends the release-owned profile's exact entries, artifact digests and preprocessing identity to its explicitly selected endpoint, with existing authentication and authority rechecks. It accepts only the matching producer key and finite vectors with the expected dimensions. A bound refusal cannot fall back to `/predict`, another model or another destination. Existing `/predict` calls retain their behavior.

Bound prediction verifies current artifacts and preprocessing before and after inference, loads without downloading or clearing the model cache, and writes accelerator-derived files only into an owned temporary directory. Failed inference detaches retained exception frames before removing derived files. The initial contract permits one CLIP text/image model, at most 16 MiB input, 16 Mi pixels, and a 4 MiB result. Sessions currently reload per request; practical NAS performance and a protected immutable-session cache still need qualification.

Changing the producer implementation changes preprocessing identity. The existing signed CPU runtime and catalogue remain pinned to their independently qualified fc1a632 bytes; this endpoint does not qualify a replacement runtime or authorize model scope. A freshly signed runtime/catalogue, producer-pair/index admission, explicit pool/LAN authority and automatic orchestration remain required. Never relabel existing unknown vectors or reindex on sign-in.
