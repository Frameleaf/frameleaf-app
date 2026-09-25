/**
 * GPU classes, per-workload model ladders, start fees and GPU set-up problems for Frameleaf Cloud
 * and this server's hardware (FL-159, CLD-201). Ported from the prototype's `gpu-model-catalog.mjs`
 * (design/frameleaf/template/src, effd05ffb7), which takes them from the cloud research
 * (`frameleaf-cloud/docs/research/model-gpu-matrix.json`, `pick` models only, and
 * `gpu-pricing.json`). Pure data and maths: no Svelte, no storage, no copy (every sentence a person
 * reads is an i18n key; see `modelNoteKey`, `gpuClassLabelKey`, `problemExplainKey`).
 *
 * Still estimates, not measurements: every speed class and the local seconds derived from them,
 * most VRAM figures of the newest models and most cloud seconds per unit. The benchmark on
 * Hardware & GPU replaces local seconds for this server; the cloud catalogue replaces the rest.
 *
 * Studio exports render at home only (this server or a home-network worker, §2.7): the `render`
 * ladder has no cloud position.
 */

/** Customers pay this multiple of the fully loaded GPU cost, for GPU time and the start fee alike. */
export const PRICE_MULTIPLIER = 2;
/** Loaded cost = provider flex rate × runtime overhead × payment allowance. */
export const PAYMENT_ALLOWANCE = 1.07;
export const MAX_CHUNK_WORKERS = 5;
export const CHUNK_SECONDS = 30;

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const ceilCents = (value: number) => Math.ceil(round(value * 100, 6)) / 100;

export type GpuClassId = 'gpu24' | 'gpu24pro' | 'gpu48pro' | 'gpu80pro' | 'gpu141';

export type GpuClass = Readonly<{
  id: GpuClassId;
  vramGb: number;
  flexUsdPerSec: number;
  /** Our fully loaded cost per second of serverless GPU time. */
  loadedUsdPerSec: number;
  /** What a customer pays per second of measured GPU time: PRICE_MULTIPLIER × the loaded cost. */
  customerUsdPerSec: number;
}>;

const gpuClass = (id: GpuClassId, vramGb: number, flexUsdPerSec: number, runtimeOverhead: number): GpuClass => {
  const loadedUsdPerSec = round(flexUsdPerSec * runtimeOverhead * PAYMENT_ALLOWANCE, 8);
  return Object.freeze({
    id,
    vramGb,
    flexUsdPerSec,
    loadedUsdPerSec,
    customerUsdPerSec: round(loadedUsdPerSec * PRICE_MULTIPLIER, 8),
  });
};

/** Serverless GPU classes on Frameleaf Cloud (flex rates from the pricing research). */
export const gpuClasses: readonly GpuClass[] = Object.freeze([
  gpuClass('gpu24', 24, 0.00019167, 1.25),
  gpuClass('gpu24pro', 24, 0.00030556, 1.25),
  gpuClass('gpu48pro', 48, 0.00048611, 1.25),
  gpuClass('gpu80pro', 80, 0.00133056, 1.3),
  gpuClass('gpu141', 141, 0.00164722, 1.3),
]);

export const gpuClassById = (id: string) => gpuClasses.find((item) => item.id === id) ?? null;
export const gpuClassLabelKey = (id: GpuClassId) => `frameleaf_gpu_class_${id}` as const;

export type FeeClassId = 'small-24' | 'small-48' | 'vlm-7b' | 'vlm-32b' | 'vlm-72b' | 'video-diffusion';

/**
 * Start fee per worker, by model size class: covers cold start (p90) plus the idle tail, at
 * 2 × 1.07 × provider rate, rounded up to the cent.
 */
export const startFees: Readonly<
  Record<FeeClassId, Readonly<{ gpuClass: GpuClassId; customerUsd: number; coldStartP90: number }>>
> = Object.freeze({
  'small-24': Object.freeze({ gpuClass: 'gpu24pro', customerUsd: 0.05, coldStartP90: 60 }),
  'small-48': Object.freeze({ gpuClass: 'gpu48pro', customerUsd: 0.1, coldStartP90: 90 }),
  'vlm-7b': Object.freeze({ gpuClass: 'gpu48pro', customerUsd: 0.2, coldStartP90: 180 }),
  'vlm-32b': Object.freeze({ gpuClass: 'gpu80pro', customerUsd: 0.87, coldStartP90: 300 }),
  'vlm-72b': Object.freeze({ gpuClass: 'gpu141', customerUsd: 1.71, coldStartP90: 480 }),
  'video-diffusion': Object.freeze({ gpuClass: 'gpu80pro', customerUsd: 0.45, coldStartP90: 150 }),
});

// ------------------------------------------------------------------ workloads

export type LadderWorkload = 'descriptions' | 'upscale' | 'restoration' | 'studio' | 'render' | 'interpolation';

/** How many units a price label quotes, which container runs the work locally, and whether video is chunked. */
export const workloadUnits: Readonly<
  Record<LadderWorkload, Readonly<{ per: number; container: 'ml' | 'server'; chunked?: boolean }>>
> = Object.freeze({
  descriptions: { per: 100, container: 'ml' },
  upscale: { per: 1, container: 'ml' },
  restoration: { per: 1, container: 'ml', chunked: true },
  studio: { per: 1, container: 'ml' },
  render: { per: 1, container: 'server' },
  interpolation: { per: 1, container: 'ml', chunked: true },
});

export const LADDER_WORKLOADS = Object.freeze(Object.keys(workloadUnits) as LadderWorkload[]);

/** The unit a workload is billed and timed in, as an i18n key taking `{count}`. */
export const workloadUnitKey = (workload: LadderWorkload) => `frameleaf_cloud_unit_${workload}` as const;

/** GPU profiles the research rates models against; `cpu8` and `mac_docker` are processor-only hosts. */
export type GpuProfileId =
  'cpu8' | 'mac_docker' | 'gtx1650_4' | 'rtx3060_12' | 'rtx4070_12' | 'rtx4090_24' | 'arc_a770_16' | 'rx7900xtx_24';
const PROFILE_ORDER: readonly GpuProfileId[] = [
  'cpu8',
  'gtx1650_4',
  'rtx3060_12',
  'rtx4070_12',
  'rtx4090_24',
  'arc_a770_16',
  'rx7900xtx_24',
  'mac_docker',
];

/**
 * The research profile a detected GPU matches, by name and memory, or null (the memory check
 * decides then). Detection reports what the container sees; nothing here guesses a card.
 */
export const gpuProfileFor = (name: string | null | undefined, vramGb: number): GpuProfileId | null => {
  const model = (name ?? '').toLowerCase();
  const rules: Array<[RegExp, GpuProfileId]> = [
    [/gtx\s*1650/, 'gtx1650_4'],
    [/rtx\s*3060/, 'rtx3060_12'],
    [/rtx\s*4070/, 'rtx4070_12'],
    [/rtx\s*4090/, 'rtx4090_24'],
    [/arc\s*a770/, 'arc_a770_16'],
    [/7900\s*xtx/, 'rx7900xtx_24'],
  ];
  const match = rules.find(([pattern]) => pattern.test(model));
  return match && vramGb > 0 ? match[1] : null;
};

export type SpeedClass = 'fast' | 'ok' | 'slow' | 'no';
const CLASS: Readonly<Record<string, SpeedClass>> = { F: 'fast', O: 'ok', S: 'slow', N: 'no' };
/** Research speed classes in PROFILE_ORDER, e.g. "OFFFFFOO" (estimates). */
const speeds = (code: string) =>
  Object.freeze(Object.fromEntries(PROFILE_ORDER.map((id, index) => [id, CLASS[code[index]]]))) as Readonly<
    Record<GpuProfileId, SpeedClass>
  >;

/** Local seconds per unit for each speed class (estimates; the benchmark replaces them). */
const classSeconds: Readonly<Record<LadderWorkload, Record<'fast' | 'ok' | 'slow', number>>> = Object.freeze({
  descriptions: { fast: 1.5, ok: 5, slow: 20 },
  upscale: { fast: 3, ok: 12, slow: 60 },
  restoration: { fast: 50, ok: 240, slow: 1500 },
  studio: { fast: 3, ok: 15, slow: 60 },
  render: { fast: 20, ok: 90, slow: 300 },
  // Doubling the frame rate of one minute of 1080p video (estimates).
  interpolation: { fast: 25, ok: 120, slow: 600 },
});
type SizeClass = 'cpu' | 'tiny' | 'small' | 'medium' | 'large' | 'xl';
const sizeFactor: Readonly<Record<SizeClass, number>> = Object.freeze({
  cpu: 0.5,
  tiny: 0.7,
  small: 1,
  medium: 1.3,
  large: 1.8,
  xl: 2.5,
});

export type CloudOffer = Readonly<{
  gpuClass: GpuClassId;
  feeClass: FeeClassId;
  secondsPerUnit: Readonly<{ p50: number; p90: number }>;
}>;

/**
 * One model position on a workload ladder (light → heavy). `commercialHosted` "no" is never
 * offered on the cloud; every position here is "yes" today and the rule is kept for the catalogue.
 */
export type ModelPosition = Readonly<{
  workload: LadderWorkload;
  id: string;
  name: string;
  short: string;
  params: string | null;
  sizeClass: SizeClass;
  licence: string;
  /** Has a licence note (an i18n key, `modelLicenceNoteKey`). */
  licenceNote: boolean;
  commercialHosted: 'yes' | 'conditions' | 'no';
  cpuFeasible: boolean;
  vramGb: Readonly<Partial<Record<'fp16' | 'int8' | 'int4', number>>>;
  speed: Readonly<Partial<Record<GpuProfileId, SpeedClass>>>;
  cloud: CloudOffer | null;
  retiresOn: string | null;
}>;

type PositionSpec = {
  id: string;
  name: string;
  short: string;
  params: string | null;
  sizeClass: SizeClass;
  licence: string;
  licenceNote?: boolean;
  cpuFeasible?: boolean;
  vramGb: ModelPosition['vramGb'];
  speed: ModelPosition['speed'];
  cloud: CloudOffer | null;
};

const position = (workload: LadderWorkload, spec: PositionSpec): ModelPosition =>
  Object.freeze({
    workload,
    commercialHosted: 'yes',
    cpuFeasible: false,
    retiresOn: null,
    ...spec,
    licenceNote: spec.licenceNote ?? false,
  });
const cloud = (gpuClassId: GpuClassId, feeClass: FeeClassId, p50: number, p90: number): CloudOffer =>
  Object.freeze({ gpuClass: gpuClassId, feeClass, secondsPerUnit: Object.freeze({ p50, p90 }) });

const noteKeyOf = (id: string) =>
  id
    .replace(/@\d+$/, '')
    .replaceAll(/[^a-z0-9]+/gi, '_')
    .toLowerCase();
/** What a model is good for, one plain sentence. */
export const modelNoteKey = (item: Pick<ModelPosition, 'id'>) => `frameleaf_model_note_${noteKeyOf(item.id)}`;
/** A licence condition worth saying next to the model (attribution, languages). */
export const modelLicenceNoteKey = (item: Pick<ModelPosition, 'id'>) =>
  `frameleaf_model_licence_note_${noteKeyOf(item.id)}`;

/** Every model position, light → heavy per workload. Only the research's `pick` models appear. */
export const modelLadders: Readonly<Record<LadderWorkload, readonly ModelPosition[]>> = Object.freeze({
  descriptions: Object.freeze([
    position('descriptions', {
      id: 'florence2-large@1',
      name: 'Florence-2 Large',
      short: 'Florence-2',
      params: '0.77B',
      sizeClass: 'cpu',
      licence: 'MIT',
      cpuFeasible: true,
      vramGb: { fp16: 2, int8: 1.2 },
      speed: speeds('OFFFFFOO'),
      cloud: cloud('gpu24', 'small-24', 0.1, 0.12),
    }),
    position('descriptions', {
      id: 'moondream2@1',
      name: 'moondream2',
      short: 'moondream2',
      params: '1.9B',
      sizeClass: 'cpu',
      licence: 'Apache-2.0',
      cpuFeasible: true,
      vramGb: { fp16: 4.5, int8: 2.8, int4: 2 },
      speed: speeds('SFFFFFFO'),
      cloud: cloud('gpu24pro', 'small-24', 0.25, 0.3),
    }),
    position('descriptions', {
      id: 'qwen3.5-2b@1',
      name: 'Qwen3.5 2B',
      short: 'Qwen3.5 2B',
      params: '2B',
      sizeClass: 'tiny',
      licence: 'Apache-2.0',
      cpuFeasible: true,
      vramGb: { fp16: 5.5, int8: 3.5, int4: 2.5 },
      speed: speeds('SOFFFFFS'),
      cloud: cloud('gpu24pro', 'small-24', 0.3, 0.36),
    }),
    position('descriptions', {
      id: 'qwen3.5-4b@1',
      name: 'Qwen3.5 4B',
      short: 'Qwen3.5 4B',
      params: '4.7B',
      sizeClass: 'small',
      licence: 'Apache-2.0',
      cpuFeasible: true,
      vramGb: { fp16: 11, int8: 6.5, int4: 4 },
      speed: speeds('SSFFFOFS'),
      cloud: cloud('gpu48pro', 'vlm-7b', 0.4, 0.48),
    }),
    position('descriptions', {
      id: 'gemma4-e4b@1',
      name: 'Gemma 4 E4B',
      short: 'Gemma 4 E4B',
      params: '4B',
      sizeClass: 'small',
      licence: 'Apache-2.0',
      cpuFeasible: true,
      vramGb: { fp16: 17.9, int8: 8.9, int4: 4.5 },
      speed: speeds('SSOOFFOS'),
      cloud: cloud('gpu48pro', 'vlm-7b', 0.45, 0.54),
    }),
    position('descriptions', {
      id: 'qwen3.5-9b@1',
      name: 'Qwen3.5 9B',
      short: 'Qwen3.5 9B',
      params: '9.7B',
      sizeClass: 'medium',
      licence: 'Apache-2.0',
      vramGb: { fp16: 21, int8: 12, int4: 7.5 },
      speed: speeds('NNOOFFOS'),
      cloud: cloud('gpu48pro', 'vlm-7b', 0.5, 0.59),
    }),
    position('descriptions', {
      id: 'gemma4-12b@1',
      name: 'Gemma 4 12B',
      short: 'Gemma 4 12B',
      params: '12B',
      sizeClass: 'medium',
      licence: 'Apache-2.0',
      vramGb: { fp16: 26.7, int8: 13.4, int4: 6.7 },
      speed: speeds('NNOOFFOS'),
      cloud: cloud('gpu48pro', 'vlm-7b', 0.65, 0.78),
    }),
    position('descriptions', {
      id: 'qwen3.5-27b@1',
      name: 'Qwen3.5 27B',
      short: 'Qwen3.5 27B',
      params: '28B',
      sizeClass: 'large',
      licence: 'Apache-2.0',
      vramGb: { fp16: 60, int8: 32, int4: 18 },
      speed: speeds('NNNNSNSN'),
      cloud: cloud('gpu80pro', 'vlm-32b', 1.25, 1.4),
    }),
    position('descriptions', {
      id: 'qwen3.5-35b-a3b@1',
      name: 'Qwen3.5 35B-A3B',
      short: 'Qwen3.5 35B',
      params: '35B (3B active)',
      sizeClass: 'large',
      licence: 'Apache-2.0',
      vramGb: { fp16: 75, int8: 39, int4: 22 },
      speed: speeds('SNNNONOS'),
      cloud: cloud('gpu80pro', 'vlm-32b', 0.6, 0.72),
    }),
    position('descriptions', {
      id: 'qwen3.5-122b-a10b@1',
      name: 'Qwen3.5 122B-A10B',
      short: 'Qwen3.5 122B',
      params: '122B',
      sizeClass: 'xl',
      licence: 'Apache-2.0',
      vramGb: { fp16: 255, int8: 130, int4: 70 },
      speed: speeds('NNNNNNNN'),
      cloud: cloud('gpu80pro', 'vlm-72b', 1.5, 1.8),
    }),
  ]),
  upscale: Object.freeze([
    position('upscale', {
      id: 'realesr-general-x4v3@1',
      name: 'Real-ESRGAN compact ×4',
      short: 'ESRGAN compact',
      params: '1.2M',
      sizeClass: 'cpu',
      licence: 'BSD-3-Clause',
      cpuFeasible: true,
      vramGb: { fp16: 0.5 },
      speed: speeds('OFFFFFFO'),
      cloud: cloud('gpu24pro', 'small-24', 4, 4.8),
    }),
    position('upscale', {
      id: 'realesrgan-x4plus@1',
      name: 'Real-ESRGAN ×4',
      short: 'Real-ESRGAN',
      params: '16.7M',
      sizeClass: 'small',
      licence: 'BSD-3-Clause',
      cpuFeasible: true,
      vramGb: { fp16: 1.5 },
      speed: speeds('SOFFFFFS'),
      cloud: cloud('gpu24pro', 'small-24', 15, 16.5),
    }),
    position('upscale', {
      id: 'gfpgan-v1.4@1',
      name: 'GFPGAN faces',
      short: 'GFPGAN',
      params: '80M',
      sizeClass: 'small',
      licence: 'Apache-2.0',
      cpuFeasible: true,
      vramGb: { fp16: 2 },
      speed: speeds('SFFFFFFO'),
      cloud: cloud('gpu24pro', 'small-24', 3, 3.6),
    }),
    position('upscale', {
      id: 'hat-real-gan@1',
      name: 'HAT ×4',
      short: 'HAT',
      params: '20.8M',
      sizeClass: 'medium',
      licence: 'Apache-2.0',
      cpuFeasible: true,
      vramGb: { fp16: 3 },
      speed: speeds('NSOOFFOS'),
      cloud: cloud('gpu48pro', 'small-48', 90, 92),
    }),
    position('upscale', {
      id: 'seedvr2-3b-image@1',
      name: 'SeedVR2 3B · photo',
      short: 'SeedVR2 3B',
      params: '3B',
      sizeClass: 'large',
      licence: 'Apache-2.0',
      vramGb: { fp16: 18, int8: 10, int4: 7 },
      speed: speeds('NNSSONSS'),
      cloud: cloud('gpu80pro', 'video-diffusion', 12, 14.4),
    }),
    position('upscale', {
      id: 'seedvr2-7b-image@1',
      name: 'SeedVR2 7B · photo',
      short: 'SeedVR2 7B',
      params: '7B',
      sizeClass: 'xl',
      licence: 'Apache-2.0',
      vramGb: { fp16: 32, int8: 18, int4: 10 },
      speed: speeds('NNNNSNSN'),
      cloud: cloud('gpu80pro', 'video-diffusion', 25, 30),
    }),
  ]),
  restoration: Object.freeze([
    position('restoration', {
      id: 'realbasicvsr@1',
      name: 'RealBasicVSR',
      short: 'RealBasicVSR',
      params: '6.3M',
      sizeClass: 'small',
      licence: 'Apache-2.0',
      vramGb: { fp16: 4 },
      speed: speeds('NSOOFFOS'),
      cloud: cloud('gpu48pro', 'small-48', 270, 280),
    }),
    position('restoration', {
      id: 'seedvr2-3b@1',
      name: 'SeedVR2 3B',
      short: 'SeedVR2 3B',
      params: '3B',
      sizeClass: 'large',
      licence: 'Apache-2.0',
      vramGb: { fp16: 24, int8: 14, int4: 9 },
      speed: speeds('NNNSOONS'),
      cloud: cloud('gpu80pro', 'video-diffusion', 2808, 2890),
    }),
    position('restoration', {
      id: 'seedvr2-7b@1',
      name: 'SeedVR2 7B',
      short: 'SeedVR2 7B',
      params: '7B',
      sizeClass: 'xl',
      licence: 'Apache-2.0',
      vramGb: { fp16: 40, int8: 24, int4: 14 },
      speed: speeds('NNNNNNNN'),
      cloud: cloud('gpu80pro', 'video-diffusion', 5616, 6739.2),
    }),
  ]),
  studio: Object.freeze([
    position('studio', {
      id: 'whisper-small@1',
      name: 'Whisper small',
      short: 'Whisper small',
      params: '244M',
      sizeClass: 'cpu',
      licence: 'MIT',
      cpuFeasible: true,
      vramGb: { fp16: 1.5, int8: 1 },
      speed: speeds('OFFFFFFF'),
      cloud: cloud('gpu24', 'small-24', 1, 1.2),
    }),
    position('studio', {
      id: 'parakeet-tdt-0.6b-v3@1',
      licenceNote: true,
      name: 'Parakeet 0.6B',
      short: 'Parakeet',
      params: '600M',
      sizeClass: 'small',
      licence: 'CC-BY-4.0',
      cpuFeasible: true,
      vramGb: { fp16: 2.5 },
      speed: speeds('OFFFFNNS'),
      cloud: cloud('gpu24', 'small-24', 0.5, 0.6),
    }),
    position('studio', {
      id: 'whisper-large-v3-turbo@1',
      name: 'Whisper large-v3 turbo',
      short: 'Whisper turbo',
      params: '809M',
      sizeClass: 'medium',
      licence: 'MIT',
      cpuFeasible: true,
      vramGb: { fp16: 2.5, int8: 1.6 },
      speed: speeds('SFFFFFFF'),
      cloud: cloud('gpu24', 'small-24', 1.8, 2.16),
    }),
    position('studio', {
      id: 'whisper-large-v3@1',
      name: 'Whisper large-v3',
      short: 'Whisper large',
      params: '1.55B',
      sizeClass: 'large',
      licence: 'MIT',
      cpuFeasible: true,
      vramGb: { fp16: 4.5, int8: 2.9 },
      speed: speeds('SOFFFFFF'),
      cloud: cloud('gpu24', 'small-24', 3.1, 3.4),
    }),
  ]),
  interpolation: Object.freeze([
    position('interpolation', {
      id: 'rife-4.25@1',
      name: 'RIFE 4.25',
      short: 'RIFE',
      params: '10M',
      sizeClass: 'small',
      licence: 'MIT',
      cpuFeasible: true,
      vramGb: { fp16: 1.5 },
      speed: speeds('SFFFFFFO'),
      cloud: cloud('gpu24pro', 'small-24', 20, 24),
    }),
    position('interpolation', {
      id: 'film@1',
      licenceNote: true,
      name: 'FILM',
      short: 'FILM',
      params: '34M',
      sizeClass: 'medium',
      licence: 'Apache-2.0',
      cpuFeasible: true,
      vramGb: { fp16: 6 },
      speed: speeds('NNOOFFSS'),
      cloud: cloud('gpu24pro', 'small-24', 480, 576),
    }),
  ]),
  render: Object.freeze([
    position('render', {
      id: 'render-software@1',
      name: 'Software encode',
      short: 'Software',
      params: null,
      sizeClass: 'cpu',
      licence: 'LGPL (encoder library)',
      cpuFeasible: true,
      vramGb: {},
      speed: speeds('ONNNNNNO'),
      cloud: null,
    }),
    position('render', {
      id: 'render-hardware@1',
      name: 'Hardware encode',
      short: 'Hardware',
      params: null,
      sizeClass: 'small',
      licence: 'LGPL (encoder library)',
      vramGb: { fp16: 1 },
      speed: speeds('NFFFFFFN'),
      cloud: null,
    }),
  ]),
});

/**
 * Local-only work (never offered on the cloud). Faces keep InsightFace buffalo_l under a commercial
 * licence Frameleaf holds (§2.8); search and text recognition stay on this server.
 */
export const localOnlyModels = Object.freeze({
  search: Object.freeze([{ id: 'clip-vit-b-32', name: 'CLIP ViT-B-32', licence: 'MIT' }]),
  faces: Object.freeze([{ id: 'insightface-buffalo_l', name: 'InsightFace buffalo_l', licence: 'commercial' }]),
  ocr: Object.freeze([{ id: 'pp-ocrv5-mobile', name: 'PP-OCRv5 mobile', licence: 'Apache-2.0' }]),
});

export const ladderFor = (workload: LadderWorkload): readonly ModelPosition[] => modelLadders[workload] ?? [];

export const positionById = (id: string | null | undefined): ModelPosition | null => {
  if (!id) {
    return null;
  }
  for (const ladder of Object.values(modelLadders)) {
    const found = ladder.find((item) => item.id === id);
    if (found) {
      return found;
    }
  }
  return null;
};

/**
 * Models that stay on this server only (FL-146 owner decisions, 2026-09-25): the nllb-clip search
 * models (base and large, every variant; CC-BY-NC-4.0), MusicGen-small (CC-BY-NC-4.0) and
 * Qwen2.5-VL-3B-Instruct (Qwen Research License, including its OpenVINO conversion). They are never
 * offered on Frameleaf Cloud, whatever a catalogue says; the server refuses a cloud job for them too.
 */
const LOCAL_ONLY_MODEL = /nllb-clip|musicgen-small|qwen2\.5-vl-3b/i;
export const isLocalOnlyModel = (id: string | null | undefined) => !!id && LOCAL_ONLY_MODEL.test(id);

/** Positions Frameleaf Cloud may host: offered on the cloud, licensed for hosted use, not local only. */
export const isCloudOffered = (item: ModelPosition | null | undefined): item is ModelPosition & { cloud: CloudOffer } =>
  !!item?.cloud && item.commercialHosted !== 'no' && !isLocalOnlyModel(item.id);

export const cloudPositions = (workload?: LadderWorkload) =>
  (workload ? ladderFor(workload) : Object.values(modelLadders).flat()).filter((item) => isCloudOffered(item));

/** Smallest GPU memory the model needs at any precision (null when it has no GPU path). */
export const minVramGb = (item: Pick<ModelPosition, 'vramGb'> | null | undefined): number | null => {
  const values = Object.values(item?.vramGb ?? {}).filter((value): value is number => Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : null;
};

// ------------------------------------------------------------------ bands

export type Band = 'cpu' | 'gpu' | 'cloud' | 'none';

/** Where a stop runs: its colour, icon and i18n label. The label and icon always travel with the colour. */
export const BANDS: Readonly<Record<Band, Readonly<{ id: Band; color: string; icon: string; labelKey: string }>>> =
  Object.freeze({
    cpu: { id: 'cpu', color: 'white', icon: 'mdiChip', labelKey: 'frameleaf_model_band_cpu' },
    gpu: { id: 'gpu', color: 'green', icon: 'mdiExpansionCard', labelKey: 'frameleaf_model_band_gpu' },
    cloud: { id: 'cloud', color: 'blue', icon: 'mdiCloudOutline', labelKey: 'frameleaf_model_band_cloud' },
    none: { id: 'none', color: 'none', icon: 'mdiCancel', labelKey: 'frameleaf_model_band_none' },
  });

/** A GPU a container can use, as the hardware check reports it. */
export type DetectedGpu = { name: string; vramGb: number; backend: string; profile: GpuProfileId | null };

/** Speed class of a model on a GPU; falls back to a memory check for profiles the research does not rate. */
export const speedOn = (item: ModelPosition, gpu: DetectedGpu | null): SpeedClass => {
  if (!gpu) {
    return 'no';
  }
  const rated = gpu.profile ? item.speed[gpu.profile] : undefined;
  if (rated) {
    return rated;
  }
  const need = minVramGb(item);
  return need !== null && gpu.vramGb >= need ? 'ok' : 'no';
};

/** Speed class on this host's processor ("no" unless the research marks the model CPU-feasible). */
export const cpuSpeed = (item: ModelPosition, cpuProfile: GpuProfileId = 'cpu8'): SpeedClass => {
  if (!item.cpuFeasible) {
    return 'no';
  }
  return item.speed[cpuProfile] ?? item.speed.cpu8 ?? 'slow';
};

/**
 * Where a model runs for the detected hardware: "gpu" (green) on the GPU, "cpu" (white) when it has
 * a processor path, "cloud" (blue) when Frameleaf Cloud may host it, else "none".
 */
export const bandFor = (
  item: ModelPosition | null,
  gpu: DetectedGpu | null,
  cpuProfile: GpuProfileId = 'cpu8',
): Band => {
  if (!item) {
    return 'none';
  }
  if (speedOn(item, gpu) !== 'no') {
    return 'gpu';
  }
  if (cpuSpeed(item, cpuProfile) !== 'no') {
    return 'cpu';
  }
  return isCloudOffered(item) ? 'cloud' : 'none';
};

// ------------------------------------------------------------------ estimates

/** Measured speed factors from this server's benchmark, per model id (1 = as estimated). */
export type Benchmark = { ranAt: string; factors: Readonly<Record<string, number>> };

/** Local seconds per unit (estimate from the speed class; the benchmark refines it). */
export const localSecondsPerUnit = (
  item: ModelPosition,
  gpu: DetectedGpu | null,
  { benchmark = null, cpuProfile = 'cpu8' }: { benchmark?: Benchmark | null; cpuProfile?: GpuProfileId } = {},
): number | null => {
  const band = bandFor(item, gpu, cpuProfile);
  if (band !== 'gpu' && band !== 'cpu') {
    return null;
  }
  const speedClass = band === 'gpu' ? speedOn(item, gpu) : cpuSpeed(item, cpuProfile);
  if (speedClass === 'no') {
    return null;
  }
  const base = classSeconds[item.workload][speedClass] * (sizeFactor[item.sizeClass] ?? 1);
  const factor = benchmark?.factors[item.id] ?? 1;
  return round(base * factor, 2);
};

/** Serverless workers a job fans out to: video runs in 30 s chunks on up to 5 workers. */
export const workersFor = (item: ModelPosition, units: number) => {
  if (!workloadUnits[item.workload]?.chunked) {
    return 1;
  }
  const chunks = Math.max(1, Math.ceil((units * 60) / CHUNK_SECONDS));
  return Math.min(MAX_CHUNK_WORKERS, chunks);
};

export type CostEstimate = {
  item: ModelPosition;
  gpuClass: GpuClass;
  rate: number;
  startFee: number;
  workers: number;
  chunkSeconds: number | null;
  workSeconds: { p50: number; p90: number };
  perUnit: { p50: number; p90: number };
  p50: number;
  p90: number;
  hold: number;
};

/**
 * Cloud cost of a job: start fee × workers + units × seconds per unit × rate, where rate and start
 * fee are both 2× our loaded cost. p50 is typical, p90 the high end, and the wallet hold is p90
 * rounded up to the cent (§2.4).
 */
export const estimateCost = (itemOrId: ModelPosition | string | null, quantity: number): CostEstimate | null => {
  const item = typeof itemOrId === 'string' ? positionById(itemOrId) : itemOrId;
  const units = quantity;
  if (!isCloudOffered(item) || !Number.isFinite(units) || units <= 0) {
    return null;
  }
  const gpu = gpuClassById(item.cloud.gpuClass);
  const fee = startFees[item.cloud.feeClass];
  if (!gpu || !fee) {
    return null;
  }
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
};

/** Typical GPU-time cost for the number of units a label quotes (e.g. per 100 photos), start fee excluded. */
export const quotedUnitCost = (item: ModelPosition | null) => {
  if (!isCloudOffered(item)) {
    return null;
  }
  const per = workloadUnits[item.workload]?.per ?? 1;
  const gpu = gpuClassById(item.cloud.gpuClass);
  return gpu ? { per, usd: item.cloud.secondsPerUnit.p50 * gpu.customerUsdPerSec * per } : null;
};

/** The range of start fees, for the billing explainer. */
export const startFeeRange = () => {
  const fees = Object.values(startFees).map((fee) => fee.customerUsd);
  return { min: Math.min(...fees), max: Math.max(...fees) };
};

// ------------------------------------------------------------------ positions on a slider

export type RouteMode = 'local' | 'both' | 'cloud';

/** Why a stop cannot be chosen, as an i18n key with its values. */
export type StopReason =
  | { key: 'frameleaf_model_reason_needs_memory'; values: { name: string; needs: number; gpu: string; has: number } }
  | { key: 'frameleaf_model_reason_needs_memory_no_gpu'; values: { name: string; needs: number } }
  | { key: 'frameleaf_model_reason_not_hosted'; values: { name: string } }
  | { key: 'frameleaf_model_reason_licence'; values: { name: string } }
  | { key: 'frameleaf_model_reason_local_only'; values: Record<string, never> }
  | { key: 'frameleaf_model_reason_cloud_only'; values: Record<string, never> };

export type PositionState = {
  item: ModelPosition;
  band: Band;
  runsOn: 'local' | 'cloud' | null;
  speedClass: SpeedClass;
  /** Local seconds per unit, for the CPU and GPU bands. */
  seconds: number | null;
  /** Measured by this server's benchmark rather than estimated. */
  measured: boolean;
  /** Typical cloud cost for the quoted number of units, for the cloud band. */
  quote: { per: number; usd: number } | null;
  reasons: StopReason[];
  disabled: boolean;
};

/**
 * Everything a slider stop shows: band, speed or cost, and whether it can be chosen for the
 * workload's route (§3.3). With "cloud", models that would run here move to the cloud when
 * Frameleaf Cloud may host them, and are disabled otherwise; with "local", cloud stops are crossed
 * out with the reason. Non-commercial licences never reach the blue band (`isCloudOffered`).
 */
export const positionState = (
  item: ModelPosition,
  {
    gpu = null,
    route = 'both',
    benchmark = null,
    cpuProfile = 'cpu8',
  }: { gpu?: DetectedGpu | null; route?: RouteMode; benchmark?: Benchmark | null; cpuProfile?: GpuProfileId } = {},
): PositionState => {
  const natural = bandFor(item, gpu, cpuProfile);
  const band: Band =
    route === 'cloud' && natural !== 'cloud' && natural !== 'none' && isCloudOffered(item) ? 'cloud' : natural;
  const local = band === 'gpu' || band === 'cpu';
  const speedClass = band === 'gpu' ? speedOn(item, gpu) : band === 'cpu' ? cpuSpeed(item, cpuProfile) : 'no';
  const reasons: StopReason[] = [];
  if (band === 'none') {
    const needs = minVramGb(item);
    if (needs !== null) {
      reasons.push(
        gpu
          ? {
              key: 'frameleaf_model_reason_needs_memory',
              values: { name: item.name, needs, gpu: gpu.name, has: gpu.vramGb },
            }
          : { key: 'frameleaf_model_reason_needs_memory_no_gpu', values: { name: item.name, needs } },
      );
    }
    reasons.push(
      item.commercialHosted === 'no'
        ? { key: 'frameleaf_model_reason_licence', values: { name: item.name } }
        : { key: 'frameleaf_model_reason_not_hosted', values: { name: item.name } },
    );
  } else if (band === 'cloud' && route === 'local') {
    reasons.push({ key: 'frameleaf_model_reason_local_only', values: {} });
  } else if (band !== 'cloud' && route === 'cloud') {
    reasons.push({ key: 'frameleaf_model_reason_cloud_only', values: {} });
  }
  return {
    item,
    band,
    runsOn: band === 'cloud' ? 'cloud' : band === 'none' ? null : 'local',
    speedClass,
    seconds: local ? localSecondsPerUnit(item, gpu, { benchmark, cpuProfile }) : null,
    measured: local && benchmark?.factors[item.id] !== undefined,
    quote: band === 'cloud' ? quotedUnitCost(item) : null,
    reasons,
    disabled: reasons.length > 0,
  };
};

/**
 * The model a kind of work uses on Frameleaf Cloud when nothing is chosen (FL-146): a commercially
 * licensed catalogue pick. Descriptions use Qwen3.5 9B (Apache-2.0): rich descriptions with strong
 * text reading, and the pricing research's worked example (about $0.85 per 1,000 photos).
 */
export const CLOUD_DEFAULT_MODELS: Readonly<Partial<Record<LadderWorkload, string>>> = Object.freeze({
  descriptions: 'qwen3.5-9b@1',
});

export const ladderStates = (workload: LadderWorkload, options: Parameters<typeof positionState>[1] = {}) =>
  ladderFor(workload).map((item) => positionState(item, options));

/**
 * The position to use: the saved choice when it can be chosen, otherwise the heaviest position that
 * runs at a usable speed here, otherwise the cloud default (`CLOUD_DEFAULT_MODELS`) or the lightest
 * cloud one. Only a known model that no longer
 * fits counts as a fallback; retired ids just reset.
 */
export const resolvePosition = (
  workload: LadderWorkload,
  savedId: string | null | undefined,
  options: Parameters<typeof positionState>[1] = {},
): (PositionState & { fallback: boolean }) | null => {
  const states = ladderStates(workload, options);
  const saved = states.find((entry) => entry.item.id === savedId);
  if (saved && !saved.disabled) {
    return { ...saved, fallback: false };
  }
  const enabled = states.filter((entry) => !entry.disabled);
  const local = enabled.filter((entry) => entry.runsOn === 'local');
  const usable = local.filter((entry) => entry.speedClass !== 'slow' && entry.band !== 'cpu');
  const cloud = enabled.filter((entry) => entry.runsOn === 'cloud');
  const pick =
    usable.at(-1) ??
    local[0] ??
    cloud.find((entry) => entry.item.id === CLOUD_DEFAULT_MODELS[workload]) ??
    cloud[0] ??
    null;
  return pick ? { ...pick, fallback: !!saved && savedId !== pick.item.id } : null;
};

// ------------------------------------------------------------------ problems & fixes

export type ComposeFixId = 'nvidia' | 'intel' | 'amd' | 'wsl2';
export type ComposeFix = { title: string; steps: number; yaml: string };
export type GpuProblem = { id: string; vendor: string; symptom: string; fix: ComposeFixId | null };

/** The plain-language explanation of a set-up problem (first sentence is its heading). */
export const problemExplainKey = (id: string) => `frameleaf_hardware_problem_${id.replaceAll('-', '_')}`;
/** One step of a compose fix, 1-based. */
export const fixStepKey = (id: ComposeFixId, step: number) => `frameleaf_hardware_fix_${id}_step_${step}`;

/**
 * Common GPU set-up problems with the log line people see and the fix that resolves them (from the
 * detection research; 19 cases condensed for people, not logs).
 */
export const gpuProblems: readonly GpuProblem[] = Object.freeze([
  {
    id: 'nvidia-toolkit',
    vendor: 'NVIDIA',
    symptom: 'could not select device driver "nvidia" with capabilities: [[gpu]]',
    fix: 'nvidia',
  },
  { id: 'nvidia-runtime', vendor: 'NVIDIA', symptom: 'unknown or invalid runtime name: nvidia', fix: 'nvidia' },
  { id: 'nvidia-dri', vendor: 'NVIDIA', symptom: '/dev/dri mapped, no NVIDIA device in the container', fix: 'nvidia' },
  { id: 'nvenc-video', vendor: 'NVIDIA', symptom: 'Cannot load libnvidia-encode.so.1', fix: 'nvidia' },
  {
    id: 'nvidia-driver-old',
    vendor: 'NVIDIA',
    symptom: 'CUDA driver version is insufficient for CUDA runtime version',
    fix: 'nvidia',
  },
  {
    id: 'nvidia-arch',
    vendor: 'NVIDIA',
    symptom: 'no kernel image is available for execution on the device',
    fix: null,
  },
  {
    id: 'nvml-lost',
    vendor: 'NVIDIA',
    symptom: 'Failed to initialize NVML: Unknown Error (after a while)',
    fix: 'nvidia',
  },
  { id: 'compose-count', vendor: 'NVIDIA', symptom: 'count and device_ids error on compose up', fix: 'nvidia' },
  {
    id: 'cpu-image',
    vendor: 'Any',
    symptom: 'GPU passed through but analysis still slow, processor at 100%',
    fix: null,
  },
  {
    id: 'dri-missing',
    vendor: 'Intel / AMD',
    symptom: 'No VA display found for device /dev/dri/renderD128',
    fix: 'intel',
  },
  {
    id: 'render-permission',
    vendor: 'Intel / AMD',
    symptom: 'Permission denied opening /dev/dri/renderD128',
    fix: 'amd',
  },
  { id: 'openvino-cpu-only', vendor: 'Intel', symptom: 'OpenVINO devices: CPU only', fix: 'intel' },
  {
    id: 'wrong-gpu',
    vendor: 'Intel / AMD',
    symptom: 'The integrated GPU is used instead of the graphics card',
    fix: null,
  },
  { id: 'kfd-missing', vendor: 'AMD', symptom: 'Unable to open /dev/kfd read-write', fix: 'amd' },
  { id: 'rocm-gfx', vendor: 'AMD', symptom: 'hipErrorNoBinaryForGpu on RX 6000/7000', fix: 'amd' },
  { id: 'wsl2', vendor: 'Windows', symptom: 'WSL2: /dev/dri missing or Quick Sync fails', fix: 'wsl2' },
  { id: 'unraid', vendor: 'Unraid', symptom: 'The GPU plugin shows the card but the container does not', fix: null },
  { id: 'macos', vendor: 'Apple', symptom: 'Docker Desktop on macOS shows no GPU', fix: null },
  {
    id: 'snap-docker',
    vendor: 'NVIDIA',
    symptom: 'Docker installed from the Ubuntu snap cannot use the NVIDIA toolkit',
    fix: null,
  },
]);

export const composeFixes: Readonly<Record<ComposeFixId, ComposeFix>> = Object.freeze({
  nvidia: {
    title: 'NVIDIA',
    steps: 3,
    yaml: "services:\n  frameleaf-server:\n    deploy:\n      resources:\n        reservations:\n          devices:\n            - driver: nvidia\n              count: 1\n              capabilities: [gpu, compute, video]\n\n  frameleaf-machine-learning:\n    image: ghcr.io/frameleaf/machine-learning:release-cuda\n    deploy:\n      resources:\n        reservations:\n          devices:\n            - driver: nvidia\n              count: 1              # or device_ids: ['0'], not both\n              capabilities: [gpu]",
  },
  intel: {
    title: 'Intel',
    steps: 3,
    yaml: 'services:\n  frameleaf-server:\n    devices:\n      - /dev/dri:/dev/dri\n    group_add:\n      - "993"   # host render group: stat -c \'%g\' /dev/dri/renderD128\n      - "44"    # host video group\n\n  frameleaf-machine-learning:\n    image: ghcr.io/frameleaf/machine-learning:release-openvino\n    devices:\n      - /dev/dri:/dev/dri\n    group_add:\n      - "993"   # host render group',
  },
  amd: {
    title: 'AMD',
    steps: 2,
    yaml: 'services:\n  frameleaf-server:\n    devices:\n      - /dev/dri:/dev/dri\n    group_add:\n      - "993"   # host render group\n      - "44"    # host video group\n\n  frameleaf-machine-learning:\n    image: ghcr.io/frameleaf/machine-learning:release-rocm\n    devices:\n      - /dev/kfd:/dev/kfd\n      - /dev/dri:/dev/dri\n    group_add:\n      - video\n      - "993"   # host render group (number)\n    security_opt:\n      - seccomp=unconfined\n    # environment:\n    #   - HSA_OVERRIDE_GFX_VERSION=10.3.0   # only for RX 6000 cards',
  },
  wsl2: {
    title: 'Windows (WSL2)',
    steps: 1,
    yaml: 'services:\n  frameleaf-server:\n    devices:\n      - /dev/dri:/dev/dri\n      - /dev/dxg:/dev/dxg\n    volumes:\n      - /usr/lib/wsl:/usr/lib/wsl\n    environment:\n      - LIBVA_DRIVER_NAME=d3d12\n\n  frameleaf-machine-learning:\n    devices:\n      - /dev/dxg:/dev/dxg\n    volumes:\n      - /usr/lib/wsl:/usr/lib/wsl',
  },
});
export const problemById = (id: string) => gpuProblems.find((item) => item.id === id) ?? null;

// ------------------------------------------------------------------ smooth motion

export const INTERPOLATION_PREVIEW_SECONDS = 5;

/**
 * Work for a frame-rate increase: source minutes weighted by how many new frames each source frame
 * needs (2× the frame rate = one new frame each). The output file grows with the frame rate.
 */
export const interpolationWork = ({
  durationSeconds = 0,
  sourceFps = 30,
  targetFps = 60,
}: { durationSeconds?: number; sourceFps?: number; targetFps?: number } = {}) => {
  const ratio = Math.max(1, Number(targetFps) / Math.max(1, Number(sourceFps) || 30));
  const minutes = Math.max(0.05, (Number(durationSeconds) || 0) / 60);
  return { ratio: round(ratio, 3), units: round(minutes * Math.max(0.5, ratio - 1), 3), sizeFactor: round(ratio, 2) };
};

/** Local time or cloud cost for smoothing motion with one model position. */
export const interpolationEstimate = (
  item: ModelPosition,
  work: ReturnType<typeof interpolationWork>,
  {
    gpu = null,
    cpuProfile = 'cpu8',
    benchmark = null,
    band,
  }: { gpu?: DetectedGpu | null; cpuProfile?: GpuProfileId; benchmark?: Benchmark | null; band?: Band } = {},
) => {
  const runsOn = band ?? bandFor(item, gpu, cpuProfile);
  if (runsOn === 'cloud') {
    return { runsOn, seconds: null, cost: estimateCost(item, work.units), sizeFactor: work.sizeFactor };
  }
  const perUnit = localSecondsPerUnit(item, gpu, { benchmark, cpuProfile });
  return {
    runsOn,
    seconds: perUnit === null ? null : Math.round(perUnit * work.units),
    cost: null,
    sizeFactor: work.sizeFactor,
  };
};
