/**
 * FL-563: vertical (9:16) and square (1:1) Studio exports with automatic reframing.
 *
 * The shape is a setting of one export, never an edit of the project. For each shot (every video and
 * still on the main timeline) the crop keeps the full height of the project frame and moves sideways
 * to follow the subject. This module is the pure part:
 *
 * - where the subject is in a picture, from face boxes (`subjectCentre`), and how a few samples
 *   through a shot become a steady path (`smoothSubjectPath`), with a centre fallback;
 * - where a point of a clip's picture lands on the project canvas (`canvasFraction`);
 * - the framing an export seals for the render worker (`sealStudioReframe`): the output size and the
 *   crop centre path of every shot, clamped so the crop never leaves the frame.
 *
 * The bundled Studio worker derives the rendered graph from that seal
 * (`studio/tools/bundled-worker-reframe.mjs`, `reframe-v1`).
 */

export const STUDIO_EXPORT_SHAPES = ['original', 'vertical', 'square'] as const;
export type StudioExportShape = (typeof STUDIO_EXPORT_SHAPES)[number];
export type StudioReframeShape = Exclude<StudioExportShape, 'original'>;

/** Render-worker evidence that it derives and renders shaped graphs (`bundled-worker-reframe.mjs`). */
export const REFRAME_PROFILE = 'reframe-v1';
export const REFRAME_VERSION = 1;
/** Points a crop path may have; the worker refuses longer ones. */
export const REFRAME_MAX_POINTS = 8;
/** Where a video shot is sampled for its subject, as progress through the shot. */
export const REFRAME_SAMPLE_POINTS = [0.15, 0.5, 0.85] as const;
/** A path that moves less than this (share of the frame width) is held still: no drifting crop. */
export const REFRAME_STILL_RANGE = 0.04;
/** Faces smaller than this share of the largest face in the picture are background, not the subject. */
const MIN_FACE_SHARE = 0.2;

const SHAPE_ASPECT: Readonly<Record<StudioReframeShape, number>> = { vertical: 9 / 16, square: 1 };
const SHORT_SIDE: Readonly<Record<string, number>> = { '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160 };

export type ReframePoint = { t: number; x: number };
export type ReframePath = ReframePoint[];
export type StudioReframeSeal = {
  version: typeof REFRAME_VERSION;
  shape: StudioReframeShape;
  output: { width: number; height: number };
  shots: Record<string, ReframePath>;
};

export const isReframeShape = (shape: unknown): shape is StudioReframeShape =>
  shape === 'vertical' || shape === 'square';

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The file a shaped export writes: 1080p vertical is 1080 × 1920, 1080p square 1080 × 1080. */
export const shapedOutputSize = (shape: StudioReframeShape, resolution: string) => {
  const short = SHORT_SIDE[resolution];
  if (!short) {
    return null;
  }
  return shape === 'vertical' ? { width: short, height: even((short * 16) / 9) } : { width: short, height: short };
};

/** The crop width as a share of the frame width; 1 when the frame is no wider than the shape. */
export const cropShare = (canvas: { width: number; height: number }, shape: StudioReframeShape) =>
  Math.min(1, (canvas.height * SHAPE_ASPECT[shape]) / canvas.width);

/** A crop centre the crop can reach: half a crop from either edge. */
export const clampCentre = (centre: number, share: number) => {
  const half = share / 2;
  return share >= 1 ? 0.5 : round4(clamp(centre, half, 1 - half));
};

export type FaceBox = {
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
  imageWidth: number;
  imageHeight: number;
};

/**
 * Where the subject sits across a picture (0 left, 1 right), from its face boxes: the centre of the
 * faces weighted by their size, ignoring faces far smaller than the largest. Null when there are none.
 */
export const subjectCentre = (faces: readonly FaceBox[]): number | null => {
  const boxes = faces
    .filter((face) => face.imageWidth > 0 && face.imageHeight > 0 && face.boundingBoxX2 > face.boundingBoxX1)
    .map((face) => {
      const x1 = clamp(face.boundingBoxX1 / face.imageWidth, 0, 1);
      const x2 = clamp(face.boundingBoxX2 / face.imageWidth, 0, 1);
      const y1 = clamp(face.boundingBoxY1 / face.imageHeight, 0, 1);
      const y2 = clamp(face.boundingBoxY2 / face.imageHeight, 0, 1);
      return { centre: (x1 + x2) / 2, area: Math.max(0, x2 - x1) * Math.max(0, y2 - y1) };
    })
    .filter((box) => box.area > 0);
  if (boxes.length === 0) {
    return null;
  }
  const largest = Math.max(...boxes.map((box) => box.area));
  const subject = boxes.filter((box) => box.area >= largest * MIN_FACE_SHARE);
  const weight = subject.reduce((sum, box) => sum + box.area, 0);
  return round4(subject.reduce((sum, box) => sum + box.centre * box.area, 0) / weight);
};

/**
 * A steady crop path from subject samples through a shot (`t` progress, `x` subject centre or null
 * where nothing was found). Gaps take the nearest sample, then the `prior` (the faces found in the
 * library's own preview frame), and with nothing at all the result is null: the caller centres the
 * crop. The samples are smoothed with a 1-2-1 window so one jumpy frame cannot swing the crop, and a
 * path that barely moves is held at its average.
 */
export const smoothSubjectPath = (
  samples: ReadonlyArray<{ t: number; x: number | null }>,
  prior: number | null = null,
): ReframePath | null => {
  const sorted = [...samples].filter((sample) => finite(sample.t)).sort((a, b) => a.t - b.t);
  const known = sorted.filter((sample): sample is { t: number; x: number } => finite(sample.x));
  if (known.length === 0) {
    return prior === null ? null : [{ t: 0.5, x: round4(clamp(prior, 0, 1)) }];
  }
  const filled = sorted.map((sample) => {
    if (finite(sample.x)) {
      return { t: sample.t, x: sample.x };
    }
    let nearest = known[0];
    for (const item of known) {
      if (Math.abs(item.t - sample.t) < Math.abs(nearest.t - sample.t)) {
        nearest = item;
      }
    }
    return { t: sample.t, x: nearest.x };
  });
  const smoothed = filled.map((sample, index) => {
    const previous = filled[index - 1]?.x ?? sample.x;
    const next = filled[index + 1]?.x ?? sample.x;
    return { t: round4(clamp(sample.t, 0, 1)), x: round4(clamp((previous + 2 * sample.x + next) / 4, 0, 1)) };
  });
  const xs = smoothed.map((point) => point.x);
  if (Math.max(...xs) - Math.min(...xs) < REFRAME_STILL_RANGE) {
    return [{ t: 0.5, x: round4(xs.reduce((sum, x) => sum + x, 0) / xs.length) }];
  }
  // One point per progress value, in order.
  return smoothed.filter((point, index) => index === 0 || point.t > smoothed[index - 1].t);
};

export type ReframeShot = {
  id: string;
  type: 'video' | 'image';
  mediaId: string | null;
  trackId: string | null;
  from: number;
  durationInFrames: number;
  sourceStart: number | null;
  sourceEnd: number | null;
  sourceFps: number | null;
  item: Record<string, unknown>;
};

/** The project canvas, or null when the graph has none. */
export const reframeCanvas = (graph: unknown) => {
  const metadata = asRecord(asRecord(graph).metadata);
  const width = metadata.width;
  const height = metadata.height;
  return finite(width) && finite(height) && width > 0 && height > 0 ? { width, height } : null;
};

/** Every shot of the main timeline (videos and stills), in the order they start. */
export const reframeShots = (graph: unknown): ReframeShot[] => {
  const items = asRecord(asRecord(graph).timeline).items;
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((raw) => asRecord(raw))
    .filter((item) => (item.type === 'video' || item.type === 'image') && typeof item.id === 'string')
    .map((item) => ({
      id: item.id as string,
      type: item.type as 'video' | 'image',
      mediaId: typeof item.mediaId === 'string' ? item.mediaId : null,
      trackId: typeof item.trackId === 'string' ? item.trackId : null,
      from: finite(item.from) ? item.from : 0,
      durationInFrames: finite(item.durationInFrames) ? item.durationInFrames : 1,
      sourceStart: finite(item.sourceStart) ? item.sourceStart : null,
      sourceEnd: finite(item.sourceEnd) ? item.sourceEnd : null,
      sourceFps: finite(Number(item.sourceFps)) && Number(item.sourceFps) > 0 ? Number(item.sourceFps) : null,
      item,
    }))
    .sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
};

/** Seconds into the source a video shot shows at progress `t`, when its source window is known. */
export const shotSourceSeconds = (shot: ReframeShot, t: number): number | null => {
  if (shot.sourceStart === null || shot.sourceEnd === null || shot.sourceFps === null) {
    return null;
  }
  return (shot.sourceStart + (shot.sourceEnd - shot.sourceStart) * clamp(t, 0, 1)) / shot.sourceFps;
};

/**
 * Where a point across a clip's picture (`u`, 0 left to 1 right) lands on the project canvas, as a
 * share of the canvas width: the clip's box (stored, or its source contained in the frame, render
 * spec L5/L6), the picture contained in the box, flips honoured. A rotated clip answers its box centre.
 */
export const canvasFraction = (item: Record<string, unknown>, canvas: { width: number; height: number }, u: number) => {
  const transform = asRecord(item.transform);
  const sourceWidth = item.sourceWidth;
  const sourceHeight = item.sourceHeight;
  const hasSource = finite(sourceWidth) && finite(sourceHeight) && sourceWidth > 0 && sourceHeight > 0;
  let boxWidth = finite(transform.width) ? transform.width : null;
  let boxHeight = finite(transform.height) ? transform.height : null;
  if (boxWidth === null || boxHeight === null) {
    if (!hasSource) {
      boxWidth = canvas.width;
      boxHeight = canvas.height;
    } else {
      const fit = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
      boxWidth = sourceWidth * fit;
      boxHeight = sourceHeight * fit;
    }
  }
  const x = finite(transform.x) ? transform.x : 0;
  const left = canvas.width / 2 + x - boxWidth / 2;
  const rotation = finite(transform.rotation) ? transform.rotation % 360 : 0;
  if (!hasSource || rotation !== 0) {
    return round4((left + boxWidth / 2) / canvas.width);
  }
  const fit = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const pictureWidth = sourceWidth * fit;
  const pictureLeft = left + (boxWidth - pictureWidth) / 2;
  const across = transform.flipHorizontal === true ? 1 - u : u;
  return round4((pictureLeft + clamp(across, 0, 1) * pictureWidth) / canvas.width);
};

export class StudioReframeError extends Error {}

/**
 * The framing an export seals for the render worker. `framing` is what the person saw in the export
 * dialog (the automatic path with their moves); a shot it does not name is centred on its picture, and
 * a clip that is no longer a shot of this version is ignored.
 * Every centre is clamped so the crop stays inside the frame, and every path is checked.
 */
export const sealStudioReframe = (
  graph: unknown,
  shape: StudioReframeShape,
  resolution: string,
  framing: ReadonlyArray<{ clipId: string; path: ReadonlyArray<ReframePoint> }> = [],
): StudioReframeSeal => {
  const output = shapedOutputSize(shape, resolution);
  if (!output) {
    throw new StudioReframeError('A vertical or square export needs a resolution from 720p to 2160p');
  }
  const canvas = reframeCanvas(graph);
  if (!canvas) {
    throw new StudioReframeError('The project has no canvas');
  }
  const shots = reframeShots(graph);
  const known = new Set(shots.map((shot) => shot.id));
  const asked = new Map<string, ReadonlyArray<ReframePoint>>();
  for (const entry of framing) {
    if (!known.has(entry.clipId)) {
      // Edited away since the dialog read the framing (the export saves pending edits first).
      continue;
    }
    if (asked.has(entry.clipId)) {
      throw new StudioReframeError(`The framing names a clip twice: ${entry.clipId}`);
    }
    const path = entry.path;
    const ordered = path.every(
      (point, index) => finite(point.t) && finite(point.x) && (index === 0 || point.t > path[index - 1].t),
    );
    if (path.length === 0 || path.length > REFRAME_MAX_POINTS || !ordered) {
      throw new StudioReframeError(`The framing of ${entry.clipId} is not a path through the shot`);
    }
    asked.set(entry.clipId, path);
  }
  const share = cropShare(canvas, shape);
  const sealed: Record<string, ReframePath> = {};
  for (const shot of shots) {
    const path = asked.get(shot.id) ?? [{ t: 0.5, x: canvasFraction(shot.item, canvas, 0.5) }];
    const points = path.map((point) => ({ t: round4(clamp(point.t, 0, 1)), x: clampCentre(point.x, share) }));
    // Rounding may bring two progress values together; the worker takes strictly increasing ones.
    sealed[shot.id] = points.filter((point, index) => index === 0 || point.t > points[index - 1].t);
  }
  return { version: REFRAME_VERSION, shape, output, shots: sealed };
};
