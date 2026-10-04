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
