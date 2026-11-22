/** FL-923: a point on a scan, in the pixels of the scan as it is displayed (after its EXIF orientation). */
export type ScanPoint = [number, number];

/** The straight rectangle a print is cut out as: its centre, its size and how far it is turned (degrees, clockwise). */
export type ScanCropRect = { centerX: number; centerY: number; width: number; height: number; angle: number };

export const SCAN_CROP_ROTATIONS = [0, 90, 180, 270] as const;
/** A print narrower than this after straightening is a slip of the hand, not a photo. */
export const SCAN_CROP_MIN_EDGE = 16;

const distance = (a: ScanPoint, b: ScanPoint) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * The rotated rectangle fitted to a print's four corners (top-left, top-right, bottom-right, bottom-left): the
 * centre of the corners, the mean length of each pair of opposite sides, turned as far as the top and bottom
 * edges are on average.
 *
 * ponytail: a quad that is not a rectangle (a print photographed at an angle rather than scanned flat) is cut as
 * this rectangle, not warped corner to corner. Prints lie flat on a scanner, so their quads are rectangles to
 * within a pixel or two; a true perspective warp would need a resampler sharp does not have.
 */
export function fitScanCropRect(quad: ScanPoint[]): ScanCropRect {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  const acrossX = topRight[0] - topLeft[0] + (bottomRight[0] - bottomLeft[0]);
  const acrossY = topRight[1] - topLeft[1] + (bottomRight[1] - bottomLeft[1]);
  return {
    centerX: (topLeft[0] + topRight[0] + bottomRight[0] + bottomLeft[0]) / 4,
    centerY: (topLeft[1] + topRight[1] + bottomRight[1] + bottomLeft[1]) / 4,
    width: (distance(topLeft, topRight) + distance(bottomLeft, bottomRight)) / 2,
    height: (distance(topLeft, bottomLeft) + distance(topRight, bottomRight)) / 2,
    angle: (Math.atan2(acrossY, acrossX) * 180) / Math.PI,
  };
}

/** Scales a quad from one picture of the scan to another of a different size (a detection copy to the original). */
export function scaleScanQuad(
  quad: ScanPoint[],
  from: { width: number; height: number },
  to: { width: number; height: number },
): ScanPoint[] {
  const round = (value: number) => Math.round(value * 10) / 10;
  return quad.map(([x, y]) => [
    Math.min(to.width, Math.max(0, round((x * to.width) / from.width))),
    Math.min(to.height, Math.max(0, round((y * to.height) / from.height))),
  ]);
}
