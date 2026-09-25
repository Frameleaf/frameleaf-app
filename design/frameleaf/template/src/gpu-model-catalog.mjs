// GPU profiles, per-workload model ladders, serverless GPU classes with rates,
// start fees and hardware-check samples for the Frameleaf prototype.
// Pure data and maths: no React, no storage.
//
// Sources (research read 2026-09-25): scratchpad research/model-gpu-matrix.json
// (models, licences, VRAM, speed class per GPU profile, detection, compose
// snippets) and research/gpu-pricing.json (serverless flex rates, overhead
// factor, start fees per size class, worked examples).
//
// Still ESTIMATES, not measurements (marked "estimate" below; never in UI copy):
// - every speed class (research: engineering estimates from VRAM fit and
//   published throughput anecdotes), and the local seconds derived from them;
// - VLM VRAM figures other than Gemma 4; Qwen3.5 2B/4B/35B-A3B/122B-A10B VRAM;
//   Qwen3.5 llama.cpp/OpenVINO support; Gemma 4 OpenVINO support;
// - SeedVR2 VRAM per precision and ROCm support; RealBasicVSR/GFPGAN params;
// - Parakeet VRAM and CPU path; Whisper turbo VRAM;
// - cloud seconds per unit except where a pricing example gives them
//   (7B/32B/72B describe, Real-ESRGAN, HAT-L, RealBasicVSR, SeedVR2-3B video,
//   Whisper large-v3), which are themselves planning rates;
// - cold-start based start fees for 7B and 72B classes.
// Cloud work runs on the GPU provider's serverless workers only (no always-on
// machines). Video restoration runs as 20–30 s chunks on up to 5 workers.

/** Customers pay this multiple of our fully loaded GPU cost, for GPU time and the start fee alike. */
export const PRICE_MULTIPLIER = 2;
/**
 * Loaded cost = provider flex rate × runtime overhead × payment allowance 1.07
 * (runtime overhead 1.25 up to 48 GB, 1.3 for 80 GB and larger).
 */
export const PAYMENT_ALLOWANCE = 1.07;
export const MAX_CHUNK_WORKERS = 5;
export const CHUNK_SECONDS = 30;

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
const ceilCents = (value) => Math.ceil(round(value * 100, 6)) / 100;

// ------------------------------------------------------------------ GPU classes

const gpuClass = (id, label, vramGb, flexUsdPerSec, runtimeOverhead) => {
  const loadedUsdPerSec = round(flexUsdPerSec * runtimeOverhead * PAYMENT_ALLOWANCE, 8);
  return Object.freeze({
    id,
    label,
    vramGb,
    flexUsdPerSec,
    /** Our fully loaded cost per second of serverless GPU time. */
    loadedUsdPerSec,
    /** What a customer pays per second of measured GPU time: PRICE_MULTIPLIER × the loaded cost. */
    customerUsdPerSec: round(loadedUsdPerSec * PRICE_MULTIPLIER, 8),
  });
};

/** Serverless GPU classes on Frameleaf Cloud (flex rates from the pricing research). */
export const gpuClasses = Object.freeze([
  gpuClass("gpu24", "24 GB GPU (L4 / A5000 class)", 24, 0.00019167, 1.25),
  gpuClass("gpu24pro", "24 GB GPU (RTX 4090 class)", 24, 0.00030556, 1.25),
  gpuClass("gpu48pro", "48 GB GPU (L40S class)", 48, 0.00048611, 1.25),
  gpuClass("gpu80pro", "80 GB GPU (H100 class)", 80, 0.00133056, 1.3),
  gpuClass("gpu141", "141 GB GPU (H200 class)", 141, 0.00164722, 1.3),
]);

export function gpuClassById(id) {
  return gpuClasses.find((item) => item.id === id) ?? null;
}

/**
 * Start fee per worker, by model size class: covers cold start (p90) plus the
 * idle tail, at 2 × 1.07 × provider rate, rounded up to the cent.
 */
export const startFees = Object.freeze({
  "small-24": Object.freeze({ gpuClass: "gpu24pro", customerUsd: 0.05, coldStartP90: 60 }),
  "small-48": Object.freeze({ gpuClass: "gpu48pro", customerUsd: 0.1, coldStartP90: 90 }),
  "vlm-7b": Object.freeze({ gpuClass: "gpu48pro", customerUsd: 0.2, coldStartP90: 180 }),
  "vlm-32b": Object.freeze({ gpuClass: "gpu80pro", customerUsd: 0.87, coldStartP90: 300 }),
  "vlm-72b": Object.freeze({ gpuClass: "gpu141", customerUsd: 1.71, coldStartP90: 480 }),
  "video-diffusion": Object.freeze({ gpuClass: "gpu80pro", customerUsd: 0.45, coldStartP90: 150 }),
});

// ------------------------------------------------------------------ workloads

/** Billing unit per workload, how many units a price label quotes, and which container runs it locally. */
export const workloadUnits = Object.freeze({
  descriptions: { unit: "photo", plural: "photos", per: 100, container: "ml" },
  upscale: { unit: "photo", plural: "photos", per: 1, container: "ml" },
  restoration: { unit: "source minute", plural: "source minutes", per: 1, container: "ml", chunked: true },
  studio: { unit: "audio minute", plural: "audio minutes", per: 1, container: "ml" },
  render: { unit: "output minute", plural: "output minutes", per: 1, container: "server" },
  interpolation: { unit: "source minute", plural: "source minutes", per: 1, container: "ml", chunked: true },
});

export const LADDER_WORKLOADS = Object.freeze(Object.keys(workloadUnits));

/**
 * GPU profiles the research rates models against. "cpu8" and "mac_docker" are
 * processor-only hosts; the rest are GPUs.
 */
export const gpuProfiles = Object.freeze({
  cpu8: { label: "Processor only (8-core x86)", vramGb: 0, cpu: true },
  mac_docker: { label: "Docker Desktop on a Mac", vramGb: 0, cpu: true },
  gtx1650_4: { label: "NVIDIA GTX 1650 4 GB", vramGb: 4 },
  rtx3060_12: { label: "NVIDIA RTX 3060 12 GB", vramGb: 12 },
  rtx4070_12: { label: "NVIDIA RTX 4070 12 GB", vramGb: 12 },
  rtx4090_24: { label: "NVIDIA RTX 4090 24 GB", vramGb: 24 },
  arc_a770_16: { label: "Intel Arc A770 16 GB", vramGb: 16 },
  rx7900xtx_24: { label: "AMD RX 7900 XTX 24 GB", vramGb: 24 },
});
const PROFILE_ORDER = ["cpu8", "gtx1650_4", "rtx3060_12", "rtx4070_12", "rtx4090_24", "arc_a770_16", "rx7900xtx_24", "mac_docker"];
const CLASS = { F: "fast", O: "ok", S: "slow", N: "no" };
/** Research speed classes in PROFILE_ORDER, e.g. "OFFFFFOO" (estimates). */
const speeds = (code) => Object.freeze(Object.fromEntries(PROFILE_ORDER.map((id, index) => [id, CLASS[code[index]]])));

/**
 * Local seconds per unit for each speed class, scaled by model size (estimates,
 * derived from the research's speed classes; the benchmark replaces them).
 */
const classSeconds = Object.freeze({
  descriptions: { fast: 1.5, ok: 5, slow: 20 },
  upscale: { fast: 3, ok: 12, slow: 60 },
  restoration: { fast: 50, ok: 240, slow: 1500 },
  studio: { fast: 3, ok: 15, slow: 60 },
  render: { fast: 20, ok: 90, slow: 300 },
  // Doubling the frame rate of one minute of 1080p video (estimates).
  interpolation: { fast: 25, ok: 120, slow: 600 },
});
const sizeFactor = Object.freeze({ cpu: 0.5, tiny: 0.7, small: 1, medium: 1.3, large: 1.8, xl: 2.5 });

/**
 * One model position on a workload ladder (light → heavy). Only the research's
 * "pick" models appear, at most two per size class.
 * cloud: null when not offered; otherwise gpuClass, feeClass (start fee),
 * secondsPerUnit {p50, p90} on that class.
 * commercialHosted: "yes" | "conditions" | "no" — "no" is never offered on the cloud.
 */
const position = (workload, spec) =>
  Object.freeze({
    workload,
    unit: workloadUnits[workload].unit,
    commercialHosted: "yes",
    licenceNote: "",
    cpuFeasible: false,
    vramGb: {},
    speed: {},
    cloud: null,
    retiresOn: null,
    ...spec,
  });
const cloud = (gpuClassId, feeClass, p50, p90 = round(p50 * 1.2, 3)) =>
  Object.freeze({ gpuClass: gpuClassId, feeClass, secondsPerUnit: Object.freeze({ p50, p90 }) });

export const modelLadders = Object.freeze({
  descriptions: Object.freeze([
    position("descriptions", {
      id: "florence2-large@1",
      name: "Florence-2 Large",
      short: "Florence-2",
      params: "0.77B",
      sizeClass: "cpu",
      licence: "MIT",
      note: "Short captions, tags and text; not for long descriptions.",
      cpuFeasible: true,
      vramGb: { fp16: 2, int8: 1.2 },
      speed: speeds("OFFFFFOO"),
      cloud: cloud("gpu24", "small-24", 0.1), // estimate
    }),
    position("descriptions", {
      id: "moondream2@1",
      name: "moondream2",
      short: "moondream2",
      params: "1.9B",
      sizeClass: "cpu",
      licence: "Apache-2.0",
      note: "Sentence captions and simple moments.",
      cpuFeasible: true,
      vramGb: { fp16: 4.5, int8: 2.8, int4: 2 },
      speed: speeds("SFFFFFFO"),
      cloud: cloud("gpu24pro", "small-24", 0.25), // estimate
    }),
    position("descriptions", {
      id: "qwen3.5-2b@1",
      name: "Qwen3.5 2B",
      short: "Qwen3.5 2B",
      params: "2B",
      sizeClass: "tiny",
      licence: "Apache-2.0",
      note: "Natural captions and tags on small GPUs.",
      cpuFeasible: true,
      vramGb: { fp16: 5.5, int8: 3.5, int4: 2.5 }, // estimate
      speed: speeds("SOFFFFFS"),
      cloud: cloud("gpu24pro", "small-24", 0.3), // estimate
    }),
    position("descriptions", {
      id: "qwen3.5-4b@1",
      name: "Qwen3.5 4B",
      short: "Qwen3.5 4B",
      params: "4.7B",
      sizeClass: "small",
      licence: "Apache-2.0",
      note: "Detailed captions, tags and moments.",
      cpuFeasible: true,
      vramGb: { fp16: 11, int8: 6.5, int4: 4 }, // estimate
      speed: speeds("SSFFFOFS"),
      cloud: cloud("gpu48pro", "vlm-7b", 0.4), // estimate
    }),
    position("descriptions", {
      id: "gemma4-e4b@1",
      name: "Gemma 4 E4B",
      short: "Gemma 4 E4B",
      params: "4B",
      sizeClass: "small",
      licence: "Apache-2.0",
      note: "Describes photos and short videos.",
      cpuFeasible: true,
      vramGb: { fp16: 17.9, int8: 8.9, int4: 4.5 },
      speed: speeds("SSOOFFOS"),
      cloud: cloud("gpu48pro", "vlm-7b", 0.45), // estimate
    }),
    position("descriptions", {
      id: "qwen3.5-9b@1",
      name: "Qwen3.5 9B",
      short: "Qwen3.5 9B",
      params: "9.7B",
      sizeClass: "medium",
      licence: "Apache-2.0",
      note: "Rich descriptions with strong text reading.",
      vramGb: { fp16: 21, int8: 12, int4: 7.5 }, // estimate
      speed: speeds("NNOOFFOS"),
      cloud: cloud("gpu48pro", "vlm-7b", 0.5, 0.59), // pricing example: 2 photos/s planning rate
    }),
    position("descriptions", {
      id: "gemma4-12b@1",
      name: "Gemma 4 12B",
      short: "Gemma 4 12B",
      params: "12B",
      sizeClass: "medium",
      licence: "Apache-2.0",
      note: "Rich descriptions; also understands video and audio.",
      vramGb: { fp16: 26.7, int8: 13.4, int4: 6.7 },
      speed: speeds("NNOOFFOS"),
      cloud: cloud("gpu48pro", "vlm-7b", 0.65), // estimate
    }),
    position("descriptions", {
      id: "qwen3.5-27b@1",
      name: "Qwen3.5 27B",
      short: "Qwen3.5 27B",
      params: "28B",
      sizeClass: "large",
      licence: "Apache-2.0",
      note: "Very detailed descriptions for albums you care about.",
      vramGb: { fp16: 60, int8: 32, int4: 18 }, // estimate
      speed: speeds("NNNNSNSN"),
      cloud: cloud("gpu80pro", "vlm-32b", 1.25, 1.4), // pricing example: 0.8 photos/s planning rate
    }),
    position("descriptions", {
      id: "qwen3.5-35b-a3b@1",
      name: "Qwen3.5 35B-A3B",
      short: "Qwen3.5 35B",
      params: "35B (3B active)",
      sizeClass: "large",
      licence: "Apache-2.0",
      note: "Large-model quality at small-model speed.",
      vramGb: { fp16: 75, int8: 39, int4: 22 }, // estimate
      speed: speeds("SNNNONOS"),
      cloud: cloud("gpu80pro", "vlm-32b", 0.6), // estimate
    }),
    position("descriptions", {
      id: "qwen3.5-122b-a10b@1",
      name: "Qwen3.5 122B-A10B",
      short: "Qwen3.5 122B",
      params: "122B",
      sizeClass: "xl",
      licence: "Apache-2.0",
      note: "The most detailed descriptions. Best for small, important batches.",
      vramGb: { fp16: 255, int8: 130, int4: 70 }, // estimate
      speed: speeds("NNNNNNNN"),
      cloud: cloud("gpu80pro", "vlm-72b", 1.5), // estimate: 4-bit on one 80 GB GPU
    }),
  ]),
  upscale: Object.freeze([
    position("upscale", {
      id: "realesr-general-x4v3@1",
      name: "Real-ESRGAN compact ×4",
      short: "ESRGAN compact",
      params: "1.2M",
      sizeClass: "cpu",
      licence: "BSD-3-Clause",
      note: "Quick, clean 4× upscale.",
      cpuFeasible: true,
      vramGb: { fp16: 0.5 },
      speed: speeds("OFFFFFFO"),
      cloud: cloud("gpu24pro", "small-24", 4), // estimate
    }),
    position("upscale", {
      id: "realesrgan-x4plus@1",
      name: "Real-ESRGAN ×4",
      short: "Real-ESRGAN",
      params: "16.7M",
      sizeClass: "small",
      licence: "BSD-3-Clause",
      note: "Crisper 4× upscale for most photos.",
      cpuFeasible: true,
      vramGb: { fp16: 1.5 },
      speed: speeds("SOFFFFFS"),
      cloud: cloud("gpu24pro", "small-24", 15, 16.5), // pricing example: 15 s per 12 MP photo
    }),
    position("upscale", {
      id: "gfpgan-v1.4@1",
      name: "GFPGAN faces",
      short: "GFPGAN",
      params: "80M",
      sizeClass: "small",
      licence: "Apache-2.0",
      note: "Restores faces in soft or old photos.",
      cpuFeasible: true,
      vramGb: { fp16: 2 },
      speed: speeds("SFFFFFFO"),
      cloud: cloud("gpu24pro", "small-24", 3), // estimate
    }),
    position("upscale", {
      id: "hat-real-gan@1",
      name: "HAT ×4",
      short: "HAT",
      params: "20.8M",
      sizeClass: "medium",
      licence: "Apache-2.0",
      note: "Sharpest fine detail and text.",
      cpuFeasible: true,
      vramGb: { fp16: 3 },
      speed: speeds("NSOOFFOS"),
      cloud: cloud("gpu48pro", "small-48", 90, 92), // pricing example: 90 s per 12 MP photo
    }),
    position("upscale", {
      id: "seedvr2-3b-image@1",
      name: "SeedVR2 3B · photo",
      short: "SeedVR2 3B",
      params: "3B",
      sizeClass: "large",
      licence: "Apache-2.0",
      note: "Generative detail for small or soft photos.",
      vramGb: { fp16: 18, int8: 10, int4: 7 }, // estimate
      speed: speeds("NNSSONSS"),
      cloud: cloud("gpu80pro", "video-diffusion", 12), // estimate
    }),
    position("upscale", {
      id: "seedvr2-7b-image@1",
      name: "SeedVR2 7B · photo",
      short: "SeedVR2 7B",
      params: "7B",
      sizeClass: "xl",
      licence: "Apache-2.0",
      note: "Highest detail for prints.",
      vramGb: { fp16: 32, int8: 18, int4: 10 }, // estimate
      speed: speeds("NNNNSNSN"),
      cloud: cloud("gpu80pro", "video-diffusion", 25), // estimate
    }),
  ]),
  restoration: Object.freeze([
    position("restoration", {
      id: "realbasicvsr@1",
      name: "RealBasicVSR",
      short: "RealBasicVSR",
      params: "6.3M",
      sizeClass: "small",
      licence: "Apache-2.0",
      note: "Faithful clean-up: removes noise and compression without inventing detail.",
      vramGb: { fp16: 4 },
      speed: speeds("NSOOFFOS"),
      cloud: cloud("gpu48pro", "small-48", 270, 280), // pricing example: 0.15 s per 1080p frame
    }),
    position("restoration", {
      id: "seedvr2-3b@1",
      name: "SeedVR2 3B",
      short: "SeedVR2 3B",
      params: "3B",
      sizeClass: "large",
      licence: "Apache-2.0",
      note: "Creative restoration: rebuilds detail in soft or damaged video.",
      vramGb: { fp16: 24, int8: 14, int4: 9 }, // estimate
      speed: speeds("NNNSOONS"),
      cloud: cloud("gpu80pro", "video-diffusion", 2808, 2890), // pricing example: 1.5 s/frame + 4% overlap
    }),
    position("restoration", {
      id: "seedvr2-7b@1",
      name: "SeedVR2 7B",
      short: "SeedVR2 7B",
      params: "7B",
      sizeClass: "xl",
      licence: "Apache-2.0",
      note: "Most detailed creative restoration; preview a short clip first.",
      vramGb: { fp16: 40, int8: 24, int4: 14 }, // estimate
      speed: speeds("NNNNNNNN"),
      cloud: cloud("gpu80pro", "video-diffusion", 5616), // estimate: about twice the 3B
    }),
  ]),
  studio: Object.freeze([
    position("studio", {
      id: "whisper-small@1",
      name: "Whisper small",
      short: "Whisper small",
      params: "244M",
      sizeClass: "cpu",
      licence: "MIT",
      note: "Quick transcripts for clear speech.",
      cpuFeasible: true,
      vramGb: { fp16: 1.5, int8: 1 },
      speed: speeds("OFFFFFFF"),
      cloud: cloud("gpu24", "small-24", 1), // estimate
    }),
    position("studio", {
      id: "parakeet-tdt-0.6b-v3@1",
      name: "Parakeet 0.6B",
      short: "Parakeet",
      params: "600M",
      sizeClass: "small",
      licence: "CC-BY-4.0",
      licenceNote: "25 European languages. Attribution required.",
      note: "Very fast and accurate for European languages, with word timings.",
      cpuFeasible: true,
      vramGb: { fp16: 2.5 }, // estimate
      speed: speeds("OFFFFNNS"),
      cloud: cloud("gpu24", "small-24", 0.5), // estimate
    }),
    position("studio", {
      id: "whisper-large-v3-turbo@1",
      name: "Whisper large-v3 turbo",
      short: "Whisper turbo",
      params: "809M",
      sizeClass: "medium",
      licence: "MIT",
      note: "Accurate captions in 99 languages.",
      cpuFeasible: true,
      vramGb: { fp16: 2.5, int8: 1.6 }, // estimate
      speed: speeds("SFFFFFFF"),
      cloud: cloud("gpu24", "small-24", 1.8), // estimate
    }),
    position("studio", {
      id: "whisper-large-v3@1",
      name: "Whisper large-v3",
      short: "Whisper large",
      params: "1.55B",
      sizeClass: "large",
      licence: "MIT",
      note: "Best for noisy audio and many languages.",
      cpuFeasible: true,
      vramGb: { fp16: 4.5, int8: 2.9 },
      speed: speeds("SOFFFFFF"),
      cloud: cloud("gpu24", "small-24", 3.1, 3.4), // pricing example: 19.4× real time
    }),
  ]),
  // Frame interpolation is defined below (see interpolationLadder).
  get interpolation() {
    return interpolationLadder;
  },
  // Studio export is encoding, not ML; not in the model research (estimates).
  render: Object.freeze([
    position("render", {
      id: "render-software@1",
      name: "Software encode",
      short: "Software",
      params: null,
      sizeClass: "cpu",
      licence: "LGPL (encoder library)",
      note: "H.264 and H.265 on the processor.",
      cpuFeasible: true,
      vramGb: {},
      speed: speeds("SOOOOOOS"),
    }),
    position("render", {
      id: "render-hardware@1",
      name: "Hardware encode",
      short: "Hardware",
      params: null,
      sizeClass: "small",
      licence: "LGPL (encoder library)",
      note: "H.264 and H.265 on the GPU's video engine.",
      vramGb: { fp16: 1 },
      speed: speeds("NFFFFFFN"),
    }),
    position("render", {
      id: "render-standard@1",
      name: "Render · Standard",
      short: "Standard",
      params: null,
      sizeClass: "small",
      licence: "LGPL (encoder library)",
      note: "H.264 and H.265 up to 4K.",
      cloud: cloud("gpu24", "small-24", 20),
    }),
    position("render", {
      id: "render-master@1",
      name: "Render · Master",
      short: "Master",
      params: null,
      sizeClass: "medium",
      licence: "LGPL (encoder library)",
      note: "HDR10 and ProRes masters.",
      cloud: cloud("gpu48pro", "small-48", 45),
    }),
  ]),
});

// Frame interpolation (Smooth motion). Only two research picks exist: RIFE is
// the fast, CPU-feasible choice and FILM handles large motion but is much
// slower (research speed classes, except FILM on 4 GB cards, noted below).
export const interpolationLadder = Object.freeze([
  position("interpolation", {
    id: "rife-4.25@1",
    name: "RIFE 4.25",
    short: "RIFE",
    params: "10M",
    sizeClass: "small",
    licence: "MIT",
    note: "Fast, clean in-between frames for most footage.",
    cpuFeasible: true,
    vramGb: { fp16: 1.5 },
    speed: speeds("SFFFFFFO"),
    cloud: cloud("gpu24pro", "small-24", 20), // estimate: ~90 frames/s at 1080p
  }),
  position("interpolation", {
    id: "film@1",
    name: "FILM",
    short: "FILM",
    params: "34M",
    sizeClass: "medium",
    licence: "Apache-2.0",
    licenceNote: "Apache-2.0; keep the attribution notice.",
    note: "Better with large motion, such as fast pans; much slower than RIFE.",
    cpuFeasible: true,
    vramGb: { fp16: 6 },
    // Research rates the GTX 1650 "ok", but FILM needs 6 GB in fp16; treated as not fitting 4 GB.
    speed: speeds("NNOOFFSS"),
    cloud: cloud("gpu24pro", "small-24", 480), // estimate: ~0.27 s per new 1080p frame
  }),
]);

/**
 * Local-only models (never offered on the cloud). Faces keep InsightFace
 * buffalo_l: Frameleaf holds a commercial licence for it.
 */
export const localOnlyModels = Object.freeze({
  search: Object.freeze([{ id: "clip-vit-b-32", name: "CLIP ViT-B-32", licence: "MIT", commercialHosted: "yes" }]),
  faces: Object.freeze([
    { id: "insightface-buffalo_l", name: "InsightFace buffalo_l", licence: "Commercial licence held by Frameleaf", commercialHosted: "licensed" },
  ]),
  ocr: Object.freeze([{ id: "pp-ocrv5-mobile", name: "PP-OCRv5 mobile", licence: "Apache-2.0", commercialHosted: "yes" }]),
});

export function ladderFor(workload) {
  return modelLadders[workload] ?? [];
}

export function positionById(id) {
  for (const ladder of Object.values(modelLadders)) {
    const found = ladder.find((item) => item.id === id);
    if (found) return found;
  }
  return null;
}

/** Positions Frameleaf Cloud may host: offered on the cloud and licensed for hosted use. */
export function isCloudOffered(item) {
  return Boolean(item?.cloud) && item.commercialHosted !== "no";
}

export function cloudPositions(workload) {
  const all = workload ? ladderFor(workload) : Object.values(modelLadders).flat();
  return all.filter(isCloudOffered);
}

/** Smallest GPU memory the model needs at any precision (null when it has no GPU path). */
export function minVramGb(item) {
  const values = Object.values(item?.vramGb ?? {}).filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

// ------------------------------------------------------------------ bands

export const BANDS = Object.freeze({
  cpu: { id: "cpu", label: "CPU", color: "white", icon: "mdiChip", where: "This server's processor" },
  gpu: { id: "gpu", label: "Your GPU", color: "green", icon: "mdiExpansionCard", where: "Your GPU" },
  cloud: { id: "cloud", label: "Cloud", color: "blue", icon: "mdiCloudOutline", where: "Frameleaf Cloud" },
  none: { id: "none", label: "Unavailable", color: "none", icon: "mdiCancel", where: "Nowhere yet" },
});

/** Speed class of a model on a GPU; falls back to a memory check for profiles the research does not rate. */
export function speedOn(item, gpu) {
  if (!gpu) return "no";
  const rated = item.speed?.[gpu.profile];
  if (rated) return rated;
  const need = minVramGb(item);
  return need !== null && gpu.vramGb >= need ? "ok" : "no";
}

/** Speed class of a model on this host's processor ("no" unless the research marks it CPU-feasible). */
export function cpuSpeed(item, cpuProfile = "cpu8") {
  if (!item?.cpuFeasible) return "no";
  return item.speed?.[cpuProfile] ?? item.speed?.cpu8 ?? "slow";
}

/**
 * Where a model runs for the detected hardware: "gpu" (green) when it runs on
 * the GPU, "cpu" (white) when it is CPU-feasible, "cloud" (blue) when Frameleaf
 * Cloud may host it, else "none".
 */
export function bandFor(item, gpu, cpuProfile = "cpu8") {
  if (!item) return "none";
  if (speedOn(item, gpu) !== "no") return "gpu";
  if (cpuSpeed(item, cpuProfile) !== "no") return "cpu";
  if (isCloudOffered(item)) return "cloud";
  return "none";
}

// ------------------------------------------------------------------ estimates

/** Local seconds per unit (estimate from the speed class; a benchmark factor refines it). */
export function localSecondsPerUnit(item, gpu, { benchmark = null, cpuProfile = "cpu8" } = {}) {
  const band = bandFor(item, gpu, cpuProfile);
  if (band !== "gpu" && band !== "cpu") return null;
  const speedClass = band === "gpu" ? speedOn(item, gpu) : cpuSpeed(item, cpuProfile);
  const base = classSeconds[item.workload][speedClass] * (sizeFactor[item.sizeClass] ?? 1);
  const factor = benchmark?.factors?.[item.id] ?? 1;
  return round(base * factor, 2);
}

/** Serverless workers a job fans out to: video runs in 30 s chunks on up to 5 workers. */
export function workersFor(item, units) {
  if (!workloadUnits[item.workload]?.chunked) return 1;
  const chunks = Math.max(1, Math.ceil((Number(units) * 60) / CHUNK_SECONDS));
  return Math.min(MAX_CHUNK_WORKERS, chunks);
}

/**
 * Cloud cost of a job: start fee × workers + units × seconds per unit × rate,
 * where rate and start fee are both 2× our loaded cost. p50 is typical, p90
 * the high end, and the wallet hold is p90 rounded up to the cent.
 */
export function estimateCost(itemOrId, quantity) {
  const item = typeof itemOrId === "string" ? positionById(itemOrId) : itemOrId;
  const units = Number(quantity);
  if (!isCloudOffered(item) || !Number.isFinite(units) || units <= 0) return null;
  const gpu = gpuClassById(item.cloud.gpuClass);
  const fee = startFees[item.cloud.feeClass];
  if (!gpu || !fee) return null;
  const rate = gpu.customerUsdPerSec;
  const workers = workersFor(item, units);
  const startFee = fee.customerUsd;
  const workSeconds = {
    p50: round(units * item.cloud.secondsPerUnit.p50, 2),
    p90: round(units * item.cloud.secondsPerUnit.p90, 2),
  };
  const p50 = round(startFee * workers + workSeconds.p50 * rate, 6);
  const p90 = round(startFee * workers + workSeconds.p90 * rate, 6);
  return {
    item,
    gpuClass: gpu,
    rate,
    startFee,
    workers,
    chunkSeconds: workloadUnits[item.workload].chunked ? CHUNK_SECONDS : null,
    workSeconds,
    perUnit: {
      p50: round(item.cloud.secondsPerUnit.p50 * rate, 7),
      p90: round(item.cloud.secondsPerUnit.p90 * rate, 7),
    },
    p50,
    p90,
    hold: Math.max(0.01, ceilCents(p90)),
  };
}

/** Typical GPU-time cost for the number of units a label quotes (e.g. per 100 photos), start fee excluded. */
export function quotedUnitCost(item) {
  if (!isCloudOffered(item)) return null;
  const per = workloadUnits[item.workload]?.per ?? 1;
  const gpu = gpuClassById(item.cloud.gpuClass);
  return gpu ? { per, usd: item.cloud.secondsPerUnit.p50 * gpu.customerUsdPerSec * per } : null;
}

// ------------------------------------------------------------------ labels

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 10) return `${round(seconds, 1)} s`;
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

export function formatMoney(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 0.1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

/** GPU-time rate as shown to people: per minute. */
export function formatRate(usdPerSec) {
  return Number.isFinite(usdPerSec) ? `${formatMoney(usdPerSec * 60)} per minute` : "—";
}

const perUnitText = (workload, per) => {
  const units = workloadUnits[workload];
  if (!units) return "";
  return per === 1 ? `per ${units.unit}` : `per ${per} ${units.plural}`;
};

/**
 * Everything a slider position shows: band, icon, text label and whether it
 * can be chosen for the workload's route ("local" | "both" | "cloud").
 * With "cloud", models that would run here move to the cloud when Frameleaf
 * Cloud may host them, and are disabled otherwise.
 */
export function positionState(item, { gpu = null, route = "both", benchmark = null, cpuProfile = "cpu8" } = {}) {
  const natural = bandFor(item, gpu, cpuProfile);
  const band = route === "cloud" && natural !== "cloud" && natural !== "none" && isCloudOffered(item) ? "cloud" : natural;
  const units = workloadUnits[item.workload];
  let label = "Not available here";
  let detail = "";
  if (band === "gpu" || band === "cpu") {
    const seconds = localSecondsPerUnit(item, gpu, { benchmark, cpuProfile });
    const speedClass = band === "gpu" ? speedOn(item, gpu) : cpuSpeed(item, cpuProfile);
    const slow = speedClass === "slow" ? "slow · " : "";
    label =
      band === "gpu"
        ? `Your GPU · ${slow}~${formatDuration(seconds)} per ${units.unit}`
        : `CPU · slow · ~${formatDuration(seconds)} per ${units.unit}`;
    detail = benchmark?.factors?.[item.id] ? "Time measured by your benchmark." : "Estimated time for your hardware.";
  } else if (band === "cloud") {
    const quote = quotedUnitCost(item);
    label = `Cloud${item.params ? ` · ${item.params}` : ""} · about ${formatMoney(quote.usd)} ${perUnitText(item.workload, quote.per)}`;
    detail = `Runs on a ${gpuClassById(item.cloud.gpuClass).label}; plus a start fee per job.`;
  }
  let reason = "";
  if (band === "none") {
    const needs = minVramGb(item);
    reason = [
      needs !== null
        ? `${item.name} needs about ${needs} GB of GPU memory${gpu ? `; ${gpu.name} has ${gpu.vramGb} GB` : " and no usable GPU was found"}.`
        : "",
      item.commercialHosted === "no"
        ? "It is not offered on Frameleaf Cloud because its licence does not allow hosted use."
        : "It is not offered on Frameleaf Cloud.",
    ]
      .filter(Boolean)
      .join(" ");
  } else if (band === "cloud" && route === "local") {
    reason = "This work is set to run on this server only. Choose Both or Frameleaf Cloud in Where each job runs.";
  } else if (band !== "cloud" && route === "cloud") {
    reason = "This work is set to Frameleaf Cloud only, and this model is not offered there.";
  }
  return {
    item,
    band,
    runsOn: band === "cloud" ? "cloud" : band === "none" ? null : "local",
    label,
    detail,
    licenceNote: item.commercialHosted === "conditions" || item.licenceNote ? item.licenceNote || item.licence : "",
    disabled: Boolean(reason),
    reason,
  };
}

export function ladderStates(workload, options = {}) {
  return ladderFor(workload).map((item) => positionState(item, options));
}

/**
 * The position to use: the saved choice when it can be chosen, otherwise the
 * heaviest position that runs at a usable speed here, otherwise the lightest
 * cloud one.
 */
export function resolvePosition(workload, savedId, options = {}) {
  const states = ladderStates(workload, options);
  const saved = states.find((entry) => entry.item.id === savedId);
  if (saved && !saved.disabled) return { ...saved, fallback: false };
  const enabled = states.filter((entry) => !entry.disabled);
  const local = enabled.filter((entry) => entry.runsOn === "local");
  const usable = local.filter((entry) => !/slow/.test(entry.label));
  const pick =
    usable[usable.length - 1] ?? local[0] ?? enabled.find((entry) => entry.runsOn === "cloud") ?? null;
  // Only a known model that no longer fits counts as a fallback; retired ids just reset.
  return pick ? { ...pick, fallback: Boolean(saved) && savedId !== pick.item.id } : null;
}

// ------------------------------------------------------------------ hardware samples

const check = (spec) => Object.freeze({ vendor: null, model: null, vramGb: 0, driver: "—", backend: "CPU", profile: null, ...spec });

/**
 * Hardware-check results per container. The server container transcodes video;
 * the ML container runs photo and video analysis. Sample states for the
 * prototype's "Preview other hardware" disclosure.
 */
export const hardwareSamples = Object.freeze([
  Object.freeze({
    id: "rtx3060",
    label: "NVIDIA GeForce RTX 3060 · 12 GB",
    host: "Linux · Docker Engine 27",
    cpuProfile: "cpu8",
    server: check({
      vendor: "NVIDIA",
      model: "GeForce RTX 3060",
      vramGb: 12,
      profile: "rtx3060_12",
      driver: "Driver 550.107 · CUDA 12.4",
      backend: "NVENC",
      test: { ok: true, text: "Test transcode ran on NVENC · 1080p at 9.6× real time" },
    }),
    ml: check({
      vendor: "NVIDIA",
      model: "GeForce RTX 3060",
      vramGb: 12,
      profile: "rtx3060_12",
      driver: "Driver 550.107 · CUDA 12.4 · compute 8.6",
      backend: "CUDA",
      test: { ok: true, text: "Test job ran on CUDA · search embedding in 31 ms" },
    }),
    issues: [],
  }),
  Object.freeze({
    id: "gtx1650",
    label: "NVIDIA GeForce GTX 1650 · 4 GB",
    host: "Linux · Docker Engine 27",
    cpuProfile: "cpu8",
    server: check({
      vendor: "NVIDIA",
      model: "GeForce GTX 1650",
      vramGb: 4,
      profile: "gtx1650_4",
      driver: "Driver 550.107 · CUDA 12.4",
      backend: "NVENC",
      test: { ok: true, text: "Test transcode ran on NVENC · 1080p at 5.1× real time" },
    }),
    ml: check({
      vendor: "NVIDIA",
      model: "GeForce GTX 1650",
      vramGb: 4,
      profile: "gtx1650_4",
      driver: "Driver 550.107 · CUDA 12.4 · compute 7.5",
      backend: "CUDA",
      test: { ok: true, text: "Test job ran on CUDA · search embedding in 74 ms" },
    }),
    issues: [],
    notes: ["This card has no bf16 support, so larger models run in fp16 or 4-bit and take longer."],
  }),
  Object.freeze({
    id: "rtx4090",
    label: "NVIDIA GeForce RTX 4090 · 24 GB",
    host: "Linux · Docker Engine 27",
    cpuProfile: "cpu8",
    server: check({
      vendor: "NVIDIA",
      model: "GeForce RTX 4090",
      vramGb: 24,
      profile: "rtx4090_24",
      driver: "Driver 560.35 · CUDA 12.6",
      backend: "NVENC",
      test: { ok: true, text: "Test transcode ran on NVENC · 1080p at 14× real time" },
    }),
    ml: check({
      vendor: "NVIDIA",
      model: "GeForce RTX 4090",
      vramGb: 24,
      profile: "rtx4090_24",
      driver: "Driver 560.35 · CUDA 12.6 · compute 8.9",
      backend: "CUDA",
      test: { ok: true, text: "Test job ran on CUDA · search embedding in 12 ms" },
    }),
    issues: [],
  }),
  Object.freeze({
    id: "arc-a770-no-dri",
    label: "Intel Arc A770 · 16 GB · /dev/dri not mapped",
    host: "Linux · Docker Engine 27",
    cpuProfile: "cpu8",
    server: check({
      vendor: "Intel",
      model: "Arc A770 (on the host only)",
      driver: "No VA display found for /dev/dri/renderD128",
      test: { ok: false, text: "Test transcode ran on the processor · 1080p at 1.4× real time" },
    }),
    ml: check({
      vendor: "Intel",
      model: "Arc A770 (on the host only)",
      driver: "OpenVINO devices: CPU only",
      test: { ok: false, text: "Test job ran on the processor · search embedding in 410 ms" },
    }),
    onHost: { vendor: "Intel", model: "Arc A770", vramGb: 16, profile: "arc_a770_16" },
    issues: ["dri-missing", "openvino-cpu-only"],
    fixes: ["intel"],
  }),
  Object.freeze({
    id: "rx7900xtx-render-group",
    label: "AMD Radeon RX 7900 XTX · 24 GB · permission denied",
    host: "Linux · Docker Engine 27",
    cpuProfile: "cpu8",
    server: check({
      vendor: "AMD",
      model: "Radeon RX 7900 XTX",
      driver: "Mesa 24.2 · radeonsi",
      test: { ok: false, text: "Permission denied opening /dev/dri/renderD128 · test transcode ran on the processor" },
    }),
    ml: check({
      vendor: "AMD",
      model: "Radeon RX 7900 XTX",
      driver: "ROCm 6.2 · gfx1100",
      test: { ok: false, text: "Unable to open /dev/kfd read-write · test job ran on the processor" },
    }),
    onHost: { vendor: "AMD", model: "Radeon RX 7900 XTX", vramGb: 24, profile: "rx7900xtx_24" },
    issues: ["render-permission", "kfd-missing"],
    fixes: ["amd"],
  }),
  Object.freeze({
    id: "rtx3060-cpu-image",
    label: "NVIDIA GeForce RTX 3060 · 12 GB · processor analysis image",
    host: "Linux · Docker Engine 27",
    cpuProfile: "cpu8",
    server: check({
      vendor: "NVIDIA",
      model: "GeForce RTX 3060",
      vramGb: 12,
      profile: "rtx3060_12",
      driver: "Driver 550.107 · CUDA 12.4",
      backend: "NVENC",
      test: { ok: true, text: "Test transcode ran on NVENC · 1080p at 9.6× real time" },
    }),
    ml: check({
      vendor: "NVIDIA",
      model: "GeForce RTX 3060 (not used)",
      driver: "The analysis image has no CUDA runtime",
      test: { ok: false, text: "Test job ran on the processor · search embedding in 380 ms" },
    }),
    onHost: { vendor: "NVIDIA", model: "GeForce RTX 3060", vramGb: 12, profile: "rtx3060_12" },
    issues: ["cpu-image"],
    fixes: ["nvidia"],
  }),
  Object.freeze({
    id: "rtx4070-no-toolkit",
    label: "NVIDIA GeForce RTX 4070 · 12 GB · set up like Intel",
    host: "Linux · Docker Engine 27",
    cpuProfile: "cpu8",
    server: check({
      vendor: "NVIDIA",
      model: "GeForce RTX 4070 (on the host only)",
      driver: "could not select device driver \"nvidia\"",
      test: { ok: false, text: "Test transcode ran on the processor · 1080p at 1.6× real time" },
    }),
    ml: check({
      vendor: "NVIDIA",
      model: "GeForce RTX 4070 (on the host only)",
      driver: "could not select device driver \"nvidia\"",
      test: { ok: false, text: "Test job ran on the processor · search embedding in 395 ms" },
    }),
    onHost: { vendor: "NVIDIA", model: "GeForce RTX 4070", vramGb: 12, profile: "rtx4070_12" },
    issues: ["nvidia-dri", "nvidia-toolkit"],
    fixes: ["nvidia"],
  }),
  Object.freeze({
    id: "cpu-only",
    label: "No GPU · processor only",
    host: "Linux · Docker Engine 27",
    cpuProfile: "cpu8",
    server: check({
      model: "No GPU found",
      test: { ok: true, text: "Test transcode ran on the processor · 1080p at 1.3× real time" },
    }),
    ml: check({
      model: "No GPU found",
      test: { ok: true, text: "Test job ran on the processor · search embedding in 420 ms" },
    }),
    issues: [],
  }),
  Object.freeze({
    id: "macos-docker-desktop",
    label: "Docker Desktop on macOS · no GPU passthrough",
    host: "macOS · Docker Desktop 4.34",
    cpuProfile: "mac_docker",
    server: check({
      vendor: "Apple",
      model: "Apple M2 Pro (on the host only)",
      driver: "Not available inside Docker Desktop",
      test: { ok: true, text: "Test transcode ran on the processor · 1080p at 2.2× real time" },
    }),
    ml: check({
      vendor: "Apple",
      model: "Apple M2 Pro (on the host only)",
      driver: "Not available inside Docker Desktop",
      test: { ok: true, text: "Test job ran on the processor · search embedding in 260 ms" },
    }),
    onHost: { vendor: "Apple", model: "Apple M2 Pro", vramGb: 0, profile: null },
    issues: ["macos"],
    fixes: [],
  }),
]);

export const DEFAULT_HARDWARE_SAMPLE = "gtx1650";

export function hardwareSampleById(id) {
  return hardwareSamples.find((item) => item.id === id) ?? hardwareSamples.find((item) => item.id === DEFAULT_HARDWARE_SAMPLE);
}

const gpuFromCheck = (result) =>
  result.backend !== "CPU" && result.vramGb > 0
    ? { name: result.model, vramGb: result.vramGb, backend: result.backend, profile: result.profile }
    : null;

/** The GPU each container can actually use (null = processor only). */
export function containerGpus(sample) {
  const found = typeof sample === "string" ? hardwareSampleById(sample) : sample;
  return { server: gpuFromCheck(found.server), ml: gpuFromCheck(found.ml) };
}

/** The GPU a workload runs on locally: Studio export uses the server container, the rest the ML container. */
export function gpuForWorkload(sample, workload) {
  const gpus = containerGpus(sample);
  return workloadUnits[workload]?.container === "server" ? gpus.server : gpus.ml;
}

/** Simulated benchmark: deterministic per-model speed factors for this hardware. */
export function runBenchmark(sampleId, ranAt = new Date().toISOString()) {
  const factors = {};
  for (const item of Object.values(modelLadders).flat()) {
    if (!item.cpuFeasible && minVramGb(item) === null) continue;
    let hash = 7;
    for (const char of `${sampleId}:${item.id}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    factors[item.id] = round(0.72 + (hash % 50) / 100, 2);
  }
  return { sample: sampleId, ranAt, factors };
}

// ------------------------------------------------------------------ problems & fixes

/**
 * Common GPU set-up problems, in plain words, with the fix that resolves them
 * (from the detection research; 19 cases condensed for people, not logs).
 */
export const gpuProblems = Object.freeze([
  { id: "nvidia-toolkit", vendor: "NVIDIA", symptom: 'could not select device driver "nvidia" with capabilities: [[gpu]]', explain: "Docker cannot hand the NVIDIA card to containers. The NVIDIA Container Toolkit is missing or Docker was not configured after installing it.", fix: "nvidia" },
  { id: "nvidia-runtime", vendor: "NVIDIA", symptom: "unknown or invalid runtime name: nvidia", explain: "The compose file asks for the nvidia runtime, but Docker does not know it. Configure the toolkit, or use a GPU reservation instead of runtime: nvidia.", fix: "nvidia" },
  { id: "nvidia-dri", vendor: "NVIDIA", symptom: "/dev/dri mapped, no NVIDIA device in the container", explain: "/dev/dri is how Intel and AMD cards are shared. NVIDIA cards need the toolkit and a GPU reservation in docker compose.", fix: "nvidia" },
  { id: "nvenc-video", vendor: "NVIDIA", symptom: "Cannot load libnvidia-encode.so.1", explain: "The server container can see the card but not its video encoder. Add the video capability to its GPU reservation.", fix: "nvidia" },
  { id: "nvidia-driver-old", vendor: "NVIDIA", symptom: "CUDA driver version is insufficient for CUDA runtime version", explain: "The host driver is older than the CUDA image needs (driver 545 or newer). Update the host driver, or use the processor image until you can.", fix: "nvidia" },
  { id: "nvidia-arch", vendor: "NVIDIA", symptom: "no kernel image is available for execution on the device", explain: "This card is older than the GPU image supports. Work runs on the processor instead.", fix: null },
  { id: "nvml-lost", vendor: "NVIDIA", symptom: "Failed to initialize NVML: Unknown Error (after a while)", explain: "Docker's cgroup handling dropped GPU access after a reload. Restart the container; switching the toolkit to CDI mode prevents it.", fix: "nvidia" },
  { id: "compose-count", vendor: "NVIDIA", symptom: "count and device_ids error on compose up", explain: "The reservation sets both count and device_ids, or leaves out capabilities. Use exactly one of them and always list capabilities.", fix: "nvidia" },
  { id: "cpu-image", vendor: "Any", symptom: "GPU passed through but analysis still slow, processor at 100%", explain: "The machine-learning container runs the processor image. Use the image that matches your GPU: -cuda, -openvino or -rocm.", fix: null },
  { id: "dri-missing", vendor: "Intel / AMD", symptom: "No VA display found for device /dev/dri/renderD128", explain: "/dev/dri is not passed into the container, or the host driver is not loaded.", fix: "intel" },
  { id: "render-permission", vendor: "Intel / AMD", symptom: "Permission denied opening /dev/dri/renderD128", explain: "The container is not in the host's render group. Add the group by its number; names differ between the host and the image.", fix: "amd" },
  { id: "openvino-cpu-only", vendor: "Intel", symptom: "OpenVINO devices: CPU only", explain: "The analysis container cannot reach the Intel GPU: /dev/dri is missing, the image is not the OpenVINO one, or the host kernel is too old for Arc (6.2 or newer).", fix: "intel" },
  { id: "wrong-gpu", vendor: "Intel / AMD", symptom: "The integrated GPU is used instead of the graphics card", explain: "renderD128 and renderD129 can swap between restarts. Map the card's own node by its PCI path.", fix: null },
  { id: "kfd-missing", vendor: "AMD", symptom: "Unable to open /dev/kfd read-write", explain: "ROCm analysis needs /dev/kfd as well as /dev/dri, and the video and render groups.", fix: "amd" },
  { id: "rocm-gfx", vendor: "AMD", symptom: "hipErrorNoBinaryForGpu on RX 6000/7000", explain: "ROCm was not built for this card. RX 6000 cards usually need HSA_OVERRIDE_GFX_VERSION=10.3.0; otherwise use the processor.", fix: "amd" },
  { id: "wsl2", vendor: "Windows", symptom: "WSL2: /dev/dri missing or Quick Sync fails", explain: "WSL2 shares the GPU through /dev/dxg, not /dev/dri. Use the WSL2 settings; Quick Sync is not available there. For NVIDIA install only the Windows driver.", fix: "wsl2" },
  { id: "unraid", vendor: "Unraid", symptom: "The GPU plugin shows the card but the container does not", explain: "The container template is missing --runtime=nvidia or the right NVIDIA_VISIBLE_DEVICES, or the card is reserved for a virtual machine.", fix: null },
  { id: "macos", vendor: "Apple", symptom: "Docker Desktop on macOS shows no GPU", explain: "Docker Desktop runs containers in a Linux virtual machine with no GPU. This is expected: work runs on the processor, and heavier work can go to Frameleaf Cloud.", fix: null },
  { id: "snap-docker", vendor: "NVIDIA", symptom: "Docker installed from the Ubuntu snap cannot use the NVIDIA toolkit", explain: "The snap package keeps its settings elsewhere. Install Docker from Docker's own apt repository.", fix: null },
]);

export function problemById(id) {
  return gpuProblems.find((item) => item.id === id) ?? null;
}

/** Copy-ready docker compose fixes per vendor, for the server and ML containers. */
export const composeFixes = Object.freeze({
  nvidia: {
    title: "NVIDIA",
    steps: [
      "Install the NVIDIA driver (545 or newer) and the NVIDIA Container Toolkit on the host.",
      "Run: sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker",
      "Remove any /dev/dri mapping from these services; NVIDIA does not use it.",
    ],
    yaml: `services:
  frameleaf-server:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu, compute, video]

  frameleaf-machine-learning:
    image: ghcr.io/frameleaf/machine-learning:release-cuda
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1              # or device_ids: ['0'], not both
              capabilities: [gpu]`,
  },
  intel: {
    title: "Intel",
    steps: [
      "Find the render group's number on the host: stat -c '%g' /dev/dri/renderD128",
      "Use numbers in group_add; group names differ between the host and the image.",
      "Arc cards need host kernel 6.2 or newer.",
    ],
    yaml: `services:
  frameleaf-server:
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "993"   # host render group: stat -c '%g' /dev/dri/renderD128
      - "44"    # host video group

  frameleaf-machine-learning:
    image: ghcr.io/frameleaf/machine-learning:release-openvino
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "993"   # host render group`,
  },
  amd: {
    title: "AMD",
    steps: [
      "Find the render group's number on the host: stat -c '%g' /dev/dri/renderD128",
      "Video transcoding needs /dev/dri. ROCm analysis also needs /dev/kfd and the ROCm image (about 35 GB free disk).",
    ],
    yaml: `services:
  frameleaf-server:
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "993"   # host render group
      - "44"    # host video group

  frameleaf-machine-learning:
    image: ghcr.io/frameleaf/machine-learning:release-rocm
    devices:
      - /dev/kfd:/dev/kfd
      - /dev/dri:/dev/dri
    group_add:
      - video
      - "993"   # host render group (number)
    security_opt:
      - seccomp=unconfined
    # environment:
    #   - HSA_OVERRIDE_GFX_VERSION=10.3.0   # only for RX 6000 cards`,
  },
  wsl2: {
    title: "Windows (WSL2)",
    steps: ["Install only the Windows GPU driver; do not install a Linux driver inside WSL."],
    yaml: `services:
  frameleaf-server:
    devices:
      - /dev/dri:/dev/dri
      - /dev/dxg:/dev/dxg
    volumes:
      - /usr/lib/wsl:/usr/lib/wsl
    environment:
      - LIBVA_DRIVER_NAME=d3d12

  frameleaf-machine-learning:
    devices:
      - /dev/dxg:/dev/dxg
    volumes:
      - /usr/lib/wsl:/usr/lib/wsl`,
  },
});

// ------------------------------------------------------------------ smooth motion

/** Shown once wherever AI interpolation is offered. */
export const INTERPOLATION_TRADEOFF = "Fast motion and objects crossing can smear; check the preview.";
export const INTERPOLATION_PREVIEW_SECONDS = 5;

/**
 * Work for a frame-rate increase: source minutes weighted by how many new
 * frames each source frame needs (2× the frame rate = one new frame each).
 * The output file grows with the frame rate (about 2× at double).
 */
export function interpolationWork({ durationSeconds = 0, sourceFps = 30, targetFps = 60 } = {}) {
  const ratio = Math.max(1, Number(targetFps) / Math.max(1, Number(sourceFps) || 30));
  const minutes = Math.max(0.05, (Number(durationSeconds) || 0) / 60);
  return {
    ratio: round(ratio, 3),
    units: round(minutes * Math.max(0.5, ratio - 1), 3),
    sizeFactor: round(ratio, 2),
  };
}

/** Local time or cloud cost for smoothing motion with one model position. */
export function interpolationEstimate(item, work, { gpu = null, cpuProfile = "cpu8", benchmark = null, band } = {}) {
  const runsOn = band ?? bandFor(item, gpu, cpuProfile);
  if (runsOn === "cloud") return { runsOn, seconds: null, cost: estimateCost(item, work.units), sizeFactor: work.sizeFactor };
  const perUnit = localSecondsPerUnit(item, gpu, { benchmark, cpuProfile });
  return {
    runsOn,
    seconds: perUnit === null ? null : Math.round(perUnit * work.units),
    cost: null,
    sizeFactor: work.sizeFactor,
  };
}
