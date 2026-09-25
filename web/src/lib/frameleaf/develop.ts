/**
 * Develop module for the quick editor (FL-113).
 *
 * Ported from `design/frameleaf/template/src/develop.mjs`: the parameter schema behind Adjust,
 * the preset looks, the CSS approximation used while the server preview is still rendering,
 * histogram sampling, and the pure crop geometry the editing surface uses. Everything here is
 * deterministic and runs in node for tests.
 *
 * The prototype's CSS filters are approximations. Production shows the server's rendered
 * preview as soon as it arrives and only falls back to these numbers while a render is pending,
 * so the histogram and the stage never disagree with what the renderer will actually produce
 * for longer than one round trip.
 */
import { AssetDevelopPreset, VideoDevelopPreset, type AssetDevelopRecipeDto } from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round = (value: number, places = 3) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const finite = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export type DevelopGroupId = 'light' | 'color' | 'effects' | 'detail';

export const DEVELOP_GROUPS: { id: DevelopGroupId; label: Translations }[] = [
  { id: 'light', label: 'frameleaf_editor_group_light' },
  { id: 'color', label: 'frameleaf_editor_group_color' },
  { id: 'effects', label: 'frameleaf_editor_group_effects' },
  { id: 'detail', label: 'frameleaf_editor_group_detail' },
];

export type DevelopKey =
  | 'exposure'
  | 'contrast'
  | 'highlights'
  | 'shadows'
  | 'whites'
  | 'blacks'
  | 'temperature'
  | 'tint'
  | 'vibrance'
  | 'saturation'
  | 'clarity'
  | 'dehaze'
  | 'vignette'
  | 'grain'
  | 'sharpen'
  | 'noiseReduction';

export type DevelopParamSpec = {
  id: DevelopKey;
  /** i18n key of the slider label. */
  label: Translations;
  group: DevelopGroupId;
  min: number;
  max: number;
  default: number;
  step: number;
  unit: string;
};

const param = (
  id: DevelopKey,
  label: Translations,
  group: DevelopGroupId,
  options: Partial<DevelopParamSpec> = {},
) => ({
  id,
  label,
  group,
  min: -100,
  max: 100,
  default: 0,
  step: 1,
  unit: '',
  ...options,
});

export const DEVELOP_PARAMS: readonly DevelopParamSpec[] = [
  param('exposure', 'frameleaf_editor_param_exposure', 'light', { min: -2, max: 2, step: 0.05, unit: 'EV' }),
  param('contrast', 'frameleaf_editor_param_contrast', 'light'),
  param('highlights', 'frameleaf_editor_param_highlights', 'light'),
  param('shadows', 'frameleaf_editor_param_shadows', 'light'),
  param('whites', 'frameleaf_editor_param_whites', 'light'),
  param('blacks', 'frameleaf_editor_param_blacks', 'light'),
  param('temperature', 'frameleaf_editor_param_temperature', 'color'),
  param('tint', 'frameleaf_editor_param_tint', 'color'),
  param('vibrance', 'frameleaf_editor_param_vibrance', 'color'),
  param('saturation', 'frameleaf_editor_param_saturation', 'color'),
  param('clarity', 'frameleaf_editor_param_clarity', 'effects'),
  param('dehaze', 'frameleaf_editor_param_dehaze', 'effects'),
  param('vignette', 'frameleaf_editor_param_vignette', 'effects'),
  param('grain', 'frameleaf_editor_param_grain', 'effects', { min: 0 }),
  param('sharpen', 'frameleaf_editor_param_sharpen', 'detail', { min: 0 }),
  param('noiseReduction', 'frameleaf_editor_param_noise_reduction', 'detail', { min: 0 }),
];

export const DEVELOP_KEYS: readonly DevelopKey[] = DEVELOP_PARAMS.map((item) => item.id);
const paramsById = Object.fromEntries(DEVELOP_PARAMS.map((item) => [item.id, item])) as Record<
  DevelopKey,
  DevelopParamSpec
>;

export const paramFor = (id: DevelopKey) => paramsById[id];

export type DevelopValues = Record<DevelopKey, number>;

export const developDefaults = (): DevelopValues =>
  Object.fromEntries(DEVELOP_PARAMS.map((item) => [item.id, item.default])) as DevelopValues;

export function clampParam(id: DevelopKey, value: unknown): number {
  const spec = paramsById[id];
  if (!spec) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return spec.default;
  }
  const stepped = Math.round(value / spec.step) * spec.step;
  return round(clamp(stepped, spec.min, spec.max), 3);
}

export const paramsInGroup = (group: DevelopGroupId) => DEVELOP_PARAMS.filter((item) => item.group === group);

export const groupIsDefault = (values: Partial<DevelopValues>, group: DevelopGroupId) =>
  paramsInGroup(group).every((item) => finite(values[item.id], item.default) === item.default);

export const groupReset = (group: DevelopGroupId): Partial<DevelopValues> =>
  Object.fromEntries(paramsInGroup(group).map((item) => [item.id, item.default]));

/** A gentle, image-agnostic tone recipe used by the Auto button. */
export const AUTO_TONE: Partial<DevelopValues> = {
  exposure: 0.15,
  contrast: 12,
  highlights: -22,
  shadows: 18,
  whites: 8,
  blacks: -6,
  vibrance: 14,
  clarity: 6,
};

export const autoToneApplied = (values: Partial<DevelopValues>) =>
  Object.entries(AUTO_TONE).every(([key, value]) => finite(values[key as DevelopKey]) === value);

export const autoToneCleared = (): Partial<DevelopValues> =>
  Object.fromEntries(Object.keys(AUTO_TONE).map((key) => [key, 0]));

export type DevelopLook = { grayscale: number; sepia: number };

/** The looks a recipe can name: the photo develop presets plus the video-only B&W. */
export type DevelopLookId = AssetDevelopPreset | VideoDevelopPreset;

export type DevelopPresetSpec = {
  id: DevelopLookId;
  /** `video`: offered for clips only (`develop.mjs` PRESETS `scope`). */
  scope?: 'video';
  /** i18n key. */
  label: Translations;
  params: Partial<DevelopValues>;
  look?: Partial<DevelopLook>;
};

/** Looks. `params` nudge develop sliders; `look` adds grayscale/sepia mixes. Mirrors the server table. */
export const PRESETS: readonly DevelopPresetSpec[] = [
  { id: AssetDevelopPreset.Original, label: 'frameleaf_editor_preset_original', params: {} },
  {
    id: AssetDevelopPreset.Vivid,
    label: 'frameleaf_editor_preset_vivid',
    params: { contrast: 18, vibrance: 30, saturation: 12, clarity: 10 },
  },
  {
    id: AssetDevelopPreset.Natural,
    label: 'frameleaf_editor_preset_natural',
    params: { contrast: 6, highlights: -12, shadows: 10, vibrance: 8 },
  },
  {
    id: AssetDevelopPreset.Warm,
    label: 'frameleaf_editor_preset_warm',
    params: { temperature: 32, tint: 6, vibrance: 8 },
  },
  {
    id: AssetDevelopPreset.Cool,
    label: 'frameleaf_editor_preset_cool',
    params: { temperature: -30, tint: -4, contrast: 6 },
  },
  {
    id: AssetDevelopPreset.Mono,
    label: 'frameleaf_editor_preset_mono',
    params: { contrast: 8 },
    look: { grayscale: 100 },
  },
  {
    id: AssetDevelopPreset.Silvertone,
    label: 'frameleaf_editor_preset_silvertone',
    params: { contrast: 14, highlights: -8, clarity: 8 },
    look: { grayscale: 100, sepia: 18 },
  },
  {
    id: AssetDevelopPreset.Noir,
    label: 'frameleaf_editor_preset_noir',
    params: { contrast: 36, blacks: -24, vignette: 40, grain: 20 },
    look: { grayscale: 100 },
  },
  {
    id: AssetDevelopPreset.Fade,
    label: 'frameleaf_editor_preset_fade',
    params: { contrast: -18, blacks: 26, saturation: -18, whites: -10 },
  },
  {
    id: VideoDevelopPreset.BW,
    label: 'frameleaf_editor_preset_bw',
    scope: 'video',
    params: { contrast: 24 },
    look: { grayscale: 100 },
  },
];
/** The photo looks: what a still recipe may name. */
export const PRESET_IDS: readonly AssetDevelopPreset[] = PRESETS.filter((item) => !item.scope).map(
  (item) => item.id as AssetDevelopPreset,
);
export const presetFor = (id: unknown) => PRESETS.find((item) => item.id === id) ?? PRESETS[0];
/** The looks offered for a photo or a clip (`develop.mjs` presetsFor). */
export const presetsFor = (kind: 'photo' | 'video') => PRESETS.filter((item) => !item.scope || item.scope === kind);

export type DevelopSource = Partial<DevelopValues> & { preset?: DevelopLookId; presetStrength?: number };

/** Manual sliders plus the chosen preset scaled by its strength. */
export function effectiveDevelop(recipe: DevelopSource): { params: DevelopValues; look: DevelopLook } {
  const preset = presetFor(recipe?.preset);
  const strength = clamp(finite(recipe?.presetStrength, 100), 0, 100) / 100;
  const params = {} as DevelopValues;
  for (const item of DEVELOP_PARAMS) {
    const base = clamp(finite(recipe?.[item.id], item.default), item.min, item.max);
    const nudge = finite(preset.params?.[item.id]) * strength;
    params[item.id] = round(clamp(base + nudge, item.min, item.max), 3);
  }
  return {
    params,
    look: {
      grayscale: round(finite(preset.look?.grayscale) * strength, 3),
      sepia: round(finite(preset.look?.sepia) * strength, 3),
    },
  };
}

const GRAIN_SVG = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>",
);

export type CssLayer = { id: string; style: string };
export type CssFilterNumeric = {
  brightness: number;
  contrast: number;
  saturate: number;
  grayscale: number;
  sepia: number;
  blur: number;
};
export type CssFilterInfo = {
  filter: string;
  numeric: CssFilterNumeric;
  layers: CssLayer[];
  params: DevelopValues;
  look: DevelopLook;
};

/**
 * CSS approximation of the develop state: a filter() string, the numeric factors behind it,
 * and overlay layers for the effects filter() cannot do. Used only until the server preview
 * for the same recipe has arrived.
 */
export function cssFilterFor(recipe: DevelopSource): CssFilterInfo {
  const { params: p, look } = effectiveDevelop(recipe);
  const brightness =
    2 ** p.exposure *
    (1 + (p.whites / 100) * 0.12) *
    (1 + (p.shadows / 100) * 0.06) *
    (1 + (p.highlights / 100) * 0.05) *
    (1 - (p.dehaze / 100) * 0.04);
  const contrast =
    (1 + (p.contrast / 100) * 0.5) *
    (1 + (p.clarity / 100) * 0.2) *
    (1 + (p.dehaze / 100) * 0.25) *
    (1 - (p.blacks / 100) * 0.12) *
    (1 - (p.shadows / 100) * 0.1) *
    (1 - (p.highlights / 100) * 0.06) *
    (1 + (p.sharpen / 100) * 0.08);
  const saturate = (1 + p.saturation / 100) * (1 + (p.vibrance / 100) * 0.5) * (1 + (p.dehaze / 100) * 0.08);
  const numeric: CssFilterNumeric = {
    brightness: round(Math.max(0, brightness)),
    contrast: round(Math.max(0, contrast)),
    saturate: round(Math.max(0, saturate)),
    grayscale: round(clamp(look.grayscale / 100, 0, 1)),
    sepia: round(clamp(look.sepia / 100, 0, 1)),
    blur: round((p.noiseReduction / 100) * 0.6),
  };
  const parts = [`brightness(${numeric.brightness})`, `contrast(${numeric.contrast})`, `saturate(${numeric.saturate})`];
  if (numeric.grayscale > 0) {
    parts.push(`grayscale(${numeric.grayscale})`);
  }
  if (numeric.sepia > 0) {
    parts.push(`sepia(${numeric.sepia})`);
  }
  if (numeric.blur > 0) {
    parts.push(`blur(${numeric.blur}px)`);
  }
  const layers: CssLayer[] = [];
  if (p.temperature !== 0) {
    layers.push({
      id: 'temperature',
      style: `background:${p.temperature > 0 ? '#ff9a3c' : '#3c8bff'};mix-blend-mode:overlay;opacity:${round((Math.abs(p.temperature) / 100) * 0.4)}`,
    });
  }
  if (p.tint !== 0) {
    layers.push({
      id: 'tint',
      style: `background:${p.tint > 0 ? '#ff4fd8' : '#4fff7a'};mix-blend-mode:overlay;opacity:${round((Math.abs(p.tint) / 100) * 0.3)}`,
    });
  }
  if (p.vignette !== 0) {
    const edge = p.vignette > 0 ? '0,0,0' : '255,255,255';
    const alpha = round((Math.abs(p.vignette) / 100) * 0.9);
    layers.push({
      id: 'vignette',
      style: `background:radial-gradient(ellipse at center, rgba(${edge},0) 42%, rgba(${edge},${alpha}) 100%)`,
    });
  }
  if (p.grain > 0) {
    layers.push({
      id: 'grain',
      style: `background-image:url("data:image/svg+xml,${GRAIN_SVG}");background-size:180px 180px;mix-blend-mode:overlay;opacity:${round((p.grain / 100) * 0.6)}`,
    });
  }
  return { filter: parts.join(' '), numeric, layers, params: p, look };
}

/**
 * Applies the numeric filter factors (plus temperature/tint casts) to RGBA bytes in place, so
 * the histogram matches the CSS preview in every browser while the server preview is pending.
 */
export function tonePixels(
  data: Uint8ClampedArray | Uint8Array,
  numeric: Partial<CssFilterNumeric>,
  params: Partial<Pick<DevelopValues, 'temperature' | 'tint'>> = {},
) {
  const { brightness = 1, contrast = 1, saturate = 1, grayscale = 0, sepia = 0 } = numeric ?? {};
  const warm = (finite(params.temperature) / 100) * 28;
  const tint = (finite(params.tint) / 100) * 22;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] * brightness;
    let g = data[i + 1] * brightness;
    let b = data[i + 2] * brightness;
    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = luma + (r - luma) * saturate;
    g = luma + (g - luma) * saturate;
    b = luma + (b - luma) * saturate;
    if (grayscale > 0) {
      const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r += (gray - r) * grayscale;
      g += (gray - g) * grayscale;
      b += (gray - b) * grayscale;
    }
    if (sepia > 0) {
      const sr = 0.393 * r + 0.769 * g + 0.189 * b;
      const sg = 0.349 * r + 0.686 * g + 0.168 * b;
      const sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r += (sr - r) * sepia;
      g += (sg - g) * sepia;
      b += (sb - b) * sepia;
    }
    r += warm;
    b -= warm;
    r += tint * 0.6;
    g -= tint;
    b += tint * 0.6;
    data[i] = clamp(Math.round(r), 0, 255);
    data[i + 1] = clamp(Math.round(g), 0, 255);
    data[i + 2] = clamp(Math.round(b), 0, 255);
  }
  return data;
}

export type HistogramBins = {
  bins: number;
  red: number[];
  green: number[];
  blue: number[];
  luma: number[];
  max: number;
  samples: number;
  clipped: { shadows: number; highlights: number };
};

/** Per-channel and luminance histograms from an ImageData-like object. */
export function histogramBins(imageData: { data: ArrayLike<number> } | null | undefined, bins = 64): HistogramBins {
  const count = Math.max(1, Math.min(256, Math.floor(bins) || 64));
  const red = Array.from({ length: count }, () => 0);
  const green = Array.from({ length: count }, () => 0);
  const blue = Array.from({ length: count }, () => 0);
  const luma = Array.from({ length: count }, () => 0);
  const data = imageData?.data;
  const length = data?.length ?? 0;
  const pixels = Math.floor(length / 4);
  const stride = Math.max(1, Math.floor(pixels / 60_000));
  let samples = 0;
  let max = 0;
  const scale = count / 256;
  for (let i = 0; i + 3 < length; i += 4 * stride) {
    if (data![i + 3] === 0) {
      continue;
    }
    const r = data![i];
    const g = data![i + 1];
    const b = data![i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    red[Math.min(count - 1, Math.floor(r * scale))] += 1;
    green[Math.min(count - 1, Math.floor(g * scale))] += 1;
    blue[Math.min(count - 1, Math.floor(b * scale))] += 1;
    luma[Math.min(count - 1, Math.floor(l * scale))] += 1;
    samples += 1;
  }
  for (let i = 0; i < count; i += 1) {
    max = Math.max(max, red[i], green[i], blue[i], luma[i]);
  }
  const clipped = samples
    ? { shadows: round(luma[0] / samples), highlights: round(luma[count - 1] / samples) }
    : { shadows: 0, highlights: 0 };
  return { bins: count, red, green, blue, luma, max, samples, clipped };
}

/* Crop geometry ---------------------------------------------------------- */

export type AspectId = 'Free' | 'Original' | '1:1' | '16:9' | '9:16' | '4:3' | '3:2' | '4:5';

export const ASPECTS: { id: AspectId; label: string }[] = [
  { id: 'Free', label: 'frameleaf_editor_aspect_free' },
  { id: 'Original', label: 'frameleaf_editor_aspect_original' },
  { id: '1:1', label: 'frameleaf_editor_aspect_square' },
  { id: '16:9', label: '16:9' },
  { id: '9:16', label: '9:16' },
  { id: '4:3', label: '4:3' },
  { id: '3:2', label: '3:2' },
  { id: '4:5', label: '4:5' },
];
export const ASPECT_IDS: readonly AspectId[] = ASPECTS.map((item) => item.id);

export const SOCIAL_PRESETS: { id: string; label: Translations; aspect: AspectId; note: Translations }[] = [
  { id: 'portrait', label: 'frameleaf_editor_social_portrait', aspect: '4:5', note: 'frameleaf_editor_social_feed' },
  { id: 'shorts', label: 'frameleaf_editor_social_shorts', aspect: '9:16', note: 'frameleaf_editor_social_vertical' },
  { id: 'wide', label: 'frameleaf_editor_social_wide', aspect: '16:9', note: 'frameleaf_editor_social_landscape' },
];

export type CropRect = { x: number; y: number; w: number; h: number };

/** Display ratio (width / height) for an aspect id; null means free. */
export function aspectRatioValue(id: string | undefined, frameWidth: number, frameHeight: number): number | null {
  if (id === 'Original') {
    return frameWidth > 0 && frameHeight > 0 ? frameWidth / frameHeight : null;
  }
  const match = /^(\d+):(\d+)$/.exec(id ?? '');
  if (!match) {
    return null;
  }
  return Number(match[1]) / Number(match[2]);
}

export const FULL_RECT: Readonly<CropRect> = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });
export const MIN_CROP = 0.05;

export function normalizeRect(candidate: unknown): CropRect {
  const value = (candidate && typeof candidate === 'object' ? candidate : {}) as Partial<CropRect>;
  const w = round(clamp(finite(value.w, 1), MIN_CROP, 1), 4);
  const h = round(clamp(finite(value.h, 1), MIN_CROP, 1), 4);
  const x = round(clamp(finite(value.x, 0), 0, 1 - w), 4);
  const y = round(clamp(finite(value.y, 0), 0, 1 - h), 4);
  return { x, y, w, h };
}

export const isFullRect = (rect: CropRect | null | undefined) =>
  !rect || (rect.x === 0 && rect.y === 0 && rect.w === 1 && rect.h === 1);

/** Largest centred normalized rect with the given display ratio. */
export function fitCropRect(ratio: number | null, frameWidth: number, frameHeight: number): CropRect {
  if (!ratio || !(frameWidth > 0) || !(frameHeight > 0)) {
    return { ...FULL_RECT };
  }
  let h = 1;
  let w = (ratio * frameHeight) / frameWidth;
  if (w > 1) {
    w = 1;
    h = frameWidth / (ratio * frameHeight);
  }
  return normalizeRect({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const CROP_HANDLES: readonly Exclude<CropHandle, 'move'>[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

/**
 * Resizes a normalized crop rect by dragging one of eight handles or moving it. dx/dy are
 * normalized deltas. When a ratio is given the rect keeps that display ratio.
 */
export function resizeCropRect(
  rect: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  options: { ratio?: number | null; frameWidth?: number; frameHeight?: number } = {},
): CropRect {
  const { ratio = null, frameWidth = 1, frameHeight = 1 } = options;
  const current = normalizeRect(rect);
  if (handle === 'move') {
    return normalizeRect({
      ...current,
      x: clamp(current.x + dx, 0, 1 - current.w),
      y: clamp(current.y + dy, 0, 1 - current.h),
    });
  }
  let left = current.x;
  let top = current.y;
  let right = current.x + current.w;
  let bottom = current.y + current.h;
  if (handle.includes('w')) {
    left = clamp(left + dx, 0, right - MIN_CROP);
  }
  if (handle.includes('e')) {
    right = clamp(right + dx, left + MIN_CROP, 1);
  }
  if (handle.includes('n')) {
    top = clamp(top + dy, 0, bottom - MIN_CROP);
  }
  if (handle.includes('s')) {
    bottom = clamp(bottom + dy, top + MIN_CROP, 1);
  }
  if (ratio) {
    // normalized width per normalized height for this display ratio
    const k = (ratio * frameHeight) / frameWidth;
    let w = right - left;
    let h = bottom - top;
    const horizontalOnly = handle === 'e' || handle === 'w';
    const verticalOnly = handle === 'n' || handle === 's';
    if (horizontalOnly) {
      h = w / k;
    } else if (verticalOnly || w / k > h) {
      w = h * k;
    } else {
      h = w / k;
    }
    if (handle.includes('w')) {
      left = right - w;
    } else {
      right = left + w;
    }
    if (handle.includes('n')) {
      top = bottom - h;
    } else {
      bottom = top + h;
    }
    if (verticalOnly) {
      const centre = current.x + current.w / 2;
      left = centre - w / 2;
      right = centre + w / 2;
    }
    if (horizontalOnly) {
      const centre = current.y + current.h / 2;
      top = centre - h / 2;
      bottom = centre + h / 2;
    }
    // keep the rect inside the frame without breaking the ratio
    if (left < 0) {
      right -= left;
      left = 0;
    }
    if (top < 0) {
      bottom -= top;
      top = 0;
    }
    if (right > 1) {
      const overflow = right - 1;
      right = 1;
      left = Math.max(0, left - overflow);
      w = right - left;
      h = w / k;
      if (handle.includes('n')) {
        top = bottom - h;
      } else {
        bottom = top + h;
      }
    }
    if (bottom > 1) {
      const overflow = bottom - 1;
      bottom = 1;
      top = Math.max(0, top - overflow);
      h = bottom - top;
      w = h * k;
      if (handle.includes('w')) {
        left = right - w;
      } else {
        right = left + w;
      }
    }
    if (right - left < MIN_CROP || bottom - top < MIN_CROP) {
      return current;
    }
  }
  return normalizeRect({ x: left, y: top, w: right - left, h: bottom - top });
}

/** Scale that keeps a straightened image covering its own frame. */
export function straightenScale(width: number, height: number, degrees: number): number {
  if (!(width > 0) || !(height > 0)) {
    return 1;
  }
  const theta = (Math.abs(finite(degrees)) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return round(Math.max((width * cos + height * sin) / width, (width * sin + height * cos) / height), 4);
}

/** The crop rect after a quarter turn of the frame, so the framing follows the picture. */
export const rotateRect = (rect: CropRect, clockwise: boolean): CropRect =>
  clockwise
    ? { x: 1 - rect.y - rect.h, y: rect.x, w: rect.h, h: rect.w }
    : { x: rect.y, y: 1 - rect.x - rect.w, w: rect.h, h: rect.w };

export const rotateAspect = (aspect: AspectId): AspectId =>
  (
    ({ '16:9': '9:16', '9:16': '16:9', Original: 'Original', '1:1': '1:1', Free: 'Free' }) as Partial<
      Record<AspectId, AspectId>
    >
  )[aspect] ?? 'Free';

/** The recipe fields the server renders as tone; geometry is applied on the stage while editing. */
export const toneOnlyRecipe = (recipe: AssetDevelopRecipeDto): AssetDevelopRecipeDto => ({
  ...recipe,
  crop: { ...FULL_RECT },
  straighten: 0,
  rotation: 0,
  flipHorizontal: false,
  flipVertical: false,
});

/** Stable key of everything that changes the server preview, so stale previews are never shown. */
export const toneKey = (recipe: AssetDevelopRecipeDto): string => {
  const tone = toneOnlyRecipe(recipe);
  // Masks are sent in the source frame, so their preview also depends on the turns and flips (FL-64).
  const masks = recipe.masks?.length
    ? [recipe.masks, recipe.rotation ?? 0, !!recipe.flipHorizontal, !!recipe.flipVertical]
    : [];
  return JSON.stringify([
    ...DEVELOP_KEYS.map((key) => tone[key] ?? 0),
    tone.preset ?? AssetDevelopPreset.Original,
    tone.presetStrength ?? 100,
    ...masks,
  ]);
};

export const formatParam = (spec: DevelopParamSpec, value: number) => {
  const sign = spec.min < 0 && value > 0 ? '+' : '';
  if (spec.id === 'exposure') {
    return `${sign}${value.toFixed(2)} ${spec.unit}`;
  }
  return `${sign}${Math.round(value)}${spec.unit}`;
};

type CompareKeyEvent = Pick<KeyboardEvent, 'key'> &
  Partial<Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey'>>;

/**
 * Hold-to-compare keys for the photo editor (`develop.mjs` `isCompareKey`). Backslash is the
 * primary key: Apple Photos uses M, but M already means "Group by month" in the library
 * shortcuts, and backslash is Lightroom's before/after key. Y stays as the earlier binding.
 * A press with a command modifier is never a compare, but a release always is, so a held
 * original can't get stuck.
 */
export const isCompareKey = (event: CompareKeyEvent | undefined | null, { release = false } = {}) => {
  if (!event) {
    return false;
  }
  if (!release && (event.metaKey || event.ctrlKey || event.altKey)) {
    return false;
  }
  return event.key === '\\' || event.code === 'Backslash' || (event.key || '').toLowerCase() === 'y';
};
