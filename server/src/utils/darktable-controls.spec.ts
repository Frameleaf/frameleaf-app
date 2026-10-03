import { DarktableDevelopRecipeSchema } from 'src/dtos/asset-develop.dto.js';
import { nativeBlendParams, nativeModuleParams } from 'src/utils/darktable-controls.js';

const base = { version: 2, renderer: 'darktable/5.6.1', exposureEV: 0 };
it('validates every native control, strict nested objects and ordered endpoint curves', () => {
  expect(
    DarktableDevelopRecipeSchema.safeParse({
      ...base,
      whiteBalance: { red: 1.2, green: 1, blue: 0.9 },
      shadows: 20,
      highlights: -30,
      saturation: 1.2,
      contrast: 1.1,
      curve: [
        { x: 0, y: 0 },
        { x: 0.4, y: 0.5 },
        { x: 1, y: 1 },
      ],
      noiseThreshold: 0.02,
      sharpen: { radius: 2, amount: 0.6, threshold: 0.5 },
      lensCorrection: true,
      crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 },
      rotation: 90,
      straighten: 1.5,
    }).success,
  ).toBe(true);
  expect(
    DarktableDevelopRecipeSchema.safeParse({
      ...base,
      curve: [
        { x: 0.5, y: 0 },
        { x: 0.4, y: 1 },
      ],
    }).success,
  ).toBe(false);
  expect(DarktableDevelopRecipeSchema.safeParse({ ...base, crop: { x: 0.9, y: 0, w: 0.5, h: 1 } }).success).toBe(false);
  expect(
    DarktableDevelopRecipeSchema.safeParse({ ...base, whiteBalance: { red: 1, green: 1, blue: 1, guess: 1 } }).success,
  ).toBe(false);
});
it('serializes verified module versions, lengths, defaults and native blend raster references', () => {
  const recipe = DarktableDevelopRecipeSchema.parse({
    ...base,
    shadows: 25,
    highlights: -40,
    curve: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    saturation: 0,
    contrast: 1.4,
    noiseThreshold: 0.02,
    sharpen: { radius: 2, amount: 1, threshold: 0.5 },
    lensCorrection: true,
    crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 },
    straighten: 3,
  });
  const modules = nativeModuleParams(recipe);
  expect(modules.get('shadhi')!.params.length).toBe(48);
  expect(modules.get('shadhi')!.params.readFloatLE(8)).toBe(25);
  expect(modules.get('shadhi')!.params.readFloatLE(16)).toBe(-40);
  expect(modules.get('rgbcurve')!.params.length).toBe(516);
  expect(modules.get('rawdenoise')!.params.length).toBe(164);
  expect(modules.get('lens')!.params.length).toBe(356);
  expect(modules.get('lens')!.params.readInt32LE(332)).toBe(0); // native camera defaults, not guessed EXIF
  expect(modules.get('clipping')!.params.readFloatLE(12)).toBeCloseTo(0.9);
  expect(modules.get('colorbalance')!.params.readFloatLE(52)).toBe(0);
  const blend = nativeBlendParams(4, 3);
  expect(blend.length).toBe(420);
  expect(blend.readUInt32LE(0)).toBe(9);
  expect(blend.toString('utf8', 388, 398)).toBe('rasterfile');
  expect(blend.readInt32LE(408)).toBe(3);
  expect(blend.readInt32LE(412)).toBe(0);
});
