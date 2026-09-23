import { AssetDevelopPreset } from 'src/dtos/asset-develop.dto.js';
import {
  DEVELOP_SLIDER_KEYS,
  applyDevelopTone,
  buildToneLuts,
  createNoise,
  defaultDevelopRecipe,
  effectiveDevelop,
  isIdentityDevelop,
  normalizeCrop,
  normalizeDevelopRecipe,
  planDevelopDetail,
  planDevelopGeometry,
  straightenScale,
} from 'src/utils/develop-recipe.js';

const grey = (width: number, height: number, value = 128, channels: 3 | 4 = 3) => {
  const data = new Uint8Array(width * height * channels);
  for (let i = 0; i < data.length; i += channels) {
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    if (channels === 4) {
      data[i + 3] = 255;
    }
  }
  return data;
};

describe('develop recipe', () => {
  describe('normalizeDevelopRecipe', () => {
    it('fills defaults for an empty recipe', () => {
      expect(normalizeDevelopRecipe({})).toEqual(defaultDevelopRecipe());
      expect(normalizeDevelopRecipe(null)).toEqual(defaultDevelopRecipe());
    });

    it('clamps every slider into its contract range', () => {
      const recipe = normalizeDevelopRecipe({
        exposure: 9,
        contrast: -500,
        grain: -20,
        sharpen: 400,
        straighten: 90,
        presetStrength: 250,
      });
      expect(recipe.exposure).toBe(2);
      expect(recipe.contrast).toBe(-100);
      expect(recipe.grain).toBe(0);
      expect(recipe.sharpen).toBe(100);
      expect(recipe.straighten).toBe(45);
      expect(recipe.presetStrength).toBe(100);
    });

    it('snaps rotation to quarter turns and unknown presets to Original', () => {
      expect(normalizeDevelopRecipe({ rotation: 100 }).rotation).toBe(90);
      expect(normalizeDevelopRecipe({ rotation: -90 }).rotation).toBe(270);
      expect(normalizeDevelopRecipe({ preset: 'Nope' as AssetDevelopPreset }).preset).toBe(AssetDevelopPreset.Original);
      expect(normalizeDevelopRecipe({ preset: AssetDevelopPreset.Noir }).preset).toBe(AssetDevelopPreset.Noir);
    });

    it('keeps the crop inside the frame', () => {
      expect(normalizeCrop({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
      expect(normalizeCrop({ x: -1, y: -1, w: 0.01, h: 4 })).toEqual({ x: 0, y: 0, w: 0.05, h: 1 });
      expect(normalizeCrop(undefined)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    });
  });

  describe('effectiveDevelop', () => {
    it('is the identity for the default recipe', () => {
      const { params, look } = effectiveDevelop(defaultDevelopRecipe());
      for (const key of DEVELOP_SLIDER_KEYS) {
        expect(params[key]).toBe(0);
      }
      expect(look).toEqual({ grayscale: 0, sepia: 0 });
      expect(isIdentityDevelop(defaultDevelopRecipe())).toBe(true);
    });

    it('adds the preset nudge scaled by its strength', () => {
      const full = effectiveDevelop({ ...defaultDevelopRecipe(), preset: AssetDevelopPreset.Vivid });
      expect(full.params.vibrance).toBe(30);
      expect(full.params.contrast).toBe(18);
      const half = effectiveDevelop({
        ...defaultDevelopRecipe(),
        preset: AssetDevelopPreset.Vivid,
        presetStrength: 50,
      });
      expect(half.params.vibrance).toBe(15);
      expect(half.params.contrast).toBe(9);
    });

    it('scales the look mixes and never exceeds a slider range', () => {
      const { params, look } = effectiveDevelop({
        ...defaultDevelopRecipe(),
        contrast: 95,
        preset: AssetDevelopPreset.Silvertone,
        presetStrength: 50,
      });
      expect(look).toEqual({ grayscale: 50, sepia: 9 });
      expect(params.contrast).toBe(100);
      expect(isIdentityDevelop({ ...defaultDevelopRecipe(), preset: AssetDevelopPreset.Mono })).toBe(false);
    });
  });

  describe('geometry', () => {
    it('matches the prototype cover scale for a straightened frame', () => {
      expect(straightenScale(1600, 1200, 0)).toBe(1);
      // the prototype's develop.mjs formula: max((w·cos + h·sin) / w, (w·sin + h·cos) / h)
      expect(straightenScale(1600, 1200, 10)).toBeCloseTo(1.2163, 4);
      expect(straightenScale(0, 0, 10)).toBe(1);
    });

    it('swaps the axes for quarter turns before applying the crop', () => {
      const plan = planDevelopGeometry({ ...defaultDevelopRecipe(), rotation: 90 }, 4000, 3000);
      expect(plan.oriented).toEqual({ width: 3000, height: 4000 });
      expect(plan.extract).toEqual({ left: 0, top: 0, width: 3000, height: 4000 });
      expect(plan.output).toEqual({ width: 3000, height: 4000 });
    });

    it('turns the normalized crop into pixels of the oriented frame', () => {
      const plan = planDevelopGeometry(
        { ...defaultDevelopRecipe(), crop: { x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, flipHorizontal: true },
        4000,
        3000,
      );
      expect(plan.extract).toEqual({ left: 1000, top: 1500, width: 2000, height: 1500 });
      expect(plan.flipHorizontal).toBe(true);
      expect(plan.straighten).toBe(0);
    });
  });

  describe('tone', () => {
    it('leaves pixels unchanged for the identity recipe', () => {
      const { params, look } = effectiveDevelop(defaultDevelopRecipe());
      const data = grey(4, 4, 128);
      applyDevelopTone(data, { width: 4, height: 4, channels: 3 }, params, look);
      expect([...data.slice(0, 3)]).toEqual([128, 128, 128]);
      const luts = buildToneLuts(params);
      expect(luts.r[0]).toBe(0);
      expect(luts.r[255]).toBe(255);
      expect(luts.g[128]).toBe(128);
    });

    it('brightens with positive exposure and darkens with negative exposure', () => {
      const brighter = buildToneLuts({ ...effectiveDevelop(defaultDevelopRecipe()).params, exposure: 1 });
      const darker = buildToneLuts({ ...effectiveDevelop(defaultDevelopRecipe()).params, exposure: -1 });
      expect(brighter.g[128]).toBeGreaterThan(128);
      expect(darker.g[128]).toBeLessThan(128);
      expect(brighter.g[0]).toBe(0);
    });

    it('warms by lifting red and lowering blue', () => {
      const { params, look } = effectiveDevelop({ ...defaultDevelopRecipe(), temperature: 60 });
      const data = grey(1, 1, 128);
      applyDevelopTone(data, { width: 1, height: 1, channels: 3 }, params, look);
      expect(data[0]).toBeGreaterThan(data[2]);
      expect(data[1]).toBe(128);
    });

    it('desaturates fully for the Mono look and leaves alpha alone', () => {
      const { params, look } = effectiveDevelop({ ...defaultDevelopRecipe(), preset: AssetDevelopPreset.Mono });
      const data = new Uint8Array([200, 40, 40, 77]);
      applyDevelopTone(data, { width: 1, height: 1, channels: 4 }, params, look);
      expect(data[0]).toBe(data[1]);
      expect(data[1]).toBe(data[2]);
      expect(data[3]).toBe(77);
    });

    it('darkens the corners and not the centre with a positive vignette', () => {
      const { params, look } = effectiveDevelop({ ...defaultDevelopRecipe(), vignette: 100 });
      const width = 9;
      const height = 9;
      const data = grey(width, height, 180);
      applyDevelopTone(data, { width, height, channels: 3 }, params, look);
      const centre = (4 * width + 4) * 3;
      expect(data[centre]).toBe(180);
      expect(data[0]).toBeLessThan(180);
    });

    it('produces the same grain for the same seed', () => {
      const { params, look } = effectiveDevelop({ ...defaultDevelopRecipe(), grain: 80 });
      const a = grey(8, 8, 120);
      const b = grey(8, 8, 120);
      applyDevelopTone(a, { width: 8, height: 8, channels: 3 }, params, look, 7);
      applyDevelopTone(b, { width: 8, height: 8, channels: 3 }, params, look, 7);
      expect([...a]).toEqual([...b]);
      const c = grey(8, 8, 120);
      applyDevelopTone(c, { width: 8, height: 8, channels: 3 }, params, look, 8);
      expect([...c]).not.toEqual([...a]);
      const noise = createNoise(3);
      const first = noise();
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(1);
    });
  });

  describe('planDevelopDetail', () => {
    it('skips every stage for the identity recipe', () => {
      expect(planDevelopDetail(effectiveDevelop(defaultDevelopRecipe()).params, { width: 100, height: 100 })).toEqual({
        median: 0,
      });
    });

    it('scales the clarity radius with the frame and ignores negative clarity', () => {
      const params = effectiveDevelop({
        ...defaultDevelopRecipe(),
        clarity: 50,
        noiseReduction: 70,
        sharpen: 50,
      }).params;
      const small = planDevelopDetail(params, { width: 400, height: 300 });
      const large = planDevelopDetail(params, { width: 6000, height: 4000 });
      expect(small.median).toBe(5);
      expect(small.clarity?.sigma).toBe(2);
      expect(large.clarity?.sigma).toBe(24);
      expect(small.sharpen).toEqual({ sigma: 1.4, m1: 0.5, m2: 1.1 });
      const soft = planDevelopDetail(effectiveDevelop({ ...defaultDevelopRecipe(), clarity: -40 }).params, {
        width: 400,
        height: 300,
      });
      expect(soft.clarity).toBeUndefined();
    });
  });
});
