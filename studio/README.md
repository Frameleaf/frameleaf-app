# Studio preservation contracts

This directory contains preservation metadata and an explicit isolated engine build. The source archive is recovered only by the preparation command below; the vendor snapshot and generated workspace are not committed. The production Studio host is present, but this build does not supply its engine adapter, deploy a rendering worker, qualify hardware or provide licensed Dolby tools. Locked npm packages may contain model, font and asset payloads; no separate weight acquisition is authorized by this build.

- `freecut-provenance.json` records the immutable upstream Freecut revision, exact archive URL and digest, MIT license, and 2,646 ordered source-file hashes.
- `freecut-feature-manifest.json` preserves 210 source-derived feature rows and a pinned contract for all 2,204 family-source references across ten categories. Every row remains explicitly not implemented in Frameleaf, not run, and unqualified for rendering.
- `dependency-attribution.json` records preliminary dependency and asset review obligations plus a pinned 51-row package name/version/license projection from the provenance-bound Freecut lockfile. It is not a completed legal or redistribution approval.

The provenance ledger was cross-checked against a temporary clean checkout of `walterlow/freecut@4d62e8082c5eb387a96275bcbd323d28f6e41a62`. The clean tree contained 2,646 files and matched every recorded path and SHA-256 digest. SHA-256 of the UTF-8 bytes of `JSON.stringify(files)` in recorded order is `a56d57c4bcd2c996c389bb7470216b185caa28de389def109bf4d86fd95e3adb`, covering every row whether or not a feature references it. The exact codeload URL is pinned, and its archive matched SHA-256 `b4224e5c219a6302586cbe2242e9e6d299dfd1878f1fcd0f2d77ea3db12a5d32`. This is source-identity evidence only, not execution or qualification evidence.

The engine tooling rejects duplicate keys in its contract JSON and verifies the pinned source identity.

## Browser evidence records (FL-112)

`scripts/frameleaf-studio-evidence.mjs --meta <run-meta.json>` requires the measured run's
`startedAt` and `finishedAt`, in order. Command evidence also supplies `operation`;
preview, export and timing/color evidence supply `frameTimeIdentity`, `inputProfiles`,
`outputProfiles`, `alpha`, `audio` and `temporalRecovery`. The generator retains these
measurements without substituting its own clock or a default media policy. The Test workflow
checks generated records against `tools/conformance.mjs` with synthetic schema fixtures.

This repairs the record contract only. Full-manifest control/reopen/preview/export evidence,
pointer/keyboard/touch coverage, measured performance budgets and long-timeline reconnection
remain required on each browser against an admitted worker. Real Safari/iPad evidence remains
separate from Playwright WebKit; the committed conformance statuses are unchanged.

The admitted-host `STUDIO_HOST_SCENARIO=track`, `auto-key` and `ease-out` save/reopen scenarios accept
`BROWSER=chromium`, `firefox` or `safari`. Firefox and Safari use the supplied
`WEBDRIVER_ENDPOINT` for real geckodriver or safaridriver; Safari receives no Firefox
binary or preferences. The same GPU admission, visible-canvas and pixel oracle gates apply.
Track/auto-key use real native iframe input and undo/save controls, observed stage drafts,
real backend revisions and project-only reopening. Their pixel comparison crops the actual
browser screenshot using iframe/preview bounds and measured device scale; no render is substituted.
Project-only evidence requires an HTTP `HOST_ORIGIN`, a proxied browser GET for that exact
project within the reopen window, and no asset listing/search or opaque CONNECT tunnel in that window.
Empty observations, HTTPS origins and tunneled traffic cannot produce a passing project-only result.
This dispatch support does not qualify Safari/iPad hardware, touch, every manifest row or exported-media parity.

`tools/resource-admission.browser.mjs` accepts the same three `BROWSER` values and an HTTP
`STUDIO_TEST_ORIGIN`. Firefox/Safari require `WEBDRIVER_ENDPOINT`; classic runs do not load
Playwright. The report records the observed browser user agent, and a mismatched browser fails.
All startup, blocked-resource, worker, local-import and byte-tamper checks run through the
same deny-all proxy. Chromium retains its service-worker context policy; classic drivers use
fresh sessions without a service-worker blocking API. This source support is separate from
actual Firefox/Safari device qualification.
An empty proxy log, any opaque tunnel or a substituted entry cannot qualify startup absence;
each entry must have its own transparent proxied GET and no proxy errors.

The `editor-controls`, `auto-key-control` and `easing-control` probes also use that shared
three-browser session opener and retain its observed browser provenance. Their native component,
history and independent pixel checks remain separate from API persistence and worker qualification.

`boundary-hit` and `linked-edit-axis` use the same opener for their native geometry and selection
checks. Source dispatch still requires the deny-all proxy: Safari 26.5.2 rejects its manual-proxy
capability before session creation. There is no unproxied fallback or existing classic network
interception lane; Safari execution needs a supported transport that preserves admission first.

## Studio graph protocol (native apps)

`docs/docs/developer/studio-graph-protocol-v1.md` specifies the project graph for the native apps, which may not read engine source. Its machine-readable files are `graph-schema-v1.json` (JSON Schema of a graph in normal form) and `graph-conformance-v1.json` (fixtures whose answers come from the real engine). `adapters/web/test/graph-conformance.test.ts` replays every fixture through the engine and fails on drift; `GRAPH_CONFORMANCE_WRITE=1 node studio/tools/adapter.mjs test` regenerates the answers. `tools/graph-protocol.test.mjs` re-derives digests, id draws and rounding from the prose without the engine, and validates every fixture graph against the schema.

Part 2 of the protocol (FL-307, section 12 of the page) gives the mutation rules of the 28 clip, timeline-edit, track and marker commands, each with applied and rejected fixtures named `<command>/<case>`. A case marked `outsideNormalForm` records an edit the engine accepts but a native client must refuse. To add a case, append its inputs to `cases` in `graph-conformance-v1.json` with `"expect": null` and regenerate; envelopes name clips by the ids the base graph or earlier envelopes of the batch minted. The engine-free check also replays every part 2 case through `tools/graph-reference.mjs`, an implementation of section 12 written from the page without the engine, and requires the engine's graph, digest and refusal for each. When a part 2 rule changes, change the page, the reference and the fixtures together.

Part 3 (FL-308, section 13) gives the rules of the 12 effect, transition, keyframe, expression, modifier, text motion and Ken Burns commands, and of the graph fields that no engine command writes. `graph-parameters-v1.json` is its parameter catalogue: every effect, transition and blend mode a graph may name, with parameter names, types, ranges, options and defaults, and no engine text. It is generated from the engine's registries by `adapters/web/test/graph-parameters.test.ts`, which fails when a registry and the committed file differ; `GRAPH_PARAMETERS_WRITE=1 node studio/tools/adapter.mjs test` regenerates it, and the engine-free check re-derives its content digest, so a hand edit fails too. A case marked `engineArithmetic` holds values from sines, arctangents or keyframe interpolation that the page does not fix to the last bit; the reference skips those six by name.

Part 4 (FL-309, section 14) gives the rules of the 8 composition, group, published control, title, sequence setting and template commands, including the `keep-time` and `keep-frames` retime policies, and adds title styles, title animations, templates and project rates to the parameter catalogue. A case marked `settlesOnLoad` records a graph that is one load short of normal form; its answer also holds the `settled` digest a native client must match. Section 8.3 of the page has one row for each of the 73 graph-changing commands, and `commandStatus` in the fixtures names each command's status, story and section. The engine-free check is the coverage gate: it fails when a `mutatesGraph` command of `frameleaf-studio-commands.json` has no row in section 8.3, when the row and `commandStatus` disagree, when an engine command lacks applied or rejected fixtures, or when a command the engine does not apply lacks a `not-implemented/<command>` fixture and a native rule. To add a graph-changing command, add its rule to the page, its row to section 8.3, its `commandStatus` entry and its fixtures in the same change.

FL-348 (section 17 of the page) makes `clip.setMask` an engine command and adds `clip.relink`, both with engine-generated `clip.setMask/<case>` and `clip.relink/<case>` fixtures that the reference replays. The web editor's own mask controls write the same fields, and its drafts report each changed mask as `clip.setMask` in the revision summary. The catalogue now has 74 graph-changing commands, 16 of them not implemented.

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

Patch 0051 includes explicitly extracted embedded-caption segments and legacy caption text in
the shared export collector and visual-copy filter. Burn retains authored styling; off removes
these captions, sidecar emits SRT, and supported embedded WebM/MKV emits WebVTT. Ordinary
titles and unclassified text remain visual items. SRT/VTT preserve cue text and timing, including
bounded overlaps, rather than arbitrary typography. The existing MP4/MOV admission rejection
and the shared helper's internal burn fallback remain unchanged. Authored regressions use the
real source-window/speed-aware caption builder and shared serializers/parsers, with owned inline
text, and preserve source provenance and the input graph. Hosted execution, real-container
subtitle extraction and mux round trips remain unqualified; this is one FL-103 slice.

Patch 0052 binds a microphone take to its original project, workspace handle and
workspace revision through acquisition, stopping, probe/decode and persistence.
Cancellation, project or workspace replacement (including A→B→A) and toolbar
unmount permanently retire that take. Current takes alone publish timeline,
selection, media-list, error and reset state. Admitted source, thumbnail, metadata
and association writes finish on the captured workspace; retirement preserves
successful origin artifacts without placing them in the current editor. Scoped
recordings avoid the global file-handle registry and the optional eager preview
warm/conform jobs whose deferred persistence is unbound; ordinary imports retain
those jobs and normal on-demand preview remains available.

Scoped recording import refuses a known existing generated media namespace or
source. File System Access provides no exclusive cross-tab namespace allocation:
failed admitted writes retain possible partial origin artifacts and propagate the
real failure instead of recursively deleting files with unproven ownership. This
is not a cross-tab collision guarantee or automated orphan recovery. Stale origin
permission failures still fail, but do not notify a replacement workspace gate.
Controller/history, real in-memory filesystem and service probe/decode barriers
have authored regression coverage. Qualification results must identify the exact
source digest, tested paths and execution environment; authored coverage alone
does not establish an executed pass. Patch ordering and raw provenance remain
pinned. The adapted source digest identifies the prepared patched source, not a
hosted qualification result. Local preparation and focused regression results do
not qualify a new source for hosted execution, browser behavior or activation.
Microphone device/permission/hotplug/latency, browser and native recording,
sample/channel/pitch/EQ/transition rendering, silence/filler undo and full caption
styling/export acceptance remain open FL-103 gates.

Patch 0108 permanently retires a disposed microphone recorder. A permission
request that resolves after cancellation releases its stream before metering or
capture starts; disposal also settles a pending native start wait, and a queued
start event cannot revive the recorder. Synchronous
recorder setup failures release acquired resources. Deferred-acquisition tests
exercise the production recorder, alongside existing terminal-event and
origin-owned finalization controls. This source change does not qualify actual
browser/native microphone, hotplug or latency behavior.


Patch 0109 retires pre-record monitor permission requests before allocating a
meter, and guards level callbacks against closed/replaced picker ownership or a
recording taking over. The toolbar subscribes to device changes and releases the
subscription on unmount. Shared device refresh generation discards older
enumerations that complete after a newer refresh; removing the selected input resets selection and retires
its idle monitor while leaving an active recording under recorder authority.
CPU fake-device regressions exercise production monitor/meter, controller and
mount/teardown callbacks. They qualify these ownership controls only; real
Chromium/Firefox/Safari permission, hotplug and measured recording latency remain
open. The adapted source digest still requires the artifact owner's binding.


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

Patch 0065 establishes the current HDR working boundary (FL-97), specified in
`src/shared/graphics/color/managed-color.ts`.

- **Working ranges.** SDR keeps Freecut's sRGB-encoded BT.709 parameters, clamps,
  endpoints and directions. HDR uses **linear display-referred BT.709**, straight
  alpha, with **1.0 = 203 cd/m²** by default (`linear-display-bt709-v1`). Signed RGB
  carries wide gamut and values above 1 carry highlights until explicit output.
- **Ingress and output.** Decoded PQ/HLG BT.2020 planes enter this linear domain.
  SDR media decode each texel before premultiplied filtering; authored shape,
  gradient, stroke and background colors decode before interpolation/compositing.
  Text and Lottie Canvas snapshots decode into float textures. Output explicitly
  converts to PQ/HLG BT.2020 or the selected SDR monitoring policy.
- **Admitted HDR graph.** Effect-free items, normal straight-alpha source-over,
  masks, nested viewports, cuts and explicit output have bounded regression
  witnesses. Brightness adds its amount in linear reference-white units before
  straight-alpha compositing; its [-1, 1] parameter bounds and SDR encoded
  addition stay pinned. Contrast uses dimensionless gain [0, 3] around a fixed
  linear pivot 0.5 (101.5 cd/m² at reference white 203), with straight alpha
  unchanged and signed RGB kept until explicit output. SDR retains its encoded
  0.5 pivot and clamp. Exposure multiplies linear RGB by 2^EV ([-3, 3]), adds
  offset [-0.5, 0.5] reference-white units (±101.5 cd/m²), then applies artistic
  sign-preserving power 1/gamma (gamma [0.2, 3]) about unit reference white;
  alpha stays unchanged. SDR keeps encoded gain/offset, unsigned gamma and clamp.
  Saturation mixes toward artistic gray (RGB weights 0.299/0.587/0.114),
  amount [0, 3], on linear BT.709 with unchanged straight alpha; the weights
  retain the existing look and do not measure physical BT.709 luminance. SDR
  keeps the same encoded equation and clamp. Gaussian, box and motion blur
  preserve the pinned kernels and parameter bounds, accumulating premultiplied
  linear light and coverage before returning straight alpha. SDR keeps encoded
  hardware sampling. The other 47 enabled effects, 21 transitions and 24
  non-normal blends throw the shared `HdrRenderUnavailableError` until individually migrated and
  measured in this domain. Nested compositions containing a transition refuse
  as a whole. A declined HDR float item also refuses Canvas fallback.
- **Historical contracts.** Patch 0031's extended sRGB-encoded HDR classifications
  and prior receipts belong to that historical domain. The effect/transition
  semantics retain their original contracts, commit and file hashes under
  `historicalEncodedHdr`; they cannot qualify current linear HDR.

The effects, blend and transition matrices retain production SDR measurements:
parameter extremes and meanings, animation, stack order, blend equations,
transition endpoints/directions and rgba8/float parity. They also observe each
unmigrated HDR operator's typed refusal. Brightness, contrast, exposure, saturation,
Gaussian/box/motion blur and normal HDR blend have positive linear-domain
measurements, including signed/highlight and alpha checks. Spatial blur accumulates
premultiplied light and coverage, then returns straight alpha; hidden colors cannot
bleed into visible highlights. `tools/hdr-blur.browser.mjs` checks independent
spatial equations and full composition PQ exports against the prepared source.
The independent photometric equations and signed/gamma/
highlight discriminators remain historical checks, with a separate current SDR
oracle and reviewed source hash guard. `tools/linear-hdr-subtree.browser.mjs`
provides separate physical PQ/HLG/SDR equations for admitted linear HDR paths,
including brightness on authored snapshots, shapes, decoded HDR video, and nested
children/instances. Canvas/video effect fallbacks remain typed-refused in HDR.
`tools/graphics-float.browser.mjs` measures admitted effect-free graphics.

Browser reports bind actual prepared input and patch hashes, the tested commit,
runner/oracle/harness hashes, working-domain conventions and observed fixture
outcomes. The evidence updater consumes per-feature/per-case observations. A
passing refusal cannot cover a rendered fixture, and SDR measurements cannot
cover HDR extremes. Passing regressions do not establish hardware, native,
other-browser, human or release acceptance.

Patch 0048 gives a transition's invalid inputs that meaning (FL-99), by the rule patch
0039 set for effect parameters: a finite number outside its declared range is clamped to
the range, and a value that is not a finite number falls back to the declared default.
A duration that is not a finite number draws as the transition type's default 30 frames
(it used to leave the outgoing clip on screen for the whole incoming clip); an alignment
that is not a finite number draws centred on the cut. A declared numeric parameter is
clamped to its range or drawn as its default, a declared colour that is not three finite
numbers as its default, and a property the transition does not declare is dropped unless
it is a finite number. The check lives in the transition planner
(`shared/timeline/transitions/transition-inputs.ts`), which every preview and export
renderer and the audio crossfade read their windows and transitions from, so no
transition carries its own. Finite durations keep their whole frames and are not held to
a transition's editing minimum and maximum, and finite colour components are not clamped.

The compositor, transition and nested regressions retain SDR transport and alpha
witnesses; HDR operator refusals are isolated from admitted HDR subtree checks.

Still missing:

- HDR source decode in the browser graph;
- the GPU output pass and native PQ/HLG frame export;
- a project-level control or source-derived default.

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
Kokoro model's approved commit. Patch 0030 loads the Supertonic
Space from its pinned commit; the Supertonic model row and all 64 Kokoro and Supertonic voice rows
now name an exact Hugging Face commit and a byte digest per file; the owner approved those 65
rows on 2026-09-29, so Supertonic and Kokoro speech load only from the pinned commits. Browser caches keyed by the original `main` URLs
(kokoro-js voices, transformers.js pre-flight) are not cleared if a pinned commit later changes;
approving a new revision should clear them. Patch 0029 (owner decisions, 2026-09-29) removes every runtime CDN. The Whisper worker imports
transformers.js 3.8.1, the version Freecut pinned, from the lockfile-pinned install instead of
esm.sh: on 4.1.0 real whisper-tiny output places every word about a word late
(`tools/fixtures/whisper-timing.json`). `tools/whisper-timing.test.mjs` fails when the worker's
transformers.js version differs from the recorded evidence, and with `STUDIO_WHISPER_TIMING=1` it
downloads the approved model revision and checks every word time and the clip's measured pauses.
Each ONNX Runtime WebAssembly the engine loads (onnxruntime-web, transformers.js 4.x, and the
transformers.js 3.8.1 runtime kokoro-js and Whisper share) is emitted into the build from the
pinned packages and served from the engine's origin (`src/shared/utils/local-ort-assets.ts`). The
`runtime:onnx-cdn` and `runtime:whisper-transformers` rows name those bundled packages, with byte
digests of the files served. The owner approved the `runtime:onnx-cdn` row again on 2026-09-29
(recorded per row in `rights-approval.json`, which may carry its own `approvedOn` and `source` for
a re-approval), and the Whisper row again on 2026-09-29 at transformers.js 3.8.1, so Whisper,
Parakeet, RIFE and Supertonic use those bundled runtimes. File-byte admission is a separate gate:
`tools/resource-policy.mjs` validates the existing schema-1 resource `files` inventory as exact
`{path, sha256}` records. Paths are literal relative identities without traversal, URL syntax,
queries, fragments or percent escapes; hashes are lowercase SHA256 hex or null. Duplicate paths
are rejected. A repository locator plus its exact lowercase commit revision and file path defines
one Hugging Face resolve URL. A reviewed full-file URL can bind only itself when its literal
suffix matches the file path and its revision matches. No directory prefixes are guessed:
Supertonic repository paths need their actual `assets/` prefix reviewed and re-approved before
those transport URLs can match. Bundled npm paths do not become network identities.

The generator emits URL-specific hashes only when the owner approved that exact row for local
runtime and did not withhold the use. `approvalRowDigest` already includes `files`, locator and
revision: adding or changing a file invalidates the existing approval until the owner re-approves
the changed row. Root `sha256` remains null. `verifyResourceBytes` first resolves the URL through
the existing overlapping-row admission rule, then checks that file's URL, row digest, revision and
byte hash; a model ID, unknown filename, branch, URL alias or blocked voice cannot borrow a hash.
It copies bytes before awaiting the digest and returns that verified copy. The Whisper model row now names the exact seven observed path/SHA256 pairs in their original
inventory order. The owner approved that changed row on 2026-10-03 ("Approve this exact seven-file
inventory"); its renewed canonical row digest in `rights-approval.json` is
`80e61764717ea2f274fa12ab2e9a9b0bb4fc0e8cb1f41ba9a32ef67279cfc3f5`. This permits
URL-specific byte admission after genuine policy generation; it does not activate loader transport
or establish production inference. The manifest change requires fresh hosted engine source recovery;
the expected canonical engine source digest remains unchanged.

`qualification-evidence/whisper-37164769288-diagnostic.json` retains the genuine hosted isolated
fixture-inference report from commit `1b8a544824d533f3a5eef5105c1f1c21bf194114`, run
`37164769288`, SHA256 `63cc58638218ec4c4cb9807a015cd44e0537fa0c190899457ded0ccb67277153`.
The accompanying `whisper-37164769288-candidates.json` records seven distinct payloads from eight
observations, with exact origin/revision/size and observed hashes. Both remain byte-identical unsigned **UNAPPROVED observation snapshots**, including their historical
acceptance fields. Neither file is consumed as policy or owner authority. Current authority is the
renewed manifest-bound row in `rights-approval.json`, recording the actual 2026-10-03 owner approval
and this run/revision/report provenance. Future timing diagnostics say production transport remains
unqualified rather than repeating the now-resolved missing-inventory gate. Transport
integration with approved bytes, real browser-worker inference, all other pinned/supplemental
models, progress/cancellation, artifact/relink/bundle and privacy workflows remain separate gates.

`tools/engine.test.mjs` exercises the actual generator and runtime with explicitly synthetic
approval fixtures for file hashes, malformed inventories, withheld uses, equal-locator overlap,
revision/row mutations and byte-mutation races. These are contracts, not inference evidence.
It also covers approval, withheld uses,
changed rows, URL lookalikes, voice precedence and revision pinning;
`tools/resource-admission.browser.mjs` checks every entrypoint's refusal path under an
all-blocked substitute policy.

Patch 0032 adds the float route and the explicit output conversion (FL-97, FL-107).

- **Float route.** HDR projects, and any delivery request, render each item through
  the participant path into rgba16float. Admitted HDR items cover transform and
  opacity keyframes, with masks left to the compositor; unmigrated operators refuse. Every frame is then composited on the GPU
  compositor with the background as the bottom layer. The Canvas2D direct path is not
  used.
- **Output conversion.** `ColorOutputPipeline` (`src/infrastructure/gpu-color`) is a
  WGSL mirror of the managed-colour reference. It converts the float composite to
  BT.2020 PQ or HLG signal, or to SDR display values. SDR display values clip, or
  tone map with BT.2390 when the project names that policy.
- **Renderer API.** `renderFrameSignal(frame, target)` returns straight RGBA signal.
  If a frame cannot be composited in float, it throws rather than delivering an 8-bit
  canvas.
- **Native master.** `tools/hdr-master.mjs` measures CTA-861.3 MaxCLL/MaxFALL from the
  edited frames themselves and never copies them from a source. It refuses content
  above the declared mastering display. It encodes HEVC Main10 BT.2020 with the FL-102
  explicit matrix/range/dither convention and HDR10 SEI (PQ) or HLG signalling, then
  probes and decodes the result back. Matrix/range conversion uses FFmpeg's libzimg
  `zscale` filter in both directions; an RGB round trip through `scale` alone can
  hide shifted native ten-bit Y/Cb/Cr codes.

Tests:

- `tools/color-output.browser.mjs` checks the GPU conversion against the reference.
- `tools/hdr-signal.browser.mjs` checks the old edited HDR graph as a typed refusal
  and admitted effect-free HDR/SDR graphics through the production renderer.
- Patch 0071 admits owned linear Float32 RGBA reconstructed from HDR images, with
  explicit sRGB/P3/BT.2020 gamut and source reference white. The existing float
  compositor preserves alpha and headroom; it never routes these pixels through
  an SDR canvas. `tools/hdr-source.browser.mjs` measures six gamut/white cases
  through that compositor against an independent color conversion reference.
  This is renderer coverage, not HEIC/gain-map resource-adapter or HDR still-export
  qualification; those delivery paths remain gated until their checks pass.
- `tools/hdr-master.browser.mjs` checks the old effect/blend graph as a typed refusal,
  then renders admitted HDR raster cuts, SDR graphics and opacity keyframes. It
  encodes PQ/HLG Main10 diagnostic masters and decodes them within two 10-bit codes.
  `HDR_MASTER_4K=1` runs the same four edited frames at 3840×2160 with proportional
  graph geometry, exact 24 fps presentation timestamps and the same decoded RGB
  and native Y/Cb/Cr tolerances. Frames cross the browser boundary one at a time
  as binary float RGBA; reports retain their individual digests and `.rgba-f32le`
  files alongside output masters, exact commands and encoder/probe binary digests.
  Failed RGB QC retains only an explicitly named `.failed-candidate.mp4` diagnostic
  with raw RGB/plane measurements and its digest; it still throws and the helper
  removes the unpublished partial file without promoting it to a master.
  This short graph check does not qualify 4K throughput, device loss, every effect
  family, masks/transitions/titles, physical monitor review or admitted deployments.
- `tools/hdr-master.test.mjs` covers the metadata maths, refusals and a lossless round
  trip.

- `tools/hdr-master-timing.test.mjs` checks diagnostic PQ/HLG masters against an
  independently specified ffmpeg `setpts` VFR fixture. The helper accepts exact
  integer PTS and rational time base validated by `sourceTimeline`; it preserves
  those PTS with passthrough timing. The test checks decoded frame identity, 5.1
  and 7.1(wide) layouts, compressed audio packet hashes, and independently decoded
  channel order. Audio uses explicit stream copy, without a downmix or resample;
  the selected codec must be supported by the MP4 muxer.
- The timing test kills a real ffmpeg attempt after its unpublished output opens,
  verifies the previous complete master remains untouched, and restarts from the
  supplied immutable rendered sequence. Each attempt writes a unique sibling
  partial MP4 and only publishes it with a rename after successful encoding.
  An `AbortSignal` cleans up the interrupted attempt.

The helper validates the private candidate's Main10 picture count/size, BT.2020
signalling, measured content-light and declared mastering metadata, and complete
decode before atomic publication. The browser and timing diagnostics run their
independent numerical/PTS/audio QC before that rename too. A rejected candidate
cannot replace a previous complete master.

The diagnostics also decode native `yuv420p10le` planes without an RGB conversion
and compare Y/Cb/Cr with analytical BT.2020 non-constant-luminance, limited-range
ten-bit reference codes. Flat interior samples allow two codes of conversion/dither
error. Reports retain the expected codes, decoded codes, absolute errors and decode
arguments. This check covers the diagnostic flat regions; chroma edges and arbitrary
edited pictures require their own reference comparison.

The engine workflow requires FFmpeg with libx265 and libzimg/zscale for these tests and retains
`hdr-master-timing-report.json` with tool versions, commands, input/output SHA-256
and raw PTS/audio probe results. Run the focused packet with
`HDR_TIMING_REPORT=/absolute/path/report.json node --test studio/tools/hdr-master.test.mjs studio/tools/hdr-master-timing.test.mjs`.
When `HDR_TIMING_REPORT` or `HDR_MASTER_REPORT` is set, the corresponding diagnostic
retains its exact media in a unique sibling `.artifacts-*` directory. Reports bind
relative output paths to SHA-256; the timing report also retains source video/audio,
and the browser report binds its rendered input signals and encoder commands/tool
versions. The engine workflow uploads both reports and their media for later QC.
Retaining diagnostic media does not establish monitor or deployment qualification.

This is diagnostic helper evidence only. The timestamp expression is deliberately
limited to 256 frames and is not a streaming production export implementation.
These cases do not clear conformance `timingColor` rows. The production render
worker must map edited timeline frames to source sample PTS, preserve edited
multichannel audio, and use the existing `media_operation_checkpoint` identities,
checksums and restart planning. No checkpoint adapter is implemented here;
helper abort/restart does not prove durable operation recovery.

Production publication independently probes HDR exports and refuses incorrect or
unknown BT.2020 primaries/matrix before moving or publishing the output
(`server/src/utils/studio-export-contract.ts`). This signalling check does not
qualify the encoded pictures or static mastering/content-light metadata.

Remaining acceptance:

- complete HDR source/edit coverage and physical-backend qualification; existing
  decoded PQ/HLG browser fixtures and their remaining gates are recorded in
  [the managed-color qualification ledger](managed-color-qualification.md);
- 4K throughput and device loss;
- reference monitor review;
- a render worker that streams frames to the encoder and maps edited/source PTS;
- production edited-audio/layout preservation and checkpoint-backed restart;
- qualification on each admitted deployment, including all effect families,
  titles, masks and transitions, independent luma/chroma/error checks and
  versioned evidence. FL-107 remains open until its full acceptance passes.

Patch 0033 applies the owner's FL-97 decision: a project is HDR if and only if it
contains HDR media.

- **Detecting HDR media.** Imported video records the transfer from the track's colour
  description (`MediaMetadata.colorTransfer`: `sdr`, `pq` or `hlg`). The engine's
  playback stream of a library original is not the original, so the server reports
  placed library originals that are HDR (PQ, HLG or Dolby Vision) in
  `resources.hdrSources`. The host marks those assets `hdr`, and the adapter records
  `colorTransfer: 'hdr'` on them.
- **Deriving the range.** The renderer derives the working range from the placed
  media every frame, nested compositions included. Media placed or probed later
  switches every node pipeline without a remount. There is no project colour control,
  and the export Colour choice does not decide it. SDR projects keep exact Freecut
  parity.
- **SDR preview.** An HDR project previews on SDR displays through the explicit BT.2390
  conversion, never clipped. One stop of headroom puts reference white near BT.2408's
  75% level. Highlights that are still out of range are scaled as a whole, keeping
  their chromaticity.

`tools/allocation-audit.mjs` and `graph-allocation-audit.json` inventory literal 8-bit
formats, pooled texture calls and direct literal Canvas2D context calls in the graph
source. The audit fails on any undeclared detected site, or on a declared site that
no longer exists. A `canvas2d-context` declaration identifies an 8-bit surface; it
does not establish whether an HDR render can reach it. Indirect allocations and
complete float-route reachability still require graph and runtime qualification.

`frameleaf-source.json` records all adapted input hashes. `frameleaf-build.json` records the sorted output hashes/digest, upstream and patch identities, toolchain/platform, and every direct/transitive/optional/development package's lockfile license declaration. Missing declarations remain `UNDECLARED`. The original MIT license and bundled SoundTouch/WebSR notices are retained. These records do not establish redistribution approval, including for external models, fonts and assets.

The dedicated read-only Actions workflow runs the upstream unit and Node headless contracts, builds twice from separately prepared workspaces, compares artifact digests, and rechecks the complete original snapshot. Both build manifests are retained even on comparison failure, and mismatches report the affected artifact paths. Uploaded provenance is build evidence only after the exact candidate passes. Browser/GPU/media headless tests, full feature conformance, HDR/Dolby qualification and application integration remain separate gates.

No library startup script, web/server entry point or Docker image invokes this build or imports its output. Ordinary Frameleaf library startup therefore does not fetch the Freecut archive or any engine model/font/asset. Launching the standalone upstream editor is outside this isolation guarantee; its resource refusals are tested independently, while complete project-resource admission and offline lifecycle still require qualification before production integration. This slice does not mount or ship that editor.

Patch `0058-preview-layout-keyboard-accessibility.patch` adds keyboard and pointer resizing,
Bento reorder alternatives and control hit targets while retaining Freecut's MIT terms.
The playback shortcut yields to buttons and dialog controls so Space can activate them.
The mask toolbar selects points or incoming/outgoing handles and nudges them one project
pixel in the displayed direction, including mirrored and rotated paths. Independent
handle movement follows the existing tangent behavior. Static edits and playhead path
keyframes use the existing mask edit commands and undo history. Native buttons insert
a point on the selected segment or delete selected points, respecting open endpoints,
minimum path sizes and inherited track locks. Paths with geometry keyframes retain
their point count; point and handle nudges remain available on unlocked tracks.
Corner-pin numeric fields name each corner and axis, preserve the displayed offsets
when editing resized or cropped targets, and respect inherited track locks for edits
and reset through the existing item history commands.

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
read-only surfaces, host lifecycle). A non-command row still names what proves it: 16 list
the `commands` whose graph edits are the row's behaviour (`module.effects` is `effect.add`,
`effect.remove`, `effect.reorder` and `effect.update`), which is where
`scripts/frameleaf-studio-evidence.mjs` takes a row's command-axis evidence from, and the
other 12 say in `withoutCommand` what covers them instead. The check fails on a row with
neither, a row with both, or a link to a command the catalogue does not have.

```sh
node scripts/frameleaf-studio-commands.mjs            # verify, the CI default
node scripts/frameleaf-studio-commands.mjs --write    # regenerate after editing the catalogue
node --test scripts/frameleaf-studio-commands.test.mjs
```

Publishing the vocabulary does not implement command semantics, rendering or worker
admission. The bridge answers `not-implemented` for commands without an implementation.

Patch `0111-multichannel-shared-retiming.patch` retains every decoded PCM plane
through speed and independent pitch edits. The existing SoundTouch implementation
uses one overlap choice, interpolation phase and output frame count for all planes;
its mono/stereo controls retain exact original stereo PCM bytes. Export gain, EQ,
fades, track/master automation and untouched sibling contributions retain their
existing ownership. Preview serialization, queued source and worklet transport keep
the supplied AudioBuffer plane count/order instead of truncating it to L/R.

Encoder admission reads actual source plane counts. The current graph has no
semantic surround speaker-layout authority, so PCM encoding with more than two
planes refuses explicitly; original encoded packet-copy behavior is unchanged.
This refusal is a temporary export boundary, not multichannel layout qualification.
The persisted decoded-preview cache still stores downmixed stereo Int16 bins and
cannot recover original surround planes; this patch does not change that durable
cache contract. Hardware monitor limits, semantic source/output layouts, real
decoder/encoder/mux round trips, latency and per-browser acceptance remain open.
Focused synthetic PCM/source tests, typechecking and builds do not close those gates.
