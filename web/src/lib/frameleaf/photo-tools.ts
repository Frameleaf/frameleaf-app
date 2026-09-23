/**
 * Selective photo tools in the quick editor (FL-64): masks, saved presets and the round trip of
 * an original through another application.
 *
 * Mask coordinates are fractions of the oriented frame (after quarter turns and flips, before
 * straightening and the crop), the same space as the crop rectangle, so the renderer and the
 * stage agree on where a mask sits. The server recipe (`AssetDevelopMask`) is the contract.
 */
import {
  AssetDevelopMaskKind,
  AssetDevelopPreset,
  type AssetDevelopMask,
  type AssetDevelopMaskAdjustments,
  type AssetDevelopRecipeDto,
  type DevelopPresetSettingsDto,
} from '@immich/sdk';
import { DEVELOP_KEYS, clampParam, toneOnlyRecipe, type DevelopKey } from '$lib/frameleaf/develop';

export const MAX_MASKS = 8;

/** The per-pixel controls a mask may change; spatial ones (clarity, detail, vignette, grain) stay global. */
export const MASK_KEYS = [
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
] as const satisfies readonly DevelopKey[];
export type MaskKey = (typeof MASK_KEYS)[number];

export type EditorMask = Required<Omit<AssetDevelopMask, 'adjustments' | 'name'>> & {
  name: string | null;
  adjustments: Record<MaskKey, number>;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round = (value: number, places = 4) => Math.round(value * 10 ** places) / 10 ** places;
const unit = (value: unknown, fallback: number, min = 0) =>
  round(clamp(typeof value === 'number' && Number.isFinite(value) ? value : fallback, min, 1));
const whole = (value: unknown, fallback: number) =>
  Math.round(clamp(typeof value === 'number' && Number.isFinite(value) ? value : fallback, 0, 100));

export const emptyMaskAdjustments = (): Record<MaskKey, number> =>
  Object.fromEntries(MASK_KEYS.map((key) => [key, 0])) as Record<MaskKey, number>;

/** Clamped, defaults filled, malformed and duplicate masks dropped, at most `MAX_MASKS`. */
export function normalizeMasks(candidate: unknown): EditorMask[] {
  if (!Array.isArray(candidate)) {
    return [];
  }
  const seen = new Set<string>();
  const masks: EditorMask[] = [];
  for (const item of candidate as Partial<AssetDevelopMask>[]) {
    if (!item || typeof item !== 'object' || masks.length >= MAX_MASKS) {
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
    for (const key of MASK_KEYS) {
      adjustments[key] = clampParam(key, (item.adjustments as Partial<AssetDevelopMaskAdjustments>)?.[key] ?? 0);
    }
    masks.push({
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 60) : null,
      kind,
      enabled: item.enabled !== false,
      invert: item.invert === true,
      x: unit(item.x, 0.5),
      y: unit(item.y, 0.5),
      radiusX: unit(item.radiusX, 0.25, 0.01),
      radiusY: unit(item.radiusY, 0.25, 0.01),
      endX: unit(item.endX, 0.5),
      endY: unit(item.endY, 1),
      feather: whole(item.feather, 50),
      amount: whole(item.amount, 100),
      adjustments,
    });
  }
  return masks;
}

const newMaskId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

/** A new mask as the Add buttons draw it: a centred ellipse, or a gradient from the top down to the middle. */
export function createMask(kind: AssetDevelopMaskKind, existing: readonly EditorMask[] = []): EditorMask {
  let id = newMaskId();
  while (existing.some((mask) => mask.id === id)) {
    id = newMaskId();
  }
  return normalizeMasks([
    kind === AssetDevelopMaskKind.Radial
      ? { id, kind, x: 0.5, y: 0.5, radiusX: 0.25, radiusY: 0.25, feather: 50 }
      : { id, kind, x: 0.5, y: 0, endX: 0.5, endY: 0.5 },
  ])[0];
}

export const maskIsActive = (mask: EditorMask) =>
  mask.enabled && mask.amount > 0 && MASK_KEYS.some((key) => mask.adjustments[key] !== 0);

type Point = { x: number; y: number };
const rotatePoint = ({ x, y }: Point, clockwise: boolean): Point =>
  clockwise ? { x: round(1 - y), y: round(x) } : { x: round(y), y: round(1 - x) };

/** The mask after a quarter turn of the frame, so it stays on the same content. */
export function rotateMask(mask: EditorMask, clockwise: boolean): EditorMask {
  const start = rotatePoint(mask, clockwise);
  const end = rotatePoint({ x: mask.endX, y: mask.endY }, clockwise);
  return { ...mask, ...start, endX: end.x, endY: end.y, radiusX: mask.radiusY, radiusY: mask.radiusX };
}

/** The mask after a mirror of the frame. */
export const flipMask = (mask: EditorMask, axis: 'h' | 'v'): EditorMask =>
  axis === 'h'
    ? { ...mask, x: round(1 - mask.x), endX: round(1 - mask.endX) }
    : { ...mask, y: round(1 - mask.y), endY: round(1 - mask.endY) };

/**
 * Masks moved from the oriented frame back onto the unrotated, unflipped source, for the tone
 * preview, which the server renders without geometry. Inverse of rotate → mirror left/right →
 * mirror top/bottom, the order the renderer applies them.
 */
export function masksToSource(
  masks: readonly EditorMask[],
  geometry: { rotation: number; flipHorizontal: boolean; flipVertical: boolean },
): EditorMask[] {
  const turns = (((Math.round(geometry.rotation / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return masks.map((original) => {
    let mask = original;
    if (geometry.flipVertical) {
      mask = flipMask(mask, 'v');
    }
    if (geometry.flipHorizontal) {
      mask = flipMask(mask, 'h');
    }
    for (let i = 0; i < turns; i += 1) {
      mask = rotateMask(mask, false);
    }
    return mask;
  });
}

/**
 * The recipe the stage asks the server to preview: tone only, geometry drawn on the stage, and
 * the masks moved onto the source frame the preview is rendered in.
 */
export const tonePreviewRecipe = (recipe: AssetDevelopRecipeDto): AssetDevelopRecipeDto => ({
  ...toneOnlyRecipe(recipe),
  masks: masksToSource(normalizeMasks(recipe.masks), {
    rotation: recipe.rotation ?? 0,
    flipHorizontal: !!recipe.flipHorizontal,
    flipVertical: !!recipe.flipVertical,
  }),
});

/* Presets ------------------------------------------------------------------------------------ */

/** What a preset holds: the develop sliders, the look and its strength, and the masks. Never geometry. */
export type PresetSettings = Record<DevelopKey, number> & {
  preset: AssetDevelopPreset;
  presetStrength: number;
  masks: EditorMask[];
};

export function presetSettingsFrom(source: Partial<PresetSettings> | DevelopPresetSettingsDto): PresetSettings {
  const value = source as Partial<PresetSettings>;
  const develop = Object.fromEntries(DEVELOP_KEYS.map((key) => [key, clampParam(key, value[key])])) as Record<
    DevelopKey,
    number
  >;
  return {
    ...develop,
    preset: Object.values(AssetDevelopPreset).includes(value.preset as AssetDevelopPreset)
      ? (value.preset as AssetDevelopPreset)
      : AssetDevelopPreset.Original,
    presetStrength: whole(value.presetStrength, 100),
    // Applying a preset replaces the draft's masks, so its mask identifiers never collide.
    masks: normalizeMasks(value.masks),
  };
}

/** True when the draft already carries exactly the preset's settings (so the preset shows as applied). */
export const presetMatches = (settings: PresetSettings, current: PresetSettings) =>
  JSON.stringify(settings) === JSON.stringify(current);

/* External development round trip ---------------------------------------------------------- */

/** Finished formats a developed file may come back in; RAW goes out, never back. */
export const RETURN_ACCEPT = '.jpg,.jpeg,.png,.tif,.tiff,.webp,.heic,.heif';

/** SHA-256 of a file as hexadecimal, so the server can tell a transfer that did not arrive intact. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Short form of a checksum for provenance lines. */
export const shortChecksum = (hex: string | null | undefined) => (hex ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : '');
