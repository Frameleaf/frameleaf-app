/**
 * The local (white and green) stops of the model pickers (FL-189; prototype ModelSlider.jsx and
 * gpu-model-catalog.mjs `bandFor`). A local stop is a real choice: it writes the model setting of
 * that kind of work, and the ML container downloads the named model the first time
 * a job uses it. Only names the setting already accepts are offered, the same ones the Machine
 * learning settings list (`DESCRIPTION_MODEL_PROFILES` and `FALLBACK_MODEL_PROFILES`), so a stop
 * never names a model the container cannot fetch or load.
 *
 * Only descriptions has a local model setting (`machineLearning.imageDescription.modelName`).
 * Upscale and smooth motion have no local runner, and restoration and Studio AI run on dedicated
 * workers that bring their own pinned models, so those pickers have the blue band only.
 *
 * Bands follow the stored Hardware & GPU check of the ML container: green when the model fits its
 * GPU, white when it runs on the processor, and unavailable otherwise. Without a check every stop is
 * white, since nothing says which fit. Which models load at all depends on the ML image, not the GPU
 * (FL-427): the processor image has torch but no OpenVINO GenAI, the OpenVINO image the reverse.
 */
import type { HardwareCheckResponseDto } from '@frameleaf/sdk';
import { workerFromHardware, type RoutedWorkload } from '$lib/frameleaf/cloud-ml';
import type { DetectedGpu, RouteMode } from '$lib/frameleaf/gpu-model-catalog';

export type LocalModel = {
  /** The name the setting takes; the ML container downloads it the first time a job uses it. */
  value: string;
  name: string;
  /** The stop's short label. */
  short: string;
  /** GPU memory it needs, about, in GB. */
  vramGb: number;
  /**
   * The ML images (`mlImage`) that load it, and where it runs in each: `gpu` only on the image's GPU,
   * `any` on the GPU when it fits and on the processor otherwise. An image left out cannot load it.
   */
  images: Readonly<Partial<Record<string, 'gpu' | 'cpu' | 'any'>>>;
  noteKey: string;
};

// Florence runs on torch: the processor image's on the CPU, the CUDA image's on the GPU (or the CPU
// when CUDA is unavailable). Qwen runs on CUDA through torch, or as a converted OpenVINO build.
const FLORENCE = Object.freeze({ cpu: 'cpu', cuda: 'any' } as const);
const QWEN_CONVERTED = Object.freeze({ cuda: 'gpu', openvino: 'any' } as const);
const CUDA_ONLY = Object.freeze({ cuda: 'gpu' } as const);

/**
 * Description models, lightest first. The memory figures are the hints of the Machine learning
 * settings and the Image enrichment guide.
 */
export const LOCAL_DESCRIPTION_MODELS: readonly LocalModel[] = Object.freeze([
  {
    value: 'microsoft/Florence-2-base-ft',
    name: 'Florence-2 base',
    short: 'Florence-2 base',
    vramGb: 1,
    images: FLORENCE,
    noteKey: 'admin.frameleaf_model_local_note_florence',
  },
  {
    value: 'microsoft/Florence-2-large-ft',
    name: 'Florence-2 large',
    short: 'Florence-2 large',
    vramGb: 3,
    images: FLORENCE,
    noteKey: 'admin.frameleaf_model_local_note_florence',
  },
  {
    value: 'Qwen/Qwen2.5-VL-3B-Instruct',
    name: 'Qwen2.5-VL 3B',
    short: 'Qwen2.5 3B',
    vramGb: 6,
    images: QWEN_CONVERTED,
    noteKey: 'admin.frameleaf_model_local_note_qwen2_5_vl_3b',
  },
  {
    value: 'Qwen/Qwen2.5-VL-7B-Instruct',
    name: 'Qwen2.5-VL 7B',
    short: 'Qwen2.5 7B',
    vramGb: 16,
    images: QWEN_CONVERTED,
    noteKey: 'admin.frameleaf_model_local_note_qwen2_5_vl_7b',
  },
  {
    value: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
    name: 'Qwen3-VL 30B-A3B',
    short: 'Qwen3 30B',
    vramGb: 60,
    images: CUDA_ONLY,
    noteKey: 'admin.frameleaf_model_local_note_qwen3_vl_30b_a3b',
  },
  {
    value: 'Qwen/Qwen2.5-VL-32B-Instruct',
    name: 'Qwen2.5-VL 32B',
    short: 'Qwen2.5 32B',
    vramGb: 64,
    images: CUDA_ONLY,
    noteKey: 'admin.frameleaf_model_local_note_qwen2_5_vl_32b',
  },
  {
    value: 'Qwen/Qwen2.5-VL-72B-Instruct',
    name: 'Qwen2.5-VL 72B',
    short: 'Qwen2.5 72B',
    vramGb: 144,
    images: CUDA_ONLY,
    noteKey: 'admin.frameleaf_model_local_note_qwen2_5_vl_72b',
  },
]);

/** The local models a routed kind of work offers; empty where this server has no model setting for it. */
export const localModelsFor = (row: RoutedWorkload): readonly LocalModel[] =>
  row === 'descriptions' ? LOCAL_DESCRIPTION_MODELS : [];

/** What the stored Hardware & GPU check says about the ML container. */
export type LocalHardware = {
  /** A check reached the ML container and it reported its image; without both nothing says which fit. */
  known: boolean;
  gpu: DetectedGpu | null;
  /** The ML image flavour (cpu, cuda, openvino, rocm, …). */
  image: string | null;
};

export const localHardware = (check: HardwareCheckResponseDto | null | undefined): LocalHardware => ({
  known: !!check?.ml.reachable && !!check.mlImage,
  gpu: workerFromHardware(check).gpu,
  image: check?.mlImage ?? null,
});

export type LocalBand = 'cpu' | 'gpu' | 'none';

export type LocalReason =
  | { kind: 'memory'; needs: number; gpu: string; has: number }
  | { kind: 'memory-no-gpu'; needs: number }
  | { kind: 'image'; image: string }
  | { kind: 'cloud-only' };

export type LocalStop = {
  model: LocalModel;
  band: LocalBand;
  /** Why the stop cannot be chosen; null when it can. */
  reason: LocalReason | null;
};

const bandOf = (model: LocalModel, hardware: LocalHardware): { band: LocalBand; reason: LocalReason | null } => {
  if (!hardware.known || !hardware.image) {
    return { band: 'cpu', reason: null };
  }
  const { gpu, image } = hardware;
  const where = model.images[image];
  if (!where) {
    return { band: 'none', reason: { kind: 'image', image } };
  }
  if (where !== 'cpu' && gpu && gpu.vramGb >= model.vramGb) {
    return { band: 'gpu', reason: null };
  }
  if (where !== 'gpu') {
    return { band: 'cpu', reason: null };
  }
  return gpu
    ? { band: 'none', reason: { kind: 'memory', needs: model.vramGb, gpu: gpu.name, has: gpu.vramGb } }
    : { band: 'none', reason: { kind: 'memory-no-gpu', needs: model.vramGb } };
};

/** The local side of one picker: its stops and the setting they write. */
export type LocalSide = {
  stops: LocalStop[];
  /** The model name in the settings draft. */
  value: string;
  /** The saved model name; a different draft value waits for the settings bar. */
  saved: string;
  hardware: LocalHardware;
  /** Settings come from a configuration file, so they cannot be changed here. */
  disabled: boolean;
  onChoose: (value: string) => void;
};

/**
 * Every local stop with its band. Work set to Cloud only never uses this server's model, so its
 * local stops cannot be chosen there (the prototype's `positionState`).
 */
export const localStops = (models: readonly LocalModel[], hardware: LocalHardware, route: RouteMode): LocalStop[] =>
  models.map((model) => {
    const { band, reason } = bandOf(model, hardware);
    return { model, band, reason: reason ?? (route === 'cloud' ? { kind: 'cloud-only' } : null) };
  });
