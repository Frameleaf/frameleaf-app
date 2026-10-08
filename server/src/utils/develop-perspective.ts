/**
 * Keystone (perspective) correction for still develop recipes (native API gap: `perspective`).
 *
 * The correction is a projective warp of the oriented frame (after the quarter turns and flips,
 * before straightening and the crop) onto itself. `vertical` and `horizontal` run from -100 to 100:
 *
 * - `vertical > 0` widens the top of the picture (corrects verticals that converge upwards, a
 *   building photographed from below); `vertical < 0` widens the bottom.
 * - `horizontal > 0` widens the right side (corrects a right edge that recedes); `horizontal < 0`
 *   widens the left side.
 *
 * In normalized frame coordinates (x and y from -1 at the left/top edge to 1 at the right/bottom
 * edge) each output corner samples the source at a corner pulled inwards along one axis by
 * `PERSPECTIVE_MAX_SHRINK` × |value| / 100:
 *
 *   t = K·max(v, 0)   b = K·max(−v, 0)   r = K·max(h, 0)   l = K·max(−h, 0)
 *   top-left  (−1, −1) ← (−(1 − t), −(1 − l))     top-right    (1, −1) ← ((1 − t), −(1 − r))
 *   bottom-left (−1, 1) ← (−(1 − b), (1 − l))     bottom-right (1, 1)  ← ((1 − b), (1 − r))
 *
 * and every other point follows the homography those four corners define. The source quadrilateral
 * lies inside the frame, so the corrected frame is always fully covered (no empty corners) and keeps
 * the oriented frame's size. Shared by the server renderer, the HDR renderer, the mask mapping and
 * the web preview (`web/src/lib/frameleaf/perspective.ts`); native renderers must use the same maths
 * (docs/docs/features/develop-recipe-protocol.md).
 */
export const PERSPECTIVE_MAX_SHRINK = 0.35;

export type DevelopPerspective = { vertical: number; horizontal: number };

/** Row-major 3×3 homography `[a, b, c, d, e, f, g, h, i]`. */
export type Homography = [number, number, number, number, number, number, number, number, number];

type Point = [number, number];

const clampUnit = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(-100, Math.min(100, value)) / 100 : 0;

export const isIdentityPerspective = (perspective: Partial<DevelopPerspective> | null | undefined) =>
  clampUnit(perspective?.vertical) === 0 && clampUnit(perspective?.horizontal) === 0;

/**
 * Heckbert's square-to-quad mapping: (0,0) → p0, (1,0) → p1, (1,1) → p2, (0,1) → p3.
 */
export function squareToQuad(p0: Point, p1: Point, p2: Point, p3: Point): Homography {
  const [x0, y0] = p0;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;
  const dx3 = x0 - x1 + x2 - x3;
  const dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  }
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export const applyHomography = (m: Homography, x: number, y: number): Point => {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
};

/** The source corners (normalized, -1..1) each output corner samples, in the order TL, TR, BR, BL. */
export function perspectiveSourceCorners(perspective: Partial<DevelopPerspective>): [Point, Point, Point, Point] {
  const v = clampUnit(perspective.vertical);
  const h = clampUnit(perspective.horizontal);
  const t = PERSPECTIVE_MAX_SHRINK * Math.max(v, 0);
  const b = PERSPECTIVE_MAX_SHRINK * Math.max(-v, 0);
  const r = PERSPECTIVE_MAX_SHRINK * Math.max(h, 0);
  const l = PERSPECTIVE_MAX_SHRINK * Math.max(-h, 0);
  return [
    [-(1 - t), -(1 - l)],
    [1 - t, -(1 - r)],
    [1 - b, 1 - r],
    [-(1 - b), 1 - l],
  ];
}

/**
 * The homography from an output position to the source position it samples, both as fractions of
 * the frame (0..1 across, 0..1 down).
 */
export function perspectiveHomography(perspective: Partial<DevelopPerspective>): Homography {
  const toFraction = ([x, y]: Point): Point => [(x + 1) / 2, (y + 1) / 2];
  const [tl, tr, br, bl] = perspectiveSourceCorners(perspective).map((point) => toFraction(point));
  return squareToQuad(tl, tr, br, bl);
}

/**
 * Where an output point of a `width` × `height` frame samples the uncorrected frame, in pixels.
 * Identity when the perspective is identity.
 */
export function perspectiveSourcePoint(
  homography: Homography | null,
  x: number,
  y: number,
  width: number,
  height: number,
): Point {
  if (!homography) {
    return [x, y];
  }
  const [u, v] = applyHomography(homography, x / width, y / height);
  return [u * width, v * height];
}

/** The homography for a recipe value, or null for no correction (so callers skip the stage). */
export const perspectiveFor = (perspective: Partial<DevelopPerspective> | null | undefined): Homography | null =>
  !perspective || isIdentityPerspective(perspective) ? null : perspectiveHomography(perspective);

/**
 * Warps interleaved pixels (8-bit or float) of a `width` × `height` frame into a new buffer of the
 * same kind and size: every output pixel samples the source bilinearly at its homography position
 * (edge pixels clamped).
 */
export function warpPerspective<T extends Uint8Array | Float32Array>(
  data: T,
  info: { width: number; height: number; channels: number },
  homography: Homography,
): T {
  const { width, height, channels } = info;
  const round = !(data instanceof Float32Array);
  const output = (round ? new Uint8Array(data.length) : new Float32Array(data.length)) as T;
  let index = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, index += channels) {
      const [sx, sy] = perspectiveSourcePoint(homography, x + 0.5, y + 0.5, width, height);
      const fx = Math.max(0, Math.min(width - 1, sx - 0.5));
      const fy = Math.max(0, Math.min(height - 1, sy - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const ax = fx - x0;
      const ay = fy - y0;
      const i00 = (y0 * width + x0) * channels;
      const i10 = (y0 * width + x1) * channels;
      const i01 = (y1 * width + x0) * channels;
      const i11 = (y1 * width + x1) * channels;
      for (let c = 0; c < channels; c += 1) {
        const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * ax;
        const bottom = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * ax;
        const value = top + (bottom - top) * ay;
        output[index + c] = round ? Math.round(value) : value;
      }
    }
  }
  return output;
}
