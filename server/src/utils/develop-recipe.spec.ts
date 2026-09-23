import { type AssetDevelopMask, AssetDevelopMaskKind, AssetDevelopPreset } from 'src/dtos/asset-develop.dto.js';
import {
  DEVELOP_SLIDER_KEYS,
  applyDevelopMasks,
  applyDevelopTone,
  buildToneLuts,
  createNoise,
  defaultDevelopRecipe,
  effectiveDevelop,
  identityMaskMapping,
  isActiveMask,
  isIdentityDevelop,
  maskWeight,
  normalizeCrop,
  normalizeDevelopMasks,
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
  describe('selective masks (FL-64)', () => {
    const mask = (overrides: Partial<AssetDevelopMask> = {}): AssetDevelopMask => ({
      id: 'm1',
      name: null,
      kind: AssetDevelopMaskKind.Radial,
      enabled: true,
      invert: false,
      x: 0.5,
      y: 0.5,
      radiusX: 0.25,
      radiusY: 0.25,
      endX: 0.5,
      endY: 1,
      feather: 0,
      amount: 100,
      adjustments: {
        exposure: 1,
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
      },
      ...overrides,
    });

    it('normalizes stored masks: clamps, fills defaults, drops malformed and duplicate ones, keeps at most eight', () => {
      const masks = normalizeDevelopMasks([
        { id: 'a', kind: AssetDevelopMaskKind.Radial, x: 4, radiusX: 0, adjustments: { exposure: 9 } },
        { id: 'a', kind: AssetDevelopMaskKind.Linear, x: 0, y: 0 },
        { id: '', kind: AssetDevelopMaskKind.Radial },
        { id: 'b', kind: 'brush' },
        null,
        ...Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, kind: AssetDevelopMaskKind.Linear })),
      ]);
      expect(masks).toHaveLength(8);
      expect(masks[0]).toMatchObject({ id: 'a', x: 1, radiusX: 0.01, enabled: true, feather: 50, amount: 100 });
      expect(masks[0].adjustments.exposure).toBe(2);
      expect(masks[0].adjustments.contrast).toBe(0);
      expect(masks.map((item) => item.id)).not.toContain('b');
      expect(normalizeDevelopMasks('nope')).toEqual([]);
      expect(normalizeDevelopRecipe({}).masks).toEqual([]);
    });

    it('weights a radial mask by its feathered ellipse and a linear mask along its gradient', () => {
      const radial = mask({ feather: 50 });
      expect(maskWeight(radial, 0.5, 0.5)).toBe(1);
      expect(maskWeight(radial, 0.5 + 0.25 * 0.4, 0.5)).toBe(1);
      expect(maskWeight(radial, 0.5 + 0.25 * 0.75, 0.5)).toBeGreaterThan(0);
      expect(maskWeight(radial, 0.5 + 0.25 * 0.75, 0.5)).toBeLessThan(1);
      expect(maskWeight(radial, 0.9, 0.9)).toBe(0);
      expect(maskWeight({ ...radial, invert: true }, 0.9, 0.9)).toBe(1);

      const linear = mask({ kind: AssetDevelopMaskKind.Linear, x: 0.5, y: 0, endX: 0.5, endY: 1 });
      expect(maskWeight(linear, 0.2, 0)).toBe(1);
      expect(maskWeight(linear, 0.2, 0.5)).toBeCloseTo(0.5, 5);
      expect(maskWeight(linear, 0.2, 1)).toBe(0);
      expect(maskWeight(linear, 0.2, -0.5)).toBe(1);
    });

    it('treats a disabled, zero-amount or no-op mask as inactive and leaves the pixels alone', () => {
      expect(isActiveMask(mask())).toBe(true);
      expect(isActiveMask(mask({ enabled: false }))).toBe(false);
      expect(isActiveMask(mask({ amount: 0 }))).toBe(false);
      expect(isActiveMask(mask({ adjustments: { ...mask().adjustments, exposure: 0 } }))).toBe(false);
      const pixels = grey(4, 4);
      const before = Uint8Array.from(pixels);
      applyDevelopMasks(pixels, { width: 4, height: 4, channels: 3 }, [mask({ enabled: false })]);
      expect(pixels).toEqual(before);
      expect(isIdentityDevelop({ ...defaultDevelopRecipe(), masks: [mask({ enabled: false })] })).toBe(true);
      expect(isIdentityDevelop({ ...defaultDevelopRecipe(), masks: [mask()] })).toBe(false);
    });

    it('brightens only inside a hard-edged radial mask, scaled by its amount', () => {
      const info = { width: 8, height: 8, channels: 3 } as const;
      const full = grey(8, 8);
      applyDevelopMasks(full, info, [mask()]);
      const centre = (4 * 8 + 4) * 3;
      expect(full[centre]).toBeGreaterThan(128);
      expect(full[0]).toBe(128);

      const half = grey(8, 8);
      applyDevelopMasks(half, info, [mask({ amount: 50 })]);
      expect(half[centre]).toBeGreaterThan(128);
      expect(half[centre]).toBeLessThan(full[centre]);
    });

    it('keeps a mask on the same content through the crop and the straighten', () => {
      // A 100×100 frame cropped to its right half, with a mask over the content at (75, 50).
      // Straightening turns that content about the frame centre and scales it to cover the
      // frame; the mask follows it to wherever it lands in the output.
      const info = { width: 50, height: 100, channels: 3 } as const;
      for (const straighten of [0, 12]) {
        const pixels = grey(50, 100);
        applyDevelopMasks(pixels, info, [mask({ x: 0.75, radiusX: 0.05, radiusY: 0.05 })], {
          oriented: { width: 100, height: 100 },
          extract: { left: 50, top: 0 },
          straighten,
        });
        const theta = (straighten * Math.PI) / 180;
        const scale = straightenScale(100, 100, straighten);
        const landedX = Math.floor(50 + scale * 25 * Math.cos(theta) - 50);
        const landedY = Math.floor(50 + scale * 25 * Math.sin(theta));
        const at = (x: number, y: number) => pixels[(y * 50 + x) * 3];
        expect(at(landedX, landedY)).toBeGreaterThan(128);
        expect(at(2, 50)).toBe(128);
        expect(at(25, 5)).toBe(128);
      }
      expect(identityMaskMapping(10, 20)).toEqual({
        oriented: { width: 10, height: 20 },
        extract: { left: 0, top: 0 },
        straighten: 0,
      });
    });
  });
});
