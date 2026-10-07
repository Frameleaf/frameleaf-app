import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssetDevelopCleanupMethod, AssetDevelopMaskKind } from 'src/dtos/asset-develop.dto.js';
import {
  type DevelopBitmap,
  applyDevelopCleanup,
  cleanupCoverage,
  developCleanupArtifacts,
  normalizeDevelopCleanup,
  normalizeStrokes,
  orientedToOriginal,
  sampleBitmap,
} from 'src/utils/develop-cleanup.js';
import {
  applyDevelopMasks,
  applyDevelopTone,
  brillianceRgb,
  effectiveDevelop,
  identityMaskMapping,
  normalizeDevelopRecipe,
  originalMaskWeight,
} from 'src/utils/develop-recipe.js';

/**
 * FL-233 (renderer `frameleaf-develop/3`): Brilliance, brush and bitmap masks and Clean Up on a
 * deterministic synthetic image. The golden digests pin every byte the server renderer produces
 * for each new field, so a change to a definition shows up here and in the protocol document the
 * native renderers follow.
 */
const W = 64;
const H = 48;
const gradient = (channels: 3 | 4 = 3) => {
  const data = new Uint8Array(W * H * channels);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const index = (y * W + x) * channels;
      data[index] = Math.round((x / (W - 1)) * 255);
      data[index + 1] = Math.round((y / (H - 1)) * 255);
      data[index + 2] = (x * 7 + y * 13) % 256;
      if (channels === 4) {
        data[index + 3] = 255;
      }
    }
  }
  return data;
};
const info = { width: W, height: H, channels: 3 as const };
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex').slice(0, 16);
const pixel = (data: Uint8Array, x: number, y: number) => [...data.slice((y * W + x) * 3, (y * W + x) * 3 + 3)];

const maskAdjustments = (exposure: number) => ({
  exposure,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  dehaze: 0,
});

describe('Brilliance (FL-233)', () => {
  it('opens the shadows, holds the highlights back and leaves black, middle grey and white alone', () => {
    const [shadow] = brillianceRgb(0.2, 0.2, 0.2, 1);
    const [highlight] = brillianceRgb(0.8, 0.8, 0.8, 1);
    expect(shadow).toBeGreaterThan(0.2);
    expect(highlight).toBeLessThan(0.8);
    for (const value of [0, 0.5, 1]) {
      const [r] = brillianceRgb(value, value, value, 1);
      expect(r).toBeCloseTo(value, 6);
    }
    // negative does the reverse
    expect(brillianceRgb(0.2, 0.2, 0.2, -1)[0]).toBeLessThan(0.2);
    // hue is kept: the channel ratios of a colour survive (before the chroma lift)
    const [r, g] = brillianceRgb(0.3, 0.15, 0.1, 0.5);
    expect(r / g).toBeCloseTo(((0.3 - 0) / 0.15) * 1, 0);
  });

  it('is part of the still develop and renders to golden bytes', () => {
    const recipe = normalizeDevelopRecipe({ brilliance: 60 });
    expect(recipe.brilliance).toBe(60);
    expect(normalizeDevelopRecipe({ brilliance: 400 }).brilliance).toBe(100);
    const { params, look } = effectiveDevelop(recipe);
    const data = applyDevelopTone(gradient(), info, params, look, 1);
    expect(digest(data)).toBe('388a789047602525');
    // zero brilliance renders exactly as before (renderer v2 bytes)
    const zero = effectiveDevelop(normalizeDevelopRecipe({}));
    expect(applyDevelopTone(gradient(), info, zero.params, zero.look, 1)).toEqual(gradient());
  });
});

describe('original-image coordinates (FL-233)', () => {
  it('maps an oriented point back through flips and quarter turns', () => {
    // a 40 x 30 original turned 90° clockwise is 30 x 40; its top-left corner went to the top-right
    expect(orientedToOriginal(30, 0, { oriented: { width: 30, height: 40 }, rotation: 90 })).toEqual({
      x: 0,
      y: 0,
      original: { width: 40, height: 30 },
    });
    expect(orientedToOriginal(0, 40, { oriented: { width: 30, height: 40 }, rotation: 270 })).toMatchObject({
      x: 0,
      y: 0,
    });
    expect(orientedToOriginal(40, 30, { oriented: { width: 40, height: 30 }, rotation: 180 })).toMatchObject({
      x: 0,
      y: 0,
    });
    expect(orientedToOriginal(40, 0, { oriented: { width: 40, height: 30 }, flipHorizontal: true })).toMatchObject({
      x: 0,
      y: 0,
    });
  });

  it('samples a bitmap bilinearly across the whole original', () => {
    const bitmap: DevelopBitmap = { data: new Uint8Array([0, 255, 0, 255]), width: 2, height: 2, channels: 1 };
    expect(sampleBitmap(bitmap, 0, 0, 0)).toBe(0);
    expect(sampleBitmap(bitmap, 1, 0, 0)).toBe(255);
    expect(sampleBitmap(bitmap, 0.5, 0.5, 0)).toBeCloseTo(127.5, 5);
  });
});

describe('brush and bitmap masks (FL-233)', () => {
  const brush = normalizeDevelopRecipe({
    masks: [
      {
        id: 'b',
        kind: AssetDevelopMaskKind.Brush,
        feather: 50,
        adjustments: maskAdjustments(1),
        strokes: [
          {
            points: [
              [0.25, 0.5],
              [0.75, 0.5],
            ],
            radius: 0.1,
            erase: false,
          },
          { points: [[0.5, 0.5]], radius: 0.05, erase: true },
        ],
      },
    ],
  } as never).masks;

  it('paints strokes in original coordinates and erases with an erasing stroke', () => {
    const original = { width: W, height: H };
    expect(originalMaskWeight(brush[0], 0.25 * W, 0.5 * H, original)).toBe(1);
    expect(originalMaskWeight(brush[0], 0.5 * W, 0.5 * H, original)).toBe(0);
    expect(originalMaskWeight(brush[0], 0.25 * W, 0.05 * H, original)).toBe(0);
  });

  it('renders a brush mask to golden bytes, and on the same content after a quarter turn', () => {
    const data = applyDevelopMasks(gradient(), info, brush, identityMaskMapping(W, H));
    expect(digest(data)).toBe('229711c61f0e4a22');
    // turned 90°: the frame is 48 x 64, and the stroke still lies on the original's middle row
    const turned = { width: H, height: W, channels: 3 as const };
    const rotated = applyDevelopMasks(new Uint8Array(W * H * 3).fill(100), turned, brush, {
      ...identityMaskMapping(H, W),
      rotation: 90,
    });
    // the original's (0.25 W, 0.5 H) is at oriented (H - 0.5 H, 0.25 W)
    const at = (x: number, y: number) => rotated[(y * H + x) * 3];
    expect(at(Math.floor(H / 2), Math.floor(W / 4))).toBeGreaterThan(100);
    expect(at(2, 2)).toBe(100);
  });

  it('reads a subject mask from its stored bitmap', () => {
    const id = 'a'.repeat(64);
    const masks = normalizeDevelopRecipe({
      masks: [{ id: 's', kind: AssetDevelopMaskKind.Subject, artifact: id, adjustments: maskAdjustments(-1) }],
    } as never).masks;
    // left half selected
    const bitmap: DevelopBitmap = { data: new Uint8Array([255, 0, 255, 0]), width: 2, height: 2, channels: 1 };
    const data = applyDevelopMasks(gradient(), info, masks, identityMaskMapping(W, H), new Map([[id, bitmap]]));
    expect(pixel(data, 2, 10)[1]).toBeLessThan(pixel(gradient(), 2, 10)[1]);
    expect(pixel(data, W - 2, 10)).toEqual(pixel(gradient(), W - 2, 10));
    expect(digest(data)).toBe('e03048b85f8a69c8');
    // without its bitmap a subject mask is not active (the service refuses such a render first)
    const missing = normalizeDevelopRecipe({
      masks: [{ id: 's', kind: AssetDevelopMaskKind.Subject, adjustments: maskAdjustments(-1) }],
    } as never).masks;
    expect(applyDevelopMasks(gradient(), info, missing)).toEqual(gradient());
  });
});

describe('Clean Up (FL-233)', () => {
  const region = { x: 0.25, y: 0.25, w: 0.25, h: 0.25 };
  const ops = (operations: unknown[]) => normalizeDevelopCleanup(operations);

  it('normalizes operations, keeps exactly one area and drops unknown methods', () => {
    expect(
      ops([
        { id: 'a', method: 'pixelate', region },
        { id: 'a', method: 'pixelate', region },
        { id: 'b', method: 'paint', region },
        { id: 'c', method: 'clone', region, strokes: [{ points: [[0, 0]], radius: 0.1 }] },
        { id: 'd', method: 'heal', strokes: [{ points: [[0.1, 0.1]], radius: 0.05, erase: true }] },
      ]).map(({ id }) => id),
    ).toEqual(['a', 'd']);
    // erasing is for brush masks only
    expect(normalizeStrokes([{ points: [[0, 0]], radius: 0.1, erase: true }], false)[0].erase).toBe(false);
  });

  it('covers a region with a soft edge and strokes like a brush', () => {
    const [op] = ops([{ id: 'r', method: 'pixelate', region, feather: 50 }]);
    expect(cleanupCoverage(op, 0.375 * W, 0.375 * H, { width: W, height: H })).toBe(1);
    expect(cleanupCoverage(op, 0.1 * W, 0.1 * H, { width: W, height: H })).toBe(0);
    const edge = cleanupCoverage(op, 0.49 * W, 0.375 * H, { width: W, height: H });
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
  });

  it('pixelates into blocks of the mean colour, golden', () => {
    const data = applyDevelopCleanup(gradient(), info, ops([{ id: 'p', method: 'pixelate', region, blockSize: 0.1 }]));
    expect(pixel(data, 17, 13)).toEqual(pixel(data, 18, 13));
    expect(pixel(data, 2, 2)).toEqual(pixel(gradient(), 2, 2));
    expect(digest(data)).toBe('e896ca968fd68fef');
  });

  it('clones from the source offset, and heals by matching the area’s mean colour, golden', () => {
    const clone = applyDevelopCleanup(
      gradient(),
      info,
      ops([{ id: 'c', method: AssetDevelopCleanupMethod.Clone, region, source: { dx: 0.25, dy: 0 } }]),
    );
    expect(pixel(clone, 20, 15)).toEqual(pixel(gradient(), 36, 15));
    expect(digest(clone)).toBe('d4b79274d7344687');

    const heal = applyDevelopCleanup(
      gradient(),
      info,
      ops([{ id: 'h', method: AssetDevelopCleanupMethod.Heal, region, source: { dx: 0.25, dy: 0 } }]),
    );
    // the healed red channel keeps the area's own mean; the cloned one takes the source's
    const mean = (data: Uint8Array) => {
      let sum = 0;
      for (let y = 12; y < 24; y += 1) {
        for (let x = 16; x < 32; x += 1) {
          sum += pixel(data, x, y)[0];
        }
      }
      return sum / (12 * 16);
    };
    expect(Math.abs(mean(heal) - mean(gradient()))).toBeLessThan(1);
    expect(mean(clone) - mean(gradient())).toBeGreaterThan(50);
    expect(digest(heal)).toBe('88ce57059db63438');
  });

  it('removes with the stored fill, composited by its alpha, golden; and needs the fill', () => {
    const fillId = 'f'.repeat(64);
    const fill: DevelopBitmap = { data: new Uint8Array([10, 200, 30, 255]), width: 1, height: 1, channels: 4 };
    const operations = ops([{ id: 'x', method: AssetDevelopCleanupMethod.Remove, region, fill: fillId }]);
    expect(developCleanupArtifacts(operations)).toEqual([fillId]);
    const data = applyDevelopCleanup(gradient(), info, operations, new Map([[fillId, fill]]));
    expect(pixel(data, 20, 15)).toEqual([10, 200, 30]);
    expect(digest(data)).toBe('c8e4d53226ef5ea8');
    expect(() => applyDevelopCleanup(gradient(), info, operations)).toThrow('needs its generated fill');
  });

  it('applies operations in order, each to the result of the one before, and skips disabled ones', () => {
    const both = ops([
      { id: 'c', method: AssetDevelopCleanupMethod.Clone, region, source: { dx: 0.25, dy: 0 } },
      { id: 'p', method: AssetDevelopCleanupMethod.Pixelate, region, blockSize: 0.1, enabled: false },
    ]);
    expect(applyDevelopCleanup(gradient(), info, both)).toEqual(
      applyDevelopCleanup(gradient(), info, both.slice(0, 1)),
    );
  });
});

describe('worst-case cost (FL-233)', () => {
  it('renders the largest brush and Clean Up recipe on a 3 MP image in bounded time', () => {
    const width = 2000;
    const height = 1500;
    const image = new Uint8Array(width * height * 3).fill(120);
    const wiggle = (seed: number, count: number) =>
      Array.from({ length: count }, (_, index) => [
        (Math.sin(seed + index * 0.37) + 1) / 2,
        (Math.cos(seed * 1.7 + index * 0.21) + 1) / 2,
      ]);
    // 8 brush masks of 4 strokes x 96 points, and 4 Clean Up strokes of 128 points: 4096 points
    const recipe = normalizeDevelopRecipe({
      masks: Array.from({ length: 8 }, (_, mask) => ({
        id: `b${mask}`,
        kind: AssetDevelopMaskKind.Brush,
        adjustments: maskAdjustments(0.5),
        strokes: Array.from({ length: 4 }, (_, stroke) => ({ points: wiggle(mask * 4 + stroke, 96), radius: 0.08 })),
      })),
      cleanup: [
        {
          id: 'h',
          method: AssetDevelopCleanupMethod.Heal,
          source: { dx: 0.05, dy: 0.05 },
          strokes: Array.from({ length: 4 }, (_, stroke) => ({ points: wiggle(100 + stroke, 128), radius: 0.08 })),
        },
      ],
    } as never);
    expect(recipe.masks.flatMap((mask) => mask.strokes ?? []).flatMap((stroke) => stroke.points)).toHaveLength(3072);
    // CPU time of this worker, not wall time: a busy machine running the suite in parallel stretches
    // the wall clock many times over without the render doing any more work
    const started = process.cpuUsage();
    applyDevelopCleanup(image, { width, height, channels: 3 }, recipe.cleanup);
    applyDevelopMasks(image, { width, height, channels: 3 }, recipe.masks, identityMaskMapping(width, height));
    const { user, system } = process.cpuUsage(started);
    // a few seconds on a laptop (before FL-233 review: minutes); the bound leaves room for a slow runner
    expect((user + system) / 1000).toBeLessThan(15_000);
  }, 180_000);

  it('keeps at most 4096 stroke points in a recipe', () => {
    const recipe = normalizeDevelopRecipe({
      masks: Array.from({ length: 8 }, (_, mask) => ({
        id: `b${mask}`,
        kind: AssetDevelopMaskKind.Brush,
        strokes: Array.from({ length: 64 }, () => ({
          points: Array.from({ length: 512 }, () => [0.5, 0.5]),
          radius: 0.1,
        })),
      })),
    } as never);
    expect(recipe.masks.flatMap((mask) => mask.strokes ?? []).flatMap((stroke) => stroke.points)).toHaveLength(4096);
  });
});

it('allows native semantic paint/erase refinement while retaining untouched bitmap coverage', () => {
  const bitmap: DevelopBitmap = { data: Buffer.alloc(64 * 48, 255), width: 64, height: 48, channels: 1 };
  const mask = {
    id: 'refined',
    kind: AssetDevelopMaskKind.Subject,
    enabled: true,
    invert: false,
    amount: 100,
    x: 0.5,
    y: 0.5,
    endX: 0.5,
    endY: 1,
    radiusX: 0.25,
    radiusY: 0.25,
    feather: 0,
    name: null,
    artifact: 'a'.repeat(64),
    strokes: [{ points: [[0.5, 0.5]] as [number, number][], radius: 0.15, erase: true }],
  };
  const artifacts = new Map([[mask.artifact, bitmap]]);
  expect(originalMaskWeight(mask, 32, 24, { width: 64, height: 48 }, artifacts)).toBe(0);
  expect(originalMaskWeight(mask, 2, 2, { width: 64, height: 48 }, artifacts)).toBe(1);
});

it('clones fractional HDR light without integer quantization and rejects an unbudgeted float surface', () => {
  const data = new Float32Array([2.125, 2.125, 2.125, 1, 8.25, 8.25, 8.25, 1]);
  const operations = normalizeDevelopCleanup([
    { id: 'hdr', method: 'clone', region: { x: 0, y: 0, w: 0.5, h: 1 }, source: { dx: 0.5, dy: 0 } },
  ]);
  expect(() => applyDevelopCleanup(data, { width: 2, height: 1, channels: 4 }, operations, new Map(), 32)).toThrow(
    'budget',
  );
  applyDevelopCleanup(data, { width: 2, height: 1, channels: 4 }, operations, new Map(), 1024);
  expect([...data]).toEqual([8.25, 8.25, 8.25, 1, 8.25, 8.25, 8.25, 1]);
});

it('places a premultiplied linear SDR fill at reference-white intensity in HDR', () => {
  const data = new Float32Array([8, 8, 8, 1]);
  const fillId = 'b'.repeat(64);
  const fills = new Map([
    [fillId, { data: new Float32Array([0.5, 0.5, 0.5, 1]), width: 1, height: 1, channels: 4 as const }],
  ]);
  const operations = normalizeDevelopCleanup([
    { id: 'fill', method: 'remove', region: { x: 0, y: 0, w: 1, h: 1 }, fill: fillId },
  ]);
  applyDevelopCleanup(data, { width: 1, height: 1, channels: 4 }, operations, fills, 1024);
  expect([...data]).toEqual([0.5, 0.5, 0.5, 1]);
});

it('pixelates HDR using visible linear light and retains alpha', () => {
  const data = new Float32Array(10 * 10 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([4.125, 4.125, 4.125, 1], i);
  data.set([32, 32, 32, 0], 0);
  const operations = normalizeDevelopCleanup([
    { id: 'hdr-pixelate', method: 'pixelate', region: { x: 0, y: 0, w: 1, h: 1 }, blockSize: 0.2 },
  ]);
  applyDevelopCleanup(data, { width: 10, height: 10, channels: 4 }, operations, new Map(), 16_384);
  expect([...data.slice(0, 8)]).toEqual([4.125, 4.125, 4.125, 0, 4.125, 4.125, 4.125, 1]);
});

it('heals floating HDR using the surrounding tone without clipping headroom', () => {
  const data = new Float32Array([8.125, 8.125, 8.125, 0.75, 16.25, 16.25, 16.25, 1]);
  const operations = normalizeDevelopCleanup([
    { id: 'hdr-heal', method: 'heal', region: { x: 0, y: 0, w: 0.5, h: 1 }, source: { dx: 0.5, dy: 0 } },
  ]);
  applyDevelopCleanup(data, { width: 2, height: 1, channels: 4 }, operations, new Map(), 1024);
  expect([...data]).toEqual([8.125, 8.125, 8.125, 0.75, 16.25, 16.25, 16.25, 1]);
});
