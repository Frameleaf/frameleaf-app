# Native model catalogue

This release-owned catalogue pins Frameleaf's default `ViT-B-16-SigLIP-384__webli` model for image encoding and text requests with empty options or `language: en`. All three profiles produce 768-dimensional embeddings. Other models, configurations, providers or runtime source revisions remain unsupported until separately approved; selection never replaces a configured model.

The catalogue includes complete staged artifact hashes/sizes, the immutable model snapshot revision, preprocessing identity, project-generated text/PNG fixtures, CPU reference outputs and conservative memory floors. Text profiles share the larger measured text floor (1.75 GiB); the visual floor is 1 GiB. These are initial admission floors, not maximum memory guarantees or performance claims. Raw hardware receipts remain outside source control.

References were generated and passed through the production native qualifier using the signed private CPU runtime at source `fc1a63223ccfe43f5f9d8dd4e27c9d977f5c9176`. Each client must complete fresh qualification for its runtime, provider and device. Current reference evidence is macOS CPU; installed Windows/Linux and GPU acceptance remain required.

The desktop compiles an identical copy at `runtime/model-catalogue.json`. TypeScript and Rust tests assert identical canonical challenge digests: a fresh NAS UUID changes only the fixture filename and raw-spec binding. Catalogue parsing and challenge construction do not issue worker grants or change routes. Durable challenge state, authorization/revocation checks, result admission and the automatic worker loop remain separate required integrations.

To requalify a profile, decode its `fixtureBase64` into `spec.fixtureFile`, write `spec` as UTF-8 JSON, and run the existing `immich_ml.native_qualification` entrypoint with that spec and a cache matching every approved artifact. Retain successful reports privately before changing reference outputs, memory floors, snapshot revisions or runtime bindings.

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
