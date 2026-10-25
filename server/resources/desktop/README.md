# Native model catalogue

This release-owned catalogue pins Frameleaf's default `ViT-B-16-SigLIP-384__webli` model for image encoding and text requests with empty options or `language: en`. All three profiles produce 768-dimensional embeddings. Other models, configurations, providers or runtime source revisions remain unsupported until separately approved; selection never replaces a configured model.

The catalogue includes complete staged artifact hashes/sizes, the immutable model snapshot revision, preprocessing identity, project-generated text/PNG fixtures, CPU reference outputs and conservative memory floors. Text profiles share the larger measured text floor (1.75 GiB); the visual floor is 1 GiB. These are initial admission floors, not maximum memory guarantees or performance claims. Raw hardware receipts remain outside source control.

References were generated and passed through the production native qualifier using the signed private CPU runtime at source `fc1a63223ccfe43f5f9d8dd4e27c9d977f5c9176`. Each client must complete fresh qualification for its runtime, provider and device. Current reference evidence is macOS CPU; installed Windows/Linux and GPU acceptance remain required.

The desktop compiles an identical copy at `runtime/model-catalogue.json`. TypeScript and Rust tests assert identical canonical challenge digests: a fresh server UUID changes only the fixture filename and raw-spec binding. Catalogue parsing and challenge construction do not issue worker grants or change routes. Durable challenge state, authorization/revocation checks, result admission and the automatic worker loop remain separate required integrations.

To requalify a profile, decode its `fixtureBase64` into `spec.fixtureFile`, write `spec` as UTF-8 JSON, and run the existing `frameleaf_ml.native_qualification` entrypoint with that spec and a cache matching every approved artifact. Retain successful reports privately before changing reference outputs, memory floors, snapshot revisions or runtime bindings.

Epoch 13 preserves all earlier CPU, CoreML, CUDA and OpenVINO bindings and adds CPU/CoreML profiles for source `1bf2ad55521c49f574cba2f450eb13d49652ea80`, with preprocessing identity `83bb75f1a5966ece214ae39221fb2b9eaa90aa53d724a2b8d0c56a6fc7681d5c`. All five canonical fixture cases passed on macOS ARM64 CPU and CoreML using the packaged runtime; CoreML recorded physical GPU execution for every model. Fixtures, expected outputs and tolerances are unchanged. These are local qualification results, not installed acceptance or a speed claim. The new CLIP keys have their own explicit producer space; existing vectors and producer spaces are not relabelled. Image workload defaults remain pinned to their existing producer keys until their server and worker integration is qualified.

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
