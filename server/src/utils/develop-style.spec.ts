import { describe, expect, it } from 'vitest';
import {
  STYLE_SLIDERS,
  type StyleSample,
  extractStyleFeatures,
  fitDevelopStyle,
  predictDevelopStyle,
  validateDevelopStyle,
} from 'src/utils/develop-style.js';

const recipe = (exposure: number): StyleSample['sliders'] =>
  Object.fromEntries(STYLE_SLIDERS.map((key) => [key, key === 'exposure' ? exposure : 0])) as StyleSample['sliders'];

it('extracts bounded tone and colour features from RGB previews', () => {
  const features = extractStyleFeatures(Uint8Array.from([100, 80, 60, 180, 160, 140]), 3);
  expect(features).toHaveLength(7);
  expect(features.every((value) => Number.isFinite(value) && Math.abs(value) <= 1)).toBe(true);
  expect(features[5]).toBeGreaterThan(0);
  expect(features[6]).toBeGreaterThan(0);
});

describe('develop style', () => {
  it('learns exposure from photos, without copying geometry or masks', () => {
    const samples = Array.from({ length: 50 }, (_, index) => {
      const feature = index / 50;
      return {
        image: [feature],
        embedding: Float32Array.from([feature, 2 * feature]),
        sliders: recipe(1.5 - 2 * feature),
      };
    });
    expect(validateDevelopStyle(samples)).toBe(true);
    const model = fitDevelopStyle(samples);
    const prediction = predictDevelopStyle(model, [0.8], Float32Array.from([0.8, 1.6]));
    expect(prediction.exposure).toBeCloseTo(-0.1, 1);
    expect(prediction.temperature).toBe(0);
    expect(prediction).not.toHaveProperty('crop');
  });
});
