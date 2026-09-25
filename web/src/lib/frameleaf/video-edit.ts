/**
 * The video quick editor's edit (FL-113), ported from the video half of
 * `design/frameleaf/template/src/state.mjs` (`initialEdit`, `normalizeEdit`) and `develop.mjs`
 * (`SPEEDS`, `TEXT_POSITIONS`, `filmstripTimes`, `speedAt`, `renderedDuration`).
 *
 * The prototype keeps one edit object per clip: the develop sliders and look, the crop in the
 * displayed (turned and flipped) frame, trim, speed with ranges, volume, text overlays and the two
 * Enhance switches. The server keeps a video recipe as a list of edit actions measured against the
 * original. This module converts between the two, exactly where the server can say the same thing:
 *
 * - the crop rectangle is turned and flipped back into the original's pixels (the server crops
 *   first, then turns, straightens and mirrors);
 * - the straighten angle changes sign under a single flip, because the server mirrors after it
 *   straightens while the prototype straightens the flipped picture;
 * - speed ranges override the whole-clip speed; overlapping ranges resolve the way `speedAt` does
 *   (the earliest range wins);
 * - a text size in points is relative to a 1280-pixel-wide frame, as the prototype's preview
 *   scales it, and is sent as a fraction of the output height.
 *
 * Adjustments and looks written by the earlier editor are kept untouched (`legacy`) until the
 * person changes Adjust or Presets, so reopening and saving an old clip never re-renders it
 * differently by accident.
 */
import {
  AssetEditAction,
  MirrorAxis,
  TextOverlayPosition,
  VideoAdjustModel,
  VideoDevelopPreset,
  VideoTrimMode,
  type AssetEditActionItemDto,
} from '@immich/sdk';
import {
  ASPECT_IDS,
  DEVELOP_KEYS,
  DEVELOP_PARAMS,
  FULL_RECT,
  clampParam,
  developDefaults,
  isFullRect,
  normalizeRect,
  presetFor,
  rotateRect,
  type AspectId,
  type CropRect,
  type DevelopKey,
  type DevelopLookId,
  type DevelopValues,
} from '$lib/frameleaf/develop';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round = (value: number, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const finite = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Whole-clip and range speeds (`develop.mjs` SPEEDS). */
export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
/** Text anchors, a 3 × 3 grid (`develop.mjs` TEXT_POSITIONS). */
export const TEXT_POSITIONS: readonly TextOverlayPosition[] = [
  TextOverlayPosition.TopLeft,
  TextOverlayPosition.Top,
  TextOverlayPosition.TopRight,
  TextOverlayPosition.Left,
  TextOverlayPosition.Center,
  TextOverlayPosition.Right,
  TextOverlayPosition.BottomLeft,
  TextOverlayPosition.Bottom,
  TextOverlayPosition.BottomRight,
];
/** Text colour swatches (`Editor.jsx` SWATCHES). */
export const TEXT_SWATCHES = ['#ffffff', '#f5d76e', '#7fd1ae', '#ff6b6b', '#101112'] as const;
export const MAX_TEXT_OVERLAYS = 20;
export const MAX_SPEED_RANGES = 20;
/** The shortest trim, range or overlay, in seconds (`Editor.jsx` 0.1 s steps). */
export const MIN_SPAN = 0.1;
/** The prototype sizes text against a 1280-pixel-wide frame (`Editor.jsx` textScale). */
const TEXT_REFERENCE_WIDTH = 1280;

export type VideoSpeedRange = { start: number; end: number; speed: number };
export type VideoTextOverlay = {
  id: string;
  text: string;
  position: TextOverlayPosition;
  start: number;
  end: number;
  fontSize: number;
  color: string;
  shadow: boolean;
};
export type VideoTrim = 'precise' | 'fast';

export type VideoEdit = DevelopValues & {
  rotation: 0 | 90 | 180 | 270;
  crop: AspectId;
  cropRect: CropRect;
  straighten: number;
  flipH: boolean;
  flipV: boolean;
  preset: DevelopLookId;
  presetStrength: number;
  /** Clip gain in percent, 0 to 150; 0 is muted. */
  volume: number;
  start: number;
  end: number;
  trim: VideoTrim;
  speed: number;
  speedSegments: VideoSpeedRange[];
  textOverlays: VideoTextOverlay[];
  stabilize: boolean;
  autoEnhance: boolean;
  /** Adjust and look actions from the earlier editor, kept as they are until Adjust or Presets change. */
  legacy: AssetEditActionItemDto[];
};

/** The original's displayed raster and length, from `getAssetEdits().originalVideo`. */
export type VideoSource = { width: number; height: number; durationMs: number };

const secondsOf = (source: VideoSource) => Math.max(MIN_SPAN, source.durationMs / 1000);

export const initialVideoEdit = (duration: number): VideoEdit => ({
  ...developDefaults(),
  rotation: 0,
  crop: 'Original',
  cropRect: { ...FULL_RECT },
  straighten: 0,
  flipH: false,
  flipV: false,
  preset: VideoDevelopPreset.Original,
  presetStrength: 100,
  volume: 100,
  start: 0,
  end: round(duration, 3),
  trim: 'precise',
  speed: 1,
  speedSegments: [],
  textOverlays: [],
  stabilize: false,
  autoEnhance: false,
  legacy: [],
});

const LOOK_IDS: readonly string[] = Object.values(VideoDevelopPreset);
const choice = <T>(value: unknown, choices: readonly T[], fallback: T): T =>
  choices.includes(value as T) ? (value as T) : fallback;

const normalizeRanges = (items: unknown, start: number, end: number): VideoSpeedRange[] =>
  (Array.isArray(items) ? items : [])
    .filter(isObject)
    .slice(0, MAX_SPEED_RANGES)
    .flatMap((item) => {
      const from = clamp(finite(item.start, NaN), start, end);
      const to = clamp(finite(item.end, NaN), start, end);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        return [];
      }
      return [{ start: round(from), end: round(to), speed: choice(item.speed, SPEEDS, 2) }];
    })
    .sort((a, b) => a.start - b.start);

const normalizeOverlays = (items: unknown, duration: number): VideoTextOverlay[] =>
  (Array.isArray(items) ? items : [])
    .filter(isObject)
    .slice(0, MAX_TEXT_OVERLAYS)
    .map((item, index) => {
      const start = round(clamp(finite(item.start, 0), 0, duration));
      return {
        id: typeof item.id === 'string' && item.id ? item.id.slice(0, 64) : `text-${index + 1}`,
        text: typeof item.text === 'string' ? item.text.slice(0, 200) : '',
        position: choice(item.position, TEXT_POSITIONS, TextOverlayPosition.Bottom),
        start,
        end: round(clamp(finite(item.end, duration), start, duration)),
        fontSize: Math.round(clamp(finite(item.fontSize, 32), 12, 96)),
        color:
          typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color.toLowerCase() : '#ffffff',
        shadow: item.shadow !== false,
      };
    });

/** `state.mjs` normalizeEdit, for a clip. */
export function normalizeVideoEdit(candidate: unknown, duration: number): VideoEdit {
  const value = isObject(candidate) ? candidate : {};
  const start = round(clamp(finite(value.start, 0), 0, Math.max(0, duration - MIN_SPAN)));
  const end = round(clamp(finite(value.end, duration), start + MIN_SPAN, duration), 3);
  const develop = Object.fromEntries(DEVELOP_KEYS.map((key) => [key, clampParam(key, value[key])])) as DevelopValues;
  return {
    ...develop,
    rotation: ((((Math.round(finite(value.rotation, 0) / 90) * 90) % 360) + 360) % 360) as VideoEdit['rotation'],
    crop: choice(value.crop, ASPECT_IDS, 'Original'),
    cropRect: normalizeRect(value.cropRect),
    straighten: round(clamp(finite(value.straighten, 0), -45, 45), 1),
    flipH: value.flipH === true,
    flipV: value.flipV === true,
    preset: choice(value.preset, LOOK_IDS, VideoDevelopPreset.Original) as DevelopLookId,
    presetStrength: Math.round(clamp(finite(value.presetStrength, 100), 0, 100)),
    volume: Math.round(clamp(finite(value.volume, 100), 0, 150)),
    start,
    end,
    trim: value.trim === 'fast' ? 'fast' : 'precise',
    speed: choice(value.speed, SPEEDS, 1),
    speedSegments: normalizeRanges(value.speedSegments, start, end),
    textOverlays: normalizeOverlays(value.textOverlays, duration),
    stabilize: value.stabilize === true,
    autoEnhance: value.autoEnhance === true,
    legacy: Array.isArray(value.legacy) ? (value.legacy as AssetEditActionItemDto[]) : [],
  };
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonical(item));
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};
export const sameVideoEdit = (a: VideoEdit, b: VideoEdit) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/* Timeline ------------------------------------------------------------ */

/** Evenly spaced sample times inside a clip, for the filmstrip (`develop.mjs` filmstripTimes). */
export function filmstripTimes(duration: number, count = 12): number[] {
  const frames = Math.max(1, Math.floor(count));
  if (!(duration > 0)) {
    return Array.from({ length: frames }, () => 0);
  }
  return Array.from({ length: frames }, (_, index) => round(((index + 0.5) / frames) * duration, 3));
}

/** Playback rate at a clip time: the first range that covers it, else the whole-clip speed. */
export const speedAt = (edit: Pick<VideoEdit, 'speed' | 'speedSegments'>, time: number) =>
  edit.speedSegments.find((range) => time >= range.start && time < range.end)?.speed ?? (edit.speed || 1);

/**
 * The ranges as the renderer sees them: inside the trim, without overlaps (an earlier range wins,
 * as `speedAt` decides), and without ranges that play at the whole-clip speed anyway.
 */
export function flattenSpeedRanges(edit: Pick<VideoEdit, 'start' | 'end' | 'speed' | 'speedSegments'>) {
  const ranges: VideoSpeedRange[] = [];
  for (const range of [...edit.speedSegments].sort((a, b) => a.start - b.start)) {
    let from = Math.max(range.start, edit.start);
    const to = Math.min(range.end, edit.end);
    const previous = ranges.at(-1);
    if (previous && from < previous.end) {
      from = previous.end;
    }
    if (to - from >= MIN_SPAN / 2 && range.speed !== edit.speed) {
      ranges.push({ start: round(from, 3), end: round(to, 3), speed: range.speed });
    }
  }
  return ranges;
}

/** Output length after the whole-clip speed and the ranges (`develop.mjs` renderedDuration). */
export function renderedDuration(edit: Pick<VideoEdit, 'start' | 'end' | 'speed' | 'speedSegments'>): number {
  if (edit.end <= edit.start) {
    return 0;
  }
  const base = edit.speed || 1;
  let total = 0;
  let cursor = edit.start;
  for (const range of flattenSpeedRanges(edit)) {
    total += (range.start - cursor) / base + (range.end - range.start) / range.speed;
    cursor = range.end;
  }
  total += (edit.end - cursor) / base;
  return round(total, 3);
}

/** `00:12.4`, the prototype's `precise` time. */
export const preciseTime = (seconds: number) => {
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
};
/** `00:12`, the ruler's time (`media.js` timecode). */
export const rulerTime = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/* Geometry ------------------------------------------------------------ */

const quarterTurns = (rotation: number) => (((rotation / 90) % 4) + 4) % 4;
const flipRect = (rect: CropRect, flipH: boolean, flipV: boolean): CropRect => ({
  x: flipH ? 1 - rect.x - rect.w : rect.x,
  y: flipV ? 1 - rect.y - rect.h : rect.y,
  w: rect.w,
  h: rect.h,
});

/** The displayed frame after the quarter turns: its width and height in source pixels. */
export const displayedSize = (source: Pick<VideoSource, 'width' | 'height'>, rotation: number) =>
  quarterTurns(rotation) % 2 === 1
    ? { width: source.height, height: source.width }
    : { width: source.width, height: source.height };

/** A crop in the displayed frame, back in the original's normalized coordinates. */
export function toOriginalRect(edit: Pick<VideoEdit, 'cropRect' | 'rotation' | 'flipH' | 'flipV'>): CropRect {
  let rect = flipRect(edit.cropRect, edit.flipH, edit.flipV);
  for (let turn = 0; turn < quarterTurns(edit.rotation); turn++) {
    rect = rotateRect(rect, false);
  }
  return rect;
}

/** A crop in the original's normalized coordinates, in the displayed frame. */
export function toDisplayedRect(rect: CropRect, rotation: number, flipH: boolean, flipV: boolean): CropRect {
  let displayed = rect;
  for (let turn = 0; turn < quarterTurns(rotation); turn++) {
    displayed = rotateRect(displayed, true);
  }
  return normalizeRect(flipRect(displayed, flipH, flipV));
}

/** The output frame in pixels: the crop of the displayed frame. */
export function outputSize(edit: Pick<VideoEdit, 'cropRect' | 'rotation'>, source: VideoSource) {
  const shown = displayedSize(source, edit.rotation);
  return {
    width: Math.max(1, Math.round(edit.cropRect.w * shown.width)),
    height: Math.max(1, Math.round(edit.cropRect.h * shown.height)),
  };
}

const singleFlip = (edit: Pick<VideoEdit, 'flipH' | 'flipV'>) => edit.flipH !== edit.flipV;

/* Text ------------------------------------------------------------------ */

const ANCHOR: Record<TextOverlayPosition, { x: number; y: number }> = Object.fromEntries(
  TEXT_POSITIONS.map((position, index) => [position, { x: (index % 3) / 2, y: Math.floor(index / 3) / 2 }]),
) as Record<TextOverlayPosition, { x: number; y: number }>;

const nearestPosition = (x: number, y: number): TextOverlayPosition => {
  const column = x < 1 / 3 ? 0 : x < 2 / 3 ? 1 : 2;
  const row = y < 1 / 3 ? 0 : y < 2 / 3 ? 1 : 2;
  return TEXT_POSITIONS[row * 3 + column];
};

/** Points against a 1280-wide frame, as a fraction of the output height (server `size`). */
export const textSizeFraction = (fontSize: number, output: { width: number; height: number }) =>
  round(clamp((fontSize * (output.width / TEXT_REFERENCE_WIDTH)) / output.height, 0.01, 0.2), 4);
const fontSizeFrom = (size: number, output: { width: number; height: number }) =>
  Math.round(clamp((size * output.height * TEXT_REFERENCE_WIDTH) / output.width, 12, 96));

/* Recipe ----------------------------------------------------------------- */

const ms = (seconds: number) => Math.round(seconds * 1000);
const developChanged = (edit: VideoEdit) =>
  DEVELOP_PARAMS.some((spec) => edit[spec.id] !== spec.default) || edit.preset !== VideoDevelopPreset.Original;

/**
 * The server recipe for an edit, measured against the original (`AssetEditsCreateDto.edits`).
 * An untouched edit is an empty list.
 */
export function toVideoEdits(edit: VideoEdit, source: VideoSource): AssetEditActionItemDto[] {
  const edits: AssetEditActionItemDto[] = [];
  const push = (action: AssetEditAction, parameters: AssetEditActionItemDto['parameters']) => {
    edits.push({ action, parameters });
  };
  const duration = secondsOf(source);

  if (!isFullRect(edit.cropRect)) {
    const rect = toOriginalRect(edit);
    const width = Math.max(1, Math.min(source.width, Math.round(rect.w * source.width)));
    const height = Math.max(1, Math.min(source.height, Math.round(rect.h * source.height)));
    push(AssetEditAction.Crop, {
      x: clamp(Math.round(rect.x * source.width), 0, source.width - width),
      y: clamp(Math.round(rect.y * source.height), 0, source.height - height),
      width,
      height,
    });
  }
  if (edit.rotation !== 0) {
    push(AssetEditAction.Rotate, { angle: edit.rotation });
  }
  if (edit.straighten !== 0) {
    push(AssetEditAction.Straighten, { angle: singleFlip(edit) ? -edit.straighten : edit.straighten });
  }
  if (edit.flipH) {
    push(AssetEditAction.Mirror, { axis: MirrorAxis.Horizontal });
  }
  if (edit.flipV) {
    push(AssetEditAction.Mirror, { axis: MirrorAxis.Vertical });
  }
  if (edit.stabilize) {
    push(AssetEditAction.Stabilize, { enabled: true });
  }
  if (edit.autoEnhance) {
    push(AssetEditAction.AutoEnhance, { enabled: true });
  }

  if (developChanged(edit)) {
    const parameters: Record<string, unknown> = { model: VideoAdjustModel.Develop };
    for (const key of DEVELOP_KEYS) {
      if (edit[key] !== 0) {
        parameters[key] = edit[key];
      }
    }
    if (edit.preset !== VideoDevelopPreset.Original) {
      parameters.preset = edit.preset;
      parameters.presetStrength = edit.presetStrength;
    }
    push(AssetEditAction.Adjust, parameters);
  } else {
    edits.push(...edit.legacy);
  }

  const trimmed = edit.start > 0 || edit.end < duration - 0.001;
  if (trimmed) {
    push(AssetEditAction.Trim, {
      startMs: ms(edit.start),
      endMs: Math.max(ms(edit.start) + 1, ms(edit.end)),
      ...(edit.trim === 'fast' && { mode: VideoTrimMode.Fast }),
    });
  }

  const ranges = flattenSpeedRanges(edit);
  if (edit.speed !== 1) {
    push(AssetEditAction.Speed, { rate: edit.speed });
  }
  for (const range of ranges) {
    push(AssetEditAction.Speed, { rate: range.speed, startMs: ms(range.start), endMs: ms(range.end) });
  }

  if (edit.volume === 0) {
    push(AssetEditAction.Audio, { muted: true });
  } else if (edit.volume !== 100) {
    push(AssetEditAction.Audio, { volume: round(edit.volume / 100, 2) });
  }

  const output = outputSize(edit, source);
  for (const overlay of edit.textOverlays) {
    const text = overlay.text.trim();
    if (!text) {
      continue;
    }
    const anchor = ANCHOR[overlay.position];
    push(AssetEditAction.TextOverlay, {
      text,
      position: overlay.position,
      x: anchor.x,
      y: anchor.y,
      shadow: overlay.shadow,
      size: textSizeFraction(overlay.fontSize, output),
      color: overlay.color,
      startMs: ms(overlay.start),
      endMs: Math.max(ms(overlay.start) + 1, ms(overlay.end)),
    });
  }

  return edits;
}

type Parameters = Record<string, unknown>;
const numberOf = (parameters: Parameters, key: string, fallback: number) => finite(parameters[key], fallback);

/** A stored recipe back into an edit the editor can show. Unknown actions are ignored. */
export function fromVideoEdits(
  edits: ReadonlyArray<{ action: string; parameters: unknown }>,
  source: VideoSource,
): VideoEdit {
  const duration = secondsOf(source);
  const edit = initialVideoEdit(duration);
  let originalRect: CropRect | null = null;
  const ranges: VideoSpeedRange[] = [];
  const overlays: Array<Parameters> = [];
  let straighten = 0;

  for (const item of edits) {
    const parameters = (isObject(item.parameters) ? item.parameters : {}) as Parameters;
    switch (item.action) {
      case AssetEditAction.Crop: {
        const x = numberOf(parameters, 'x', 0);
        const y = numberOf(parameters, 'y', 0);
        originalRect = normalizeRect({
          x: x / source.width,
          y: y / source.height,
          w: numberOf(parameters, 'width', source.width) / source.width,
          h: numberOf(parameters, 'height', source.height) / source.height,
        });
        break;
      }
      case AssetEditAction.Rotate: {
        edit.rotation = ((((Math.round(numberOf(parameters, 'angle', 0) / 90) * 90) % 360) + 360) %
          360) as VideoEdit['rotation'];
        break;
      }
      case AssetEditAction.Straighten: {
        straighten = numberOf(parameters, 'angle', 0);
        break;
      }
      case AssetEditAction.Mirror: {
        if (parameters.axis === MirrorAxis.Horizontal) {
          edit.flipH = true;
        } else if (parameters.axis === MirrorAxis.Vertical) {
          edit.flipV = true;
        }
        break;
      }
      case AssetEditAction.Stabilize: {
        edit.stabilize = parameters.enabled !== false;
        break;
      }
      case AssetEditAction.AutoEnhance: {
        edit.autoEnhance = parameters.enabled !== false;
        break;
      }
      case AssetEditAction.Adjust: {
        if (parameters.model === VideoAdjustModel.Develop) {
          for (const key of DEVELOP_KEYS) {
            edit[key as DevelopKey] = clampParam(key as DevelopKey, parameters[key]);
          }
          edit.preset = choice(parameters.preset, LOOK_IDS, VideoDevelopPreset.Original) as DevelopLookId;
          edit.presetStrength = Math.round(clamp(numberOf(parameters, 'presetStrength', 100), 0, 100));
        } else {
          edit.legacy.push({ action: AssetEditAction.Adjust, parameters } as AssetEditActionItemDto);
        }
        break;
      }
      case AssetEditAction.Filter:
      case AssetEditAction.Effect: {
        edit.legacy.push({ action: item.action, parameters } as AssetEditActionItemDto);
        break;
      }
      case AssetEditAction.Trim: {
        edit.start = numberOf(parameters, 'startMs', 0) / 1000;
        edit.end = numberOf(parameters, 'endMs', source.durationMs) / 1000;
        edit.trim = parameters.mode === VideoTrimMode.Fast ? 'fast' : 'precise';
        break;
      }
      case AssetEditAction.Speed: {
        const rate = numberOf(parameters, 'rate', 1);
        if (typeof parameters.startMs === 'number' && typeof parameters.endMs === 'number') {
          ranges.push({ start: parameters.startMs / 1000, end: parameters.endMs / 1000, speed: rate });
        } else {
          edit.speed = rate;
        }
        break;
      }
      case AssetEditAction.Audio: {
        edit.volume = parameters.muted === true ? 0 : Math.round(numberOf(parameters, 'volume', 1) * 100);
        break;
      }
      case AssetEditAction.TextOverlay: {
        overlays.push(parameters);
        break;
      }
    }
  }

  edit.straighten = singleFlip(edit) ? -straighten : straighten;
  if (originalRect && !isFullRect(originalRect)) {
    edit.cropRect = toDisplayedRect(originalRect, edit.rotation, edit.flipH, edit.flipV);
    edit.crop = 'Free';
  }
  edit.speedSegments = ranges;
  const output = outputSize(edit, source);
  edit.textOverlays = overlays.map((parameters, index) => ({
    id: `text-${index + 1}`,
    text: typeof parameters.text === 'string' ? parameters.text : '',
    position: choice(
      parameters.position,
      TEXT_POSITIONS,
      nearestPosition(numberOf(parameters, 'x', 0.5), numberOf(parameters, 'y', 0.8)),
    ),
    start: numberOf(parameters, 'startMs', 0) / 1000,
    end: numberOf(parameters, 'endMs', source.durationMs) / 1000,
    fontSize: fontSizeFrom(numberOf(parameters, 'size', 0.06), output),
    color: typeof parameters.color === 'string' ? parameters.color.slice(0, 7) : '#ffffff',
    shadow: parameters.shadow === true,
  }));
  return normalizeVideoEdit(edit, duration);
}

/** Copy adjustments / Paste adjustments: the develop sliders and the look (`develop.mjs` pickSettings). */
export type VideoSettings = Pick<VideoEdit, DevelopKey | 'preset' | 'presetStrength'>;
export const pickVideoSettings = (edit: VideoEdit): VideoSettings =>
  Object.fromEntries(
    [...DEVELOP_KEYS, 'preset', 'presetStrength'].map((key) => [key, edit[key as keyof VideoEdit]]),
  ) as VideoSettings;

/** A change to Adjust or Presets replaces adjustments written by the earlier editor. */
export const touchesDevelop = (patch: Partial<VideoEdit>) =>
  Object.keys(patch).some(
    (key) => (DEVELOP_KEYS as readonly string[]).includes(key) || key === 'preset' || key === 'presetStrength',
  );

/** The label key of the look, for the strength slider. */
export const lookLabel = (preset: DevelopLookId) => presetFor(preset).label;

/* Undo history (`state.mjs` changeDraft / travelDraft) -------------------------------------- */

export type VideoDraft = { edit: VideoEdit; undo: VideoEdit[]; redo: VideoEdit[] };
const HISTORY_LIMIT = 100;

export const createVideoDraft = (edit: VideoEdit): VideoDraft => ({ edit, undo: [], redo: [] });

export function changeVideoDraft(draft: VideoDraft, patch: Partial<VideoEdit>, duration: number): VideoDraft {
  const next = normalizeVideoEdit({ ...draft.edit, ...patch, ...(touchesDevelop(patch) && { legacy: [] }) }, duration);
  if (sameVideoEdit(next, draft.edit)) {
    return draft;
  }
  return { edit: next, undo: [...draft.undo, draft.edit].slice(-HISTORY_LIMIT), redo: [] };
}

export function travelVideoDraft(draft: VideoDraft, direction: 'undo' | 'redo'): VideoDraft {
  const from = direction === 'undo' ? draft.undo : draft.redo;
  const target = from.at(-1);
  if (!target) {
    return draft;
  }
  const rest = from.slice(0, -1);
  return direction === 'undo'
    ? { edit: target, undo: rest, redo: [...draft.redo, draft.edit] }
    : { edit: target, undo: [...draft.undo, draft.edit], redo: rest };
}
