import { AssetDevelopMaskKind, AssetDevelopPreset } from '@immich/sdk';
import {
  MAX_MASKS,
  createMask,
  flipMask,
  maskIsActive,
  masksToSource,
  normalizeMasks,
  presetMatches,
  presetSettingsFrom,
  rotateMask,
  sha256Hex,
  tonePreviewRecipe,
} from '$lib/frameleaf/photo-tools';

describe('photo tools (FL-64)', () => {
  it('normalizes masks: clamps, fills defaults, drops malformed and duplicate ones, keeps at most eight', () => {
    const masks = normalizeMasks([
      { id: 'a', kind: AssetDevelopMaskKind.Radial, x: 3, radiusX: 0, adjustments: { exposure: 9, clarity: 40 } },
      { id: 'a', kind: AssetDevelopMaskKind.Linear },
      { id: 'b', kind: 'brush' },
      null,
      ...Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, kind: AssetDevelopMaskKind.Linear })),
    ]);
    expect(masks).toHaveLength(MAX_MASKS);
    expect(masks[0]).toMatchObject({ id: 'a', x: 1, radiusX: 0.01, enabled: true, feather: 50, amount: 100 });
    expect(masks[0].adjustments.exposure).toBe(2);
    expect(masks[0].adjustments).not.toHaveProperty('clarity');
    expect(normalizeMasks(undefined)).toEqual([]);
  });

  it('creates radial and linear masks with unique ids and no effect until a control moves', () => {
    const radial = createMask(AssetDevelopMaskKind.Radial);
    const linear = createMask(AssetDevelopMaskKind.Linear, [radial]);
    expect(radial.id).not.toBe(linear.id);
    expect(linear).toMatchObject({ x: 0.5, y: 0, endX: 0.5, endY: 0.5 });
    expect(maskIsActive(radial)).toBe(false);
    expect(maskIsActive({ ...radial, adjustments: { ...radial.adjustments, exposure: 0.5 } })).toBe(true);
    expect(maskIsActive({ ...radial, enabled: false, adjustments: { ...radial.adjustments, exposure: 0.5 } })).toBe(
      false,
    );
  });

  it('turns and mirrors a mask with the frame, and four turns come back where they started', () => {
    const mask = { ...createMask(AssetDevelopMaskKind.Radial), x: 0.2, y: 0.1, radiusX: 0.3, radiusY: 0.1 };
    const turned = rotateMask(mask, true);
    expect(turned).toMatchObject({ x: 0.9, y: 0.2, radiusX: 0.1, radiusY: 0.3 });
    expect(rotateMask(turned, false)).toEqual(mask);
    let spun = mask;
    for (let i = 0; i < 4; i += 1) {
      spun = rotateMask(spun, true);
    }
    expect(spun).toEqual(mask);
    expect(flipMask(mask, 'h')).toMatchObject({ x: 0.8, y: 0.1 });
    expect(flipMask(mask, 'v')).toMatchObject({ x: 0.2, y: 0.9 });
  });

  it('moves masks back onto the source frame for the tone preview', () => {
    const drawn = { ...createMask(AssetDevelopMaskKind.Linear), x: 0.1, y: 0.2, endX: 0.3, endY: 0.9 };
    // What the renderer does: turn, then mirror left/right.
    const source = { ...drawn, x: 0.4, y: 0.25, endX: 0.6, endY: 0.35 };
    const oriented = flipMask(rotateMask(source, true), 'h');
    expect(masksToSource([oriented], { rotation: 90, flipHorizontal: true, flipVertical: false })).toEqual([
      expect.objectContaining({ x: 0.4, y: 0.25, endX: 0.6, endY: 0.35 }),
    ]);

    const preview = tonePreviewRecipe({
      version: 1,
      rotation: 90,
      flipHorizontal: true,
      crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      masks: [oriented],
    });
    expect(preview).toMatchObject({ rotation: 0, flipHorizontal: false, crop: { x: 0, y: 0, w: 1, h: 1 } });
    expect(preview.masks?.[0]).toMatchObject({ x: 0.4, y: 0.25 });
  });

  it('keeps preset settings without geometry and compares them exactly', () => {
    const settings = presetSettingsFrom({
      temperature: 30,
      preset: AssetDevelopPreset.Warm,
      crop: { x: 0.5, y: 0, w: 0.5, h: 1 },
      rotation: 90,
    } as never);
    expect(settings).toMatchObject({ temperature: 30, exposure: 0, preset: AssetDevelopPreset.Warm, masks: [] });
    expect(settings).not.toHaveProperty('crop');
    expect(settings).not.toHaveProperty('rotation');
    expect(presetMatches(settings, presetSettingsFrom({ ...settings }))).toBe(true);
    expect(presetMatches(settings, presetSettingsFrom({ ...settings, temperature: 31 }))).toBe(false);
  });

  it('hashes a file as SHA-256 hex', async () => {
    await expect(sha256Hex(new Blob(['abc']))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
