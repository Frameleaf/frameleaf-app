# OPS-05 · Hardware acceleration for processing

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators with an NVIDIA, AMD, Intel, Mali or Rockchip GPU who want machine learning to use it |
| Features demonstrated | Supported backends and limits, prerequisites, hwaccel.ml.yml, image tag suffixes (-cuda, -rocm, -openvino, -armnn, -rknn), extends section, WSL2 variant, recreating the container, verifying in the machine-learning logs, verifying with the GPU check (Run check again, GPU ready, Needs attention), multi-GPU variables (MACHINE_LEARNING_DEVICE_IDS, MACHINE_LEARNING_WORKERS), single compose file platforms |
| Source docs | docs/docs/features/ml-hardware-acceleration.md |
| Capture checklist | A Linux host for frameleaf.home with an NVIDIA GPU, the NVIDIA driver and Container Toolkit installed, and the Frameleaf release files in one folder (`docker-compose.yml`, `hwaccel.ml.yml`, `hwaccel.transcoding.yml`, `.env`). Start with the machine-learning container on the processor image so Hardware & GPU reads "Processor only" (and, for beat 10, a capture reading "Needs attention" with the processor-image problem). Terminal theme per the style guide; blur GPU names and UUIDs. A second capture host with two GPUs for the multi-GPU beat, or a mocked terminal. Taylor signed in as administrator, dark theme. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "Hardware acceleration for processing · Running Frameleaf". SCREEN: Settings → Compute & jobs → Hardware & GPU; the GPU check reads "Processor only"; the "AI features" row shows "Processor". | Processor only | "A GPU speeds up search, faces and descriptions and takes load off the processor. This episode turns it on for the machine-learning container." |
| 3 | 0:13–0:28 | CARD "Supported backends": bullets appear as named: "CUDA · NVIDIA (compute capability 5.2+)", "ROCm · AMD", "OpenVINO · Intel Iris Xe and Arc", then a second CARD row "ARM NN · Mali" and "RKNN · Rockchip". A strip below reads "Linux · Windows through WSL2 · Experimental". | Supported backends | "Five backends are supported: CUDA for NVIDIA, ROCm for AMD, OpenVINO for Intel graphics, ARM NN for Mali and RKNN for Rockchip. It works on Linux, and on Windows through WSL2, and it is still experimental." |
| 4 | 0:28–0:41 | CARD "Before you start (NVIDIA)": bullet 1 "Official NVIDIA driver 545 or newer"; bullet 2 "NVIDIA Container Toolkit (Linux)"; bullet 3 "Compute capability 5.2 or higher". Small footnote "ROCm image: at least 35 GiB free disk". | Before you start | "Check the prerequisites for your card. NVIDIA needs driver 545 or newer and, on Linux, the NVIDIA Container Toolkit. The ROCm image needs at least 35 gigabytes of free disk." |
| 5 | 0:41–0:51 | TERMINAL: prompt in the Frameleaf folder; `ls` prints `docker-compose.yml  hwaccel.ml.yml  hwaccel.transcoding.yml  .env`. HIGHLIGHT `hwaccel.ml.yml`. | hwaccel.ml.yml | "Next to your compose file you need the machine-learning acceleration file. Frameleaf releases include it; keep both in the same folder." |
| 6 | 0:51–1:10 | TERMINAL: `docker-compose.yml` open at the `immich-machine-learning:` service. The image line gains the suffix as it is typed: `image: ghcr.io/frameleaf/frameleaf-machine-learning:${IMMICH_VERSION:-release}-cuda`. CALLOUT lists the suffixes "-cuda · -rocm · -openvino · -armnn · -rknn". The commented block is uncommented: `extends:` / `file: hwaccel.ml.yml` / `service: cuda` (the word `cpu` replaced by `cuda`). CALLOUT "WSL2: openvino-wsl". | Image tag suffix · extends · service: cuda | "Open the compose file at the machine-learning service. Add your backend's suffix to the image tag: cuda, rocm, openvino, armnn or rknn. Then uncomment the extends section and change cpu to the same backend. On WSL2, use the wsl variant where one exists." |
| 7 | 1:10–1:20 | TERMINAL: `docker compose up -d`; output shows the machine-learning container pulled and recreated. | docker compose up -d | "Recreate the container. You do not need to rerun any jobs; the GPU is used from the next job on." |
| 8 | 1:20–1:36 | SPLIT: left TERMINAL `docker compose logs -f immich-machine-learning`; right the Frameleaf search palette running "Moraine Lake". A log line appears and is HIGHLIGHTED: `Setting execution providers to ['CUDAExecutionProvider', 'CPUExecutionProvider'], in descending order of preference`. CALLOUT "ARM NN: Loaded ANN model". | Your provider first | "To confirm, follow the machine-learning logs and run a search. The line that sets the execution providers should list your GPU's provider first, such as the CUDA execution provider. On ARM NN, look for Loaded ANN model." |
| 9 | 1:36–1:49 | SCREEN: Settings → Compute & jobs → Hardware & GPU. CURSOR clicks "Run check again"; "Checking both containers…"; the header turns to "GPU ready" and the "AI features" row to "GPU in use". ZOOM on the line "Test job ran on … · search test in … ms" (device name blurred). | Run check again · GPU ready | "Then open Compute & jobs, then Hardware & GPU, and choose Run check again. AI features should read GPU in use, and the check should say GPU ready." |
| 10 | 1:49–2:00 | SCREEN: the Needs attention capture. ZOOM on "What needs fixing": "The machine-learning container runs the processor image. Use the image that matches your GPU: -cuda, -openvino or -rocm." | Needs attention · What needs fixing | "If it says Needs attention, read What needs fixing. A common cause is a missing tag suffix, so the container still runs the processor image." |
| 11 | 2:00–2:15 | TERMINAL: `nvidia-smi -L` prints `GPU 0: …` and `GPU 1: …` (names and UUIDs blurred). Then `.env` gains two lines typed in turn: `MACHINE_LEARNING_DEVICE_IDS=0,1` and `MACHINE_LEARNING_WORKERS=2`. CALLOUT "One device per worker"; a second CALLOUT "Pin one card: MACHINE_LEARNING_DEVICE_IDS=1". | Multi-GPU | "With several NVIDIA or Intel GPUs, list their device IDs in one variable and set the worker count to match. Each worker takes one device. The same variable can also pin a single device." |
| 12 | 2:15–2:27 | CARD "Two GPUs or more": bullet 1 "Each GPU must fit every model"; bullet 2 "A model is never split across cards"; bullet 3 "Raise queue concurrency". Then SCREEN: Job manager → Concurrency dialog with Visual search raised from 2 to 4. | Two GPUs or more | "Each GPU must hold every model, and one model is never split across cards. Raise queue concurrency in Job manager so every card stays busy." |
| 13 | 2:27–2:42 | SPLIT: left, the `cuda` block of `hwaccel.ml.yml` (`deploy` → `resources` → `reservations` → `devices` with `driver: nvidia`, `count: 1`, `capabilities: gpu`); right, the same block pasted into the `immich-machine-learning:` service, with no `extends`. CALLOUT "Unraid · Portainer". | Single compose file | "On Unraid or Portainer, which take a single compose file, copy your backend's block from the acceleration file into the machine-learning service instead. If one model fails on your card, try another." |
| 14 | 2:42–2:45 | LOGO OUTRO | Next: OPS-06 · A second computer on your home network | "Next up: A second computer on your home network." |

## Voice-over (clean)

A GPU speeds up search, faces and descriptions and takes load off the processor. This episode turns it on for the machine-learning container.

Five backends are supported: CUDA for NVIDIA, ROCm for AMD, OpenVINO for Intel graphics, ARM NN for Mali and RKNN for Rockchip. It works on Linux, and on Windows through WSL2, and it is still experimental.

Check the prerequisites for your card. NVIDIA needs driver 545 or newer and, on Linux, the NVIDIA Container Toolkit. The ROCm image needs at least 35 gigabytes of free disk.

[pause]

Next to your compose file you need the machine-learning acceleration file. Frameleaf releases include it; keep both in the same folder.

Open the compose file at the machine-learning service. Add your backend's suffix to the image tag: cuda, rocm, openvino, armnn or rknn. Then uncomment the extends section and change cpu to the same backend. On WSL2, use the wsl variant where one exists.

Recreate the container. You do not need to rerun any jobs; the GPU is used from the next job on.

[pause]

To confirm, follow the machine-learning logs and run a search. The line that sets the execution providers should list your GPU's provider first, such as the CUDA execution provider. On ARM NN, look for Loaded ANN model.

Then open Compute & jobs, then Hardware & GPU, and choose Run check again. AI features should read GPU in use, and the check should say GPU ready.

If it says Needs attention, read What needs fixing. A common cause is a missing tag suffix, so the container still runs the processor image.

[pause]

With several NVIDIA or Intel GPUs, list their device IDs in one variable and set the worker count to match. Each worker takes one device. The same variable can also pin a single device.

Each GPU must hold every model, and one model is never split across cards. Raise queue concurrency in Job manager so every card stays busy.

On Unraid or Portainer, which take a single compose file, copy your backend's block from the acceleration file into the machine-learning service instead. If one model fails on your card, try another.

[pause]

Next up: A second computer on your home network.

## Production notes

- Compose details follow the Frameleaf release files in `docker/`: the image is `ghcr.io/frameleaf/frameleaf-machine-learning`, the container name is `frameleaf_machine_learning`, and the service key stays `immich-machine-learning` for compatibility (docker/README.md). The `IMMICH_VERSION` variable and the service key may appear on screen; the VO never reads them. docker/README.md lists the same suffixes and gives `release-cuda` as the stable CUDA tag.
- The doc's `hw-file` link still points at the upstream release download; tell viewers the file ships with each Frameleaf release (docker/README.md: "The release includes … hwaccel.ml.yml"). Keep URLs off screen.
- Verifying in logs: the doc says to look for `Available ORT providers`. In the current machine-learning code that line is logged at debug level only, so at the default log level it does not appear. The info-level line `Setting execution providers to [...], in descending order of preference` is always logged and is what beat 8 shows; the VO describes it without quoting either. ARM NN logs `Loaded ANN model with ID …`.
- GPU check strings: "Run check again", "Checking both containers…", "GPU ready", "Processor only", "Needs attention", "AI features", "GPU in use", "What needs fixing", "Test job ran on {where} · search test in {ms} ms". The processor-image problem text is quoted exactly in beat 10. Blur the GPU model everywhere.
- Prerequisites quoted from the doc: CUDA needs compute capability 5.2+, driver 545 or newer (CUDA 12.3), and the NVIDIA Container Toolkit on Linux except WSL2; ROCm needs at least 35 GiB free disk; OpenVINO integrated GPUs are more likely to have issues; ARM NN needs `/dev/mali0` and `libmali.so`; RKNN supports RK3566, RK3568, RK3576 and RK3588. Only CUDA is scripted step by step; the other backends follow the same two edits.
- Multi-GPU (doc "Multi-GPU"): `MACHINE_LEARNING_DEVICE_IDS` is a comma-separated list and `MACHINE_LEARNING_WORKERS` the matching count; each GPU must be able to load all models. Variable names appear on screen only.
- Beat 12's concurrency change goes through the Job manager's Concurrency dialog and the settings review (OPS-03). The doc warns that higher concurrency also raises VRAM use.
- The doc notes hardware acceleration is experimental and that image enrichment has its own CUDA and OpenVINO paths; model licensing for Frameleaf Cloud is covered in CLOUD-06, not here.
