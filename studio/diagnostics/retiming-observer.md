# FL-103 shared WSOLA diagnostic

Diagnostic packet on source base `68612350e36b4e7743c84dec07533167e8ba5dae`.
The authoritative failure is run 37218690098 / job 111484804537: FLC amplitude
0.02865983673014473 versus the unchanged >0.035 assertion. Source admission
passed; clip gain passed 8/8; retiming passed 11/12. Later suites were skipped.

These files are outside the recovered engine and outside the source receipt's
68 explicit inputs / 57 patches. No patch, manifest, adapted source or digest is
changed. Root should use a separate diagnostic branch/workflow, retain the
existing pinned checkout/Node/npm/prepare-source/install steps from
`.github/workflows/frameleaf-studio-engine.yml`, and run preparation successfully
before the following steps. No engine build/publication/attestation follows.
The diagnostic candidate retains the admitted adapted digest
`486a4d425795af1c68f289897108486cc655cd532b75fde6717642279ba43aa5`.

Exact added hosted steps (bash):

```yaml
- name: Verify admitted source before external diagnostic
  run: node studio/tools/engine.mjs verify
- name: Expose locked runner dependencies to external setup
  run: ln -s "$GITHUB_WORKSPACE/studio/engine/node_modules" studio/diagnostics/node_modules
- name: Run genuine failing case with read-only observer disabled and enabled
  working-directory: studio/engine
  shell: bash
  env:
    NO_COLOR: '1'
  run: |
    for mode in 0 1; do
      set +e
      FL103_OBSERVER="$mode" FL103_OBSERVER_REPORT="$RUNNER_TEMP/fl103-observer-$mode.json" \
        ./node_modules/.bin/vp test run \
        --config "$GITHUB_WORKSPACE/studio/diagnostics/retiming-observer.config.ts" \
        src/features/export/utils/canvas-audio-retiming-preservation.test.ts \
        --testNamePattern 'full mix retains 7\.1\(wide\): double speed and one octave down pitch edit, timing and untouched companion$' \
        > "$RUNNER_TEMP/fl103-observer-$mode.log" 2>&1
      status=$?
      set -e
      cat "$RUNNER_TEMP/fl103-observer-$mode.log"
      test "$status" -eq 1
      grep -F 'FLC retained tone/pitch: expected 0.02865983673014473 to be greater than 0.035' "$RUNNER_TEMP/fl103-observer-$mode.log"
      test -f "$RUNNER_TEMP/fl103-observer-$mode.json"
    done
- name: Check identical produced PCM and complete failing-interval observation
  run: |
    node studio/diagnostics/compare-retiming-observation.mjs \
      "$RUNNER_TEMP/fl103-observer-0.json" "$RUNNER_TEMP/fl103-observer-1.json" \
      > "$RUNNER_TEMP/fl103-observer-comparison.json"
    cat "$RUNNER_TEMP/fl103-observer-comparison.json"
    node studio/tools/engine.mjs verify
- name: Retain diagnostic evidence even on failure
  if: always()
  uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
  with:
    name: fl103-shared-wsola-observation
    path: ${{ runner.temp }}/fl103-observer-*
    if-no-files-found: error
```

The original test remains untouched and must reproduce its original behavioral
failure in both runs. A missing case/report, changed failure, timeout, config
resolution failure, mutation guard failure or differing PCM is diagnostic
failure, not evidence for a DSP correction. No timeout is changed here.

The setup wraps the genuine SoundTouch `process` and shared Stretch search
prototype. Only the precise eight-plane/48-kHz/effective-tempo-4/rate-0.5 case is
recorded. It invokes the genuine search once and returns that exact offset.
Exhaustive evaluation uses the genuine correlation function after quick search
has prepared its reference. It reads every legal offset; it never updates the
selected offset, processor parameters or reference. Field identity and all
Stretch/input/output PCM arrays are compared before/after observation.
External WeakMap accounting records newly produced processor PCM in both runs;
the comparator requires byte-identical digests and lengths. This is a digest of
observed runtime PCM, not a regenerated adapted source inventory or receipt.

Only boundaries whose output spans intersect processor frames [48000,52800)
are evaluated exhaustively. The existing Fourier measurement is timeline
[72000,76800), and the edited clip begins at timeline 24000. At rate 0.5,
transposition precedes Stretch, so its output is the final processor output.
Every recorded boundary includes genuine selected/exhaustive shared scores and
weighted normalized alignment of each plane; plane 6 is FLC. The comparator
requires continuous coverage of the entire Fourier interval.

Interpretation: lower genuine shared score than exhaustive establishes a search
miss for that boundary, but does not alone prove an audible correction. Poor
FLC alignment at both offsets points toward the aggregate objective or shared
WSOLA compromise. A production change requires corresponding hosted PCM
behavior with the same assertions. This observer introduces extra work and can
affect timing; it is diagnostic only, never performance/latency qualification,
engine attestation, or full FL-103 acceptance. High-rate, long/windowed export,
tail/reference, encoded layout and broader Studio acceptance remain open.

GitNexus could not map `TimeStretchProcessor.process`,
`seekBestOverlapPositionStereoQuick`, `calculateCrossCorrelationStereo` or the
new comparator; impact coverage is UNKNOWN. No production symbol is edited.
