// FL-563: vertical (9:16) and square (1:1) exports with automatic reframing.
//
// Pure functions, no I/O. The server seals the framing in the claim settings (`shape` and `reframe`,
// `server/src/utils/studio-reframe.ts`): the output size and, for every video and still on the main
// timeline, the path of the crop centre through that shot as fractions of the canvas width. This
// module derives the graph the engine renders from the project's own graph; nothing is written back to
// the project. The canvas becomes the crop (full height of the project frame, the shape's width), and
// the engine renders that canvas at the sealed output size:
//
// - every picture keeps its size and moves so the shot's crop centre lands in the middle of the new
//   frame. A crop that moves through the shot becomes `x` keyframes (ease-in-out) on the clip;
// - a clip that is already animated sideways keeps its animation, moved by the shot's average framing;
// - titles and captions move into the shape's safe area and wrap to its width;
// - audio, effects, crops, nested timelines and colour are untouched.
//
// Anything this cannot derive honestly (a clip that follows another clip, a position driven by an
// expression) is refused with a reason rather than rendered in the wrong place.

import { applyShapedCaptionLooks } from './bundled-worker-word-captions.mjs';

export const REFRAME_PROFILE = 'reframe-v1';
export const LANDSCAPE_REFRAME_PROFILE = 'reframe-landscape-v1';
export const REFRAME_VERSION = 1;
export const REFRAME_SHAPES = Object.freeze({
  landscape: 16 / 9,
  vertical: 9 / 16,
  square: 1,
});
export const REFRAME_MAX_POINTS = 8;

/** The short side of each export resolution (mirrors `RESOLUTION_SHORT_SIDE`). */
const SHORT_SIDE = Object.freeze({
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '2160p': 2160,
});

/**
 * Where titles and captions may sit, as fractions of the shaped frame: clear of the edges, and for a
 * vertical film clear of the top and bottom where phone apps draw their own buttons and captions.
 */
export const SAFE_AREA = Object.freeze({
  landscape: Object.freeze({
    left: 0.06,
    right: 0.06,
    top: 0.06,
    bottom: 0.08,
  }),
  vertical: Object.freeze({ left: 0.06, right: 0.06, top: 0.1, bottom: 0.18 }),
  square: Object.freeze({ left: 0.06, right: 0.06, top: 0.06, bottom: 0.08 }),
});

const PICTURE_TYPES = new Set(['video', 'image']);
const TEXT_TYPES = new Set(['text', 'subtitle']);
const NON_VISUAL_TYPES = new Set(['audio']);

export class ReframeRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReframeRefusal';
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new ReframeRefusal(code, message);
};

const even = (value) => Math.max(2, Math.round(value / 2) * 2);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** The file a shaped export writes for a resolution: 1080p vertical is 1080 × 1920. */
export const shapedOutputSize = (shape, resolution) => {
  const short = SHORT_SIDE[resolution];
  if (!short || !Object.hasOwn(REFRAME_SHAPES, shape)) return null;
  return shape === 'landscape'
    ? { width: even((short * 16) / 9), height: short }
    : shape === 'vertical'
      ? { width: short, height: even((short * 16) / 9) }
      : { width: short, height: short };
};

/**
 * The crop of the project frame for a shape: the full height and the shape's width when the frame is
 * wider than the shape (the usual case), otherwise the full width and the shape's height.
 */
export const cropRegion = (canvas, shape) => {
  const aspect = REFRAME_SHAPES[shape];
  if (canvas.width / canvas.height >= aspect) {
    return {
      width: canvas.height * aspect,
      height: canvas.height,
      horizontal: true,
    };
  }
  return {
    width: canvas.width,
    height: canvas.width / aspect,
    horizontal: false,
  };
};

/** The crop centre of a shot at progress 0..1 along its path (linear between points). */
export const pathAt = (path, progress) => {
  if (path.length === 1) return path[0].x;
  if (progress <= path[0].t) return path[0].x;
  for (let index = 1; index < path.length; index++) {
    const previous = path[index - 1];
    const next = path[index];
    if (progress <= next.t) {
      const span = next.t - previous.t;
      return span <= 0 ? next.x : previous.x + ((next.x - previous.x) * (progress - previous.t)) / span;
    }
  }
  return path.at(-1).x;
};

const validPath = (path) =>
  Array.isArray(path) &&
  path.length > 0 &&
  path.length <= REFRAME_MAX_POINTS &&
  path.every(
    (point, index) =>
      point &&
      finite(point.t) &&
      finite(point.x) &&
      point.t >= 0 &&
      point.t <= 1 &&
      point.x >= 0 &&
      point.x <= 1 &&
      (index === 0 || point.t > path[index - 1].t),
  );

/**
 * The sealed framing of a claim, checked against its settings, or null for an export in the project's
 * own shape. A shape without a framing, a framing whose size is not the shape's at this resolution or
 * a malformed path is refused: the worker never guesses where the picture goes.
 */
export const reframeOf = (settings) => {
  const shape = settings?.shape;
  if (shape === undefined || shape === 'original') {
    if (settings?.reframe !== undefined) refuse('reframe_invalid', 'The export carries a framing but no shape.');
    return null;
  }
  if (!Object.hasOwn(REFRAME_SHAPES, shape)) refuse('reframe_invalid', `Unknown export shape ${shape}.`);
  const reframe = settings.reframe;
  const expected = shapedOutputSize(shape, settings.resolution);
  if (!expected) refuse('reframe_invalid', `A ${shape} export needs a resolution of 720p to 2160p.`);
  if (
    !reframe ||
    reframe.version !== REFRAME_VERSION ||
    reframe.shape !== shape ||
    reframe.output?.width !== expected.width ||
    reframe.output?.height !== expected.height ||
    !reframe.shots ||
    typeof reframe.shots !== 'object' ||
    Array.isArray(reframe.shots)
  ) {
    refuse('reframe_invalid', 'The framing sealed with this export does not match its shape and resolution.');
  }
  for (const [id, path] of Object.entries(reframe.shots)) {
    if (!validPath(path)) refuse('reframe_invalid', `The framing of shot ${id} is not a valid path.`);
  }
  return { shape, output: expected, shots: reframe.shots };
};

/** The size of a picture item's box on the project canvas: stored, or its source contained in the frame. */
const pictureBox = (item, canvas) => {
  const transform = item.transform ?? {};
  if (finite(transform.width) && finite(transform.height)) return { width: transform.width, height: transform.height };
  const sourceWidth = item.type === 'composition' ? item.compositionWidth : item.sourceWidth;
  const sourceHeight = item.type === 'composition' ? item.compositionHeight : item.sourceHeight;
  if (!finite(sourceWidth) || !finite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return null;
  const fit = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
  return { width: sourceWidth * fit, height: sourceHeight * fit };
};

const keyframeEntryOf = (timeline, itemId) => (timeline.keyframes ?? []).find((entry) => entry?.itemId === itemId);

const groupOf = (groups, property) =>
  (Array.isArray(groups) ? groups : []).find((group) => group?.property === property && group.keyframes?.length > 0);

const expressionOn = (entry, properties) =>
  (entry?.expressions ?? []).some(
    (expression) => expression?.enabled !== false && properties.has(expression?.targetProperty),
  );

const POSITION = new Set(['x', 'y', 'position']);

/** Moves the item's stored and animated horizontal position, and scales nothing. */
const shiftHorizontally = (item, entry, dx) => {
  item.transform = { ...item.transform, x: (item.transform?.x ?? 0) + dx };
  for (const keyframe of groupOf(entry?.properties, 'x')?.keyframes ?? []) {
    if (finite(keyframe.value)) keyframe.value += dx;
  }
  for (const keyframe of groupOf(entry?.vectorProperties, 'position')?.keyframes ?? []) {
    if (finite(keyframe.value?.x)) keyframe.value = { ...keyframe.value, x: keyframe.value.x + dx };
  }
};

const animatedSideways = (entry) => !!groupOf(entry?.properties, 'x') || !!groupOf(entry?.vectorProperties, 'position');

/**
 * Titles and captions: the box narrows to the safe width and the box centre moves inside the safe
 * area. Text wraps to the new width, and the engine grows the box to hold it (render spec X6).
 */
const placeText = (item, entry, frame, original, safe) => {
  const transform = item.transform ?? {};
  const width = finite(transform.width) ? transform.width : original.width;
  const height = finite(transform.height) ? transform.height : original.height;
  const safeWidth = frame.width * (1 - safe.left - safe.right);
  const safeTop = frame.height * safe.top - frame.height / 2;
  const safeBottom = frame.height / 2 - frame.height * safe.bottom;
  const safeCentreX = frame.width * ((safe.left - safe.right) / 2);
  const newWidth = Math.min(width, safeWidth);
  const placeX = (x) => clamp(x, safeCentreX - (safeWidth - newWidth) / 2, safeCentreX + (safeWidth - newWidth) / 2);
  const placeY = (y) =>
    height >= safeBottom - safeTop
      ? (safeTop + safeBottom) / 2
      : clamp(y, safeTop + height / 2, safeBottom - height / 2);
  item.transform = {
    ...transform,
    width: newWidth,
    height,
    x: placeX(transform.x ?? 0),
    y: placeY(transform.y ?? 0),
  };
  for (const keyframe of groupOf(entry?.properties, 'x')?.keyframes ?? []) {
    if (finite(keyframe.value)) keyframe.value = placeX(keyframe.value);
  }
  for (const keyframe of groupOf(entry?.properties, 'y')?.keyframes ?? []) {
    if (finite(keyframe.value)) keyframe.value = placeY(keyframe.value);
  }
  for (const keyframe of groupOf(entry?.properties, 'width')?.keyframes ?? []) {
    if (finite(keyframe.value)) keyframe.value = Math.min(keyframe.value, safeWidth);
  }
  for (const keyframe of groupOf(entry?.vectorProperties, 'position')?.keyframes ?? []) {
    if (finite(keyframe.value?.x) && finite(keyframe.value?.y)) {
      keyframe.value = {
        ...keyframe.value,
        x: placeX(keyframe.value.x),
        y: placeY(keyframe.value.y),
      };
    }
  }
};

/** The track compositing order: the highest `order` is the bottom layer, the main picture. */
const trackOrder = (timeline) => new Map((timeline.tracks ?? []).map((track) => [track.id, Number(track.order ?? 0)]));

/** The crop centre under a non-picture item at its first frame: the bottom-most shot showing then. */
const centreUnder = (items, shots, orders, frame) => {
  let best = null;
  for (const item of items) {
    if (!PICTURE_TYPES.has(item.type) || frame < item.from || frame >= item.from + item.durationInFrames) continue;
    if (!best || (orders.get(item.trackId) ?? 0) > (orders.get(best.trackId) ?? 0)) best = item;
  }
  if (!best) return 0.5;
  return pathAt(shots[best.id], (frame - best.from) / Math.max(1, best.durationInFrames - 1));
};

/**
 * The graph the engine renders for a shaped export: a deep copy of the project graph with the shaped
 * canvas and every item placed as described above. The project graph is not changed.
 */
export const reframeGraph = (graph, reframe) => {
  const derived = structuredClone(graph);
  const original = {
    width: graph.metadata.width,
    height: graph.metadata.height,
  };
  const crop = cropRegion(original, reframe.shape);
  const frame = { width: even(crop.width), height: even(crop.height) };
  derived.metadata = {
    ...derived.metadata,
    width: frame.width,
    height: frame.height,
  };
  const timeline = derived.timeline;
  const items = timeline.items;
  const orders = trackOrder(timeline);
  const safe = SAFE_AREA[reframe.shape];
  // FL-640: captions take their shaped look (Highlight, Large, Middle by default in 9:16).
  applyShapedCaptionLooks(items, frame, reframe.shape, safe);

  for (const item of items) {
    if (PICTURE_TYPES.has(item.type) && !reframe.shots[item.id]) {
      refuse('reframe_invalid', `The framing sealed with this export has no shot ${item.id}.`);
    }
  }

  for (const item of items) {
    if (NON_VISUAL_TYPES.has(item.type)) continue;
    const entry = keyframeEntryOf(timeline, item.id);
    if (item.transformParent) {
      refuse(
        'reframe_unsupported',
        'A clip follows another clip’s movement, which a vertical or square export cannot reframe yet. Export it in its original shape.',
      );
    }
    if (expressionOn(entry, POSITION)) {
      refuse(
        'reframe_unsupported',
        'A clip’s position is set by an expression, which a vertical or square export cannot reframe. Export it in its original shape.',
      );
    }
    if (TEXT_TYPES.has(item.type)) {
      placeText(item, entry, frame, original, safe);
      continue;
    }
    // Pictures and everything else that draws keep their size on the project canvas.
    const box = pictureBox(item, original);
    if (box)
      item.transform = {
        ...item.transform,
        width: box.width,
        height: box.height,
      };
    else if (PICTURE_TYPES.has(item.type)) {
      refuse('reframe_unsupported', `A ${item.type} clip has no picture size to reframe.`);
    }
    if (!crop.horizontal) continue;
    const path = PICTURE_TYPES.has(item.type) ? reframe.shots[item.id] : null;
    const offsetAt = (centre) => original.width / 2 - centre * original.width;
    if (!path) {
      shiftHorizontally(item, entry, offsetAt(centreUnder(items, reframe.shots, orders, item.from)));
      continue;
    }
    const moving = path.length > 1 && path.some((point) => Math.abs(point.x - path[0].x) > 1e-6);
    if (!moving || animatedSideways(entry)) {
      // A still framing, or a clip already animated sideways: one move for the whole shot.
      const mean = path.reduce((sum, point) => sum + point.x, 0) / path.length;
      shiftHorizontally(item, entry, offsetAt(moving ? mean : path[0].x));
      continue;
    }
    const base = item.transform?.x ?? 0;
    const last = Math.max(0, item.durationInFrames - 1);
    const keyframes = [];
    for (const point of path) {
      const frameAt = Math.round(point.t * last);
      if (keyframes.at(-1)?.frame === frameAt) continue;
      keyframes.push({
        id: `fl-reframe-${item.id}-${keyframes.length}`,
        frame: frameAt,
        value: base + offsetAt(point.x),
        easing: 'ease-in-out',
      });
    }
    item.transform = { ...item.transform, x: keyframes[0].value };
    let target = entry;
    if (!target) {
      target = { itemId: item.id, animationVersion: 2, properties: [] };
      timeline.keyframes = [...(timeline.keyframes ?? []), target];
    }
    target.properties = [
      ...(target.properties ?? []).filter((group) => group?.property !== 'x'),
      { property: 'x', keyframes },
    ];
  }
  return { graph: derived, canvas: frame };
};
