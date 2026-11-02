import { BadRequestException } from '@nestjs/common';
import {
  MotionEstimator,
  STABILISE_MARGIN_SECONDS,
  fitSimilarity,
  robustSimilarity,
  stabiliseClipOf,
  stabiliseFrameSize,
  stabiliseMotionOf,
  stabiliseRate,
  stabiliseWindow,
} from 'src/utils/studio-stabilise.js';

/** A base64 float32 little-endian path as numbers. */
const floats = (base64: string): number[] => {
  const bytes = Buffer.from(base64, 'base64');
  return Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readFloatLE(index * 4));
};

const W = 160;
const H = 90;

/** A deterministic textured scene: smooth value noise, so block matching has something to hold. */
const scene = (() => {
  const size = 512;
  const grid = 24;
  let seed = 7;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648) * 255;
  const lattice = Array.from({ length: grid * grid }, random);
  const at = (x: number, y: number) => lattice[(((y % grid) + grid) % grid) * grid + (((x % grid) + grid) % grid)];
  const cell = size / grid;
  return (x: number, y: number) => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
})();

/** The scene as a camera sees it with the content moved by (tx, ty) pixels and turned by `angle`. */
const frame = (tx: number, ty: number, angle = 0): Uint8Array => {
  const out = new Uint8Array(W * H);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Inverse map: where in the unmoved picture this output pixel comes from.
      const px = x - W / 2 - tx;
      const py = y - H / 2 - ty;
      const sx = cos * px + sin * py + 200;
      const sy = -sin * px + cos * py + 200;
      out[y * W + x] = Math.round(scene(sx, sy));
    }
  }
  return out;
};

const graph = (item: Record<string, unknown>) => ({
  metadata: { fps: 30 },
  timeline: {
    items: [
      {
        id: 'clip-1',
        type: 'video',
        from: 0,
        durationInFrames: 90,
        mediaId: '4b1f7f0e-8b44-4f53-9d6e-2a6a7f7c1a11',
        ...item,
      },
    ],
  },
});

describe('studio stabilise', () => {
  describe('the clip', () => {
    it('reads a video clip and its window with a margin', () => {
      const clip = stabiliseClipOf(graph({ sourceStart: 150, sourceFps: 30 }), 'clip-1');
      expect(clip.type).toBe('video');
      const window = stabiliseWindow(clip);
      expect(window.startSeconds).toBeCloseTo(5 - STABILISE_MARGIN_SECONDS, 6);
      expect(window.durationSeconds).toBeCloseTo(3 + 2 * STABILISE_MARGIN_SECONDS, 6);
    });

    it('starts the window at zero for a clip at the start of its source', () => {
      const window = stabiliseWindow(stabiliseClipOf(graph({}), 'clip-1'));
      expect(window.startSeconds).toBe(0);
      expect(window.durationSeconds).toBeCloseTo(3 + STABILISE_MARGIN_SECONDS, 6);
    });

    it('accepts a reversed clip: it shows the same source frames', () => {
      expect(stabiliseClipOf(graph({ isReversed: true }), 'clip-1').clipId).toBe('clip-1');
    });

    it('refuses audio, a missing clip and a clip longer than ten minutes, naming stabilising', () => {
      expect(() => stabiliseClipOf(graph({ type: 'audio' }), 'clip-1')).toThrow('Only a video clip can be stabilised');
      expect(() => stabiliseClipOf(graph({}), 'other')).toThrow(BadRequestException);
      expect(() => stabiliseWindow(stabiliseClipOf(graph({ durationInFrames: 30 * 601 }), 'clip-1'))).toThrow(
        'longer than 10 minutes',
      );
    });

    it('analyses at most 30 frames a second and keeps the picture 160 wide', () => {
      expect(stabiliseRate(59.94)).toBe(30);
      expect(stabiliseRate(24)).toBe(24);
      expect(stabiliseRate(undefined)).toBe(30);
      expect(stabiliseFrameSize(1920, 1080)).toEqual({ width: 160, height: 90 });
      expect(stabiliseFrameSize(1080, 1920)).toEqual({ width: 160, height: 284 });
    });
  });

  describe('fitting', () => {
    it('recovers an exact shift and turn from block vectors', () => {
      const vectors = [];
      for (const px of [-60, -20, 20, 60]) {
        for (const py of [-30, 0, 30]) {
          vectors.push({ px, py, dx: 1.5 - 0.01 * py, dy: -0.75 + 0.01 * px });
        }
      }
      const fit = fitSimilarity(vectors)!;
      expect(fit.tx).toBeCloseTo(1.5, 6);
      expect(fit.ty).toBeCloseTo(-0.75, 6);
      expect(fit.a).toBeCloseTo(0.01, 6);
    });

    it('ignores a moving subject that disagrees with the background', () => {
      const vectors = [];
      for (const px of [-60, -20, 20, 60]) {
        for (const py of [-30, 0, 30]) {
          vectors.push({ px, py, dx: 2, dy: 0 });
        }
      }
      vectors.push({ px: 0, py: 0, dx: -6, dy: 5 }, { px: 10, py: 5, dx: -6, dy: 5 });
      const fit = robustSimilarity(vectors)!;
      expect(fit.tx).toBeCloseTo(2, 3);
      expect(fit.ty).toBeCloseTo(0, 3);
    });

    it('finds nothing with too few vectors', () => {
      expect(fitSimilarity([{ px: 0, py: 0, dx: 1, dy: 1 }])).toBeNull();
    });
  });

  describe('estimating synthetic camera shake', () => {
    it('measures whole and fractional pixel shifts to within 0.15 of an analysis pixel', () => {
      const estimator = new MotionEstimator(W, H);
      const path = [
        [0, 0],
        [3, -2],
        [3.5, -1.25],
        [-4, 6],
        [-4, 6],
      ];
      for (const [x, y] of path) {
        estimator.push(frame(x, y));
      }
      for (const [index, move] of estimator.moves.entries()) {
        expect(move.found).toBe(true);
        expect(Math.abs(move.dx * W - (path[index + 1][0] - path[index][0]))).toBeLessThan(0.15);
        expect(Math.abs(move.dy * H - (path[index + 1][1] - path[index][1]))).toBeLessThan(0.15);
      }
    });

    it('measures a small turn about the centre', () => {
      const estimator = new MotionEstimator(W, H);
      estimator.push(frame(0, 0, 0));
      estimator.push(frame(0, 0, 0.02));
      const [move] = estimator.moves;
      expect(move.found).toBe(true);
      expect(move.da).toBeGreaterThan(0.015);
      expect(move.da).toBeLessThan(0.025);
      expect(Math.abs(move.dx * W)).toBeLessThan(0.2);
    });

    it('takes a flat picture as still and says so', () => {
      const estimator = new MotionEstimator(W, H);
      estimator.push(new Uint8Array(W * H).fill(90));
      estimator.push(new Uint8Array(W * H).fill(90));
      expect(estimator.moves).toEqual([{ dx: 0, dy: 0, da: 0, found: false }]);
    });

    it('refuses a frame of the wrong size', () => {
      expect(() => new MotionEstimator(W, H).push(new Uint8Array(10))).toThrow('wrong size');
    });
  });

  describe('the stored path', () => {
    it('sums the moves into a float32 path starting at zero', () => {
      const motion = stabiliseMotionOf(
        [
          { dx: 0.01, dy: -0.02, da: 0.001, found: true },
          { dx: 0.01, dy: 0, da: 0, found: false },
        ],
        { rate: 30, start: 1.5, width: 160, height: 90 },
      );
      expect(motion).toMatchObject({
        version: 1,
        method: 'block-similarity-v1',
        rate: 30,
        start: 1.5,
        count: 3,
        found: 0.5,
      });
      const x = floats(motion.x);
      expect(x.map((value) => Math.round(value * 1000) / 1000)).toEqual([0, 0.01, 0.02]);
      const y = floats(motion.y);
      expect(y[1]).toBeCloseTo(-0.02, 6);
    });
  });
});
