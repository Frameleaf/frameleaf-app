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
