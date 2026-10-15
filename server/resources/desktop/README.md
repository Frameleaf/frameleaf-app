# Native model catalogue

This release-owned catalogue pins Frameleaf's default `ViT-B-16-SigLIP-384__webli` model for image encoding and text requests with empty options or `language: en`. All three profiles produce 768-dimensional embeddings. Other models, configurations, providers or runtime source revisions remain unsupported until separately approved; selection never replaces a configured model.

The catalogue includes complete staged artifact hashes/sizes, the immutable model snapshot revision, preprocessing identity, project-generated text/PNG fixtures, CPU reference outputs and conservative memory floors. Text profiles share the larger measured text floor (1.75 GiB); the visual floor is 1 GiB. These are initial admission floors, not maximum memory guarantees or performance claims. Raw hardware receipts remain outside source control.

References were generated and passed through the production native qualifier using the signed private CPU runtime at source `fc1a63223ccfe43f5f9d8dd4e27c9d977f5c9176`. Each client must complete fresh qualification for its runtime, provider and device. Current reference evidence is macOS CPU; installed Windows/Linux and GPU acceptance remain required.

The desktop compiles an identical copy at `runtime/model-catalogue.json`. TypeScript and Rust tests assert identical canonical challenge digests: a fresh NAS UUID changes only the fixture filename and raw-spec binding. Catalogue parsing and challenge construction do not issue worker grants or change routes. Durable challenge state, authorization/revocation checks, result admission and the automatic worker loop remain separate required integrations.

To requalify a profile, decode its `fixtureBase64` into `spec.fixtureFile`, write `spec` as UTF-8 JSON, and run the existing `immich_ml.native_qualification` entrypoint with that spec and a cache matching every approved artifact. Retain successful reports privately before changing reference outputs, memory floors, snapshot revisions or runtime bindings.
