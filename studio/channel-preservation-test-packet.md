# FL-103 channel preservation test-only packet

Base: `422d21a432e73f0091e532979397e033dee09e44`. Patch 0054 adds a separate
`canvas-audio-channel-preservation.test.ts`; production code, pinned source,
existing tests, and prior adaptation patches are unchanged.

Immutable upstream inputs were read as data only from commit
`4d62e8082c5eb387a96275bcbd323d28f6e41a62`:

- `canvas-audio.ts`: SHA-256 `f0ef9826fcda6ee89a96057f11dc4fdfdfc46fbf42d7c74a1031921735bb05b3`.
- `canvas-audio.test.ts`: SHA-256 `963f529e5646a985e9d2d9f918d84e0e15cb89a9762519768cdd596a0b27ad6f`.

The actual `processAudio` and `processAudioWindows` pipelines receive decoded
48-kHz channel-identified impulses through a decode/demux boundary double.
No production mixer, segment extraction, downmix, timing, gain, or window helper
is replaced. Four source plane orders are tested: mono, stereo, 5.1(side), and
7.1(wide). Each has a clip gain edit plus a separate companion clip/track at unity.
Three impulses per source/channel cover the beginning, immediately before the
30-second seam, and after it. Literal 31-second sample totals and independent
gain expectations expose dropped/reordered/duplicated channels, track loss,
leakage, and sample displacement in both mix paths. Every output plane is scanned;
unexpected nonzero or nonfinite samples fail.

This tests decoded channel count, plane order, gain and impulse timing. Speaker
labels document fixture intent only: the current mixer API does not carry layout
labels. Passing cannot qualify encoded semantic layout tags, real codec
decode/mux, untouched compressed packet preservation, SoundTouch latency,
resampling, EQ/pitch/transition automation, recording/device behavior, silence or
filler undo, captions, other browsers, or any native mobile client. FL-103 parent
acceptance is retained and remains open.

The selected workflow invokes this exact file after hosted preparation and locked
dependency installation. The existing broad unit/headless steps remain intact.
The pinned production source allocates stereo in both mix paths, so mono and
multichannel count assertions are expected to expose a behavioral gap; this is a
static expectation, not observed red. Stereo is the positive control.

No local test, prepare, engine reconstruction, build, index, formatter, installation
or CI run was performed. GitNexus impact could not resolve either mixer or the
new test/helper symbols; callers, affected processes and risk remain UNKNOWN.

`engine-build.json` registers the patch hash but retains the last genuine hosted
`sourceSha256`. It is intentionally stale pending the root owner's genuine
hosted source recovery receipt. The digest gate must be reconciled before a
subsequent hosted execution can establish behavioral red. A prepare digest
failure is not the TDD red. No production implementation is authorized until the
test fails for the intended channel preservation assertion in hosted Actions.

## Approved hosted source receipt import

The independently reviewed source recovery artifact from run `37172422150`,
artifact `11292415099`, exact reviewed head
`b1de9ae5557ad7c34f78c906a647dcb2d8d8ae3e`, approves observed adapted-source
inventory digest `b482ca96155e835cafe9bbbaeb0f27a14ecb7b128e2cddc8d2ecc6e872cf3762`.
The review verified all 65 input hashes and 54 patch bindings. The receipt is
`/tmp/fl103-b1-source-recovery.json`; its downloaded ZIP is
`/tmp/fl103-b1-source-recovery.zip`, SHA-256
`42a836e160ab397ae80f2acb6a4232e18d5df714fc0b2c92f3f368f42e1adcb8`.
The corresponding engine job log is `/tmp/fl103-b1-engine.log`.

This import updates only the admitted source digest and this provenance record.
It supersedes the pending-digest state above. No local preparation, runtime or
adapted-source digest generation was performed. `runtimeQualified: false`:
the receipt establishes source identity, not behavioral red or channel fidelity.

## Hosted behavioral red and gain-only production candidate

The root owner confirmed genuine hosted behavioral red at exact head
`46ef355c656e8b89982e9295de1040ae962fe742`, Studio run `37173095254`, engine job
`111350253936`, retained log `/tmp/fl103-46ef-engine.log`. Of the eight new
tests, six failed on actual channel counts: full/windowed mono returned 2 rather
than 1, six-plane returned 2 rather than 6, and eight-plane returned 2 rather than
8. Both stereo positive controls passed. These were preservation assertions,
without fixture/type/format blockers, rather than a source-digest gate failure.

Patch 0055 is the narrow production candidate for that red. Full mixing allocates
the output on its first processed source; normal-speed gain edits keep decoded
planes in their existing order. Every source must match the first source's count,
and every processed source must match the allocated output count. Windowed mixing
reads one decoded sample from every active source before yielding to establish a
single matching plane count, then allocates that many planes for every window.
Each later decoded window must retain that count. Source decoders remain pooled,
per-channel gain/fades and sample offsets remain in their original pipeline, and
leading silence uses the admitted plane count. Mismatched counts fail explicitly
instead of choosing a largest count or guessing a new remapping/downmix.

Matching plane counts still cannot establish matching speaker layouts: the current
API carries no semantic layout labels. Distinct layouts with equal counts remain
unqualified. This candidate does not certify encoded tags or container fidelity.
Prior patch 0011's explicit SoundTouch stereo downmix for multichannel speed/pitch
processing and its existing regression are retained; multichannel retiming
preservation and SoundTouch latency require their own later packet. The full
FL-103 acceptance, including automation, recording/device behavior, removals,
captions, and independent render/codec evidence, remains open.

GitNexus upstream impacts for both mixers, their window helpers, and the new
count guard could not resolve indexed targets; caller/process coverage remains
UNKNOWN. No local engine reconstruction, adaptation application, preparation,
runtime/test/build/index/formatter/install action was performed. `sourceSha256`
remains the prior genuine `b482ca96155e835cafe9bbbaeb0f27a14ecb7b128e2cddc8d2ecc6e872cf3762`
pending a new independently reviewed hosted receipt for patch 0055. Production
green and channel fidelity are not yet established. `runtimeQualified: false`.

## Hosted patch-context failure and bounded repair

At head `6125b5c1c2371f1921acf97d5ba3aa26d4222082`, run `37173715523`, engine
job `111352159875`, hosted preparation rejected patch 0055 at its allocation
hunk (`canvas-audio.ts:2730`), before source inventory recovery or test execution.
The retained log is `/tmp/fl103-6125-engine.log`; lifecycle passed. This was a
patch-context failure and supplies no mixer behavior result or adapted digest.

The allocation hunk originally ended at its replacement and lacked trailing
context. The repair adds the exact blank line, active-segment loop and
cancellation check shown by preceding patch 0006 after it removes
`processedSegmentCount`. The immutable pinned source contains the same lines
with that now-removed counter. No preceding patch changes those surviving lines.
The hunk now has trailing context and correctly counts six old / seven new rows;
all production additions/deletions remain unchanged. The registered patch digest
is `8c177c21b6e3cb41aa2420e39988ea71ff914ce042a597226838eb90b5146143`.

Only static source/patch reads and patch-text parsing were used. No patch was
applied locally, no adapted source was reconstructed, and Git validation was not
relaxed. Hosted application remains unverified. The prior genuine `b482...3762`
source digest is retained until a new genuine hosted receipt; runtime remains
unqualified. GitNexus could not resolve `processAudio`; impact coverage is UNKNOWN.

## Authenticated post-repair hosted source receipt

Studio run `37174219286`, artifact `11292219018`, exact producer/reviewed head
`3ad66aeed245f80a3c1357efa2a58adf83c48f8a`, tree
`66043560ed6940bca9396516bd69ae978c4e2a93`, strictly applied patch 0055, then
stopped at the adapted-source digest gate before behavioral execution.
The downloaded ZIP `/tmp/fl103-3ad-source-recovery.zip` has SHA-256
`dbfc02308f75ca6fad669d136b8e26a665760062c8af994d55c77a25ca8cb024`;
its bytes match the extracted receipt
`/tmp/fl103-3ad-source-recovery/frameleaf-studio-source-recovery.json`.

All 66 input paths and hashes were authenticated against the exact producer Git
blobs, including all 55 ordered patch bindings. Producer head/tree/parents,
upstream archive/inventory, lockfile, and receipt inventory digest were validated.
The prior `b482...3762` receipt was also checked against its own producer blobs.
Its 2,704 inventory paths are unchanged; the sole adapted-file hash difference is
`src/features/export/utils/canvas-audio.ts`, from
`1ca00c4c138a090c92960a9fd6cab59d9153a3e94cf186e5ff477a7691cbf191` to
`4e2bb3bd15c5c5998370e6fffc2188dd52cc2c3a0ea15158a5887229c91c7af3`.
The only producer-input differences are the engine configuration and registered
patch 0055; every prior patch binding remains identical.

The imported actual hosted `sourceSha256` is
`aaf508828b8881a3314e5b364da5326c6706dffe191fa6a63abe2dff67e4468c`.
This supersedes the pending post-0055 digest state above. Receipt validation used
artifact data and committed Git blobs only; no local adapted source, patch
application, preparation or runtime was generated or executed.
`enginePublishedAtObservation: false`; `runtimeQualified: false`. Strict patch
application and source identity are confirmed; production behavioral green and
FL-103 acceptance remain unqualified.

## Test-only actual SoundTouch retiming packet (0056)

Base: `687b61826c25f3ef3ef79720642f4ec4bc644955`, branch
`aj/fl103-retiming-red`. Prior CLI and scheduled decoder observer branches are
preserved. The approved full FL-103 authority is the October 3 requirements
handoff, FL-103 section: channel layouts, nonedited tracks, sample-accurate sync,
pitch/EQ automation and reference renders remain required.

Patch 0056 adds only `canvas-audio-retiming-preservation.test.ts`. It uses the same
decoded/demux boundary double convention as 0054 and the pinned existing mixer
suite. No SoundTouch, mix, extraction, downmix, timing, gain or resampling code is
mocked or changed. Immutable pinned source was read as data from the retained
archive and `/tmp/fl103-pinned-canvas-audio.ts`; no engine was reconstructed.

Six full-mix cases exercise actual `processAudio`: stereo, six-plane 5.1(side),
and eight-plane 7.1(wide), each at speed 2 with pitch unchanged or independently
shifted down one octave. Every decoded source plane carries a distinct low-level
tone. Independent Fourier measurements assert its expected pitch, reject other
planes and speed-shifted pitch, and reject nonfinite PCM. These checks distinguish
the real time-stretch result from simple speed resampling; no production DSP
helper supplies the reference. Four-second output totals and the exact edited
timeline interval `[24_000, 168_000)` samples are checked independently.

Each case then mixes a separate unity companion track through the real pipeline.
Subtracting a separate deterministic actual retimed-only render isolates all
companion samples, including overlap with the retimed clip. Three unique impulses
per companion channel must remain at their exact samples and amplitudes, with no
extra samples. Composition inputs must remain unchanged. Stereo supplies two
positive controls; the six/eight-plane cases are expected to expose the current
0011 stereo downmix at the actual channel-count assertion. Expected failure is
not observed failure until the root owner's hosted run executes these tests.

Six windowed controls assert the actual support predicate is false and the first
`processAudioWindows().next()` rejects before yielding. Pinned
`canvas-audio.ts:2164-2182` excludes speed and pitch edits; `:2625-2626` refuses
them. Thus these controls qualify refusal only, never windowed SoundTouch output.
Pinned `canvas-render-orchestrator.ts:508-512` (video) and `:1026-1027` (audio-only)
select windows only for supported timelines of at least five minutes.
`:117-134` sends unsupported timelines to full `processAudio`. No adaptation
patch changes those selection sites. That is static evidence of full-mix
fallback, not executed end-to-end export qualification. Actual long-retimed
export/fallback resource behavior and encoder timestamps remain hosted acceptance
work; full FL-103 scope is retained without a new user-permission gate.

This packet checks decoded plane identity, pitch discrimination, timeline
containment and exact companion timing. It does not establish sample-accurate
internal transient alignment or SoundTouch tail/latency, encoded semantic speaker
tags, actual codec decode/mux, equal-count layout distinctions, cross-channel
phase coherence, EQ/automation/transitions, recording/devices, removal undo,
caption export, browsers or native clients. Those full-parent acceptance gates
remain open. Existing gain-only tests and patch 0011 regression are unchanged;
any later production preservation policy must reconcile that older explicit
stereo-policy regression after a genuine behavioral red.

The workflow adds the exact focused invocation after the gain tests:

```sh
cd studio/engine
./node_modules/.bin/vp test run src/features/export/utils/canvas-audio-retiming-preservation.test.ts
```

The root owner must first obtain and independently review the genuine hosted
source recovery receipt including ordered patch 0056, then import its observed
adapted digest in a separate packet. `engine-build.json` deliberately retains
the last authenticated `sourceSha256`
`aaf508828b8881a3314e5b364da5326c6706dffe191fa6a63abe2dff67e4468c`.
A strict digest/preparation/fixture/type failure supplies no behavioral red.
Only actual preservation failure after admitted preparation authorizes a bounded
production retiming fix. `runtimeQualified: false`.

GitNexus query/impacts did not resolve the mixers, actual processor, new test
helpers, decoded-boundary classes or workflow; blast-radius coverage is UNKNOWN,
with no HIGH/CRITICAL result. Only tracked patch bytes were hashed to register the
new patch. No local adapted-source hash, prepare, engine reconstruction, runtime,
test, build, formatter, install, index, CI, push or provider action was performed.

## Observed retiming RED and shared multichannel production candidate (0057)

Base `271f06ca5216532e6fc8ded3c8e278de0f831e79`, owner branch
`aj/fl103-multichannel-retiming-forward`. Root supplied genuine hosted run
`37179006071`, job `111367899980`, retained evidence
`/Users/adamtaylor/.codex/handoffs/evidence/fl103-37179006071/engine.log`.
The actual SoundTouch suite executed 12 tests: eight passed, four failed because
full six/eight-plane retiming returned two channels. Stereo full-mix positives
and all six windowed-refusal controls passed. The multichannel frequency,
containment and companion assertions following those count failures were not
reached. The peer authenticated the 56-patch, 2,705-file source receipt and
`997f29cc7f987948877d5c07062868345c3d5c02ede0a86f0b7136a19406a3da`.
This is behavioral RED, not a preparation/type/digest failure.

Patch 0057 removes the export-only fold-down and carries input plane count through
one actual SoundTouch processor: every FIFO indexes frames with the shared stride;
the rate transposer keeps one resampling phase and per-plane previous samples;
WSOLA keeps one fractional skip, search offset and overlap length, with an
interleaved mid-buffer for every plane. Correlation sums each plane's own products
before deterministic summation across planes. Opposite-phase related channels
therefore reinforce their alignment instead of cancelling in a folded guide.
The same selected offset and overlap weights apply to every plane, including
silence; no independent stereo-pair stretchers or L/R duplication are used.
Plane-order permutation cannot change the numerical search sum. Negative quick
search offsets are skipped rather than reading outside the input buffer; the
initial best score admits negative correlations as well as positive ones.

The export processor receives its decoded sample rate. Existing preview callers
retain the default two-plane/44.1-kHz constructor behavior and streaming filter
mode. The finite export filter has an explicit expected output frame cap and
one end-of-source state: after the last partial source read it pads the shared
input with silence to drain buffered overlap/interpolation. Extraction stops at
that cap; it cannot add an extra clip interval. This changes previously discarded
finite tail behavior and needs actual hosted stereo/mono/reference qualification;
bit-identical historical retimed PCM is not claimed. All source planes must have
the same frame length; deinterleaving preserves their original order and common
output length. Existing placement, gain, fades, companion-track mixing and matching
plane-count guards remain in their real production pipeline. Windowed retiming
remains refused. The older center-only 5.1 regression is reconciled with approved
preservation: center is audible in plane 2 and the other five remain silent,
instead of expecting stereo fold-down. The 12 tests in 0056 are unchanged.

Eight added actual-DSP cases exercise six/eight planes at pitch ratios 0.5, 1 and
2 with speed 1.5, plus mono/stereo short finite sources below the legacy 16,384-frame
input threshold. Nonperiodic asymmetric impulse/transient signals share signed and
scaled relationships across different former stereo pairs. Assertions check those
relationships at every output sample, silent-plane isolation, input immutability,
common finite length, nonzero late-source tails, exact extraction termination,
chunk-size invariance (127 versus 4,096 frames), and plane permutations. Both rate
routing orders and native mono are exercised. These are real TimeStretchProcessor
and TimeStretchFilter tests with a PCM source boundary only. They do not establish
absolute internal transient timestamps/latency or correctness against an external
reference renderer; those acceptance gates remain explicit.

The focused hosted workflow retains both existing gain/retiming suites and adds:

```sh
cd studio/engine
./node_modules/.bin/vp test run src/infrastructure/audio/time-stretch-multichannel.test.ts src/features/export/utils/canvas-audio-highrate-retiming.test.ts
```

Root must obtain and independently review a new genuine hosted source recovery
receipt for all 57 patches before importing its observed digest. This packet
registers only the static tracked patch hash and deliberately retains the last
authenticated `sourceSha256` `997f29cc7f987948877d5c07062868345c3d5c02ede0a86f0b7136a19406a3da`.
No local adapted-source digest, engine tree, patch application or prepare was
created. Hosted patch application, new regression execution, existing broad unit
and preview behavior, build and audible fidelity remain unverified.

Full windowed retiming, actual long-export fallback memory/latency, complete
latency/tail/reference-transient behavior, real codec decode/mux with semantic
layout tags, sample-accurate timestamps, automation/EQ/transitions, recording,
removals/undo and caption acceptance remain required engineering for full FL-103.
Matching decoded plane counts cannot certify speaker layouts. No new permission
gate or reduced completion scope is introduced. `runtimeQualified: false`.

The SoundTouch LGPL-2.1-or-later header and all attribution/notices remain intact;
export integration retains Freecut MIT attribution. Feature activation/default-OFF
controls are unchanged. GitNexus query/context and upstream impacts for the actual
processor, modified methods, export helper and added tests were unmapped in the
stale index: caller/process coverage remains UNKNOWN, with no HIGH/CRITICAL result.
Only static source/patch/evidence reads and tracked patch hashing were used. No
local runtime/tests/build/formatter/install/index/browser, CI observation, push,
Jira, mobile, provider or infrastructure action was performed.


### Pre-commit review correction: high-rate pipeline progress

The same peer identified a synchronous nonprogress loop in the initial 0057
candidate: FilterSupport still filled to a fixed 16,384 input frames, while
192-kHz speed 1.5 / pitch ratio 2 gives effective WSOLA tempo 0.75 and a
26,688-frame input requirement. That review finding is corrected in this staged
candidate, not claimed resolved by a hosted run. The input target now uses the
active SoundTouch pipeline's actual WSOLA frame requirement, adds startup overlap
when its mid-buffer must first be consumed, accounts for intermediate buffered
frames and rate conversion when the transposer runs first, and retains the old
minimum batch size. A process iteration whose input/intermediate/output frame
counts all remain unchanged throws a bounded invariant error rather than spinning.
Supported high-rate inputs retain the same shared multichannel DSP path; no
surround refusal or speed-only fallback is used to satisfy these regressions.

Eight added actual-processor cases exercise 192 kHz / speed 1.5 / pitch ratio 2
with 2,401-frame short partial inputs and 96,001-frame inputs across mono, stereo,
six and eight planes. Exact finite lengths, signed/scaled plane timing, silence,
termination and 127/4,096-frame chunk invariance are asserted. Eight separate
actual processAudio export cases use decoded 192-kHz boundary fixtures with +12
semitones and speed 1.5, one-frame and fifteen-frame clips, all four plane counts,
48-kHz final output, finite PCM and exact timeline containment. Longer cases use
an independent Fourier check for 2-kHz shifted pitch and reject the 1.5-kHz
speed-only fallback. No actual SoundTouch, extraction, configuration or mixer
helper is mocked. Existing 0056's twelve cases, mono/stereo defaults, attribution
and the last authenticated 997f source digest remain unchanged. Only the tracked
0057 patch hash is recomputed. Actual high-rate execution and the broader
qualification gates still require the root-owned hosted run.
