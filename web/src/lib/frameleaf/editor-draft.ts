/**
 * The quick editor's working copy of a still-image recipe (FL-113).
 *
 * Ported from the editor parts of `design/frameleaf/template/src/state.mjs`: `normalizeEdit`,
 * `changeDraft`, the undo/redo history and the copy/paste settings selection. The server
 * recipe (`AssetDevelopRecipeDto`) is the durable contract; this module adds the client-only
 * aspect choice the crop tool needs and keeps every value inside the contract ranges so a
 * draft can be sent as-is.
 */
import {
  AssetDevelopMaskKind,
  AssetDevelopPreset,
  AssetDevelopRevisionStatus,
  type AssetDevelopRecipeDto,
  type AssetDevelopRevisionResponseDto,
} from '@frameleaf/sdk';
import {
  ASPECT_IDS,
  DEVELOP_KEYS,
  PRESET_IDS,
  clampParam,
  developDefaults,
  isFullRect,
  normalizeRect,
  type AspectId,
  type DevelopValues,
} from '$lib/frameleaf/develop';
import { normalizeMasks, WEB_MASK_KINDS, type EditorMask } from '$lib/frameleaf/photo-tools';

export const RECIPE_VERSION = 1 as const;

export type EditorRecipe = DevelopValues & {
  straighten: number;
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  preset: AssetDevelopPreset;
  presetStrength: number;
  version: number;
  /** Untouched wire envelope; known UI values are projected separately. Never sent as a key. */
  opaqueRecipe?: AssetDevelopRecipeDto;
  crop: { x: number; y: number; w: number; h: number };
  /** Selective adjustments (FL-64), in the oriented frame like the crop. */
  masks: EditorMask[];
  /** Client-only: which aspect chip framed the crop. Not sent to the server. */
  aspect: AspectId;
};

export type EditorDraft = {
  recipe: EditorRecipe;
  undo: EditorRecipe[];
  redo: EditorRecipe[];
};

const HISTORY_LIMIT = 200;

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const choice = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T =>
  choices.includes(value as T) ? (value as T) : fallback;

export const initialRecipe = (): EditorRecipe => ({
  version: RECIPE_VERSION,
  ...developDefaults(),
  crop: { x: 0, y: 0, w: 1, h: 1 },
  aspect: 'Original',
  straighten: 0,
  rotation: 0,
  flipHorizontal: false,
  flipVertical: false,
  preset: AssetDevelopPreset.Original,
  presetStrength: 100,
  masks: [],
});

/** Every field clamped into the contract, defaults filled; safe for storage and for the wire. */
export function normalizeRecipe(candidate: unknown, fromWire = true): EditorRecipe {
  const value = (candidate && typeof candidate === 'object' ? candidate : {}) as Partial<EditorRecipe>;
  const develop = Object.fromEntries(DEVELOP_KEYS.map((key) => [key, clampParam(key, value[key])])) as DevelopValues;
  const rotation = (Math.round(number(value.rotation, 0, 0, 360) / 90) * 90) % 360;
  return {
    version:
      typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version > 0
        ? value.version
        : RECIPE_VERSION,
    ...(Object.keys(value).length > 0 && {
      // Svelte state proxies are not structured-cloneable; this is a JSON wire envelope.
      // eslint-disable-next-line unicorn/prefer-structured-clone
      opaqueRecipe: JSON.parse(
        JSON.stringify(
          (fromWire ? undefined : value.opaqueRecipe) ??
            Object.fromEntries(
              Object.entries(value).filter(([key]) => fromWire || (key !== 'aspect' && key !== 'opaqueRecipe')),
            ),
        ),
      ),
    }),
    ...develop,
    crop: normalizeRect(value.crop),
    aspect: choice(value.aspect, ASPECT_IDS, isFullRect(value.crop) ? 'Original' : 'Free'),
    straighten: Math.round(number(value.straighten, 0, -45, 45) * 2) / 2,
    rotation,
    flipHorizontal: value.flipHorizontal === true,
    flipVertical: value.flipVertical === true,
    preset: choice(value.preset, PRESET_IDS, AssetDevelopPreset.Original),
    presetStrength: Math.round(number(value.presetStrength, 100, 0, 100)),
    masks: normalizeMasks(value.masks),
  };
}

/** The wire shape: the recipe without the client-only aspect. */
export function toServerRecipe(recipe: EditorRecipe): AssetDevelopRecipeDto {
  const { aspect: _, opaqueRecipe, ...rest } = normalizeRecipe(recipe, false);
  const raw: Partial<AssetDevelopRecipeDto> = opaqueRecipe ?? {};
  if (rest.version !== RECIPE_VERSION) {
    const original = normalizeRecipe(raw, true);
    const changed = Object.fromEntries(
      Object.entries(rest).filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(original[key as keyof typeof original]),
      ),
    );
    return { ...raw, ...changed, version: rest.version } as AssetDevelopRecipeDto;
  }
  const rawMasks = Array.isArray(raw.masks) ? raw.masks : [];
  const known = new Map(rest.masks.map((mask) => [mask.id, mask]));
  const masks = rawMasks.flatMap((item) => {
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const mask = known.get(id);
    if (!mask) {
      // a mask this editor shows and the person removed goes; one it only carries (FL-233) stays
      return WEB_MASK_KINDS.includes(item.kind as AssetDevelopMaskKind) ? [] : [item];
    }
    known.delete(id);
    return [{ ...item, ...mask, adjustments: { ...(item.adjustments as object), ...mask.adjustments } }];
  });
  return {
    ...raw,
    ...rest,
    crop: { ...(raw.crop && typeof raw.crop === 'object' && raw.crop), ...rest.crop },
    masks: [...masks, ...known.values()],
  };
}

const stableRecipeKeys = (_key: string, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : value;

export const sameRecipe = (a: EditorRecipe, b: EditorRecipe) =>
  JSON.stringify(toServerRecipe(a), stableRecipeKeys) === JSON.stringify(toServerRecipe(b), stableRecipeKeys);

export const createDraft = (recipe?: unknown, fromWire = true): EditorDraft => ({
  recipe: normalizeRecipe(recipe, fromWire),
  undo: [],
  redo: [],
});

/** Applies a patch, recording the previous recipe for undo; an unchanged recipe leaves the draft alone. */
export function changeDraft(draft: EditorDraft, patch: Partial<EditorRecipe>): EditorDraft {
  const recipe = normalizeRecipe({ ...draft.recipe, ...patch }, false);
  if (sameRecipe(recipe, draft.recipe) && recipe.aspect === draft.recipe.aspect) {
    return draft;
  }
  return {
    recipe,
    undo: [...draft.undo, draft.recipe].slice(-HISTORY_LIMIT),
    redo: [],
  };
}

/**
 * Opens the draft on the recipe the server returned. Adjustments made while that request was in
 * flight were made against the defaults; they are replayed on top of the loaded recipe (one undo
 * step back to it) rather than silently discarded.
 */
export function rebaseDraft(draft: EditorDraft, loaded: unknown, fromWire = true): EditorDraft {
  const base = createDraft(loaded, fromWire);
  if (draft.undo.length === 0 && draft.redo.length === 0) {
    return base;
  }
  const defaults = initialRecipe();
  const edits = Object.fromEntries(
    (Object.keys(draft.recipe) as (keyof EditorRecipe)[])
      .filter((key) => key !== 'opaqueRecipe')
      .filter((key) => JSON.stringify(draft.recipe[key]) !== JSON.stringify(defaults[key]))
      .map((key) => [key, draft.recipe[key]]),
  ) as Partial<EditorRecipe>;
  return changeDraft(base, edits);
}

const travel = (draft: EditorDraft, source: 'undo' | 'redo'): EditorDraft => {
  const target = source === 'undo' ? 'redo' : 'undo';
  if (draft[source].length === 0) {
    return draft;
  }
  return {
    recipe: normalizeRecipe(draft[source].at(-1), false),
    [source]: draft[source].slice(0, -1),
    [target]: [...draft[target], draft.recipe].slice(-HISTORY_LIMIT),
  } as EditorDraft;
};

export const undoDraft = (draft: EditorDraft) => travel(draft, 'undo');
export const redoDraft = (draft: EditorDraft) => travel(draft, 'redo');

/** Keys copied by Copy settings / Paste settings, and kept by a saved preset. Geometry stays put. */
export const SETTINGS_KEYS = [...DEVELOP_KEYS, 'preset', 'presetStrength', 'masks'] as const;
export type EditorSettings = Partial<Pick<EditorRecipe, (typeof SETTINGS_KEYS)[number]>>;

export const pickSettings = (recipe: EditorRecipe): EditorSettings =>
  Object.fromEntries(SETTINGS_KEYS.map((key) => [key, recipe[key]])) as EditorSettings;

export const geometryIsDefault = (recipe: EditorRecipe) =>
  recipe.aspect === 'Original' &&
  isFullRect(recipe.crop) &&
  recipe.straighten === 0 &&
  recipe.rotation === 0 &&
  !recipe.flipHorizontal &&
  !recipe.flipVertical;

export const resetGeometry = (): Partial<EditorRecipe> => ({
  aspect: 'Original',
  crop: { x: 0, y: 0, w: 1, h: 1 },
  straighten: 0,
  rotation: 0,
  flipHorizontal: false,
  flipVertical: false,
});

/** The recipe the editor opens with: the current version's, or the original. */
export function openingRecipe(
  develop: { currentRevisionId: string | null; revisions: AssetDevelopRevisionResponseDto[] } | null | undefined,
  hdrSource = false,
) {
  const current = develop?.revisions.find((revision) => revision.id === develop.currentRevisionId);
  const recipe = normalizeRecipe(current?.recipe);
  const wire = toServerRecipe(recipe);
  const policy = wire.hdr && typeof wire.hdr === 'object' ? (wire.hdr as Record<string, unknown>) : {};
  const previous =
    recipe.version === 4
      ? { renderer: 'frameleaf-develop-hdr/2', version: 2, toneMapper: 'libultrahdr/2.0.2-frameleaf.2' }
      : { renderer: 'frameleaf-develop-hdr/1', version: 1, toneMapper: 'libultrahdr/2.0.2' };
  const legacyPolicy =
    (wire.renderer === undefined || wire.renderer === previous.renderer) &&
    (policy.version === undefined || policy.version === previous.version) &&
    (policy.intent === undefined || policy.intent === 'preserve') &&
    (policy.referenceWhite === undefined || policy.referenceWhite === 203) &&
    (policy.sdrToneMapper === undefined || policy.sdrToneMapper === previous.toneMapper);
  if (
    hdrSource &&
    [1, 3, 4].includes(recipe.version) &&
    legacyPolicy &&
    (wire.hdr === undefined || (wire.hdr !== null && typeof wire.hdr === 'object' && !Array.isArray(wire.hdr)))
  ) {
    return normalizeRecipe({
      ...wire,
      version: 5,
      renderer: 'frameleaf-develop-hdr/3',
      hdr: {
        ...policy,
        version: 3,
        intent: 'preserve',
        referenceWhite: 203,
        sdrToneMapper: 'libultrahdr/2.0.2-frameleaf.3',
      },
    });
  }
  return recipe;
}

export const isRevisionBusy = (status: AssetDevelopRevisionStatus) =>
  status === AssetDevelopRevisionStatus.Queued || status === AssetDevelopRevisionStatus.Rendering;

export const anyRevisionBusy = (revisions: readonly AssetDevelopRevisionResponseDto[]) =>
  revisions.some((revision) => isRevisionBusy(revision.status));
