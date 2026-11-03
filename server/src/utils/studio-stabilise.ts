import { BadRequestException } from '@nestjs/common';
import { frameStartTime, multiply, toApproximateNumber } from 'src/utils/rational-time.js';
import { TranscriptionClip, transcriptionClipOf } from 'src/utils/studio-transcription.js';

/**
 * Stabilise (FL-638): the pure half of the camera movement analysis.
 *
 * The worker decodes the clip's source window, downscaled to a small grey picture, at up to 30 frames
 * a second, and this estimates how the picture moved between each pair of frames: a shift and a turn
 * about the centre (`block-similarity-v1`). The sum of those moves is the camera path. It is stored in
 * the clip (`stabilisation.motion`); the engine smooths it for the chosen level and applies the
 * correcting shift, turn and crop-in on every frame in preview and export, so the original never
 * changes and changing the level needs no new analysis.
 */

/** The longest clip window analysed: ten minutes keeps the stored path under about 300 KB. */
export const STABILISE_MAX_SECONDS = 10 * 60;
/** Seconds read either side of the clip, so smoothing has context and small trims stay covered. */
export const STABILISE_MARGIN_SECONDS = 2;
/** Analysis frames are this wide; motion needs no more. */
export const STABILISE_ANALYSIS_WIDTH = 160;
/** At most this many frames a second are analysed; the engine interpolates between them. */
export const STABILISE_MAX_RATE = 30;
export const STABILISE_METHOD = 'block-similarity-v1';

export type StabiliseClip = TranscriptionClip & { type: 'video' };

/** The clip a stabilise request names: one main-timeline video clip of the stored graph. */
export const stabiliseClipOf = (graph: unknown, clipId: string): StabiliseClip => {
  let clip: TranscriptionClip;
  try {
    clip = transcriptionClipOf(withoutReverse(graph, clipId), clipId);
  } catch (error) {
    if (error instanceof BadRequestException) {
      // The shared reader names transcription; keep its reason but say what this job does.
      throw new BadRequestException(error.message.replace('transcribed', 'stabilised'));
    }
    throw error;
  }
  if (clip.type !== 'video') {
    throw new BadRequestException('Only a video clip can be stabilised');
  }
  return clip as StabiliseClip;
};

/** A reversed clip shows the same source frames, so it is read as if it played forwards. */
const withoutReverse = (graph: unknown, clipId: string): unknown => {
  const root = graph && typeof graph === 'object' ? (graph as Record<string, unknown>) : {};
  const timeline = root.timeline && typeof root.timeline === 'object' ? (root.timeline as Record<string, unknown>) : {};
  if (!Array.isArray(timeline.items)) {
    return graph;
  }
  return {
    ...root,
    timeline: {
      ...timeline,
      items: timeline.items.map((item) =>
        item && typeof item === 'object' && (item as Record<string, unknown>).id === clipId
          ? { ...(item as Record<string, unknown>), isReversed: false }
          : item,
      ),
    },
  };
};

export type StabiliseWindow = { startSeconds: number; durationSeconds: number };

/** The source seconds analysed: what the clip shows, with a margin either side. */
export const stabiliseWindow = (clip: StabiliseClip): StabiliseWindow => {
  const shown = toApproximateNumber(multiply(frameStartTime(clip.durationInFrames, clip.cadence), clip.speed));
  if (shown > STABILISE_MAX_SECONDS) {
    throw new BadRequestException(`A clip longer than ${STABILISE_MAX_SECONDS / 60} minutes cannot be stabilised`);
  }
  const start = toApproximateNumber(clip.sourceStart);
  const startSeconds = Math.max(0, start - STABILISE_MARGIN_SECONDS);
  return { startSeconds, durationSeconds: start - startSeconds + shown + STABILISE_MARGIN_SECONDS };
};

/** Frames a second to analyse for a source of this rate. */
export const stabiliseRate = (sourceFps: number | undefined): number =>
  sourceFps && Number.isFinite(sourceFps) && sourceFps > 0
    ? Math.min(STABILISE_MAX_RATE, sourceFps)
    : STABILISE_MAX_RATE;

/** The analysis picture's size for a source of this display size: 160 wide, even height. */
export const stabiliseFrameSize = (width: number, height: number): { width: number; height: number } => {
  const scaled = Math.round((STABILISE_ANALYSIS_WIDTH * height) / Math.max(1, width) / 2) * 2;
  return { width: STABILISE_ANALYSIS_WIDTH, height: Math.max(16, Math.min(4 * STABILISE_ANALYSIS_WIDTH, scaled)) };
};

/** One frame-to-frame move: shift as a fraction of the frame, turn in radians, and whether it was found. */
export type FrameMotion = { dx: number; dy: number; da: number; found: boolean };

type Block = { x: number; y: number };

const BLOCK = 16;
const COARSE_RADIUS = 6;
const FINE_RADIUS = 2;
/** A block flatter than this (standard deviation of grey levels) carries no motion. */
const MIN_TEXTURE = 4;
const MIN_BLOCKS = 4;

const half = (frame: Uint8Array, width: number, height: number): Uint8Array => {
  const w = width >> 1;
  const h = height >> 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 2 * y * width + 2 * x;
      out[y * w + x] = (frame[i] + frame[i + 1] + frame[i + width] + frame[i + width + 1] + 2) >> 2;
    }
  }
  return out;
};

const sad = (
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  size: number,
  limit: number,
): number => {
  let total = 0;
  for (let y = 0; y < size; y++) {
    const ra = (ay + y) * width + ax;
    const rb = (by + y) * width + bx;
    for (let x = 0; x < size; x++) {
      total += Math.abs(a[ra + x] - b[rb + x]);
    }
    if (total >= limit) {
      return total;
    }
  }
  return total;
};

const texture = (frame: Uint8Array, width: number, x0: number, y0: number, size: number): number => {
  let sum = 0;
  let squares = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = frame[(y0 + y) * width + x0 + x];
      sum += value;
      squares += value * value;
    }
  }
  const n = size * size;
  return Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2));
};

/**
 * Sub-pixel offset of a minimum from its two neighbours. Absolute differences grow about linearly
 * with the offset, so two lines of equal slope through the three costs place it (equiangular fit).
 */
const vertex = (left: number, centre: number, right: number): number => {
  const slope = Math.max(left, right) - centre;
  return slope > 0 ? Math.max(-0.5, Math.min(0.5, (left - right) / (2 * slope))) : 0;
};

/** Solve the 3x3 system `m · v = r` (Cramer); null when it is singular. */
const solve3 = (m: number[][], r: number[]): [number, number, number] | null => {
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) {
    return null;
  }
  const column = (index: number) => m.map((row, i) => row.map((value, j) => (j === index ? r[i] : value)));
  return [det(column(0)) / d, det(column(1)) / d, det(column(2)) / d];
};

type Vector = { px: number; py: number; dx: number; dy: number };

/** Least-squares shift and small turn about the centre for block displacements (pixels). */
export const fitSimilarity = (vectors: readonly Vector[]): { tx: number; ty: number; a: number } | null => {
  if (vectors.length < MIN_BLOCKS) {
    return null;
  }
  // Rows: dx = tx - a·py, dy = ty + a·px.
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const r = [0, 0, 0];
  for (const { px, py, dx, dy } of vectors) {
    const rows: Array<[number[], number]> = [
      [[1, 0, -py], dx],
      [[0, 1, px], dy],
    ];
    for (const [row, value] of rows) {
      for (let i = 0; i < 3; i++) {
        r[i] += row[i] * value;
        for (let j = 0; j < 3; j++) {
          m[i][j] += row[i] * row[j];
        }
      }
    }
  }
  const solved = solve3(m, r);
  return solved ? { tx: solved[0], ty: solved[1], a: solved[2] } : null;
};

/** Fit, drop the vectors the fit explains worst (moving subjects), fit again. */
export const robustSimilarity = (vectors: readonly Vector[]): { tx: number; ty: number; a: number } | null => {
  let kept = [...vectors];
  let fit = fitSimilarity(kept);
  for (let pass = 0; pass < 2 && fit; pass++) {
    const current = fit;
    const residual = (v: Vector) =>
      Math.hypot(v.dx - (current.tx - current.a * v.py), v.dy - (current.ty + current.a * v.px));
    const residuals = kept.map((v) => residual(v)).sort((a, b) => a - b);
    const median = residuals[Math.floor(residuals.length / 2)];
    const limit = Math.max(0.75, 2.5 * median);
    const next = kept.filter((v) => residual(v) <= limit);
    if (next.length === kept.length || next.length < MIN_BLOCKS) {
      break;
    }
    kept = next;
    fit = fitSimilarity(kept);
  }
  return fit;
};

/**
 * Frame-to-frame motion of grey pictures of one size: block matching on a half-size picture, refined
 * at full size to a fraction of a pixel, then a robust shift-and-turn fit. Feed frames in order.
 */
export class MotionEstimator {
  private previous?: { full: Uint8Array; coarse: Uint8Array };
  private readonly blocks: Block[];
  readonly moves: FrameMotion[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const margin = 2 * COARSE_RADIUS + FINE_RADIUS + 2;
    const columns = 8;
    const rows = Math.max(2, Math.min(8, Math.round((columns * height) / width)));
    const usableX = width - 2 * margin - BLOCK;
    const usableY = height - 2 * margin - BLOCK;
    this.blocks = [];
    if (usableX > 0 && usableY > 0) {
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          // Even block positions keep the half-size picture aligned.
          this.blocks.push({
            x: (margin + Math.round((usableX * column) / (columns - 1))) & ~1,
            y: (margin + Math.round((usableY * row) / (rows - 1))) & ~1,
          });
        }
      }
    }
  }

  push(frame: Uint8Array): void {
    if (frame.length !== this.width * this.height) {
      throw new Error('Analysis frame has the wrong size');
    }
    const current = { full: frame, coarse: half(frame, this.width, this.height) };
    if (this.previous) {
      this.moves.push(this.estimate(this.previous, current));
    }
    this.previous = current;
  }

  private estimate(
    previous: { full: Uint8Array; coarse: Uint8Array },
    current: { full: Uint8Array; coarse: Uint8Array },
  ): FrameMotion {
    const { width, height } = this;
    const coarseWidth = width >> 1;
    const vectors: Vector[] = [];
    for (const block of this.blocks) {
      if (texture(previous.full, width, block.x, block.y, BLOCK) < MIN_TEXTURE) {
        continue;
      }
      // Coarse: whole-pixel search on the half-size picture.
      const cx = block.x >> 1;
      const cy = block.y >> 1;
      const coarseBlock = BLOCK >> 1;
      let best = { ox: 0, oy: 0, cost: Infinity };
      for (let oy = -COARSE_RADIUS; oy <= COARSE_RADIUS; oy++) {
        for (let ox = -COARSE_RADIUS; ox <= COARSE_RADIUS; ox++) {
          const cost = sad(
            previous.coarse,
            current.coarse,
            coarseWidth,
            cx,
            cy,
            cx + ox,
            cy + oy,
            coarseBlock,
            best.cost,
          );
          if (
            cost < best.cost ||
            (cost === best.cost && Math.abs(ox) + Math.abs(oy) < Math.abs(best.ox) + Math.abs(best.oy))
          ) {
            best = { ox, oy, cost };
          }
        }
      }
      // Fine: refine around twice the coarse offset at full size, then to a fraction of a pixel.
      const costAt = new Map<string, number>();
      const at = (ox: number, oy: number) => {
        const key = `${ox},${oy}`;
        let cost = costAt.get(key);
        if (cost === undefined) {
          const bx = block.x + ox;
          const by = block.y + oy;
          cost =
            bx < 0 || by < 0 || bx + BLOCK > width || by + BLOCK > height
              ? Infinity
              : sad(previous.full, current.full, width, block.x, block.y, bx, by, BLOCK, Infinity);
          costAt.set(key, cost);
        }
        return cost;
      };
      let fine = { ox: 2 * best.ox, oy: 2 * best.oy, cost: at(2 * best.ox, 2 * best.oy) };
      for (let oy = 2 * best.oy - FINE_RADIUS; oy <= 2 * best.oy + FINE_RADIUS; oy++) {
        for (let ox = 2 * best.ox - FINE_RADIUS; ox <= 2 * best.ox + FINE_RADIUS; ox++) {
          const cost = at(ox, oy);
          if (cost < fine.cost) {
            fine = { ox, oy, cost };
          }
        }
      }
      if (!Number.isFinite(fine.cost)) {
        continue;
      }
      const sx = vertex(at(fine.ox - 1, fine.oy), fine.cost, at(fine.ox + 1, fine.oy));
      const sy = vertex(at(fine.ox, fine.oy - 1), fine.cost, at(fine.ox, fine.oy + 1));
      vectors.push({
        px: block.x + BLOCK / 2 - width / 2,
        py: block.y + BLOCK / 2 - height / 2,
        dx: fine.ox + (Number.isFinite(sx) ? sx : 0),
        dy: fine.oy + (Number.isFinite(sy) ? sy : 0),
      });
    }
    const fit = robustSimilarity(vectors);
    if (!fit) {
      return { dx: 0, dy: 0, da: 0, found: false };
    }
    return { dx: fit.tx / width, dy: fit.ty / height, da: fit.a, found: true };
  }
}

/** The stored camera movement (protocol: `stabilisation.motion`). */
export type StabiliseMotion = {
  version: 1;
  method: typeof STABILISE_METHOD;
  /** Samples a second. */
  rate: number;
  /** Source seconds of the first sample. */
  start: number;
  count: number;
  /** The analysed picture's size, for its aspect. */
  width: number;
  height: number;
  /** Cumulative camera path: shift as fractions of the frame, turn in radians; float32 LE, base64. */
  x: string;
  y: string;
  a: string;
  /** The share of frame pairs whose movement was found (the rest are taken as still). */
  found: number;
};

const encode = (values: Float32Array): string => {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (const [index, value] of values.entries()) {
    view.setFloat32(index * 4, value, true);
  }
  return Buffer.from(bytes).toString('base64');
};

/** Sum the moves into the camera path and pack it for the project. */
export const stabiliseMotionOf = (
  moves: readonly FrameMotion[],
  options: { rate: number; start: number; width: number; height: number },
): StabiliseMotion => {
  const count = moves.length + 1;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const a = new Float32Array(count);
  let cx = 0;
  let cy = 0;
  let ca = 0;
  for (const [index, move] of moves.entries()) {
    cx += move.dx;
    cy += move.dy;
    ca += move.da;
    x[index + 1] = cx;
    y[index + 1] = cy;
    a[index + 1] = ca;
  }
  return {
    version: 1,
    method: STABILISE_METHOD,
    rate: options.rate,
    start: Math.round(options.start * 1e6) / 1e6,
    count,
    width: options.width,
    height: options.height,
    x: encode(x),
    y: encode(y),
    a: encode(a),
    found: moves.length === 0 ? 1 : moves.filter((move) => move.found).length / moves.length,
  };
};
