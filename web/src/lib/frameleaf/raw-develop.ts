/**
 * The RAW develop editor's controls (FL-420, prototype PhotographyEditor.jsx), expressed in the native
 * version 2 recipe the server develops with darktable (FL-282, `native-develop.ts`).
 *
 * The prototype's sliders are household units (-100 to 100, EV); the native recipe keeps darktable's
 * own units. These functions translate both ways and keep a recipe minimal: a control at its neutral
 * value is left out, exactly as a recipe the server never saw it in.
 *
 * Controls the native engine does not have (Whites, Blacks, the HSL colour mixer, Vibrance and the
 * prototype's simulated Daylight/Tungsten buttons) are not offered; see the FL-420 report.
 */
import { initialNativeRecipe, newNativeMask, type NativeMask, type NativeRecipe } from '$lib/frameleaf/native-develop';
import type { NativeSyncField } from '$lib/frameleaf/native-sync';

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
/** A plain copy of a recipe, also of a reactive (proxied) one, which structuredClone refuses. */
export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const clone = plain;

/** The server's limits for native masks (server/src/queue/develop-values.ts). */
export const MAX_MASKS = 8;
export const MAX_STROKES = 64;
export const MAX_STROKE_POINTS = 512;

/** Leaves out every key whose value is undefined, so a neutral control is absent from the recipe. */
export function tidy(recipe: NativeRecipe): NativeRecipe {
  const next = { ...recipe } as Record<string, unknown>;
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) {
      delete next[key];
    }
  }
  return next as NativeRecipe;
}

/* Light ------------------------------------------------------------------ */

export const EXPOSURE_RANGE = { min: -5, max: 5, step: 0.05 } as const;

/** Contrast: darktable's 0.01-1.99 (1 is neutral) as the prototype's -100 to 100. */
export const contrastSlider = (value: number | undefined) => Math.round(((value ?? 1) - 1) * 100);
export const contrastValue = (slider: number) =>
  slider === 0 ? undefined : round(clamp(1 + slider / 100, 0.01, 1.99));

/** Saturation: darktable's 0-2 (1 is neutral) as -100 to 100. */
export const saturationSlider = (value: number | undefined) => Math.round(((value ?? 1) - 1) * 100);
export const saturationValue = (slider: number) => (slider === 0 ? undefined : round(clamp(1 + slider / 100, 0, 2)));

/* White balance ---------------------------------------------------------- */

/**
 * Temperature and Tint move the camera's own white-balance coefficients (the recipe stores
 * multipliers of them, never Kelvin): Temperature trades red against blue by up to 0.6 stop either
 * way, Tint moves green by up to 0.4 stop. Both at zero is the camera's "As shot" balance.
 */
const TEMPERATURE_STOPS = 0.6;
const TINT_STOPS = 0.4;

export function whiteBalanceSliders(balance: NativeRecipe['whiteBalance']) {
  if (!balance) {
    return { temperature: 0, tint: 0 };
  }
  const red = Math.log2(balance.red);
  const blue = Math.log2(balance.blue);
  const green = Math.log2(balance.green) - (red + blue) / 2;
  return {
    temperature: Math.round(clamp(((red - blue) / 2 / TEMPERATURE_STOPS) * 100, -100, 100)),
    tint: Math.round(clamp((-green / TINT_STOPS) * 100, -100, 100)),
  };
}

export function whiteBalanceValue(temperature: number, tint: number): NativeRecipe['whiteBalance'] {
  if (temperature === 0 && tint === 0) {
    return undefined;
  }
  const warm = (temperature / 100) * TEMPERATURE_STOPS;
  return {
    red: round(2 ** warm),
    green: round(2 ** (-(tint / 100) * TINT_STOPS)),
    blue: round(2 ** -warm),
  };
}

/* Tone curve ------------------------------------------------------------- */

export type CurvePoint = { x: number; y: number };
export const CURVE_X = [0, 0.25, 0.5, 0.75, 1] as const;
export const CURVE_PRESETS = {
  linear: [0, 0.25, 0.5, 0.75, 1],
  soft: [0, 0.18, 0.5, 0.82, 1],
  lifted: [0.07, 0.32, 0.54, 0.77, 1],
} as const;
export type CurvePreset = keyof typeof CURVE_PRESETS;

/** The curve's output at `x`, by straight lines between its points (identity when there is none). */
export function sampleCurve(curve: readonly CurvePoint[] | undefined, x: number) {
  if (!curve || curve.length < 2) {
    return x;
  }
  const right = curve.findIndex((point) => point.x >= x);
  if (right <= 0) {
    return right === 0 ? curve[0].y : curve.at(-1)!.y;
  }
  const a = curve[right - 1];
  const b = curve[right];
  return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
}

/** The prototype's five-point view of any curve. */
export const curveLevels = (curve: readonly CurvePoint[] | undefined) =>
  CURVE_X.map((x) => round(sampleCurve(curve, x)));

/** Five levels back to a native curve; a straight line is no curve at all. */
export function curveValue(levels: readonly number[]): CurvePoint[] | undefined {
  if (levels.every((y, index) => Math.abs(y - CURVE_X[index]) < 0.001)) {
    return undefined;
  }
  return CURVE_X.map((x, index) => ({ x, y: round(clamp(levels[index], 0, 1)) }));
}

/* Detail & lens ---------------------------------------------------------- */

/** Sharpness 0-100 is darktable's sharpen amount 0-2, at its default radius and threshold. */
export const sharpnessSlider = (sharpen: NativeRecipe['sharpen']) => Math.round((sharpen?.amount ?? 0) * 50);
export const sharpnessValue = (slider: number, current: NativeRecipe['sharpen']): NativeRecipe['sharpen'] =>
  slider === 0
    ? undefined
    : { radius: current?.radius ?? 2, threshold: current?.threshold ?? 0.5, amount: slider / 50 };

/** Denoise 0-100 is the native pre-demosaic noise threshold 0-0.1. */
export const denoiseSlider = (threshold: number | undefined) => Math.round((threshold ?? 0) * 1000);
export const denoiseValue = (slider: number) => (slider === 0 ? undefined : round(slider / 1000, 4));

/* Geometry --------------------------------------------------------------- */

export const ASPECTS = ['Original', 'Free', '1:1', '3:2', '4:5', '16:9'] as const;
export type Aspect = (typeof ASPECTS)[number];
export type CropRect = NonNullable<NativeRecipe['crop']>;
export const FULL_FRAME: CropRect = { x: 0, y: 0, w: 1, h: 1 };

/** A crop at least 5% a side that stays inside the frame. */
export function normalizeCrop(rect: CropRect): CropRect {
  const w = clamp(rect.w, 0.05, 1);
  const h = clamp(rect.h, 0.05, 1);
  return {
    x: round(clamp(rect.x, 0, 1 - w), 4),
    y: round(clamp(rect.y, 0, 1 - h), 4),
    w: round(w, 4),
    h: round(h, 4),
  };
}

export const isFullFrame = (rect: CropRect | undefined) =>
  !rect || (rect.x <= 0.0001 && rect.y <= 0.0001 && rect.w >= 0.9999 && rect.h >= 0.9999);

/** The largest centred crop of `aspect` in a frame `width` by `height` pixels (after the quarter turns). */
export function aspectCrop(aspect: Aspect, width: number, height: number): CropRect | undefined {
  if (aspect === 'Original' || aspect === 'Free' || width <= 0 || height <= 0) {
    return undefined;
  }
  const [a, b] = aspect.split(':').map(Number);
  const ratio = a / b;
  const frame = width / height;
  const w = frame > ratio ? ratio / frame : 1;
  const h = frame > ratio ? 1 : frame / ratio;
  return normalizeCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

export const turn = (rotation: NativeRecipe['rotation'], by: 90 | -90) =>
  (((((rotation ?? 0) + by) % 360) + 360) % 360) as NonNullable<NativeRecipe['rotation']>;

/* Masks ------------------------------------------------------------------ */

export type MaskKind = NativeMask['kind'];
export const isPainted = (kind: MaskKind) =>
  kind === 'brush' || kind === 'subject' || kind === 'sky' || kind === 'background';
export const isSuggested = (kind: MaskKind) => kind === 'subject' || kind === 'sky' || kind === 'background';
export const isPlaced = (kind: MaskKind) => kind === 'radial' || kind === 'linear';

/** A new mask as the prototype makes one (`makeMask`); a brush stays off until its first stroke. */
export function createMask(kind: MaskKind, name: string, artifact?: string): NativeMask {
  const mask = newNativeMask(kind, artifact);
  return {
    ...mask,
    name,
    ...(kind === 'radial' && { radiusX: 0.22, radiusY: 0.3 }),
    ...(kind === 'linear' && { x: 0.5, y: 0, endX: 0.5, endY: 0.6 }),
    ...(kind === 'brush' && { enabled: false, strokes: [] }),
  };
}

/**
 * What the server is sent: no drawing-canvas flag, a brush without strokes switched off (the native
 * schema refuses an enabled empty brush) and a linear mask whose ends meet nudged apart.
 */
export function sendable(recipe: NativeRecipe): NativeRecipe {
  const next = tidy(clone(recipe));
  delete next.sensorCanvas;
  if (next.masks) {
    next.masks = next.masks.map((mask) => {
      if (mask.kind === 'brush' && mask.enabled && !mask.strokes?.length) {
        return { ...mask, enabled: false };
      }
      if (mask.kind === 'linear' && mask.x === mask.endX && mask.y === mask.endY) {
        return { ...mask, endY: mask.endY >= 0.99 ? mask.endY - 0.01 : mask.endY + 0.01 };
      }
      return mask;
    });
    if (next.masks.length === 0) {
      delete next.masks;
    }
  }
  return next;
}

/** JSON with object keys in order, so equal recipes compare equal whatever order they were built in. */
const stable = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stable(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

/** Two recipes develop the same photo. */
export const sameRecipe = (a: NativeRecipe, b: NativeRecipe) => stable(sendable(a)) === stable(sendable(b));

/** A recipe that changes nothing: the original. */
export const isOriginal = (recipe: NativeRecipe) => sameRecipe(recipe, initialNativeRecipe());

/** The recipe without its edits but with its framing, for "Hold original". */
export const originalFraming = (recipe: NativeRecipe): NativeRecipe =>
  tidy({
    ...initialNativeRecipe(),
    crop: recipe.crop,
    rotation: recipe.rotation,
    straighten: recipe.straighten,
    flipHorizontal: recipe.flipHorizontal,
    flipVertical: recipe.flipVertical,
  });

/* Looks ------------------------------------------------------------------ */

type LookValues = Pick<NativeRecipe, 'exposureEV' | 'contrast' | 'saturation' | 'shadows' | 'highlights'> & {
  temperature?: number;
  tint?: number;
  curve?: readonly number[];
};

/**
 * The prototype's looks (develop.mjs `PRESETS`) in native terms. A look sets real darktable values
 * that the server renders; the swatch is only a hint drawn on the current preview. Silvertone and
 * Noir's vignette and grain have no native counterpart, so Noir keeps its tone and Silvertone is left
 * out.
 */
export const LOOKS: readonly { id: string; values: LookValues; swatch: string }[] = [
  { id: 'original', values: {}, swatch: 'none' },
  { id: 'vivid', values: { contrast: 1.18, saturation: 1.3 }, swatch: 'contrast(1.12) saturate(1.35)' },
  {
    id: 'natural',
    values: { contrast: 1.06, highlights: -12, shadows: 10, saturation: 1.08 },
    swatch: 'contrast(1.04) saturate(1.08)',
  },
  { id: 'warm', values: { temperature: 32, tint: 6, saturation: 1.05 }, swatch: 'sepia(0.18) saturate(1.15)' },
  { id: 'cool', values: { temperature: -30, tint: -4, contrast: 1.06 }, swatch: 'hue-rotate(-8deg) saturate(0.9)' },
  { id: 'mono', values: { saturation: 0, contrast: 1.08 }, swatch: 'grayscale(1) contrast(1.08)' },
  {
    id: 'noir',
    values: { saturation: 0, contrast: 1.36, shadows: -20, curve: [0, 0.18, 0.5, 0.84, 1] },
    swatch: 'grayscale(1) contrast(1.4) brightness(0.9)',
  },
  {
    id: 'fade',
    values: { contrast: 0.82, saturation: 0.82, curve: [0.1, 0.3, 0.52, 0.76, 0.95] },
    swatch: 'contrast(0.82) saturate(0.82) brightness(1.06)',
  },
];

/**
 * `base` with a look applied at `strength` (0-100). Contrast, saturation and the white-balance
 * multipliers scale; exposure, shadows and highlights add; the curve blends toward the look's.
 */
export function applyLook(base: NativeRecipe, lookId: string, strength: number): NativeRecipe {
  const look = LOOKS.find((item) => item.id === lookId)?.values ?? {};
  const s = clamp(strength, 0, 100) / 100;
  const next = clone(base);
  const scale = (value: number | undefined, target: number | undefined, min: number, max: number) =>
    target === undefined ? value : round(clamp((value ?? 1) * target ** s, min, max));
  const add = (value: number | undefined, target: number | undefined, min: number, max: number) =>
    target === undefined ? value : round(clamp((value ?? 0) + target * s, min, max));
  next.contrast = scale(base.contrast, look.contrast, 0.01, 1.99);
  // A black-and-white look fades the colour out in a straight line; a power of zero would not.
  next.saturation =
    look.saturation === 0 ? round((base.saturation ?? 1) * (1 - s)) : scale(base.saturation, look.saturation, 0, 2);
  next.exposureEV = add(base.exposureEV, look.exposureEV, -18, 18) ?? 0;
  next.shadows = add(base.shadows, look.shadows, -100, 100);
  next.highlights = add(base.highlights, look.highlights, -100, 100);
  if (look.temperature !== undefined || look.tint !== undefined) {
    const current = whiteBalanceSliders(base.whiteBalance);
    next.whiteBalance = whiteBalanceValue(
      Math.round(clamp(current.temperature + (look.temperature ?? 0) * s, -100, 100)),
      Math.round(clamp(current.tint + (look.tint ?? 0) * s, -100, 100)),
    );
  }
  if (look.curve) {
    const from = curveLevels(base.curve);
    next.curve = curveValue(from.map((y, index) => y + (look.curve![index] - y) * s));
  }
  for (const key of ['contrast', 'saturation', 'shadows', 'highlights'] as const) {
    const neutral = key === 'contrast' || key === 'saturation' ? 1 : 0;
    if (next[key] !== undefined && Math.abs(next[key] - neutral) < 0.0005) {
      next[key] = undefined;
    }
  }
  return tidy(next);
}

/* Sync ------------------------------------------------------------------- */

export const SYNC_GROUPS = ['tone', 'colour', 'detail', 'geometry', 'masks'] as const;
export type SyncGroup = (typeof SYNC_GROUPS)[number];
export const SYNC_FIELDS: Readonly<Record<SyncGroup, readonly NativeSyncField[]>> = {
  tone: ['exposureEV', 'contrast', 'highlights', 'shadows', 'curve'],
  colour: ['whiteBalance', 'saturation'],
  detail: ['sharpen', 'noiseThreshold', 'lensCorrection'],
  geometry: ['crop', 'rotation', 'straighten', 'flipHorizontal', 'flipVertical'],
  masks: ['masks'],
};

/** The settings to copy: painted brush strokes belong to one photo and never travel (native-sync.ts). */
export const syncSource = (recipe: NativeRecipe): NativeRecipe => {
  const next = sendable(recipe);
  if (next.masks) {
    next.masks = next.masks.filter((mask) => mask.kind !== 'brush');
  }
  return next;
};

/* Histogram -------------------------------------------------------------- */

export type Histogram = { red: number[]; green: number[]; blue: number[]; luma: number[]; max: number };

/** Channel counts of RGBA pixels (a small canvas of the rendered preview). */
export function histogram(pixels: ArrayLike<number>, bins = 48): Histogram {
  const result: Histogram = {
    red: Array.from({ length: bins }, () => 0),
    green: Array.from({ length: bins }, () => 0),
    blue: Array.from({ length: bins }, () => 0),
    luma: Array.from({ length: bins }, () => 0),
    max: 0,
  };
  const bin = (value: number) => Math.min(bins - 1, Math.floor((value / 256) * bins));
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const [r, g, b] = [pixels[index], pixels[index + 1], pixels[index + 2]];
    result.red[bin(r)]++;
    result.green[bin(g)]++;
    result.blue[bin(b)]++;
    result.luma[bin(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
  }
  result.max = Math.max(...result.red, ...result.green, ...result.blue, ...result.luma);
  return result;
}

export const extensionOf = (fileName: string) => fileName.split('.').pop()?.toUpperCase() ?? '';
