import {
  AssetDevelopMaskKind,
  AssetDevelopPreset,
  AssetDevelopPreviewDto,
  AssetDevelopRecipeSchema,
  AssetDevelopSaveDto,
} from 'src/dtos/asset-develop.dto.js';

describe('AssetDevelopRecipeDto', () => {
  it('accepts a minimal recipe and fills the defaults', () => {
    const result = AssetDevelopRecipeSchema.safeParse({ version: 1 });
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
    expect(AssetDevelopRecipeSchema.safeParse({ version: 2 }).success).toBe(false);
  });

  it('rejects out-of-range sliders and a crop that leaves the frame', () => {
    expect(AssetDevelopRecipeSchema.safeParse({ version: 1, exposure: 3 }).success).toBe(false);
    expect(AssetDevelopRecipeSchema.safeParse({ version: 1, grain: -1 }).success).toBe(false);
    expect(AssetDevelopRecipeSchema.safeParse({ version: 1, rotation: 45 }).success).toBe(false);
    expect(AssetDevelopRecipeSchema.safeParse({ version: 1, crop: { x: 0.6, y: 0, w: 0.5, h: 1 } }).success).toBe(
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
    const parsed = AssetDevelopRecipeSchema.safeParse({
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
    expect(AssetDevelopRecipeSchema.safeParse({ version: 1 }).data?.masks).toEqual([]);

    const radial = { id: 'a', kind: AssetDevelopMaskKind.Radial, x: 0.5, y: 0.5 };
    expect(AssetDevelopRecipeSchema.safeParse({ version: 1, masks: [radial, radial] }).success).toBe(false);
    expect(AssetDevelopRecipeSchema.safeParse({ version: 1, masks: [{ ...radial, kind: 'brush' }] }).success).toBe(
      false,
    );
    expect(
      AssetDevelopRecipeSchema.safeParse({ version: 1, masks: [{ ...radial, adjustments: { clarity: 20 } }] }).data
        ?.masks[0].adjustments,
    ).not.toHaveProperty('clarity');
    expect(
      AssetDevelopRecipeSchema.safeParse({
        version: 1,
        masks: [{ id: 'l', kind: AssetDevelopMaskKind.Linear, x: 0.5, y: 0.5, endX: 0.5, endY: 0.5 }],
      }).success,
    ).toBe(false);
    expect(
      AssetDevelopRecipeSchema.safeParse({
        version: 1,
        masks: Array.from({ length: 9 }, (_, i) => ({ ...radial, id: `m${i}` })),
      }).success,
    ).toBe(false);
  });
});
