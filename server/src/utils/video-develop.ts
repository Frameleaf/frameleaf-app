import { AssetDevelopPreset } from 'src/dtos/asset-develop.dto.js';
import { VideoDevelopPreset } from 'src/dtos/editing.dto.js';
import {
  DEVELOP_PRESETS,
  DEVELOP_SLIDER_KEYS,
  type DevelopLook,
  type DevelopSliders,
  buildToneLuts,
} from 'src/utils/develop-recipe.js';

/**
 * The quick editor's develop model on video (FL-113, `Editor.jsx` Adjust and Presets for a clip).
 *
 * A video recipe written by the Frameleaf quick editor carries the same sliders and looks as a
 * photo (`develop.mjs` DEVELOP_PARAMS and PRESETS, plus the video-only B&W look). This module turns
 * them into an ffmpeg filter chain that follows the still renderer (`develop-recipe.ts`) as closely
 * as ffmpeg's stock filters allow:
 *
 * - the global tone stage (exposure, white and black points, contrast, dehaze, temperature, tint)
 *   is the still renderer's own per-channel lookup, sampled into `curves`, with the luminance-masked
 *   highlights and shadows folded into the same curve for neutral tones;
 * - saturation is `eq`, vibrance is ffmpeg's `vibrance`, and the grayscale and sepia mixes of a look
 *   are one exact `colorchannelmixer` matrix;
 * - noise reduction, sharpening and clarity are `hqdn3d` and `unsharp`, the vignette is `vignette`
 *   and grain is temporal `noise`.
 *
 * Pure and deterministic, so a recipe renders the same way every time.
 */

export type VideoDevelopParameters = Partial<Record<(typeof DEVELOP_SLIDER_KEYS)[number], number>> & {
  preset?: VideoDevelopPreset;
  presetStrength?: number;
};

type Look = { params: Partial<DevelopSliders>; look?: Partial<DevelopLook> };

/** B&W exists for video only (prototype `develop.mjs` PRESETS, `scope: 'video'`). */
const VIDEO_ONLY_PRESETS: Partial<Record<VideoDevelopPreset, Look>> = {
  [VideoDevelopPreset.BlackAndWhite]: { params: { contrast: 24 }, look: { grayscale: 100 } },
};

const RANGE: Record<(typeof DEVELOP_SLIDER_KEYS)[number], [number, number]> = {
  exposure: [-2, 2],
  contrast: [-100, 100],
  highlights: [-100, 100],
  shadows: [-100, 100],
  whites: [-100, 100],
  blacks: [-100, 100],
  temperature: [-100, 100],
  tint: [-100, 100],
  vibrance: [-100, 100],
  saturation: [-100, 100],
  clarity: [-100, 100],
  dehaze: [-100, 100],
  vignette: [-100, 100],
  grain: [0, 100],
  sharpen: [0, 100],
  noiseReduction: [0, 100],
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const round = (value: number, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const lookFor = (preset: VideoDevelopPreset | undefined): Look => {
  if (!preset) {
    return DEVELOP_PRESETS[AssetDevelopPreset.Original];
  }
  return (
    VIDEO_ONLY_PRESETS[preset] ??
    DEVELOP_PRESETS[preset as unknown as AssetDevelopPreset] ??
    DEVELOP_PRESETS[AssetDevelopPreset.Original]
  );
};

/** Manual sliders plus the chosen look scaled by its strength, as `effectiveDevelop` does for photos. */
export function effectiveVideoDevelop(parameters: VideoDevelopParameters): {
  params: DevelopSliders;
  look: DevelopLook;
} {
  const preset = lookFor(parameters.preset);
  const strength = clamp(finite(parameters.presetStrength, 100), 0, 100) / 100;
  const params = {} as DevelopSliders;
  for (const key of DEVELOP_SLIDER_KEYS) {
    const [min, max] = RANGE[key];
    const base = clamp(finite(parameters[key]), min, max);
    params[key] = round(clamp(base + finite(preset.params[key]) * strength, min, max), 3);
  }
  return {
    params,
    look: {
      grayscale: round(finite(preset.look?.grayscale) * strength, 3),
      sepia: round(finite(preset.look?.sepia) * strength, 3),
    },
  };
}

/** The still renderer's highlights and shadows stage for a neutral tone (r = g = b = v). */
const neutralLocalTone = (v: number, highlights: number, shadows: number) => {
  let value = v;
  if (highlights !== 0) {
    const mask = smoothstep(0.45, 1, value);
    const factor = highlights < 0 ? 1 + highlights * 0.55 * mask : 1;
    const lift = highlights > 0 ? highlights * 0.5 * mask : 0;
    value = value * factor + (1 - value) * lift;
  }
  if (shadows !== 0) {
    const mask = 1 - smoothstep(0, 0.55, value);
    value = shadows > 0 ? value + (1 - value) * shadows * 0.45 * mask * value * 2 : value * (1 + shadows * 0.6 * mask);
  }
  return clamp(value, 0, 1);
};

const CURVE_POINTS = 17;

/** `curves` points for one channel, sampled from the still renderer's lookup. */
const curvePoints = (lut: Uint8Array, highlights: number, shadows: number) =>
  Array.from({ length: CURVE_POINTS }, (_, index) => {
    const x = index / (CURVE_POINTS - 1);
    const y = neutralLocalTone(lut[Math.round(x * 255)] / 255, highlights, shadows);
    return `${round(x, 4)}/${round(y, 4)}`;
  }).join(' ');

const TONE_KEYS = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temperature',
  'tint',
  'dehaze',
] as const;

type Matrix = [[number, number, number], [number, number, number], [number, number, number]];
const IDENTITY: Matrix = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const mix = (target: Matrix, amount: number): Matrix =>
  IDENTITY.map((row, r) => row.map((value, c) => value + (target[r][c] - value) * amount)) as Matrix;
const multiply = (a: Matrix, b: Matrix): Matrix =>
  a.map((row) => [0, 1, 2].map((c) => row.reduce((sum, value, k) => sum + value * b[k][c], 0))) as Matrix;
const GREY: Matrix = [
  [0.2126, 0.7152, 0.0722],
  [0.2126, 0.7152, 0.0722],
  [0.2126, 0.7152, 0.0722],
];
const SEPIA: Matrix = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131],
];

/** The ffmpeg filters for a develop-model adjustment, in the still renderer's order. */
export function videoDevelopFilters(parameters: VideoDevelopParameters): string[] {
  const { params, look } = effectiveVideoDevelop(parameters);
  const filters: string[] = [];

  if (params.noiseReduction > 0) {
    filters.push(`hqdn3d=${round((params.noiseReduction / 100) * 6, 2)}`);
  }

  if (TONE_KEYS.some((key) => params[key] !== 0)) {
    const luts = buildToneLuts(params);
    const highlights = params.highlights / 100;
    const shadows = params.shadows / 100;
    filters.push(
      `curves=r='${curvePoints(luts.r, highlights, shadows)}':g='${curvePoints(luts.g, highlights, shadows)}':b='${curvePoints(luts.b, highlights, shadows)}'`,
    );
  }

  if (params.saturation !== 0) {
    filters.push(`eq=saturation=${round(1 + params.saturation / 100, 3)}`);
  }
  if (params.vibrance !== 0) {
    filters.push(`vibrance=intensity=${round((params.vibrance / 100) * 0.9, 3)}`);
  }

  const grayscale = clamp(look.grayscale / 100, 0, 1);
  const sepia = clamp(look.sepia / 100, 0, 1);
  if (grayscale > 0 || sepia > 0) {
    // Grayscale first, then sepia, as the still renderer mixes them.
    const [r, g, b] = multiply(mix(SEPIA, sepia), mix(GREY, grayscale)).map((row) => row.map((v) => round(v, 4)));
    filters.push(
      `colorchannelmixer=rr=${r[0]}:rg=${r[1]}:rb=${r[2]}:gr=${g[0]}:gg=${g[1]}:gb=${g[2]}:br=${b[0]}:bg=${b[1]}:bb=${b[2]}`,
    );
  }

  if (params.sharpen > 0) {
    filters.push(`unsharp=5:5:${round((params.sharpen / 100) * 1.5, 3)}`);
  }
  // Negative clarity is a softening the still renderer also renders as zero.
  if (params.clarity > 0) {
    filters.push(`unsharp=13:13:${round((params.clarity / 100) * 0.8, 3)}`);
  }

  if (params.vignette !== 0) {
    const angle = round((Math.PI / 2) * 0.85 * (Math.abs(params.vignette) / 100), 4);
    filters.push(params.vignette > 0 ? `vignette=angle=${angle}` : `vignette=angle=${angle}:mode=backward`);
  }

  if (params.grain > 0) {
    filters.push(`noise=alls=${Math.round((params.grain / 100) * 30)}:allf=t`);
  }

  return filters;
}
