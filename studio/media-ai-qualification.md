# Media and AI qualification matrix (FL-138)

Source audit: PR #140 at `d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9`, 6 October 2026.
Status: **not qualified**. This maps the existing checks and remaining acceptance; it is
not a measured worker, model, browser or release receipt. The owner's 30 September
[FL-138 comment](https://heroit.atlassian.net/browse/FL-138) moved phone/tablet QC to
FL-214 and FL-215. This matrix covers server, worker, Studio and browser only.

## Requirement ledger

References name repository files; adjacent filenames share the preceding directory.
A test's presence establishes source coverage only. Its exact candidate run, retained
final bytes and deployment identity must be supplied before recording qualification.

| Requirement | Current committed check or behavior | Remaining acceptance |
| --- | --- | --- |
| 4K, portrait, rotations and repeated original-derived edits | `server/test/medium/specs/services/video-master-qualification.service.spec.ts` renders real 3840×2160 frames, portrait crop/rotation and repeated versions, decodes authored quadrant/frame identities and hashes the unchanged original. | Source rotation **metadata** specimens in addition to authored rotation, complete edit combinations, admitted worker runs and retained masters. |
| Crops, masks, effects and compositions | The production-master spec covers crop/rotation. `studio/tools/effects-matrix.browser.mjs`, `blend-matrix.browser.mjs`, `transition-matrix.browser.mjs`, `nested-float.browser.mjs` and `photometric-goldens.mjs` cover bounded GPU families, composition paths and independent numerical expectations. | Full project preview/export combinations, temporal fixtures and every constituent action in `studio/conformance-fixtures.json`; isolated shader checks do not clear project axes. |
| SDR/HDR10/HLG, 8/10-bit and high-precision effects | SDR production-master spec; `studio/tools/hdr-master.test.mjs`, `hdr-master.browser.mjs`, `hdr-source-validation.test.mjs`, `hdr-source.browser.mjs`; `studio/managed-color-qualification.md` records independent signed/highlight/alpha goldens and outstanding cases. | Full-size edited-source/output measurements on each admitted GPU/worker, monitor review and all required colour/effect families. Tiny synthetic probes remain prerequisites. |
| Required Dolby profiles, edited-picture analysis/muxing and fallback | `server/src/utils/media-policy.ts` refuses unqualified profile 5 editing; `studio/tools/preflight-validators.mjs` refuses Dolby stream/frame signaling through the generic HDR path; `studio/distribution-gates.json` retains Dolby tool admission. | FL-109: reviewed administrator-installed tool/version/rights admission, owned Dolby specimens, **new** edited-picture analysis/XML/RPU/mux correspondence and exact fallback/playback receipts. Source RPU is never evidence for edited pictures. |
| Rational/VFR clocks and decoded frame identity | Production-master spec checks irregular PTS, speed edits and nonzero/reordered source timing; `scripts/frameleaf-studio-preflight.test.mjs` checks exact integer PTS/timebase; `studio/tools/hdr-master-timing.test.mjs` checks diagnostic PQ/HLG VFR output. | Edited Studio timeline/source PTS mapping through a production streaming worker, long/full-size sequences and durable checkpoint-backed recovery. The HDR helper's timestamped sequence is limited to 256 frames. |
| Exact/fast trims and supported codecs/containers | `server/src/services/media.service.spec.ts` covers fast packet-copy trim, exact re-encode when other edits require it, probed keyframe length and encoder selection. `server/src/utils/media-policy.ts` defines the actual MP4 copy/admission rules. | Independent decoded/frame-timing and packet checks for both trim modes across every admitted codec/container/hardware path. Command-string assertions and a HEVC/H.264 specimen do not cover that matrix. |
| Multichannel audio, layout and presentation | Production-master spec independently checks 5.1 lane frequencies, copied packets/PCM, filtered volume and A/V presentation, with swap/duplicate/mute/delay negative controls. HDR timing diagnostic checks 5.1 and 7.1(wide) ALAC copies and decoded channel order. | Edited Studio audio and all admitted codec/layout paths, full-duration timing, monitor/browser playback and recovery with audio retained. |
| AI conventional-resize, faces/text/foliage/motion/cuts, artifacts and bounds | `machine-learning/immich_ml/video_restoration/models.py` requires family-specific comparison/fault evidence before admission. `machine-learning/test_video_restoration.py` checks gates, counts, size and blank-output rejection using fake runtimes. `machine-learning/video-restoration/qualification.example.json` contains pending, unapproved examples. | FL-114/FL-115: reviewed exact model/runtime/weight pins and real local/LAN/Cloud inference, conventional-resize comparisons, hallucination/temporal/chunk-seam checks, measured VRAM/time/output bounds and deterministic repeats. No real restoration weights are qualified by these fake-runtime tests. HDR/high-bit-depth/VFR restoration remains refused. |
| AI cancellation/recovery and cost provenance | `server/src/services/restoration-worker.service.spec.ts` covers owner cancellation, pause/resume, lost leases, changed models, caps and guarded publication. `asset-restoration.service.spec.ts` covers destination estimates/admission and explicit Cloud confirmation. `studio/tools/lib/ephemeral-pipeline.test.mjs` covers owned-cache cleanup with stubs. | Real-model process/resource cleanup, retry/cache/recovery, provider request/billing/estimate reconciliation and immutable input/model/output identity. A destination estimate or lifecycle stub does not prove provider cost or hardware acceptance. |
| Canonical VID/STU/AI runs on admitted local/LAN and RunPod workers | VID production-master spec, Studio engine/adapter/browser runners and restoration qualification gate already exist. `studio/tools/render-worker-still-executor.mjs` admits one silent SDR PNG recipe only. | Supply admitted worker identities, exact executing source/build/image digests and canonical run receipts. The still recipe is not the complete Studio/video/HDR worker. Provider execution requires the existing consent, budget, rights and capability admission. |
| Supported-browser display/playback QC of exact final artifacts | `studio/tools/conformance.mjs` verifies each independent axis, constituent cases, adapted source/patch identities and referenced artifact hashes. FL-112 owns browser evidence. | Retained exact final files with checksums and browser/version/display/backend playback measurements. Software Chromium/WebGPU or Playwright WebKit does not prove physical Safari or HDR display behavior. |
| Hardware failure, disk-full and interruption: validated atomic publication and original preservation | Production-master spec rejects stale/downmixed candidates without replacing valid versions. `server/src/services/restoration-worker.service.spec.ts` covers claim-guarded publication and rollback. HDR timing diagnostic interrupts a real encoder and preserves the previous complete file. | Real admitted hardware/device-loss, isolated disk-full and process-interruption runs with final validation, checkpoint/restart identity, original hashes and prior-version preservation. Mock failures and the helper interruption alone do not qualify these paths. |

## Final-artifact boundary

`studio/tools/hdr-master.mjs` currently renames a successful encoder's partial MP4 before
its callers run `probeMaster`/`decodeMaster`. This diagnostic helper therefore does not
establish validation **before** atomic publication. The timing and browser diagnostics
remove their temporary masters in cleanup; a retained hash/report cannot replay those
deleted bytes for monitor or browser QC. FL-107 owns the validation/publication and
retained-final-artifact follow-up. Do not promote these diagnostic records into full
worker qualification.

For a qualifying run, retain the immutable original, conventional baseline where needed,
edited/restored final file and raw validation report. Bind their SHA-256 checksums to the
exact executing source, adapted engine/patches, build/image, tools, model/weights, worker
hardware/driver and destination admission. Record the real command, fixture/recipe,
dimensions, integer timestamps/timebase, colour/bit-depth/profile, audio layout and
decoded-sample/temporal tolerances. Browser/display QC must reference those same final
bytes; a re-encode, proxy, new build or changed model requires its own evidence.

## Existing runnable checks

Use the pinned Node from `.nvmrc` and administrator-installed FFmpeg/FFprobe with libx265.
These commands run local source/diagnostic checks, not the unavailable worker matrix:

```sh
node --test scripts/frameleaf-studio-preflight.test.mjs \
  studio/tools/conformance.test.mjs studio/tools/photometric-goldens.test.mjs \
  studio/tools/hdr-source-validation.test.mjs studio/tools/lib/ephemeral-pipeline.test.mjs
HDR_TIMING_REPORT=/absolute/path/hdr-timing-report.json node --test \
  studio/tools/hdr-master.test.mjs studio/tools/hdr-master-timing.test.mjs
```

The production-master runner additionally needs the repository's isolated medium-test
database/native-tool harness. Never point that harness at an existing library database:

```sh
pnpm --dir server exec vitest run --config test/vitest.config.medium.mjs \
  test/medium/specs/services/video-master-qualification.service.spec.ts
cd machine-learning
python -m pytest test_video_restoration.py
```

The Python suite uses fake runtimes; the real-model acceptance procedure is in
`machine-learning/video-restoration/README.md`. The engine preparation/build/browser
commands are in `studio/README.md` and `.github/workflows/frameleaf-studio-engine.yml`;
preparation and build success are separate from admitted hardware qualification.

FL-138 remains open until these non-mobile gaps have genuine passing evidence. FL-107
owns HDR/worker final artifacts, FL-109 owns Dolby tool/chain QC and FL-112 owns browser
conformance. Record exact tested heads and hashes when their packets arrive; stale Jira
dependency status or historical run metadata cannot supply qualification.
