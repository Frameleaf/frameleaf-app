import {
  AssetDevelopMaskKind,
  AssetDevelopPreset,
  AssetDevelopPreviewDto,
  AssetDevelopRecipeSchema,
  AssetDevelopSaveDto,
  KnownAssetDevelopRecipeSchema,
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
    expect(KnownAssetDevelopRecipeSchema.safeParse({ version: 1, masks: [{ ...radial, kind: 'brush' }] }).success).toBe(
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

it('retains a future recipe envelope and nested unknown data for save-only roundtrip (FL-233)', () => {
  const recipe = {
    version: 2,
    brilliance: 18,
    masks: [{ id: 'subject', kind: 'subject', bitmap: { revision: 'opaque', hash: 'abc' } }],
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
