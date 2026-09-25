import { AssetDevelopPreset } from '@immich/sdk';
import {
  ASPECT_IDS,
  AUTO_TONE,
  DEVELOP_KEYS,
  DEVELOP_PARAMS,
  aspectRatioValue,
  autoToneApplied,
  clampParam,
  cssFilterFor,
  developDefaults,
  effectiveDevelop,
  fitCropRect,
  groupIsDefault,
  groupReset,
  histogramBins,
  isCompareKey,
  normalizeRect,
  resizeCropRect,
  rotateAspect,
  rotateRect,
  straightenScale,
  toneKey,
  toneOnlyRecipe,
  tonePixels,
} from '$lib/frameleaf/develop';

describe('develop', () => {
  describe('parameters', () => {
    it('lists the sixteen Lightroom-style sliders in four groups', () => {
      expect(DEVELOP_KEYS).toHaveLength(16);
      expect(new Set(DEVELOP_PARAMS.map((item) => item.group))).toEqual(
        new Set(['light', 'color', 'effects', 'detail']),
      );
      expect(developDefaults().exposure).toBe(0);
    });

    it('clamps and steps slider values', () => {
      expect(clampParam('exposure', 5)).toBe(2);
      expect(clampParam('exposure', 0.123)).toBe(0.1);
      expect(clampParam('grain', -5)).toBe(0);
      expect(clampParam('contrast', NaN)).toBe(0);
    });

    it('knows when a group is at its defaults and how to reset it', () => {
      expect(groupIsDefault(developDefaults(), 'light')).toBe(true);
      expect(groupIsDefault({ ...developDefaults(), shadows: 10 }, 'light')).toBe(false);
      expect(groupReset('detail')).toEqual({ sharpen: 0, noiseReduction: 0 });
    });

    it('recognises the auto tone recipe', () => {
      expect(autoToneApplied({ ...developDefaults(), ...AUTO_TONE })).toBe(true);
      expect(autoToneApplied(developDefaults())).toBe(false);
    });
  });

  describe('effectiveDevelop', () => {
    it('adds the preset nudge scaled by strength, within range', () => {
      const vivid = effectiveDevelop({ ...developDefaults(), preset: AssetDevelopPreset.Vivid, presetStrength: 50 });
      expect(vivid.params.vibrance).toBe(15);
      expect(vivid.look).toEqual({ grayscale: 0, sepia: 0 });
      const noir = effectiveDevelop({ ...developDefaults(), contrast: 90, preset: AssetDevelopPreset.Noir });
      expect(noir.params.contrast).toBe(100);
      expect(noir.look.grayscale).toBe(100);
    });
  });

  describe('cssFilterFor', () => {
    it('is the identity filter for the default recipe', () => {
      const info = cssFilterFor(developDefaults());
      expect(info.filter).toBe('brightness(1) contrast(1) saturate(1)');
      expect(info.layers).toEqual([]);
    });

    it('adds overlay layers for the effects a filter() cannot express', () => {
      const info = cssFilterFor({ ...developDefaults(), temperature: 50, vignette: 40, grain: 30 });
      expect(info.layers.map((layer) => layer.id)).toEqual(['temperature', 'vignette', 'grain']);
      expect(info.numeric.brightness).toBe(1);
    });
  });

  describe('tonePixels and histogramBins', () => {
    it('applies the numeric factors in place and bins the result', () => {
      const data = new Uint8ClampedArray([100, 100, 100, 255, 200, 50, 50, 255, 0, 0, 0, 0]);
      tonePixels(data, { brightness: 1.5, contrast: 1, saturate: 1 });
      expect(data[0]).toBe(150);
      const bins = histogramBins({ data }, 4);
      expect(bins.samples).toBe(2);
      expect(bins.bins).toBe(4);
      expect(bins.red[2] + bins.red[3]).toBe(2);
    });

    it('reports clipping fractions', () => {
      const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
      const bins = histogramBins({ data }, 64);
      expect(bins.clipped).toEqual({ shadows: 0.5, highlights: 0.5 });
      expect(histogramBins(null).samples).toBe(0);
    });
  });

  describe('crop geometry', () => {
    it('resolves aspect ids to ratios', () => {
      expect(aspectRatioValue('Free', 1600, 900)).toBeNull();
      expect(aspectRatioValue('Original', 1600, 900)).toBeCloseTo(16 / 9);
      expect(aspectRatioValue('4:5', 1600, 900)).toBe(0.8);
      expect(ASPECT_IDS).toContain('3:2');
    });

    it('fits a centred rect for a ratio and normalizes stray values', () => {
      expect(fitCropRect(1, 1600, 900)).toEqual({ x: 0.2188, y: 0, w: 0.5625, h: 1 });
      expect(fitCropRect(null, 1600, 900)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
      expect(normalizeRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    });

    it('moves and resizes a rect within the frame', () => {
      const rect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
      expect(resizeCropRect(rect, 'move', 0.5, 0)).toEqual({ x: 0.5, y: 0.25, w: 0.5, h: 0.5 });
      expect(resizeCropRect(rect, 'e', 0.1, 0)).toEqual({ x: 0.25, y: 0.25, w: 0.6, h: 0.5 });
      expect(resizeCropRect(rect, 'nw', -1, -1)).toEqual({ x: 0, y: 0, w: 0.75, h: 0.75 });
    });

    it('keeps the ratio while dragging a corner', () => {
      const rect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
      const result = resizeCropRect(rect, 'se', 0.2, 0, { ratio: 1, frameWidth: 1000, frameHeight: 1000 });
      expect(result.w).toBeCloseTo(result.h, 3);
      expect(result.x + result.w).toBeLessThanOrEqual(1);
    });

    it('computes the straighten cover scale and follows quarter turns', () => {
      expect(straightenScale(1600, 900, 0)).toBe(1);
      expect(straightenScale(1600, 900, 10)).toBeGreaterThan(1);
      expect(rotateRect({ x: 0, y: 0, w: 0.5, h: 1 }, true)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
      expect(rotateAspect('16:9')).toBe('9:16');
      expect(rotateAspect('4:3')).toBe('Free');
    });
  });

  describe('tone key', () => {
    it('ignores geometry so crop drags do not re-request the server preview', () => {
      const base = { version: 1 as const, ...developDefaults(), contrast: 20 };
      const cropped = { ...base, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, rotation: 90, flipHorizontal: true };
      expect(toneKey(cropped)).toBe(toneKey(base));
      expect(toneKey({ ...base, contrast: 21 })).not.toBe(toneKey(base));
      expect(toneOnlyRecipe(cropped)).toMatchObject({ rotation: 0, flipHorizontal: false, crop: { w: 1, h: 1 } });
    });
  });
});

// Ported from design/frameleaf/template/tests/editor-compare.test.mjs.
describe('isCompareKey', () => {
  it('holds the original on backslash and Y', () => {
    expect(isCompareKey({ key: '\\', code: 'Backslash' })).toBe(true);
    expect(isCompareKey({ key: '#', code: 'Backslash' })).toBe(true);
    expect(isCompareKey({ key: 'y', code: 'KeyY' })).toBe(true);
    expect(isCompareKey({ key: 'Y', code: 'KeyY' })).toBe(true);
  });

  it('does not claim other editor keys or M', () => {
    for (const key of ['m', 'M', 'i', 'o', ' ', 'Escape', 'ArrowLeft']) {
      expect(isCompareKey({ key, code: '' }), key).toBe(false);
    }
    expect(isCompareKey(undefined)).toBe(false);
  });

  it('ignores modified presses but always accepts a release', () => {
    expect(isCompareKey({ key: '\\', metaKey: true })).toBe(false);
    expect(isCompareKey({ key: 'y', ctrlKey: true })).toBe(false);
    expect(isCompareKey({ key: '\\', altKey: true })).toBe(false);
    expect(isCompareKey({ key: '\\', metaKey: true }, { release: true })).toBe(true);
  });
});
