/**
 * Keystone (perspective) correction of a still develop recipe, for the editor stage.
 *
 * The same definition as the server renderer (`server/src/utils/develop-perspective.ts`): an output
 * point of the oriented frame samples the uncorrected frame through the homography that maps the
 * output corners to source corners pulled inwards by 0.35 × |value| / 100 (vertical: the top edge for
 * positive values, the bottom edge for negative; horizontal: the right edge for positive, the left for
 * negative). The stage shows it by transforming the picture with the inverse homography.
 */
export type Perspective = { vertical: number; horizontal: number };

type Matrix = [number, number, number, number, number, number, number, number, number];
type Point = [number, number];

export const PERSPECTIVE_MAX_SHRINK = 0.35;

const unit = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(-100, Math.min(100, value)) / 100 : 0;

export const isIdentityPerspective = (value: Partial<Perspective> | null | undefined) =>
  unit(value?.vertical) === 0 && unit(value?.horizontal) === 0;

/** Heckbert's square-to-quad: (0,0) → p0, (1,0) → p1, (1,1) → p2, (0,1) → p3. */
export function squareToQuad(p0: Point, p1: Point, p2: Point, p3: Point): Matrix {
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

const multiply = (a: Matrix, b: Matrix): Matrix => {
  const out = Array.from({ length: 9 }, () => 0) as Matrix;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return out;
};

const invert = (m: Matrix): Matrix => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
};

/** Output fraction (0..1 across and down) → the source fraction it samples. */
export function perspectiveHomography(value: Partial<Perspective>): Matrix {
  const v = unit(value.vertical);
  const h = unit(value.horizontal);
  const t = PERSPECTIVE_MAX_SHRINK * Math.max(v, 0);
  const b = PERSPECTIVE_MAX_SHRINK * Math.max(-v, 0);
  const r = PERSPECTIVE_MAX_SHRINK * Math.max(h, 0);
  const l = PERSPECTIVE_MAX_SHRINK * Math.max(-h, 0);
  const fraction = ([x, y]: Point): Point => [(x + 1) / 2, (y + 1) / 2];
  return squareToQuad(
    fraction([-(1 - t), -(1 - l)]),
    fraction([1 - t, -(1 - r)]),
    fraction([1 - b, 1 - r]),
    fraction([-(1 - b), 1 - l]),
  );
}

export const applyHomography = (m: Matrix, x: number, y: number): Point => {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
};

/**
 * The CSS transform that shows the corrected frame: the inverse homography in pixels of a
 * `width` × `height` frame centred on the transform origin. Empty for no correction.
 */
export function perspectiveTransform(value: Partial<Perspective> | null | undefined, width: number, height: number) {
  if (!value || isIdentityPerspective(value) || !(width > 0) || !(height > 0)) {
    return '';
  }
  const toFraction: Matrix = [1 / width, 0, 0.5, 0, 1 / height, 0.5, 0, 0, 1];
  const toPixels: Matrix = [width, 0, -width / 2, 0, height, -height / 2, 0, 0, 1];
  const m = multiply(toPixels, multiply(invert(perspectiveHomography(value)), toFraction));
  const n = m.map((item) => item / m[8]);
  const [a, b, c, d, e, f, g, h] = n.map((item) => Number(item.toPrecision(10)));
  return `matrix3d(${[a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, c, f, 0, 1].join(', ')})`;
}
