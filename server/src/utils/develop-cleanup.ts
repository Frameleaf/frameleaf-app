import {
  ASSET_DEVELOP_MAX_CLEANUP,
  ASSET_DEVELOP_MAX_STROKES,
  ASSET_DEVELOP_MAX_STROKE_POINTS,
  type AssetDevelopCleanup,
  AssetDevelopCleanupMethod,
} from 'src/dtos/asset-develop.dto.js';

/**
 * FL-233 (NAPI-009): the parts of renderer v3 (`frameleaf-develop/3`) that work in original-image
 * coordinates: Clean Up operations, brush strokes and stored bitmaps (subject, sky and background
 * masks, generated fills). Everything here is deterministic integer-friendly maths so a revision
 * re-renders to the same bytes on every server, and so the native renderers can implement the same
 * definitions (developer-documentation/develop-recipe-protocol.md).
 *
 * Original-image coordinates are fractions of the decoded original (EXIF orientation applied, before
 * the recipe's quarter turns, flips, straighten and crop). A preview decodes a smaller original; the
 * fractions keep every operation on the same content.
 */

/** A stored develop artifact's id: the lowercase hex SHA-256 of its PNG. */
export const ARTIFACT_ID = /^[0-9a-f]{64}$/;

/** A decoded artifact: greyscale (1 channel) for a mask, RGBA (4 channels) for a fill. */
export type DevelopBitmap = { data: Uint8Array; width: number; height: number; channels: 1 | 4 };

export type DevelopStroke = { points: [number, number][]; radius: number; erase: boolean };

type Size = { width: number; height: number };
type Box = { left: number; top: number; right: number; bottom: number };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const round = (value: number, places = 5) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Strokes clamped into the contract; malformed ones dropped. `erasable` keeps `erase` (brush masks). */
export function normalizeStrokes(candidate: unknown, erasable: boolean): DevelopStroke[] {
  if (!Array.isArray(candidate)) {
    return [];
  }
  const strokes: DevelopStroke[] = [];
  for (const item of candidate.slice(0, ASSET_DEVELOP_MAX_STROKES) as Partial<DevelopStroke>[]) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.points)) {
      continue;
    }
    const points = item.points
      .slice(0, ASSET_DEVELOP_MAX_STROKE_POINTS)
      .filter((point) => Array.isArray(point) && point.length === 2)
      .map(([x, y]) => [round(clamp(finite(x), 0, 1)), round(clamp(finite(y), 0, 1))] as [number, number]);
    if (points.length === 0) {
      continue;
    }
    strokes.push({
      points,
      radius: round(clamp(finite(item.radius, 0.02), 0.001, 0.5)),
      erase: erasable && item.erase === true,
    });
  }
  return strokes;
}

/** Clean Up operations clamped into the contract; malformed, duplicate and unknown ones dropped. */
export function normalizeDevelopCleanup(candidate: unknown): AssetDevelopCleanup[] {
  if (!Array.isArray(candidate)) {
    return [];
  }
  const seen = new Set<string>();
  const operations: AssetDevelopCleanup[] = [];
  for (const item of candidate as Partial<AssetDevelopCleanup>[]) {
    if (!item || typeof item !== 'object' || operations.length >= ASSET_DEVELOP_MAX_CLEANUP) {
      continue;
    }
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 40) : '';
    const method = Object.values(AssetDevelopCleanupMethod).includes(item.method as AssetDevelopCleanupMethod)
      ? (item.method as AssetDevelopCleanupMethod)
      : undefined;
    if (!id || !method || seen.has(id)) {
      continue;
    }
    const strokes = item.strokes === undefined ? undefined : normalizeStrokes(item.strokes, false);
    let region: AssetDevelopCleanup['region'];
    if (item.region && typeof item.region === 'object') {
      const w = round(clamp(finite(item.region.w, 0.1), 0.001, 1));
      const h = round(clamp(finite(item.region.h, 0.1), 0.001, 1));
      region = {
        x: round(clamp(finite(item.region.x), 0, 1 - w)),
        y: round(clamp(finite(item.region.y), 0, 1 - h)),
        w,
        h,
      };
    }
    const hasStrokes = !!strokes && strokes.length > 0;
    if (region ? hasStrokes : !hasStrokes) {
      continue;
    }
    seen.add(id);
    operations.push({
      id,
      method,
      enabled: item.enabled !== false,
      ...(region ? { region } : { strokes }),
      feather: Math.round(clamp(finite(item.feather, 0), 0, 100)),
      ...(item.source && {
        source: { dx: round(clamp(finite(item.source.dx), -1, 1)), dy: round(clamp(finite(item.source.dy), -1, 1)) },
      }),
      ...(typeof item.fill === 'string' && ARTIFACT_ID.test(item.fill) && { fill: item.fill }),
      blockSize: round(clamp(finite(item.blockSize, 0.02), 0.002, 0.2)),
    });
  }
  return operations;
}

/** FL-233: the fill artifacts the enabled Clean Up operations of a recipe need to render. */
export const developCleanupArtifacts = (operations: AssetDevelopCleanup[]) =>
  operations
    .filter((op) => op.enabled && op.method === AssetDevelopCleanupMethod.Remove && op.fill)
    .map((op) => op.fill as string);

/** Distance from (px, py) to the segment a-b, all in pixels. */
const segmentDistance = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const vx = bx - ax;
  const vy = by - ay;
  const length2 = vx * vx + vy * vy;
  const t = length2 === 0 ? 0 : clamp(((px - ax) * vx + (py - ay) * vy) / length2, 0, 1);
  // sqrt rather than hypot: hypot is implementation-approximated, and every renderer must agree
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  // eslint-disable-next-line unicorn/prefer-modern-math-apis -- see above: an exact, shared definition
  return Math.sqrt(dx * dx + dy * dy);
};

/** The soft edge shared by strokes and regions: 1 inside `inner`, 0 beyond 1, smoothstep between. */
const edge = (distance: number, feather: number) => {
  const inner = 1 - clamp(feather, 0, 100) / 100;
  if (distance <= inner) {
    return 1;
  }
  return distance >= 1 ? 0 : 1 - smoothstep(inner, 1, distance);
};

/**
 * How much of a point of the original (pixels `ux`, `uy`) a stroke covers, 0 to 1: the distance to
 * its polyline (pixels) over `radiusPx`, through the soft edge of `feather` percent of the radius.
 */
export function strokeCoverage(
  stroke: DevelopStroke,
  ux: number,
  uy: number,
  original: Size,
  radiusPx: number,
  feather: number,
): number {
  if (!(radiusPx > 0)) {
    return 0;
  }
  const { points } = stroke;
  let distance = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[Math.min(index + 1, points.length - 1)];
    distance = Math.min(
      distance,
      segmentDistance(ux, uy, ax * original.width, ay * original.height, bx * original.width, by * original.height),
    );
    if (distance === 0) {
      break;
    }
  }
  return edge(distance / radiusPx, feather);
}

/** FL-233: the longest side of the grid a brush mask is drawn into before it is sampled. */
export const BRUSH_GRID_MAX_SIDE = 2048;

/**
 * Stroke coverage drawn into a grid once, then sampled: `data[gy * width + gx]` is the coverage at
 * the original-image point (`left` + (gx + 0.5) / `scale`, `top` + (gy + 0.5) / `scale`).
 */
export type DevelopCoverage = {
  data: Float32Array;
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
};

/**
 * Draw strokes into a coverage grid over `bounds` (original pixels) at `scale` grid cells per
 * original pixel, in order: a painting stroke takes the maximum, an erasing one multiplies by
 * (1 − its coverage). Each segment only visits the cells within its radius, so the cost follows the
 * painted area, not the image size times the number of points.
 */
export function rasterizeStrokes(
  strokes: DevelopStroke[],
  original: Size,
  feather: number,
  bounds: Box,
  scale: number,
  initial?: Float32Array,
): DevelopCoverage {
  const width = Math.max(0, Math.ceil((bounds.right - bounds.left) * scale));
  const height = Math.max(0, Math.ceil((bounds.bottom - bounds.top) * scale));
  const data = initial ? new Float32Array(initial) : new Float32Array(width * height);
  if (data.length !== width * height) throw new Error('Invalid initial mask coverage');
  const unit = Math.min(original.width, original.height);
  for (const stroke of strokes) {
    const radius = stroke.radius * unit;
    if (!(radius > 0) || width === 0 || height === 0) {
      continue;
    }
    const points = stroke.points.map(([x, y]) => [x * original.width, y * original.height] as const);
    // the stroke's own cells, then merged in order
    let gx0 = width;
    let gy0 = height;
    let gx1 = 0;
    let gy1 = 0;
    for (const [x, y] of points) {
      gx0 = Math.min(gx0, Math.floor((x - radius - bounds.left) * scale));
      gy0 = Math.min(gy0, Math.floor((y - radius - bounds.top) * scale));
      gx1 = Math.max(gx1, Math.ceil((x + radius - bounds.left) * scale));
      gy1 = Math.max(gy1, Math.ceil((y + radius - bounds.top) * scale));
    }
    gx0 = clamp(gx0, 0, width);
    gy0 = clamp(gy0, 0, height);
    gx1 = clamp(gx1, 0, width);
    gy1 = clamp(gy1, 0, height);
    if (gx1 <= gx0 || gy1 <= gy0) {
      continue;
    }
    const sw = gx1 - gx0;
    const own = new Float32Array(sw * (gy1 - gy0));
    for (let index = 0; index < points.length; index += 1) {
      const [ax, ay] = points[index];
      const [bx, by] = points[Math.min(index + 1, points.length - 1)];
      const sx0 = clamp(Math.floor((Math.min(ax, bx) - radius - bounds.left) * scale), gx0, gx1);
      const sy0 = clamp(Math.floor((Math.min(ay, by) - radius - bounds.top) * scale), gy0, gy1);
      const sx1 = clamp(Math.ceil((Math.max(ax, bx) + radius - bounds.left) * scale), gx0, gx1);
      const sy1 = clamp(Math.ceil((Math.max(ay, by) + radius - bounds.top) * scale), gy0, gy1);
      for (let gy = sy0; gy < sy1; gy += 1) {
        const uy = bounds.top + (gy + 0.5) / scale;
        for (let gx = sx0; gx < sx1; gx += 1) {
          const ux = bounds.left + (gx + 0.5) / scale;
          const value = edge(segmentDistance(ux, uy, ax, ay, bx, by) / radius, feather);
          const at = (gy - gy0) * sw + (gx - gx0);
          if (value > own[at]) {
            own[at] = value;
          }
        }
      }
    }
    for (let gy = gy0; gy < gy1; gy += 1) {
      for (let gx = gx0; gx < gx1; gx += 1) {
        const value = own[(gy - gy0) * sw + (gx - gx0)];
        const at = gy * width + gx;
        data[at] = stroke.erase ? data[at] * (1 - value) : Math.max(data[at], value);
      }
    }
  }
  return { data, left: bounds.left, top: bounds.top, width, height, scale };
}

/** Bilinear sample of a coverage grid at an original-image point; 0 outside it. */
export function sampleCoverage(coverage: DevelopCoverage, ux: number, uy: number): number {
  if (coverage.width === 0 || coverage.height === 0) {
    return 0;
  }
  const x = (ux - coverage.left) * coverage.scale - 0.5;
  const y = (uy - coverage.top) * coverage.scale - 0.5;
  if (x < -0.5 || y < -0.5 || x > coverage.width - 0.5 || y > coverage.height - 0.5) {
    return 0;
  }
  const cx = clamp(x, 0, coverage.width - 1);
  const cy = clamp(y, 0, coverage.height - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, coverage.width - 1);
  const y1 = Math.min(y0 + 1, coverage.height - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const at = (px: number, py: number) => coverage.data[py * coverage.width + px];
  const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
  const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
  return top + (bottom - top) * fy;
}

/** Grid cells across the smallest stroke radius: finer adds no visible detail to a soft edge. */
export const STROKE_GRID_CELLS_PER_RADIUS = 12;

/** Grid cells per original pixel for these strokes: at most one, and at least 12 across a radius. */
export const strokeGridScale = (strokes: DevelopStroke[], original: Size) => {
  const unit = Math.min(original.width, original.height);
  const smallest = Math.min(...strokes.map((stroke) => stroke.radius * unit));
  return Number.isFinite(smallest) && smallest > 0 ? Math.min(1, STROKE_GRID_CELLS_PER_RADIUS / smallest) : 1;
};

/** The grid a brush mask over this original is drawn into: the whole original, at most 2048 a side. */
export const brushGrid = (original: Size, strokes: DevelopStroke[] = []): { bounds: Box; scale: number } => ({
  bounds: { left: 0, top: 0, right: original.width, bottom: original.height },
  scale: Math.min(
    BRUSH_GRID_MAX_SIDE / Math.max(1, original.width, original.height),
    strokeGridScale(strokes, original),
  ),
});

/**
 * Bilinear sample of one channel of a bitmap stretched over the whole original, at fractions `u`,
 * `v` (pixel centres at (i + 0.5) / width). Edges clamp.
 */
export function sampleBitmap(bitmap: DevelopBitmap, u: number, v: number, channel: number): number {
  const x = clamp(u * bitmap.width - 0.5, 0, bitmap.width - 1);
  const y = clamp(v * bitmap.height - 0.5, 0, bitmap.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, bitmap.width - 1);
  const y1 = Math.min(y0 + 1, bitmap.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number) => bitmap.data[(py * bitmap.width + px) * bitmap.channels + channel];
  const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
  const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
  return top + (bottom - top) * fy;
}

/**
 * A point of the oriented frame (after the quarter turns and flips, before straightening), in
 * pixels, back to the original image: undo the flips, then the clockwise quarter turn.
 */
export function orientedToOriginal(
  ox: number,
  oy: number,
  mapping: {
    oriented: Size;
    rotation?: 0 | 90 | 180 | 270;
    flipHorizontal?: boolean;
    flipVertical?: boolean;
  },
): { x: number; y: number; original: Size } {
  const { width: W, height: H } = mapping.oriented;
  const rotation = mapping.rotation ?? 0;
  let x = mapping.flipHorizontal ? W - ox : ox;
  let y = mapping.flipVertical ? H - oy : oy;
  const swapped = rotation === 90 || rotation === 270;
  const original = { width: swapped ? H : W, height: swapped ? W : H };
  switch (rotation) {
    case 90: {
      // original (a, b) went to (h0 - b, a)
      [x, y] = [y, original.height - x];

      break;
    }
    case 180: {
      [x, y] = [original.width - x, original.height - y];

      break;
    }
    case 270: {
      // original (a, b) went to (b, w0 - a)
      [x, y] = [original.width - y, x];

      break;
    }
    // No default
  }
  return { x, y, original };
}

/** The pixel rectangle an operation can touch in an original of this size. */
function operationBox(op: AssetDevelopCleanup, size: Size): Box {
  if (op.region) {
    return {
      left: Math.floor(op.region.x * size.width),
      top: Math.floor(op.region.y * size.height),
      right: Math.ceil((op.region.x + op.region.w) * size.width),
      bottom: Math.ceil((op.region.y + op.region.h) * size.height),
    };
  }
  const scale = Math.min(size.width, size.height);
  let box: Box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const stroke of op.strokes ?? []) {
    const r = stroke.radius * scale;
    for (const [x, y] of stroke.points) {
      box = {
        left: Math.min(box.left, Math.floor(x * size.width - r)),
        top: Math.min(box.top, Math.floor(y * size.height - r)),
        right: Math.max(box.right, Math.ceil(x * size.width + r)),
        bottom: Math.max(box.bottom, Math.ceil(y * size.height + r)),
      };
    }
  }
  return {
    left: clamp(box.left, 0, size.width),
    top: clamp(box.top, 0, size.height),
    right: clamp(box.right, 0, size.width),
    bottom: clamp(box.bottom, 0, size.height),
  };
}

/**
 * How much of the pixel centred at (ux, uy) an operation's area covers, 0 to 1. A region's soft
 * edge is `feather` percent of its half-size, measured from its centre on each axis (a rounded
 * rectangle); strokes cover as in a brush mask.
 */
export function cleanupCoverage(op: AssetDevelopCleanup, ux: number, uy: number, size: Size): number {
  if (op.region) {
    const cx = (op.region.x + op.region.w / 2) * size.width;
    const cy = (op.region.y + op.region.h / 2) * size.height;
    const hx = (op.region.w / 2) * size.width;
    const hy = (op.region.h / 2) * size.height;
    const dx = Math.abs(ux - cx) / hx;
    const dy = Math.abs(uy - cy) / hy;
    if (dx > 1 || dy > 1) {
      return 0;
    }
    return edge(dx, op.feather) * edge(dy, op.feather);
  }
  const scale = Math.min(size.width, size.height);
  let coverage = 0;
  for (const stroke of op.strokes ?? []) {
    coverage = Math.max(coverage, strokeCoverage(stroke, ux, uy, size, stroke.radius * scale, op.feather));
  }
  return coverage;
}

export type DevelopCleanupImage = { width: number; height: number; channels: 1 | 2 | 3 | 4 };

/** The colour channels of an image (alpha, when present, is never changed). */
const colourChannels = (channels: number) => (channels >= 3 ? 3 : 1);

/**
 * FL-233: applies the enabled Clean Up operations in order to the decoded original, in place, before
 * every other develop step. Each operation reads the result of the ones before it.
 *
 * - `pixelate`: blocks of `blockSize` × the shorter side, aligned to the image's top-left corner,
 *   each replaced by its mean colour (over the whole block);
 * - `clone`: the pixel `source` away (rounded to whole pixels, clamped to the image);
 * - `heal`: the clone, shifted by the difference between the area's weighted mean colour and the
 *   weighted mean colour of its source, so the copy takes on the surrounding tone;
 * - `remove`: the generated fill (an RGBA artifact) stretched over the area's bounding box and
 *   composited by its alpha. A missing fill refuses the render before this is called.
 *
 * Every result is blended into the pixel by the area's coverage.
 */
export function applyDevelopCleanup(
  data: Uint8Array,
  info: DevelopCleanupImage,
  operations: AssetDevelopCleanup[],
  fills: ReadonlyMap<string, DevelopBitmap> = new Map(),
): Uint8Array {
  const size = { width: info.width, height: info.height };
  const channels = info.channels;
  const colours = colourChannels(channels);
  for (const op of operations) {
    if (!op.enabled) {
      continue;
    }
    const box = operationBox(op, size);
    if (box.right <= box.left || box.bottom <= box.top) {
      continue;
    }
    const at = (x: number, y: number) => (y * info.width + x) * channels;
    // The rows this operation reads, copied once (a typed copy of only those rows, never the frame
    // as a JavaScript array): the area, its clone/heal source, or the whole blocks it pixelates.
    const stride = info.width * channels;
    const block = Math.max(1, Math.round(op.blockSize * Math.min(info.width, info.height)));
    const dy = Math.round((op.source?.dy ?? 0) * info.height);
    let rowStart = box.top;
    let rowEnd = box.bottom;
    if (op.method === AssetDevelopCleanupMethod.Pixelate) {
      rowStart = Math.floor(box.top / block) * block;
      rowEnd = Math.min(info.height, Math.ceil(box.bottom / block) * block);
    } else if (op.method === AssetDevelopCleanupMethod.Clone || op.method === AssetDevelopCleanupMethod.Heal) {
      rowStart = Math.min(rowStart, clamp(box.top + dy, 0, info.height - 1));
      rowEnd = Math.max(rowEnd, clamp(box.bottom - 1 + dy, 0, info.height - 1) + 1);
    }
    const before = new Uint8Array(data.subarray(rowStart * stride, rowEnd * stride));
    const prior = (index: number) => before[index - rowStart * stride];
    // strokes are drawn once over the area at full resolution; a region is measured directly
    const drawn = op.strokes
      ? rasterizeStrokes(op.strokes, size, op.feather, box, strokeGridScale(op.strokes, size))
      : undefined;
    const coverage = drawn
      ? (x: number, y: number) => sampleCoverage(drawn, x + 0.5, y + 0.5)
      : (x: number, y: number) => cleanupCoverage(op, x + 0.5, y + 0.5, size);

    let produce: (x: number, y: number, channel: number) => number;
    switch (op.method) {
      case AssetDevelopCleanupMethod.Pixelate: {
        const means = new Map<number, number[]>();
        const blockMean = (bx: number, by: number) => {
          const key = by * Math.ceil(info.width / block) + bx;
          let mean = means.get(key);
          if (!mean) {
            const sums = Array.from({ length: colours }, () => 0);
            let count = 0;
            for (let y = by * block; y < Math.min(info.height, (by + 1) * block); y += 1) {
              for (let x = bx * block; x < Math.min(info.width, (bx + 1) * block); x += 1) {
                for (let c = 0; c < colours; c += 1) {
                  sums[c] += prior(at(x, y) + c);
                }
                count += 1;
              }
            }
            mean = sums.map((sum) => sum / Math.max(1, count));
            means.set(key, mean);
          }
          return mean;
        };
        produce = (x, y, c) => blockMean(Math.floor(x / block), Math.floor(y / block))[c];
        break;
      }
      case AssetDevelopCleanupMethod.Clone:
      case AssetDevelopCleanupMethod.Heal: {
        const dx = Math.round((op.source?.dx ?? 0) * info.width);
        const sourceAt = (x: number, y: number) =>
          at(clamp(x + dx, 0, info.width - 1), clamp(y + dy, 0, info.height - 1));
        let shift = Array.from({ length: colours }, () => 0);
        if (op.method === AssetDevelopCleanupMethod.Heal) {
          const area = Array.from({ length: colours }, () => 0);
          const source = Array.from({ length: colours }, () => 0);
          let total = 0;
          for (let y = box.top; y < box.bottom; y += 1) {
            for (let x = box.left; x < box.right; x += 1) {
              const weight = coverage(x, y);
              if (weight <= 0) {
                continue;
              }
              for (let c = 0; c < colours; c += 1) {
                area[c] += prior(at(x, y) + c) * weight;
                source[c] += prior(sourceAt(x, y) + c) * weight;
              }
              total += weight;
            }
          }
          shift = area.map((sum, c) => (total > 0 ? (sum - source[c]) / total : 0));
        }
        produce = (x, y, c) => prior(sourceAt(x, y) + c) + shift[c];
        break;
      }
      case AssetDevelopCleanupMethod.Remove: {
        const fill = op.fill ? fills.get(op.fill) : undefined;
        if (!fill) {
          throw new Error(`Clean Up ${op.id} needs its generated fill`);
        }
        const width = box.right - box.left;
        const height = box.bottom - box.top;
        produce = (x, y, c) => {
          const u = (x + 0.5 - box.left) / width;
          const v = (y + 0.5 - box.top) / height;
          const alpha = sampleBitmap(fill, u, v, 3) / 255;
          const value =
            colours === 3
              ? sampleBitmap(fill, u, v, c)
              : 0.2126 * sampleBitmap(fill, u, v, 0) +
                0.7152 * sampleBitmap(fill, u, v, 1) +
                0.0722 * sampleBitmap(fill, u, v, 2);
          return prior(at(x, y) + c) + (value - prior(at(x, y) + c)) * alpha;
        };
        break;
      }
      default: {
        continue;
      }
    }

    for (let y = box.top; y < box.bottom; y += 1) {
      for (let x = box.left; x < box.right; x += 1) {
        const weight = coverage(x, y);
        if (weight <= 0) {
          continue;
        }
        const index = at(x, y);
        for (let c = 0; c < colours; c += 1) {
          const value = produce(x, y, c);
          data[index + c] = Math.round(clamp(prior(index + c) + (value - prior(index + c)) * weight, 0, 255));
        }
      }
    }
  }
  return data;
}
