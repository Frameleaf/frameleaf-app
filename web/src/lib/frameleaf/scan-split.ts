/** FL-923: the geometry of the split review sheet. Corners are in the scan's displayed pixels, as the server has them. */
export type ScanPoint = { x: number; y: number };
export type ScanSize = { width: number; height: number };
export type ScanPrint = {
  id: string;
  quad: ScanPoint[];
  rotation: number;
  added?: boolean;
};

/** The server refuses a print narrower than this (`SCAN_CROP_MIN_EDGE`). */
export const SCAN_MIN_EDGE = 16;
export const SCAN_MAX_PRINTS = 50;

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
const round = (value: number) => Math.round(value * 10) / 10;

export const clampPoint = ({ x, y }: ScanPoint, size: ScanSize): ScanPoint => ({
  x: round(clamp(x, size.width)),
  y: round(clamp(y, size.height)),
});

/** Moves one corner, kept inside the scan. */
export const moveCorner = (quad: ScanPoint[], corner: number, to: ScanPoint, size: ScanSize) =>
  quad.map((point, index) => (index === corner ? clampPoint(to, size) : point));

/** Moves a whole outline; it stops at the scan's edge and keeps its shape. */
export const moveQuad = (quad: ScanPoint[], dx: number, dy: number, size: ScanSize) => {
  const xs = quad.map(({ x }) => x);
  const ys = quad.map(({ y }) => y);
  const stepX = Math.min(size.width - Math.max(...xs), Math.max(-Math.min(...xs), dx));
  const stepY = Math.min(size.height - Math.max(...ys), Math.max(-Math.min(...ys), dy));
  return quad.map(({ x, y }) => clampPoint({ x: x + stepX, y: y + stepY }, size));
};

/** One arrow-key press: half a percent of the scan's long edge, and at least a pixel. */
export const nudgeStep = (size: ScanSize) => Math.max(1, Math.round(Math.max(size.width, size.height) * 0.005));

export const ARROW_STEPS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export const turn = (rotation: number) => (rotation + 90) % 360;

/** A new outline in the middle of the scan, a fifth of each side, for the owner to drag into place. */
export const newQuad = ({ width, height }: ScanSize): ScanPoint[] => {
  const left = round(width * 0.4);
  const right = round(width * 0.6);
  const top = round(height * 0.4);
  const bottom = round(height * 0.6);
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
};

const distance = (a: ScanPoint, b: ScanPoint) => Math.hypot(b.x - a.x, b.y - a.y);

/** The same measure the server cuts by: the mean length of each pair of opposite sides. */
export const isTooSmall = ([topLeft, topRight, bottomRight, bottomLeft]: ScanPoint[]) =>
  (distance(topLeft, topRight) + distance(bottomLeft, bottomRight)) / 2 < SCAN_MIN_EDGE ||
  (distance(topLeft, bottomLeft) + distance(topRight, bottomRight)) / 2 < SCAN_MIN_EDGE;

export const toCrops = (prints: ScanPrint[]) =>
  prints.map(({ quad, rotation }) => ({ quad: quad.map(({ x, y }) => ({ x, y })), rotation }));

const cropKey = ({ quad, rotation }: { quad: ScanPoint[]; rotation: number }) =>
  `${rotation}:${quad.map(({ x, y }) => `${x},${y}`).join(' ')}`;

/** Whether these outlines are exactly the photos the scan already has, so a new split would change nothing. */
export const sameAsExisting = (
  prints: ScanPrint[],
  existing: { quad: ScanPoint[]; rotation: number }[],
  existingCount: number,
) => {
  if (prints.length !== existingCount || existing.length !== existingCount) {
    return false;
  }
  const keys = new Set(existing.map((crop) => cropKey(crop)));
  return prints.every((print) => keys.has(cropKey(print)));
};

/** The CSS that shows one outline's bounding box of the scan inside a small thumbnail. */
export const thumbStyle = (url: string, quad: ScanPoint[], size: ScanSize) => {
  const xs = quad.map(({ x }) => x / size.width);
  const ys = quad.map(({ y }) => y / size.height);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(0.001, Math.max(...xs) - left);
  const height = Math.max(0.001, Math.max(...ys) - top);
  const offset = (start: number, span: number) => (span >= 1 ? 0 : (start / (1 - span)) * 100);
  return [
    `background-image: url("${url}")`,
    `background-size: ${100 / width}% ${100 / height}%`,
    `background-position: ${offset(left, width)}% ${offset(top, height)}%`,
  ].join('; ');
};
