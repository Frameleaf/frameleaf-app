# Studio preservation contracts

This directory contains preservation metadata and an explicit isolated engine build. The source archive is recovered only by the preparation command below; the vendor snapshot and generated workspace are not committed. The production Studio host is present, but this build does not supply its engine adapter, deploy a rendering worker, qualify hardware or provide licensed Dolby tools. Locked npm packages may contain model, font and asset payloads; no separate weight acquisition is authorized by this build.

- `freecut-provenance.json` records the immutable upstream Freecut revision, exact archive URL and digest, MIT license, and 2,646 ordered source-file hashes.
- `freecut-feature-manifest.json` preserves 210 source-derived feature rows and a pinned contract for all 2,204 family-source references across ten categories. Every row remains explicitly not implemented in Frameleaf, not run, and unqualified for rendering.
- `dependency-attribution.json` records preliminary dependency and asset review obligations plus a pinned 51-row package name/version/license projection from the provenance-bound Freecut lockfile. It is not a completed legal or redistribution approval.

The provenance ledger was cross-checked against a temporary clean checkout of `walterlow/freecut@4d62e8082c5eb387a96275bcbd323d28f6e41a62`. The clean tree contained 2,646 files and matched every recorded path and SHA-256 digest. SHA-256 of the UTF-8 bytes of `JSON.stringify(files)` in recorded order is `a56d57c4bcd2c996c389bb7470216b185caa28de389def109bf4d86fd95e3adb`, covering every row whether or not a feature references it. The exact codeload URL is pinned, and its archive matched SHA-256 `b4224e5c219a6302586cbe2242e9e6d299dfd1878f1fcd0f2d77ea3db12a5d32`. This is source-identity evidence only, not execution or qualification evidence.

The engine tooling rejects duplicate keys in its contract JSON and verifies the pinned source identity.

## Local source preflight

The local source preflight (`node scripts/frameleaf-studio-preflight.mjs /absolute/path/to/local-plan.json`)
records decoded source presentation timestamps as ordered integer `timeline.pts` with their exact
`timeline.timeBase`; array position is the zero-based frame index. It refuses missing, duplicate,
backward or unsafe integer timestamps, invalid time bases and source decode/demux error diagnostics
(even with a successful process exit), preserving fractional and variable
cadence without rounding to seconds or guessing from frame rate. The existing 30-second and 1 MiB
probe limits bound this check to small specimens; exceeding either fails closed. These source
timestamps do not prove edited-output/XML/RPU correspondence. The overall Dolby `goNoGo` remains false.
Dolby configuration or RPU/metadata side data reported on the stream or any decoded frame is refused:
the generic HDR probe has no qualified Dolby decode/reshape path or explicit base-layer-only policy.
All video streams are inspected and the input must contain exactly one video stream; a separate
Dolby enhancement stream cannot be ignored by selecting only its HDR-compatible base.
Every decoded frame must also report 10-bit 4:2:0, the requested HDR transfer and BT.2020
primaries/matrix; missing or changed frame metadata is refused even when stream headers match.
Plain single-stream HDR10/HLG sources remain eligible; these refusals do not strip metadata or create an output.

`node --test scripts/frameleaf-studio-preflight.test.mjs` requires administrator-installed FFmpeg
and FFprobe with `libx265`. It checks two probes of tiny generated HEVC Main10 fractional/VFR
fixtures in CI; their HDR signalling only exercises preflight metadata checks and does not qualify
HDR pictures, Dolby decoding, float edits, licensed tools or device playback.

## Reproducible engine workspace

Use Node 24.21.0 and npm 11.8.0. `engine-build.json` pins the upstream revision, patch hashes, independent npm lockfile and adapted source digest. Versioned patches set the private package identity and toolchain declaration, remove automatic `prepare`, and omit embedded source text from worker source maps. Vite embeds transient asset handles in that text, which otherwise makes identical fresh builds differ. Worker maps retain their mappings, names and source paths; use the preserved source files for debugging. Application maps retain embedded sources. The first three patches preserve feature behavior. Patch 0004 adds default-deny resource admission in the isolated editor/headless engine; unresolved model/font/Lottie/resource operations are explicit release blockers. This npm workspace is intentionally outside the application's pnpm workspace.

```sh
# Explicit network step; alternatively provide --archive /path/to/freecut.tar.gz.
node studio/tools/engine.mjs prepare
npm --prefix studio/engine ci --ignore-scripts --no-audit --no-fund
npm --prefix studio/engine run test:run
npm --prefix studio/engine run headless:test:node
npm --prefix studio/engine run build
node studio/tools/engine.mjs attest
node studio/tools/feature-manifest.mjs --check
```

Preparation rejects an existing `studio/engine`; preserve any work before explicitly removing that generated directory. It never installs into `studio/vendor/freecut`, applies patches there, or rewrites an existing snapshot. The recovered archive must match its pinned digest and all 2,646 paths and hashes, with no extra files or symlinks. Vendored assistant instructions remain upstream data and are not Frameleaf authority.

Patch 0010 propagates expression dependency failures through scalar and vector references, so
cycles, invalid arithmetic and incompatible result types retain the referring property's authored
value and expose the original error in the inspector. The MIT notice in `notices/freecut.txt`
continues to cover the adapted source. Its regression fixtures exercise render and inspector
evaluation plus valid references; hosted execution remains required. This does not qualify the
full expression sandbox, graph-review admission, nested Compose or the other expression
conformance axes, which remain unqualified in `conformance.json`.

Patch 0017 preserves `embeddedAudioMuted` when expanding nested composition audio, so unlinking a video from its audio does not restore the original sound during export. Its regression checks the retained audio samples in both full and windowed mixes. Hosted execution and wider audio, recording and caption conformance remain unqualified.

Patch 0018 rejects paused scope captures completed after a newer playhead epoch, including seeking
away and back to the same frame, in GPU and CPU paths. Normal GPU playback sampling continues.
Scopes label their current display-referred sRGB/Rec.709 full-range preview input. Deferred-capture regressions run in the hosted engine suite;
worker-authoritative scope samples, graph revision correspondence, seeks during playback, HDR
scope ramps and browser qualification remain unqualified.

Patch 0019 binds in-flight scope captures to their renderer registrations and immutable visual
graph inputs. Same-frame source edits, keyframes, transitions and nested composition changes
invalidate old samples without treating playback ticks as graph changes. Hosted regressions cover
provider replacement and image-source edits while paused and during GPU playback, plus paused
CPU redraw after a nested composition edit and live transform edits with stable providers.
Captures wait for updated renderer registration when the renderer rebuilds its graph snapshot,
using its existing transform-change predicate to preserve direct transform sampling. This does not
qualify worker revision/frame provenance, live seeks, HDR scope ramps or browser conformance.

Patch 0021 makes zero-softness chroma keying a defined hard edge: pixels at or below
the tolerance are transparent. The shared effect shader serves preview and export.
The MIT notice in `notices/freecut.txt` covers this adaptation. The hosted
`tools/chroma-key.browser.mjs` regression reads canvas and float-texture output for
green/blue keys, hard/soft edges, source alpha, and animated spill suppression at
0, 0.5 and 1. It targets `effect.gpu-chroma-key` and
`readme.effects-masks-compositing.5`; exact-candidate hosted execution is required.
Full project preview/export, masks, effect-stack ordering, other browsers and
native application conformance remain unqualified in `conformance.json`.

Patch 0026 gives that hard edge a 2^-16 CbCr width. Metal contracted the pixel and
key conversions differently and measured an exact blue key about 1e-8 away, so the
key stayed opaque. One 10-bit code value moves CbCr by more than 3e-4, so real colors
next to the key stay opaque. `tools/chroma-key.browser.mjs` checks both cases for
green and blue keys; it passes on SwiftShader and Apple Metal.

Patch 0027 gives temporal effects a frame clock. Grain, scanlines, color and block
glitch, VHS, trigger wave and hue flow used to read `performance.now()`, so each
render of the same frame differed, and export never matched preview. Render paths
now stamp the item-relative time of the frame (frame / fps) into those effects'
params. Only callers with no timeline frame, such as panel thumbnails, fall back
to wall time. Transition participants and nested Compose items used to ignore
keyframed effect params and adjustment-layer keyframes. They now resolve both on
their own timelines, as top-level items already did. Unit tests cover the clock,
the resolver and the transition and nested render paths.

Patch 0022 gives each render or inspector expression a budget of 64 uncached evaluations,
including its root. The inspector forwards that budget and its reference cache through both
preview callbacks, so independent branches share the limit and cached reuse remains free.
Each unrelated rendered property starts a fresh budget. Exceeding the limit preserves the
authored value and reports `Expression dependency limit exceeded`. Scalar/vector fixtures
cover 64/65-expression boundaries, branching previews, cached reuse and a full transform's
independent x/y expressions. The existing parser source/token/nesting caps remain in force;
direct-link traversal, full sandbox escape coverage and complete FL-100 conformance remain
unqualified. Bundle review parses JSON and enumerates resource references without invoking
this render evaluator. Hosted execution of the new fixtures remains required.

Patch 0023 refuses unsupported embedded-subtitle and output-format combinations before new,
restored, retried or worker export jobs can render, including smart-copy attempts. The renderer
also checks output format for direct callers, while the export frame-rate ceiling stays at job
admission so internal high-frame-rate reverse previews can render. Hosted regressions cover these
boundaries; real codec output, subtitle playback and the full export matrix remain unqualified.

Patch 0024 makes the mixer's Master mute a project setting, preserved through saved timelines,
undo/redo, preview audio/video/skimming, queued/client export and headless rendering. Device
monitor volume and mute stay outside the project and export mix. Both original-byte smart copy
and audio-packet passthrough are refused for a muted master. Export preflight reads the same
selected-sequence master settings. Sequence history restores project mute only for commands
that changed it, and skim meters retain their pre-monitor signal on a silent device. Hosted regressions cover preview
silence, full/windowed export silence, monitor independence, history, persistence and legacy defaults.
These regressions have not yet run for this candidate; worker/browser/audio-output qualification
and the broader preview/layout/scope requirements remain open.

The engine's runtime resource policy is generated at `prepare` by `tools/resource-policy.mjs`
from `dependency-attribution.json` and the owner's approval in `rights-approval.json` (FL-146,
September 25, 2026; the server mirror is `scripts/frameleaf-studio-rights.mjs`). A resource is
admitted for local runtime only when the owner approved its exact reviewed row for that use and
did not withhold it; the admission carries the row digest, so a row changed after approval is
blocked again, and any id or URL outside the approved rows stays blocked. A reviewed row cannot
admit itself: `decisions` stay as the packager recorded them. A URL is admitted only inside an
approved locator, and a Hugging Face model only from the approved commit
(`/resolve/<revision>/`); when several rows cover a URL the most specific decides and any
blocked one blocks it, and encoded path separators are refused. Patch 0028 makes the engine
request every approved model, tokenizer and processor from that revision instead of `main`
(transformers.js loaders, Parakeet, RIFE and the MOSS model store), admits each Kokoro and
Supertonic voice as its own row before use, and admits the Whisper worker's transformers runtime
as well as its model. Loaders inside third-party bundles that take no revision (kokoro-js and
transformers.js pre-flight metadata) are covered by the admission module itself: in every window
and worker that imports it, a request for an approved repository at any other ref is sent to the
approved commit; the Kokoro voice files, whose rows name `main`, are therefore read from the
Kokoro model's approved commit. The Supertonic Space is approved at a branch
(`resolve/main/assets`) and loads from it. Browser caches keyed by the original `main` URLs
(kokoro-js voices, transformers.js pre-flight) are not cleared if a pinned commit later changes;
approving a new revision should clear them. The Whisper
worker's ONNX WebAssembly files come from `cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1`,
which is not yet a reviewed row. No per-file byte digests are recorded yet, so
`verifyResourceBytes` still fails closed. `tools/engine.test.mjs` covers approval, withheld uses,
changed rows, URL lookalikes, voice precedence and revision pinning;
`tools/resource-admission.browser.mjs` checks every entrypoint's refusal path under an
all-blocked substitute policy.

`frameleaf-source.json` records all adapted input hashes. `frameleaf-build.json` records the sorted output hashes/digest, upstream and patch identities, toolchain/platform, and every direct/transitive/optional/development package's lockfile license declaration. Missing declarations remain `UNDECLARED`. The original MIT license and bundled SoundTouch/WebSR notices are retained. These records do not establish redistribution approval, including for external models, fonts and assets.

The dedicated read-only Actions workflow runs the upstream unit and Node headless contracts, builds twice from separately prepared workspaces, compares artifact digests, and rechecks the complete original snapshot. Both build manifests are retained even on comparison failure, and mismatches report the affected artifact paths. Uploaded provenance is build evidence only after the exact candidate passes. Browser/GPU/media headless tests, full feature conformance, HDR/Dolby qualification and application integration remain separate gates.

No library startup script, web/server entry point or Docker image invokes this build or imports its output. Ordinary Frameleaf library startup therefore does not fetch the Freecut archive or any engine model/font/asset. Launching the standalone upstream editor is outside this isolation guarantee; its resource refusals are tested independently, while complete project-resource admission and offline lifecycle still require qualification before production integration. This slice does not mount or ship that editor.

## Web integration boundary

The Svelte host for the editor is already in the production application. The isolated build
above remains separate from that host until its adapter is implemented:

- `web/src/lib/frameleaf/studio/host-contract.ts` is the typed `mount` / `update` /
  `dispose` contract an adapter must satisfy, plus the data the host passes (project handle,
  authorized media URLs, identity, theme tokens, capabilities, online state) and the services
  it exposes back. The engine receives no token, no API base URL and no SDK.
- `web/src/lib/frameleaf/studio/commands.ts` is the canonical command vocabulary and
  registry; `bridge.ts` validates and routes it.
- `web/src/lib/frameleaf/studio/engine-loader.ts` resolves the engine. The adapter package
  (`studio/adapters/web`, not present) calls `registerStudioEngine` once from its entry
  point. The loader refuses any module whose `engineRevision` is not the pinned commit in
  `freecut-provenance.json`, and the route renders an honest unavailable state until an
  engine registers.

Adapters live outside `vendor/freecut`; nothing in the vendored snapshot is edited, and any
unavoidable patch is recorded as a versioned patch with its licensing note.

## Graph resource inventory

`resource-inventory.json` is the inventory of every resource class a Studio project graph can
reference or a Studio job can produce: library assets, edited masters, project imports, fonts,
LUTs, models, presets, captions, audio, vector graphics, generated intermediates, nested
sequences and remote preview frames. For each class it records the owner, the access check the
server applies, whether the bytes may leave the machine (local, LAN worker, RunPod) and the
retention rule. It is generated from `server/src/utils/studio-resources.ts`, which is the
registry as code; `server/src/utils/studio-resources.spec.ts` fails when the two drift, and

```sh
pnpm --dir server exec tsx src/bin/studio-resource-inventory.ts > studio/resource-inventory.json
```

regenerates it.

`server/src/services/studio-resource.service.ts` is the resolver. Given a project graph and the
acting user it enumerates every reference, applies the library's own access checks (owner,
shared album, partner, Locked exclusion, sensitive and suppressed content), refuses URLs, blob
strings, host paths, traversal, remote fonts and subresources, undeclared imports, cyclic or
over-deep nesting and oversized graphs, and returns an authorized manifest plus the refused
references with reasons. The render and preview paths accept only a complete
manifest the service issued and read source bytes only through its short-lived, revision-bound,
worker-bound grants, which are re-checked against live access on every use. A cloud
destination without recorded consent fails before anything is enumerated. Nothing in this
directory or in the resolver claims that a graph renders; that remains the engine conformance
work.

## Canonical command catalogue

`frameleaf-studio-commands.json` is the published Studio command vocabulary: 93 commands,
each with its payload fields, scope, whether it changes the stored graph, whether it is
undoable, the worker capability it needs, and the pinned Freecut manifest rows it reaches.

Payload fields typed `time`, `duration` and `rate` are exact rationals, never floats:
an instant on the timeline, a length, and a cadence or speed
multiplier. They travel as a reduced `{ num, den }` pair of integers — `StudioTime`,
`StudioDuration` and `StudioRate` on the web side and `isRational` on the server.
`object` and `object[]` fields are opaque and travel unread.

The catalogue is the single source for two checked-in contracts:

- `web/src/lib/frameleaf/studio/commands.ts` — the typed web vocabulary the bridge routes.
- `server/src/utils/studio-commands.generated.ts` — the server mirror used by
  `server/src/utils/studio-commands.ts` to validate an envelope without trusting a client.

`scripts/frameleaf-studio-commands.mjs` writes the catalogue and the server mirror and,
with no arguments, verifies them. It fails when a checked-in file is stale, when the web vocabulary drifts from the
catalogue, or when a row of `freecut-feature-manifest.json` is neither mapped to a command
nor listed in `nonCommandRows` with a reason. 182 rows are reachable through a command and
28 are declared non-command rows (module inventories, playback and storage behaviour,
read-only surfaces, host lifecycle).

```sh
node scripts/frameleaf-studio-commands.mjs            # verify, the CI default
node scripts/frameleaf-studio-commands.mjs --write    # regenerate after editing the catalogue
node --test scripts/frameleaf-studio-commands.test.mjs
```

Publishing the vocabulary does not implement command semantics, rendering or worker
admission. The bridge answers `not-implemented` for commands without an implementation.
