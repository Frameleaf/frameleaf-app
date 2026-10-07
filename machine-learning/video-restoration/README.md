# Video restoration worker

The restoration worker serves the **Faithful** and **Creative** restoration workloads
(`restoration-faithful`, `restoration-creative`) and **Smooth motion** frame interpolation
(`interpolation`, FL-162). It is a separate process from the
`/predict` machine-learning container and is added to the server as a local or LAN
destination under **Processing destinations** (Frameleaf Cloud runs restoration as its own cloud jobs). The server only
sends it work after an explicit destination choice; a cloud destination additionally needs
the administrator's recorded consent and a per-request acknowledgement that media leaves
the network.

Status: **not qualified.** The adapters, the qualification gate and the contract are in
place; no model weights have been run for this repository. Until a qualification record
with real evidence exists, the worker reports every model as unavailable and serves no
restoration workload.

| Mode     | Family                                                           | How it runs                                                                                                        |
| -------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Faithful | [RealBasicVSR](https://github.com/ckkelvinchan/RealBasicVSR)     | Upstream `inference_realbasicvsr.py` on a folder of frames at native x4, then a Lanczos resize to the requested size |
| Creative | [SeedVR2](https://github.com/ByteDance-Seed/SeedVR)              | Upstream SeedVR2 on the validated video segment; output is checked as a stream and encoded directly |
| Smooth motion | [RIFE](https://github.com/hzwer/Practical-RIFE) (4.25)      | A frame-folder run at 2x, 4x or 8x (`--exp 1..3`) at the source size; the frames are encoded at that many times the source rate, so the clip keeps its length and audio |

The mode names express intention, not a fidelity guarantee.

## Files

- `models.example.json` — the model manifest format. Copy it to the path in
  `FRAMELEAF_RESTORATION_MODELS` (default `/restoration/config/models.json`) and replace
  every `REPLACE` value with what the qualification run measured.
- `qualification.example.json` — the qualification evidence format. Copy it to
  `FRAMELEAF_RESTORATION_QUALIFICATION` (default `/restoration/config/qualification.json`).
  The example records are deliberately `pending`.
- `../Dockerfile.video-restoration` — the worker image, with an optional stage per
  isolated runtime.
- `../immich_ml/video_restoration/` — the worker: `models.py` (adapters and gate),
  `pipeline.py` (one inference), `app.py` (HTTP), `schemas.py` (wire contract).

## Smooth motion (RIFE)

Smooth motion adds in-between frames: a clip plays slower without stutter, or at a higher frame
rate. It never changes the size (`scale` is 1) and the original is never touched; the server saves
the result as a new version. For `n` source frames the runtime must write exactly
`(n - 1) * factor + 1` frames at the source size, which the worker checks frame by frame (count,
size, and no blank frame where the source had content). The last frame is then held for
`factor - 1` frames so `n` frames become `n * factor`. A chunk of a longer video carries the next
chunk's first frame as context (`trailingContextFrame`), so the frames between two chunks are made
too; that context frame is not returned.

The weights come from the Frameleaf model source (`frameleaf/rife-4.25`, served from
`MACHINE_LEARNING_MODEL_SOURCE_URL`, by default https://models.frameleaf.cloud). A weight with a
`source` entry is downloaded with

```sh
python -m immich_ml.video_restoration fetch-weights rife-4-25
```

and is moved into place only when it hashes to the manifest's pinned sha256. Downloading never
qualifies a model: RIFE needs its own qualification record like every other model, with
`frame-count` and `interpolation-artifacts` (ghosting and warping around occlusions, fast motion
and cuts, judged against plain frame blending) on top of the common evidence. A record qualified
on the processor can set `requiresGpu: false` in the manifest; otherwise a qualified NVIDIA GPU is
required.

The server routes Smooth motion by the interpolation setting under Where each job runs: **Local
only** and **Both** can use this worker, and nothing ever moves to Frameleaf Cloud without the
person confirming a separate Frameleaf Cloud job.

## When a model is available

`GET /restoration/models` lists every configured model with a `state` and every reason it
is not available. A model is `available` only when all of these hold:

1. The manifest pins an exact 40-character upstream commit and a sha256 for every weight,
   including support weights (RealBasicVSR's SPyNet flow network).
2. The runtime checkout and its interpreter exist.
3. The checkout is at the pinned commit with no modified tracked files.
4. Every weight file exists and hashes to its pinned value. A hash is reused only while the
   file's inode, size, modification and status-change times are unchanged, and each model is
   re-checked before every request, so a replaced or rewritten file is caught.
5. A qualification record for the same model id, revision and exact weight hashes has been
   reviewed, carries `pass` with an artifact for every required evidence item (any `fail` or
   `pending` entry for an item counts, whatever else the record says), has measured
   throughput and a qualified GPU, and lists this image's `FRAMELEAF_RESTORATION_IMAGE_REVISION`.
6. The record approves the code and weight licenses (`license.approved` with the license
   names, reviewer and date).
7. An NVIDIA GPU is visible, its `nvidia-smi` name and driver branch (`550` of `550.54.14`)
   match hardware the record qualified, and it has at least `limits.minVramBytes` of memory.

`GET /capabilities` lists a restoration workload only while at least one model for that
mode is available, so the server's admission refuses restoration work on any worker that is
not qualified. The report is rebuilt at startup and every `FRAMELEAF_RESTORATION_REFRESH_S`
seconds.

Model runtimes inherit only the environment a CUDA process needs (`PATH`, locale, CUDA and
NVIDIA device variables) plus the manifest's `env`; the worker's bearer token never reaches
third-party model code.

HDR and sources above 8 bits are refused. Offering them needs a record with
`hdrQualified: true` **and** an HDR output path, which this worker does not have yet.
Variable-frame-rate sources are refused until they are conformed to a constant rate.

## Required evidence

Every model needs `pass` for: `weights-hashed`, `resource-profile` (measured VRAM, input
size and time), `compare-faces`, `compare-text`, `compare-foliage`, `compare-motion`,
`compare-cuts`, `chunk-seams`, `timing-preserved`, `audio-preserved` (each against a
conventional resize of the same source), `hallucination`, `temporal-stability` (judged over
motion, not on still frames), `deterministic-repeat`, and the fault tests
`fault-out-of-memory`, `fault-nan`, `fault-changed-weights`, `fault-dirty-checkout`,
`fault-unsupported-input`.

RealBasicVSR additionally needs `x4-to-requested-2x`: its x4 output resized to the
requested 2x compared with a plain 2x resize. SeedVR2 additionally needs
`intermediate-compression` (the loss its encoded output adds) and `frame-count` (the output
has exactly the input's frames).

Each evidence entry names an `artifact` (report path, CI run or archive) so the result can
be reproduced. `measurements` record the GPU, input size, frame count, frames per second and
peak memory of real runs; the server's estimates come from these and from measured
throughput, never from constants.

## What must be done on qualified hardware

These cannot be done in this repository's CI and remain open on FL-114:

- Pin both upstream commits, build the isolated runtimes, and confirm the argv templates,
  checkpoint file names and SPyNet cache location against those commits.
- Run the real weights on each target GPU; record sha256 of every runtime and support
  weight, peak VRAM, the largest input size that fits and frames per second.
- Produce the comparisons above against conventional resize and the fault tests
  (out-of-memory, NaN, changed weights, dirty checkout, unsupported input) and a
  deterministic repeat.
- Review the code and weight licenses.
- Fill in the manifest and qualification files with the measured values and the image
  revision the evidence covers.

## Wire contract

`POST /restoration/restore` takes a multipart form with `request` (JSON) and `media` (the
file). The request names the mode, the kind (`image` or `video`), optionally a model id and
a model fingerprint (a render that passes the fingerprint its preview reported is refused
with `model-changed` if anything moved), the scale (1, 2 or 4), the box the output must fit
(`maxWidth`, `maxHeight`, each at most 3840), whether grain should be kept, a seed and what
the server measured about the source (size, and duration for a video). The worker re-probes
the upload and refuses a mismatch.

A video comes back as H.264 in MP4 at the source's exact frame rate, converted with the
source's own YCbCr matrix; source audio is copied when MP4 can carry it and otherwise
transcoded to AAC, which the result reports (`audio: "transcoded"`) with a warning. A still
comes back as a PNG. Neither pinned model has a grain control, so `keepGrain` is answered
with a warning rather than a pretend effect.

On success the body is the restored file and the `x-restoration-result` header carries the
base64url JSON result: model identity with weight hashes and qualification id, output
description with sha256, timing and measured frames per second, peak VRAM and warnings. On
failure the body is `{ "code", "message", "modelId" }` with a code from `invalid-request`,
`model-unavailable`, `model-changed`, `unsupported-input`, `source-mismatch`, `busy`,
`out-of-memory`, `invalid-output`, `runtime-failed` or `timeout`.

The worker only reads the upload and writes the restored file as a new file in a private
working directory that is deleted after the response. It keeps the upload twice while a
request runs (the web server's spooled copy and its own working copy), so the working
directory needs room for two copies of the largest clip plus its frames (Faithful/Smooth motion) or bounded video intermediates (Creative).

## Server integration

The server reaches this worker only through `MachineLearningRepository.restore`, which
implements the `RestorationInference` seam FL-115's restoration jobs call for every still,
five-second preview clip and video chunk. FL-115 cuts the crop, clip or chunk locally before
upload, so a remote worker never receives more of the original than the job needs.

- The selection must come from `selectRestorationDestination` in
  `server/src/utils/restoration.ts`; the repository refuses anything else, including a copy
  of an admitted selection. That admission uses the destination the owner named on the
  request (or an administrator route), never another one, and needs the destination's
  recorded consent, budget, health and a qualified model.
- A cloud destination is additionally refused unless the person confirmed it for this
  request. FL-115 treats the destination the owner named on their own request, shown with a
  "leaves your network" warning, as that confirmation; a routed cloud destination nobody
  chose is refused.
- The restored file is created exclusively at the path the job gives and kept only when its
  size and sha256 match the result; originals and existing files are never replaced.
- Administrators can read each destination's model report under Processing destinations
  (`GET /ml-destinations/{id}/restoration-models`); nothing sends media to answer it.

## Environment

| Variable                               | Default                                  | Purpose                                                  |
| -------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `FRAMELEAF_RESTORATION_MODELS`         | `/restoration/config/models.json`        | Model manifest                                           |
| `FRAMELEAF_RESTORATION_QUALIFICATION`  | `/restoration/config/qualification.json` | Qualification evidence                                   |
| `FRAMELEAF_RESTORATION_WORKDIR`        | system temporary directory               | Per-request working directories                          |
| `FRAMELEAF_RESTORATION_IMAGE_REVISION` | set by the image build                   | Revision the qualification record must list              |
| `FRAMELEAF_RESTORATION_HOST` / `_PORT` | `0.0.0.0` / `3004`                       | Listen address                                           |
| `FRAMELEAF_RESTORATION_REFRESH_S`      | `300`                                    | How often the capability report is rebuilt; 0 for never  |
| `FRAMELEAF_ML_AUTH_TOKEN`              | unset                                    | Bearer token, as for the predict container               |


## Warm model runtimes and Creative video intermediates

The supplied RealBasicVSR and SeedVR2 manifest entries use `runtime.protocol: "warm-v1"`.
The HTTP worker keeps **one** isolated model process resident, reusing it for subsequent
chunks. It is killed after 120 idle seconds or 64 requests by default (`idleSeconds` and
`maxRequests`), when switching model/configuration, on inference or validation failure,
and on request disconnect or worker shutdown. A timeout kills the whole process group, including torchrun
children. The next admitted request starts fresh; a failed chunk is never silently replayed.
The exclusive request lock and per-request checkout, checkpoint and qualification checks
still apply. The resident identity includes the complete manifest entry, resolved weight
root and runtime environment. The preview fingerprint also covers runtime configuration,
limits and native scale; changing those requires a new preview.

`runtime.argv` starts the warm process. It may contain static placeholders such as
`{weight:generator}` and `{max_seq_len}`, but not input/output paths, seed or target geometry.
Before inference, a startup handshake identifies the owned worker process; torchrun puts it
in a separate session, so cleanup signals both groups. Each request then sends its values
over a private JSON-lines pipe. The bundled
`immich_ml/video_restoration/runtime_worker.py` runs with the runtime's own Python and
imports the pinned checkout. RealBasicVSR reuses `init_model(config, checkpoint)` while
calling upstream `main()` per request. SeedVR2 calls `configure_runner(1)` once, then
`generation_loop(runner, video_path=..., output_dir=..., seed=..., res_h=..., res_w=..., sp_size=1)`
per request. The SeedVR2 example uses a standalone single-process torchrun group. These
entry points and signatures must match the exact revision being qualified; a missing or
incompatible API fails closed. Custom legacy commands can retain `protocol: "process"`
(the default), which runs one process per request. Neither path imports model dependencies
into the HTTP worker or passes its bearer token to the model runtime.

The HTTP handler watches for disconnect while inference runs, terminates the owned model
groups, and waits for its request thread to finish cleanup before releasing admission. This
also applies to legacy process commands. Run the worker through
`python -m immich_ml.video_restoration`: its Uvicorn server stops active models **before**
waiting for HTTP requests during SIGTERM shutdown; the later lifespan shutdown also closes
idle models. Media preprocessing and final encoding retain their existing bounded timeouts.

For Creative videos, the already-cut server upload is linked into the private runtime input
directory without re-encoding. A request with explicit segment bounds is cut to exact frames
with lossless H.264 4:4:4 first; keyframe stream-copy is intentionally avoided. Source and
model video frames are decoded to a bounded PPM stream for frame counts, dimensions and
blank/NaN checks, retaining only one luminance statistic per source frame. The final encode
reads the validated model video directly at the original exact frame rate, uses its actual
color matrix/range, and carries source audio through the same copy/AAC rules. Still images
keep the existing frame path. No PNG compression tradeoff or uncompressed scratch images
are introduced.

Run the CPU contract tests (ffmpeg cases require ffmpeg/ffprobe on PATH):

```sh
python -m pytest --noconftest test_video_restoration.py test_video_restoration_runtime.py test_video_restoration_cancellation.py -q
```

These fake runtimes prove constructor reuse, isolation, restart, live HTTP disconnect cleanup
and SIGTERM shutdown with blocked warm/legacy models (including models ignoring SIGTERM); small
ffmpeg fixtures prove the direct segment/validation/audio path. They are **not GPU
qualification**. Before enabling an entry, repeat cold-versus-warm output comparisons,
deterministic repeats across different seeds and preceding requests, peak/resident VRAM,
OOM/timeout recovery, color/timing/audio, and chunk-seam evidence using real checkpoints
and the exact worker image. No throughput or quality improvement is claimed from fake runs.
