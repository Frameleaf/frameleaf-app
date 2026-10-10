import { vi } from 'vitest';
import { initialNativeRecipe, nativePreset, newNativeMask } from './native-develop';

vi.mock('@frameleaf/sdk', () => ({ defaults: {}, getBaseUrl: () => '/api' }));

it('keeps native units/version and never transfers image-specific artifacts or geometry in a preset', () => {
  const recipe = {
    ...initialNativeRecipe(),
    exposureEV: 2,
    whiteBalance: { red: 1.2, green: 1, blue: 0.9 },
    crop: { x: 0, y: 0, w: 0.5, h: 1 },
    sensorCanvas: true,
    masks: [newNativeMask('radial'), newNativeMask('subject', 'a'.repeat(64)), newNativeMask('brush')],
  };
  const preset = nativePreset(recipe);
  expect(preset).toMatchObject({
    version: 2,
    renderer: 'darktable/5.6.1',
    exposureEV: 2,
    whiteBalance: recipe.whiteBalance,
  });
  expect(preset).not.toHaveProperty('crop');
  expect(preset).not.toHaveProperty('sensorCanvas');
  expect(preset.masks?.map((mask) => mask.kind)).toEqual(['radial']);
  expect(recipe.masks).toHaveLength(3);
});
