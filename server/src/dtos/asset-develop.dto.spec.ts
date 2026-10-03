import z from 'zod';
import {
  AssetDevelopCleanupMethod,
  AssetDevelopMaskKind,
  AssetDevelopPreset,
  AssetDevelopPreviewDto,
  AssetDevelopRecipeSchema,
  AssetDevelopSaveDto,
  DarktableDevelopRecipeSchema,
  KnownAssetDevelopRecipeSchema,
  recipeStrokePoints,
} from 'src/dtos/asset-develop.dto.js';

describe('AssetDevelopRecipeDto', () => {
  it('accepts a minimal recipe and fills the defaults', () => {
    const result = KnownAssetDevelopRecipeSchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      exposure: 0,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      rotation: 0,
      flipHorizontal: false,
      preset: AssetDevelopPreset.Original,
      presetStrength: 100,
    });
  });

  it('rejects an unknown recipe version', () => {
    expect(KnownAssetDevelopRecipeSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it('rejects out-of-range sliders and a crop that leaves the frame', () => {
    expect(KnownAssetDevelopRecipeSchema.safeParse({ version: 1, exposure: 3 }).success).toBe(false);
    expect(KnownAssetDevelopRecipeSchema.safeParse({ version: 1, grain: -1 }).success).toBe(false);
    expect(KnownAssetDevelopRecipeSchema.safeParse({ version: 1, rotation: 45 }).success).toBe(false);
    expect(KnownAssetDevelopRecipeSchema.safeParse({ version: 1, crop: { x: 0.6, y: 0, w: 0.5, h: 1 } }).success).toBe(
      false,
    );
  });

  it('defaults render to true on save and bounds the preview size', () => {
    const save = AssetDevelopSaveDto.schema.safeParse({ recipe: { version: 1 } });
    expect(save.success).toBe(true);
    expect(save.data).toMatchObject({ render: true });
    expect(AssetDevelopSaveDto.schema.safeParse({ recipe: { version: 1 }, label: '' }).success).toBe(false);

    const preview = AssetDevelopPreviewDto.schema.safeParse({ recipe: { version: 1 } });
    expect(preview.data).toMatchObject({ size: 1280 });
    expect(AssetDevelopPreviewDto.schema.safeParse({ recipe: { version: 1 }, size: 64 }).success).toBe(false);
  });

  it('accepts selective masks with defaults and rejects malformed ones (FL-64)', () => {
    const parsed = KnownAssetDevelopRecipeSchema.safeParse({
      version: 1,
      masks: [{ id: 'sky', kind: AssetDevelopMaskKind.Linear, x: 0.5, y: 0, adjustments: { exposure: -0.5 } }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.masks[0]).toMatchObject({
      enabled: true,
      invert: false,
      endX: 0.5,
      endY: 1,
      feather: 50,
      amount: 100,
      adjustments: { exposure: -0.5, contrast: 0 },
    });
    expect(KnownAssetDevelopRecipeSchema.safeParse({ version: 1 }).data?.masks).toEqual([]);

    const radial = { id: 'a', kind: AssetDevelopMaskKind.Radial, x: 0.5, y: 0.5 };
    expect(KnownAssetDevelopRecipeSchema.safeParse({ version: 1, masks: [radial, radial] }).success).toBe(false);
    expect(KnownAssetDevelopRecipeSchema.safeParse({ version: 1, masks: [{ ...radial, kind: 'depth' }] }).success).toBe(
      false,
    );
    expect(
      KnownAssetDevelopRecipeSchema.safeParse({ version: 1, masks: [{ ...radial, adjustments: { clarity: 20 } }] }).data
        ?.masks[0].adjustments,
    ).not.toHaveProperty('clarity');
    expect(
      KnownAssetDevelopRecipeSchema.safeParse({
        version: 1,
        masks: [{ id: 'l', kind: AssetDevelopMaskKind.Linear, x: 0.5, y: 0.5, endX: 0.5, endY: 0.5 }],
      }).success,
    ).toBe(false);
    expect(
      KnownAssetDevelopRecipeSchema.safeParse({
        version: 1,
        masks: Array.from({ length: 9 }, (_, i) => ({ ...radial, id: `m${i}` })),
      }).success,
    ).toBe(false);
  });
});

it('accepts brilliance, brush and bitmap masks and Clean Up, and refuses malformed ones (FL-233)', () => {
  const stroke = {
    points: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    radius: 0.02,
  };
  const artifact = 'a'.repeat(64);
  const parsed = KnownAssetDevelopRecipeSchema.safeParse({
    version: 1,
    brilliance: 40,
    masks: [
      { id: 'b', kind: AssetDevelopMaskKind.Brush, x: 0.5, y: 0.5, strokes: [stroke, { ...stroke, erase: true }] },
      { id: 's', kind: AssetDevelopMaskKind.Sky, x: 0.5, y: 0.5, artifact, detector: { model: 'vision/sky' } },
    ],
    cleanup: [
      { id: 'p', method: AssetDevelopCleanupMethod.Pixelate, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
      { id: 'c', method: AssetDevelopCleanupMethod.Clone, strokes: [stroke], source: { dx: 0.1, dy: 0 } },
      { id: 'r', method: AssetDevelopCleanupMethod.Remove, region: { x: 0, y: 0, w: 0.5, h: 0.5 }, fill: artifact },
    ],
  });
  expect(parsed.success).toBe(true);
  expect(parsed.data?.brilliance).toBe(40);
  expect(parsed.data?.cleanup[0]).toMatchObject({ enabled: true, feather: 0, blockSize: 0.02 });
  expect(parsed.data?.masks[0].strokes?.[0]).toMatchObject({ erase: false });

  const invalid = (extra: object) => KnownAssetDevelopRecipeSchema.safeParse({ version: 1, ...extra }).success;
  expect(invalid({ brilliance: 101 })).toBe(false);
  // strokes only on a brush mask, artifacts only on bitmap masks, artifact ids are SHA-256 hex
  expect(invalid({ masks: [{ id: 'r', kind: AssetDevelopMaskKind.Radial, x: 0.5, y: 0.5, strokes: [stroke] }] })).toBe(
    false,
  );
  expect(invalid({ masks: [{ id: 'r', kind: AssetDevelopMaskKind.Radial, x: 0.5, y: 0.5, artifact }] })).toBe(false);
  expect(invalid({ masks: [{ id: 's', kind: AssetDevelopMaskKind.Subject, x: 0.5, y: 0.5, artifact: '../x' }] })).toBe(
    false,
  );
  // exactly one area; heal and clone need a source; remove needs a fill
  const region = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  expect(invalid({ cleanup: [{ id: 'p', method: 'pixelate' }] })).toBe(false);
  expect(invalid({ cleanup: [{ id: 'p', method: 'pixelate', region, strokes: [stroke] }] })).toBe(false);
  expect(invalid({ cleanup: [{ id: 'h', method: 'heal', region }] })).toBe(false);
  expect(invalid({ cleanup: [{ id: 'x', method: 'remove', region }] })).toBe(false);
  expect(invalid({ cleanup: [{ id: 'x', method: 'pixelate', region: { x: 0.9, y: 0, w: 0.2, h: 0.1 } }] })).toBe(false);
  expect(
    invalid({
      cleanup: [
        { id: 'p', method: 'pixelate', region },
        { id: 'p', method: 'pixelate', region },
      ],
    }),
  ).toBe(false);

  // at most 4096 stroke points in a recipe
  const long = { points: Array.from({ length: 512 }, () => [0.5, 0.5]), radius: 0.02 };
  const brush = (id: string) => ({
    id,
    kind: AssetDevelopMaskKind.Brush,
    x: 0.5,
    y: 0.5,
    strokes: Array.from({ length: 4 }, () => long),
  });
  expect(invalid({ masks: ['a', 'b'].map((id) => brush(id)) })).toBe(true);
  expect(invalid({ masks: ['a', 'b', 'c'].map((id) => brush(id)) })).toBe(false);
  // the envelope budget fits every recipe the known schema allows: a save carrying all 4096 points
  // (here as many short strokes as the masks and Clean Up may hold) is accepted
  const save = (recipe: object) => AssetDevelopSaveDto.schema.safeParse({ recipe: { version: 1, ...recipe } });
  expect(save({ masks: ['a', 'b'].map((id) => brush(id)) }).success).toBe(true);
  const short = (count: number) =>
    Array.from({ length: 64 }, () => ({
      points: Array.from({ length: count }, () => [0.12345, 0.67891]),
      radius: 0.02,
    }));
  const crowded = {
    masks: Array.from({ length: 8 }, (_, index) => ({ ...brush(`b${index}`), strokes: short(2) })),
    cleanup: Array.from({ length: 24 }, (_, index) => ({
      id: `c${index}`,
      method: 'pixelate',
      strokes: short(2),
    })),
  };
  expect(recipeStrokePoints(crowded)).toBe(4096);
  expect(save(crowded).success).toBe(true);

  // a future Clean Up method is kept opaque by the envelope, exactly like a future mask kind
  const future = { version: 1, cleanup: [{ id: 'g', method: 'generative-expand', prompt: 'opaque' }] };
  expect(AssetDevelopRecipeSchema.parse(future)).toEqual(future);
});

it('retains a future recipe envelope and nested unknown data for save-only roundtrip (FL-233)', () => {
  const recipe = {
    version: 2,
    brilliance: 18,
    masks: [{ id: 'subject', kind: 'depth', bitmap: { revision: 'opaque', hash: 'abc' } }],
  };
  expect(AssetDevelopRecipeSchema.parse(recipe)).toEqual(recipe);
});

it('requires recipe on save and preview; opaque envelope never makes the request optional', () => {
  expect(AssetDevelopSaveDto.schema.safeParse({ render: false }).success).toBe(false);
  expect(AssetDevelopPreviewDto.schema.safeParse({ size: 256 }).success).toBe(false);
});

it('keeps existing version1 public save validation while retaining opaque fields', () => {
  for (const recipe of [
    { version: 1, exposure: 3 },
    { version: 1, grain: -1 },
    { version: 1, rotation: 45 },
    { version: 1, crop: { x: 0.6, y: 0, w: 0.5, h: 1 } },
    { version: 1, masks: [{ id: 'known', kind: 'radial', x: 2, y: 0.5 }] },
  ])
    expect(AssetDevelopSaveDto.schema.safeParse({ recipe, render: false }).success).toBe(false);
  expect(
    AssetDevelopSaveDto.schema.parse({ recipe: { version: 1, future: { opaque: true } }, render: false }).recipe,
  ).toEqual({ version: 1, future: { opaque: true } });
});

describe('Native development API schemas', () => {
  it('publishes explicit double/integer metadata for SDK generation, including nested controls', () => {
    const schema = z.toJSONSchema(DarktableDevelopRecipeSchema, { target: 'openapi-3.0', io: 'input' });
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (node.type === 'number') expect(node.format).toBe('double');
      for (const child of Object.values(node)) visit(child);
    };
    visit(schema);
    expect(schema.properties?.version).toMatchObject({ type: 'integer', format: 'int32', enum: [2] });
  });
});
