import {
  ASSET_DEVELOP_MAX_MASKS,
  ASSET_DEVELOP_RECIPE_VERSION,
  type AssetDevelopCrop,
  type AssetDevelopMask,
  type AssetDevelopMaskAdjustments,
  AssetDevelopMaskKind,
  AssetDevelopPreset,
  type AssetDevelopRecipe,
} from 'src/dtos/asset-develop.dto.js';

/**
 * Pure still-image develop maths shared by the recipe renderer (FL-113).
 *
 * The prototype's `develop.mjs` describes the parameter space and the presets; this module
 * turns a recipe into the concrete numbers the server pipeline applies. Everything here is
 * deterministic so a revision re-renders to the same bytes, which is what makes the lineage
 * (original + recipe + renderer version = edited master) inspectable.
 *
 * Tone model, renderer v1: a per-channel 8-bit lookup carries the global operations
 * (exposure, white and black points, contrast, dehaze, white balance gains); a per-pixel pass
 * carries the luminance-masked ones (highlights, shadows), saturation and vibrance, the look
 * mixes, the vignette and the grain. Local contrast (clarity), sharpening and noise reduction
 * run as convolution stages afterwards. The prototype's CSS filters were approximations; the
 * curves below are a first pass that the Workstream C gate says must be validated against
 * reference renders before the numbers are treated as final.
 *
 * Renderer v2 (FL-64) adds selective adjustments: after the global tone pass each enabled mask
 * blends in its own tone result, weighted per pixel by the mask shape. A recipe without masks
 * renders to the same bytes as under v1.
 */
export const DEVELOP_RENDERER_VERSION = 'frameleaf-develop/2';

export const FULL_CROP: AssetDevelopCrop = { x: 0, y: 0, w: 1, h: 1 };

export const DEVELOP_SLIDER_KEYS = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temperature',
  'tint',
  'vibrance',
  'saturation',
  'clarity',
  'dehaze',
  'vignette',
  'grain',
  'sharpen',
  'noiseReduction',
] as const;

export type DevelopSliderKey = (typeof DEVELOP_SLIDER_KEYS)[number];
export type DevelopSliders = Record<DevelopSliderKey, number>;

const SLIDER_RANGE: Record<DevelopSliderKey, { min: number; max: number }> = {
  exposure: { min: -2, max: 2 },
  contrast: { min: -100, max: 100 },
  highlights: { min: -100, max: 100 },
  shadows: { min: -100, max: 100 },
  whites: { min: -100, max: 100 },
  blacks: { min: -100, max: 100 },
  temperature: { min: -100, max: 100 },
  tint: { min: -100, max: 100 },
  vibrance: { min: -100, max: 100 },
  saturation: { min: -100, max: 100 },
  clarity: { min: -100, max: 100 },
  dehaze: { min: -100, max: 100 },
  vignette: { min: -100, max: 100 },
  grain: { min: 0, max: 100 },
  sharpen: { min: 0, max: 100 },
  noiseReduction: { min: 0, max: 100 },
};

export type DevelopLook = { grayscale: number; sepia: number };

type PresetDefinition = { params: Partial<DevelopSliders>; look?: Partial<DevelopLook> };

/** Looks, identical to the prototype's `PRESETS` so a saved recipe means the same thing everywhere. */
export const DEVELOP_PRESETS: Record<AssetDevelopPreset, PresetDefinition> = {
  [AssetDevelopPreset.Original]: { params: {} },
  [AssetDevelopPreset.Vivid]: { params: { contrast: 18, vibrance: 30, saturation: 12, clarity: 10 } },
  [AssetDevelopPreset.Natural]: { params: { contrast: 6, highlights: -12, shadows: 10, vibrance: 8 } },
  [AssetDevelopPreset.Warm]: { params: { temperature: 32, tint: 6, vibrance: 8 } },
  [AssetDevelopPreset.Cool]: { params: { temperature: -30, tint: -4, contrast: 6 } },
  [AssetDevelopPreset.Mono]: { params: { contrast: 8 }, look: { grayscale: 100 } },
  [AssetDevelopPreset.Silvertone]: {
    params: { contrast: 14, highlights: -8, clarity: 8 },
    look: { grayscale: 100, sepia: 18 },
  },
  [AssetDevelopPreset.Noir]: {
    params: { contrast: 36, blacks: -24, vignette: 40, grain: 20 },
    look: { grayscale: 100 },
  },
  [AssetDevelopPreset.Fade]: { params: { contrast: -18, blacks: 26, saturation: -18, whites: -10 } },
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

export const defaultDevelopRecipe = (): AssetDevelopRecipe => ({
  version: ASSET_DEVELOP_RECIPE_VERSION,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  clarity: 0,
  dehaze: 0,
  vignette: 0,
  grain: 0,
  sharpen: 0,
  noiseReduction: 0,
  crop: { ...FULL_CROP },
  straighten: 0,
  rotation: 0,
  flipHorizontal: false,
  flipVertical: false,
  preset: AssetDevelopPreset.Original,
  presetStrength: 100,
  masks: [],
});

export const normalizeCrop = (candidate: Partial<AssetDevelopCrop> | null | undefined): AssetDevelopCrop => {
  const w = round(clamp(finite(candidate?.w, 1), 0.05, 1));
  const h = round(clamp(finite(candidate?.h, 1), 0.05, 1));
  const x = round(clamp(finite(candidate?.x, 0), 0, 1 - w));
  const y = round(clamp(finite(candidate?.y, 0), 0, 1 - h));
  return { x, y, w, h };
};

export const isFullCrop = (crop: AssetDevelopCrop | null | undefined) =>
  !crop || (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1);

/**
 * Clamps every field into its contract range and fills defaults, so a recipe read back from
 * storage or supplied by an older client always renders deterministically.
 */
export function normalizeDevelopRecipe(candidate: Partial<AssetDevelopRecipe> | null | undefined): AssetDevelopRecipe {
  const value = candidate ?? {};
  const recipe = defaultDevelopRecipe();
  for (const key of DEVELOP_SLIDER_KEYS) {
    const { min, max } = SLIDER_RANGE[key];
    recipe[key] = round(clamp(finite(value[key], 0), min, max));
  }
  recipe.crop = normalizeCrop(value.crop);
  recipe.straighten = round(clamp(finite(value.straighten, 0), -45, 45));
  const rotation = Math.round(finite(value.rotation, 0) / 90) * 90;
  recipe.rotation = ((rotation % 360) + 360) % 360;
  recipe.flipHorizontal = value.flipHorizontal === true;
  recipe.flipVertical = value.flipVertical === true;
  recipe.preset = Object.values(AssetDevelopPreset).includes(value.preset as AssetDevelopPreset)
    ? (value.preset as AssetDevelopPreset)
    : AssetDevelopPreset.Original;
  recipe.presetStrength = Math.round(clamp(finite(value.presetStrength, 100), 0, 100));
  recipe.masks = normalizeDevelopMasks(value.masks);
  return recipe;
}

/* Selective adjustments (FL-64) ---------------------------------------------- */

export const DEVELOP_MASK_KEYS = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temperature',
  'tint',
  'vibrance',
  'saturation',
  'dehaze',
] as const satisfies readonly (keyof AssetDevelopMaskAdjustments & DevelopSliderKey)[];

const emptyMaskAdjustments = (): AssetDevelopMaskAdjustments =>
  Object.fromEntries(DEVELOP_MASK_KEYS.map((key) => [key, 0])) as AssetDevelopMaskAdjustments;

/**
 * Clamps masks into the contract, drops malformed and duplicate ones and keeps at most
 * `ASSET_DEVELOP_MAX_MASKS`, so a stored recipe from any client renders deterministically.
 */
export function normalizeDevelopMasks(candidate: unknown): AssetDevelopMask[] {
  if (!Array.isArray(candidate)) {
    return [];
  }
  const seen = new Set<string>();
  const masks: AssetDevelopMask[] = [];
  for (const item of candidate as Partial<AssetDevelopMask>[]) {
    if (!item || typeof item !== 'object' || masks.length >= ASSET_DEVELOP_MAX_MASKS) {
      continue;
    }
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 40) : '';
    const kind = Object.values(AssetDevelopMaskKind).includes(item.kind as AssetDevelopMaskKind)
      ? (item.kind as AssetDevelopMaskKind)
      : undefined;
    if (!id || !kind || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const adjustments = emptyMaskAdjustments();
    for (const key of DEVELOP_MASK_KEYS) {
      const { min, max } = SLIDER_RANGE[key];
      adjustments[key] = round(clamp(finite(item.adjustments?.[key], 0), min, max));
    }
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 60) : null;
    masks.push({
      id,
      name,
      kind,
      enabled: item.enabled !== false,
      invert: item.invert === true,
      x: round(clamp(finite(item.x, 0.5), 0, 1)),
      y: round(clamp(finite(item.y, 0.5), 0, 1)),
      radiusX: round(clamp(finite(item.radiusX, 0.25), 0.01, 1)),
      radiusY: round(clamp(finite(item.radiusY, 0.25), 0.01, 1)),
      endX: round(clamp(finite(item.endX, 0.5), 0, 1)),
      endY: round(clamp(finite(item.endY, 1), 0, 1)),
      feather: Math.round(clamp(finite(item.feather, 50), 0, 100)),
      amount: Math.round(clamp(finite(item.amount, 100), 0, 100)),
      adjustments,
    });
  }
  return masks;
}

/** A mask changes the picture only when it is on, has an amount and moves at least one control. */
export const isActiveMask = (mask: AssetDevelopMask) =>
  mask.enabled && mask.amount > 0 && DEVELOP_MASK_KEYS.some((key) => mask.adjustments[key] !== 0);

/**
 * How strongly a mask applies at a point of the oriented frame, 0 to 1 (before `amount`).
 * `px`/`py` and the mask coordinates are fractions of the frame; `aspect` is its width over its
 * height, so a radial feather and a linear gradient are measured in real distances.
 */
export function maskWeight(mask: AssetDevelopMask, px: number, py: number, aspect = 1): number {
  let weight: number;
  if (mask.kind === AssetDevelopMaskKind.Radial) {
    const dx = (px - mask.x) / mask.radiusX;
    const dy = (py - mask.y) / mask.radiusY;
    const distance = Math.hypot(dx, dy);
    const inner = 1 - mask.feather / 100;
    weight = distance <= inner ? 1 : distance >= 1 ? 0 : 1 - smoothstep(inner, 1, distance);
  } else {
    const vx = (mask.endX - mask.x) * aspect;
    const vy = mask.endY - mask.y;
    const length2 = vx * vx + vy * vy;
    if (length2 === 0) {
      return 0;
    }
    const t = ((px - mask.x) * aspect * vx + (py - mask.y) * vy) / length2;
    weight = 1 - smoothstep(0, 1, t);
  }
  return mask.invert ? 1 - weight : weight;
}

/**
 * Where each output pixel came from in the oriented frame, so masks drawn over the full picture
 * land on the same content after straightening and cropping. Inverse of the geometry stage:
 * output pixel → straightened frame (add the crop offset) → oriented frame (undo the straighten
 * rotation and its cover scale about the centre).
 */
export type DevelopMaskMapping = {
  oriented: { width: number; height: number };
  extract: { left: number; top: number };
  straighten: number;
};

export const identityMaskMapping = (width: number, height: number): DevelopMaskMapping => ({
  oriented: { width, height },
  extract: { left: 0, top: 0 },
  straighten: 0,
});

export const maskMappingFor = (plan: DevelopGeometryPlan): DevelopMaskMapping => ({
  oriented: plan.oriented,
  extract: { left: plan.extract.left, top: plan.extract.top },
  straighten: plan.straighten,
});

/**
 * Applies every active mask to interleaved 8-bit pixels in place: each blends in the mask's own
 * tone and colour result (the same curves as the global pass, with the mask's controls) by its
 * per-pixel weight times its amount. Masks apply in order, each to the result of the one before.
 */
export function applyDevelopMasks(
  data: Uint8Array,
  info: ToneImageInfo,
  masks: AssetDevelopMask[],
  mapping: DevelopMaskMapping = identityMaskMapping(info.width, info.height),
): Uint8Array {
  const active = masks.filter((mask) => isActiveMask(mask));
  if (active.length === 0 || info.channels < 3) {
    return data;
  }
  const { width: ow, height: oh } = mapping.oriented;
  const aspect = oh > 0 ? ow / oh : 1;
  const theta = (mapping.straighten * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const scale = straightenScale(ow, oh, mapping.straighten);
  const cx = ow / 2;
  const cy = oh / 2;
  const channels = info.channels;
  for (const mask of active) {
    const params = { ...zeroSliders(), ...mask.adjustments };
    const luts = buildToneLuts(params);
    const local = localToneFor(params);
    const amount = mask.amount / 100;
    let index = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1, index += channels) {
        // pixel centre in the straightened frame, then back through the straighten rotation
        const sx = mapping.extract.left + x + 0.5 - cx;
        const sy = mapping.extract.top + y + 0.5 - cy;
        const ox = (sx * cos + sy * sin) / scale + cx;
        const oy = (-sx * sin + sy * cos) / scale + cy;
        const weight = maskWeight(mask, ox / ow, oy / oh, aspect) * amount;
        if (weight <= 0) {
          continue;
        }
        const r0 = data[index];
        const g0 = data[index + 1];
        const b0 = data[index + 2];
        const [r1, g1, b1] = toneRgb(luts.r[r0] / 255, luts.g[g0] / 255, luts.b[b0] / 255, local);
        data[index] = Math.round(clamp(r0 + (r1 * 255 - r0) * weight, 0, 255));
        data[index + 1] = Math.round(clamp(g0 + (g1 * 255 - g0) * weight, 0, 255));
        data[index + 2] = Math.round(clamp(b0 + (b1 * 255 - b0) * weight, 0, 255));
      }
    }
  }
  return data;
}

const zeroSliders = (): DevelopSliders =>
  Object.fromEntries(DEVELOP_SLIDER_KEYS.map((key) => [key, 0])) as DevelopSliders;

/** The manual sliders plus the chosen preset scaled by its strength, as the prototype defines it. */
export function effectiveDevelop(recipe: AssetDevelopRecipe): { params: DevelopSliders; look: DevelopLook } {
  const preset = DEVELOP_PRESETS[recipe.preset] ?? DEVELOP_PRESETS[AssetDevelopPreset.Original];
  const strength = clamp(finite(recipe.presetStrength, 100), 0, 100) / 100;
  const params = {} as DevelopSliders;
  for (const key of DEVELOP_SLIDER_KEYS) {
    const { min, max } = SLIDER_RANGE[key];
    const base = clamp(finite(recipe[key], 0), min, max);
    const nudge = finite(preset.params[key]) * strength;
    params[key] = round(clamp(base + nudge, min, max), 3);
  }
  return {
    params,
    look: {
      grayscale: round(finite(preset.look?.grayscale) * strength, 3),
      sepia: round(finite(preset.look?.sepia) * strength, 3),
    },
  };
}

export const isIdentityDevelop = (recipe: AssetDevelopRecipe) => {
  const { params, look } = effectiveDevelop(recipe);
  return (
    DEVELOP_SLIDER_KEYS.every((key) => params[key] === 0) &&
    look.grayscale === 0 &&
    look.sepia === 0 &&
    isFullCrop(recipe.crop) &&
    recipe.straighten === 0 &&
    recipe.rotation === 0 &&
    !recipe.flipHorizontal &&
    !recipe.flipVertical &&
    (recipe.masks ?? []).every((mask) => !isActiveMask(mask))
  );
};

/* Geometry ---------------------------------------------------------------- */

/** Scale that keeps a straightened frame covering its own bounds, as the prototype computes it. */
export function straightenScale(width: number, height: number, degrees: number): number {
  if (!(width > 0) || !(height > 0)) {
    return 1;
  }
  const theta = (Math.abs(finite(degrees)) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return round(Math.max((width * cos + height * sin) / width, (width * sin + height * cos) / height));
}

export type DevelopGeometryPlan = {
  /** Quarter turns applied first, clockwise degrees. */
  rotation: 0 | 90 | 180 | 270;
  flipHorizontal: boolean;
  flipVertical: boolean;
  /** Frame size after the quarter turns, before straightening. */
  oriented: { width: number; height: number };
  /** Straighten angle in degrees; zero skips the straighten stage. */
  straighten: number;
  /**
   * Pixel rectangle to extract from the straightened frame. The straightened frame is the
   * rotated bitmap cropped back to the oriented size (cover scaling), so the rectangle is in
   * oriented-frame pixels.
   */
  extract: { left: number; top: number; width: number; height: number };
  /** Final output dimensions. */
  output: { width: number; height: number };
};

/**
 * Turns the normalized recipe geometry into pixel operations for a decoded frame of
 * `width` × `height` (already EXIF-oriented). Rotation swaps the axes; the crop rectangle is
 * expressed against the rotated frame, exactly as the client draws it.
 */
export function planDevelopGeometry(recipe: AssetDevelopRecipe, width: number, height: number): DevelopGeometryPlan {
  const rotation = recipe.rotation as DevelopGeometryPlan['rotation'];
  const swapped = rotation === 90 || rotation === 270;
  const oriented = { width: swapped ? height : width, height: swapped ? width : height };
  const crop = normalizeCrop(recipe.crop);
  const left = Math.round(crop.x * oriented.width);
  const top = Math.round(crop.y * oriented.height);
  const extractWidth = Math.max(1, Math.min(oriented.width - left, Math.round(crop.w * oriented.width)));
  const extractHeight = Math.max(1, Math.min(oriented.height - top, Math.round(crop.h * oriented.height)));
  return {
    rotation,
    flipHorizontal: recipe.flipHorizontal,
    flipVertical: recipe.flipVertical,
    oriented,
    straighten: round(clamp(finite(recipe.straighten), -45, 45), 2),
    extract: { left, top, width: extractWidth, height: extractHeight },
    output: { width: extractWidth, height: extractHeight },
  };
}

/* Tone ---------------------------------------------------------------------- */

export type DevelopToneLuts = { r: Uint8Array; g: Uint8Array; b: Uint8Array };

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/**
 * Per-channel lookup for the global tone operations. Exposure multiplies linear light; the
 * white and black points move the ends of the curve; contrast is an S-curve around middle
 * grey; dehaze steepens the curve while pulling the black point down; temperature and tint
 * are per-channel gains, which is why three tables exist.
 */
export function buildToneLuts(params: DevelopSliders): DevelopToneLuts {
  const gain = 2 ** clamp(params.exposure, -2, 2);
  const whites = params.whites / 100;
  const blacks = params.blacks / 100;
  const contrast = 1 + (params.contrast / 100) * 0.6 + Math.max(0, params.dehaze / 100) * 0.3;
  const dehazeShift = (params.dehaze / 100) * 0.06;
  const warm = params.temperature / 100;
  const tint = params.tint / 100;
  const channelGain = {
    r: (1 + 0.18 * warm) * (1 + 0.06 * tint),
    g: 1 - 0.12 * tint,
    b: (1 - 0.18 * warm) * (1 + 0.06 * tint),
  };
  const curve = (index: number, channel: keyof typeof channelGain) => {
    let v = srgbToLinear(index / 255) * gain * channelGain[channel];
    v = linearToSrgb(clamp(v, 0, 4));
    // black point: positive lifts the darks, negative crushes them
    v = blacks >= 0 ? v + blacks * 0.18 * (1 - v) : v * (1 + blacks * 0.35);
    // white point: positive pushes brights towards white, negative pulls them down
    v = whites >= 0 ? v + whites * 0.14 * v : v * (1 + whites * 0.14);
    // dehaze pulls the base down before the contrast stretch
    v -= dehazeShift;
    // S-curve around middle grey
    v = 0.5 + (v - 0.5) * contrast;
    return Math.round(clamp(v, 0, 1) * 255);
  };
  const luts = { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) };
  for (let index = 0; index < 256; index += 1) {
    luts.r[index] = curve(index, 'r');
    luts.g[index] = curve(index, 'g');
    luts.b[index] = curve(index, 'b');
  }
  return luts;
}

/** Small deterministic generator so grain is identical for every render of a revision. */
export function createNoise(seed: number) {
  let state = seed >>> 0 || 0x9e_37_79_b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_00_00_00_00;
  };
}

export type ToneImageInfo = { width: number; height: number; channels: 1 | 2 | 3 | 4 };

type LocalTone = { highlights: number; shadows: number; saturation: number; vibrance: number };

const localToneFor = (params: DevelopSliders): LocalTone => ({
  highlights: params.highlights / 100,
  shadows: params.shadows / 100,
  saturation: 1 + params.saturation / 100,
  vibrance: params.vibrance / 100,
});

/**
 * The luminance-masked and colour stages of one pixel after the lookup: highlights, shadows,
 * saturation and vibrance. Values are 0–1 and may leave that range; callers clamp.
 */
function toneRgb(r: number, g: number, b: number, local: LocalTone): [number, number, number] {
  const { highlights, shadows, saturation, vibrance } = local;
  let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (highlights !== 0) {
    const mask = smoothstep(0.45, 1, luma);
    const factor = highlights < 0 ? 1 + highlights * 0.55 * mask : 1;
    const lift = highlights > 0 ? highlights * 0.5 * mask : 0;
    r = r * factor + (1 - r) * lift;
    g = g * factor + (1 - g) * lift;
    b = b * factor + (1 - b) * lift;
  }
  if (shadows !== 0) {
    const mask = 1 - smoothstep(0, 0.55, luma);
    if (shadows > 0) {
      const lift = shadows * 0.45 * mask;
      r += (1 - r) * lift * r * 2;
      g += (1 - g) * lift * g * 2;
      b += (1 - b) * lift * b * 2;
    } else {
      const factor = 1 + shadows * 0.6 * mask;
      r *= factor;
      g *= factor;
      b *= factor;
    }
  }
  luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (saturation !== 1 || vibrance !== 0) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const currentSaturation = max > 0 ? (max - min) / max : 0;
    const factor = saturation * (1 + vibrance * 0.9 * (1 - currentSaturation));
    r = luma + (r - luma) * factor;
    g = luma + (g - luma) * factor;
    b = luma + (b - luma) * factor;
  }
  return [r, g, b];
}

/**
 * Applies the recipe's tone, colour and effect stages to interleaved 8-bit pixels in place.
 * Alpha, when present, is left untouched. Returns the same buffer for chaining.
 */
export function applyDevelopTone(
  data: Uint8Array,
  info: ToneImageInfo,
  params: DevelopSliders,
  look: DevelopLook,
  seed = 1,
): Uint8Array {
  const channels = info.channels;
  if (channels < 3) {
    // Greyscale sources are rendered through the same curve on their single channel.
    const lut = buildToneLuts(params).g;
    for (let i = 0; i < data.length; i += channels) {
      data[i] = lut[data[i]];
    }
    return data;
  }
  const luts = buildToneLuts(params);
  const local = localToneFor(params);
  const grayscale = clamp(look.grayscale / 100, 0, 1);
  const sepia = clamp(look.sepia / 100, 0, 1);
  const vignette = params.vignette / 100;
  const grain = params.grain / 100;
  const noise = createNoise(seed);
  const halfW = info.width / 2;
  const halfH = info.height / 2;
  const cornerDistance = Math.hypot(halfW, halfH) || 1;
  const needsPosition = vignette !== 0;
  let index = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1, index += channels) {
      let [r, g, b] = toneRgb(
        luts.r[data[index]] / 255,
        luts.g[data[index + 1]] / 255,
        luts.b[data[index + 2]] / 255,
        local,
      );
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (grayscale > 0) {
        const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r += (grey - r) * grayscale;
        g += (grey - g) * grayscale;
        b += (grey - b) * grayscale;
      }
      if (sepia > 0) {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        r += (sr - r) * sepia;
        g += (sg - g) * sepia;
        b += (sb - b) * sepia;
      }
      if (needsPosition) {
        const distance = Math.hypot(x + 0.5 - halfW, y + 0.5 - halfH) / cornerDistance;
        const falloff = smoothstep(0.35, 1, distance);
        if (vignette > 0) {
          const factor = 1 - vignette * 0.85 * falloff;
          r *= factor;
          g *= factor;
          b *= factor;
        } else {
          const lift = -vignette * 0.7 * falloff;
          r += (1 - r) * lift;
          g += (1 - g) * lift;
          b += (1 - b) * lift;
        }
      }
      if (grain > 0) {
        const amplitude = grain * 0.12 * (1 - Math.abs(luma - 0.5));
        const value = (noise() - 0.5) * 2 * amplitude;
        r += value;
        g += value;
        b += value;
      }
      data[index] = Math.round(clamp(r, 0, 1) * 255);
      data[index + 1] = Math.round(clamp(g, 0, 1) * 255);
      data[index + 2] = Math.round(clamp(b, 0, 1) * 255);
    }
  }
  return data;
}

/* Detail --------------------------------------------------------------------- */

export type DevelopDetailPlan = {
  /** Median window for noise reduction; 0 skips it. */
  median: 0 | 3 | 5;
  /** Unsharp mask for detail sharpening; undefined skips it. */
  sharpen?: { sigma: number; m1: number; m2: number };
  /** Large-radius unsharp mask for clarity (local midtone contrast); undefined skips it. */
  clarity?: { sigma: number; m1: number; m2: number };
};

/**
 * Convolution stages that run after the tone pass. Clarity uses a radius proportional to the
 * frame so the effect reads the same on a phone photo and a 60 megapixel scan. Negative
 * clarity (a softening) has no lossless convolution equivalent and is rendered as zero;
 * the recipe keeps the value so a later renderer can honour it.
 */
export function planDevelopDetail(
  params: DevelopSliders,
  output: { width: number; height: number },
): DevelopDetailPlan {
  const plan: DevelopDetailPlan = { median: 0 };
  if (params.noiseReduction > 0) {
    plan.median = params.noiseReduction > 50 ? 5 : 3;
  }
  if (params.sharpen > 0) {
    const amount = params.sharpen / 100;
    plan.sharpen = { sigma: round(0.8 + amount * 1.2, 2), m1: round(amount * 1, 2), m2: round(amount * 2.2, 2) };
  }
  if (params.clarity > 0) {
    const amount = params.clarity / 100;
    const minEdge = Math.max(1, Math.min(output.width, output.height));
    plan.clarity = { sigma: round(clamp(minEdge / 160, 2, 24), 2), m1: 0, m2: round(amount * 1.4, 2) };
  }
  return plan;
}
