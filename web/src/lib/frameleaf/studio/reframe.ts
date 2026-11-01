/**
 * FL-563: vertical (9:16) and square (1:1) Studio exports, the export dialog's side.
 *
 * The server answers where the subject is through each shot (`GET /studio/projects/{id}/framing`) as
 * a share of the project frame width. The crop keeps the full height of the frame and is the shape's
 * width; it follows that path, clamped so it never leaves the frame. A person's move of a shot is an
 * offset added to the whole automatic path (owner decision 2026-10-26: a move applies to the whole
 * shot), so the crop still follows the subject after it is moved. The dialog sends the resulting path
 * of every shot with the export, and the server seals it (`server/src/utils/studio-reframe.ts`).
 */
import { StudioExportResolution, StudioExportShape } from '@frameleaf/sdk';

export type ReframePoint = { t: number; x: number };

/** How far one arrow key moves a shot (Shift moves five times as far), as a share of the frame width. */
export const REFRAME_STEP = 0.01;
export const REFRAME_STEP_LARGE = 0.05;
/** A move smaller than this is no move: the shot counts as automatic. */
const MOVED = 0.001;

const SHAPE_ASPECT: Record<Exclude<StudioExportShape, StudioExportShape.Original>, number> = {
  [StudioExportShape.Landscape]: 16 / 9,
  [StudioExportShape.Vertical]: 9 / 16,
  [StudioExportShape.Square]: 1,
};

const SHORT_SIDE: Partial<Record<StudioExportResolution, number>> = {
  [StudioExportResolution.$720P]: 720,
  [StudioExportResolution.$1080P]: 1080,
  [StudioExportResolution.$1440P]: 1440,
  [StudioExportResolution.$2160P]: 2160,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

export const isReshaped = (shape: StudioExportShape) => shape !== StudioExportShape.Original;

/**
 * The size of the exported file: 1080p vertical is 1080 × 1920, 1080p square 1080 × 1080. The
 * original shape keeps the project's proportions with the resolution as its short side.
 */
export const shapedSize = (
  shape: StudioExportShape,
  resolution: StudioExportResolution,
  frame?: { width: number; height: number },
) => {
  const short = SHORT_SIDE[resolution];
  if (!short) {
    return null;
  }
  if (shape === StudioExportShape.Landscape) {
    return { width: Math.round((short * 16) / 9 / 2) * 2, height: short };
  }
  if (shape === StudioExportShape.Vertical) {
    return { width: short, height: Math.round((short * 16) / 9 / 2) * 2 };
  }
  if (shape === StudioExportShape.Square) {
    return { width: short, height: short };
  }
  const { width, height } = frame ?? { width: 16, height: 9 };
  const long = Math.round((short * Math.max(width, height)) / Math.min(width, height) / 2) * 2;
  return width >= height ? { width: long, height: short } : { width: short, height: long };
};

/** The crop width as a share of the project frame width; 1 when the frame is no wider than the shape. */
export const cropShare = (shape: StudioExportShape, frame: { width: number; height: number }) =>
  isReshaped(shape) ? Math.min(1, (frame.height * SHAPE_ASPECT[shape as keyof typeof SHAPE_ASPECT]) / frame.width) : 1;

/** A crop centre the crop can reach: half a crop from either edge. */
export const clampCentre = (centre: number, share: number) =>
  share >= 1 ? 0.5 : clamp(centre, share / 2, 1 - share / 2);

/** The subject (or crop) centre at progress 0..1 through a shot: linear between points, held at the ends. */
export const pathAt = (path: readonly ReframePoint[], progress: number) => {
  if (path.length === 0) {
    return 0.5;
  }
  if (progress <= path[0].t) {
    return path[0].x;
  }
  for (let index = 1; index < path.length; index++) {
    const previous = path[index - 1];
    const next = path[index];
    if (progress <= next.t) {
      const span = next.t - previous.t;
      return span <= 0 ? next.x : previous.x + ((next.x - previous.x) * (progress - previous.t)) / span;
    }
  }
  return path.at(-1)!.x;
};

/** The crop centre at progress through a shot: the automatic path plus the person's move, clamped. */
export const cropCentreAt = (path: readonly ReframePoint[], progress: number, nudge: number, share: number) =>
  clampCentre(pathAt(path, progress) + nudge, share);

/** The crop path of a shot as the export sends it. */
export const cropPath = (path: readonly ReframePoint[], nudge: number, share: number): ReframePoint[] =>
  (path.length > 0 ? path : [{ t: 0.5, x: 0.5 }]).map((point) => ({
    t: round4(point.t),
    x: round4(clampCentre(point.x + nudge, share)),
  }));

/** A picture size as people write it: 1080 × 1920. Digits and the sign read the same in every language. */
export const sizeLabel = ({ width, height }: { width: number; height: number }) => `${width} × ${height}`;

export const isMoved = (nudge: number | undefined) => Math.abs(nudge ?? 0) > MOVED;

/** A move, kept within half the frame either way. */
export const limitNudge = (nudge: number) => clamp(nudge, -0.5, 0.5);
