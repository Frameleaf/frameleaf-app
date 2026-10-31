import { initialNativeRecipe, type NativeRecipe } from '$lib/frameleaf/native-develop';
import {
  applyLook,
  aspectCrop,
  contrastSlider,
  contrastValue,
  createMask,
  curveLevels,
  curveValue,
  denoiseSlider,
  denoiseValue,
  histogram,
  isOriginal,
  normalizeCrop,
  originalFraming,
  sameRecipe,
  saturationSlider,
  saturationValue,
  sendable,
  sharpnessSlider,
  sharpnessValue,
  syncSource,
  turn,
  whiteBalanceSliders,
  whiteBalanceValue,
} from '$lib/frameleaf/raw-develop';

vi.mock('@frameleaf/sdk', () => ({ defaults: {}, getBaseUrl: () => '/api' }));

const recipe = (value: Partial<NativeRecipe> = {}): NativeRecipe => ({ ...initialNativeRecipe(), ...value });

describe('raw-develop', () => {
  it("maps the prototype's -100 to 100 sliders to darktable's contrast and saturation, leaving neutral out", () => {
    expect(contrastValue(0)).toBeUndefined();
    expect(contrastValue(25)).toBe(1.25);
    expect(contrastValue(-100)).toBe(0.01);
    expect(contrastSlider(1.25)).toBe(25);
    expect(contrastSlider(undefined)).toBe(0);
    expect(saturationValue(-100)).toBe(0);
    expect(saturationValue(0)).toBeUndefined();
    expect(saturationSlider(1.5)).toBe(50);
  });

  it('moves the camera white balance with Temperature and Tint, and back', () => {
    expect(whiteBalanceValue(0, 0)).toBeUndefined();
    const warm = whiteBalanceValue(50, -20)!;
    expect(warm.red).toBeGreaterThan(1);
    expect(warm.blue).toBeLessThan(1);
    expect(warm.green).toBeGreaterThan(1);
    expect(whiteBalanceSliders(warm)).toEqual({ temperature: 50, tint: -20 });
    expect(whiteBalanceSliders(undefined)).toEqual({ temperature: 0, tint: 0 });
  });

  it('reads any curve as five levels and writes a straight one as no curve', () => {
    expect(curveLevels(undefined)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(
      curveLevels([
        { x: 0, y: 0 },
        { x: 0.5, y: 0.7 },
        { x: 1, y: 1 },
      ]),
    ).toEqual([0, 0.35, 0.7, 0.85, 1]);
    expect(curveValue([0, 0.25, 0.5, 0.75, 1])).toBeUndefined();
    expect(curveValue([0.07, 0.32, 0.54, 0.77, 1])).toEqual([
      { x: 0, y: 0.07 },
      { x: 0.25, y: 0.32 },
      { x: 0.5, y: 0.54 },
      { x: 0.75, y: 0.77 },
      { x: 1, y: 1 },
    ]);
  });

  it('maps Sharpness and Denoise to the native sharpen amount and noise threshold', () => {
    expect(sharpnessValue(0, undefined)).toBeUndefined();
    expect(sharpnessValue(50, undefined)).toEqual({ radius: 2, threshold: 0.5, amount: 1 });
    expect(sharpnessSlider({ radius: 2, threshold: 0.5, amount: 1 })).toBe(50);
    expect(denoiseValue(20)).toBe(0.02);
    expect(denoiseSlider(0.02)).toBe(20);
  });

  it('fits an aspect ratio into the turned frame and keeps a crop inside it', () => {
    expect(aspectCrop('Original', 6000, 4000)).toBeUndefined();
    expect(aspectCrop('1:1', 6000, 4000)).toEqual({ x: 0.1667, y: 0, w: 0.6667, h: 1 });
    expect(aspectCrop('16:9', 4000, 6000)).toMatchObject({ x: 0, w: 1 });
    expect(normalizeCrop({ x: 0.98, y: -1, w: 0.01, h: 2 })).toEqual({ x: 0.95, y: 0, w: 0.05, h: 1 });
    expect(turn(undefined, -90)).toBe(270);
    expect(turn(270, 90)).toBe(0);
  });

  it('never sends an empty brush, the drawing canvas flag or meeting gradient ends', () => {
    const brush = createMask('brush', 'Brush 1');
    const linear = { ...createMask('linear', 'Linear 1'), x: 0.5, y: 0.5, endX: 0.5, endY: 0.5 };
    const sent = sendable(recipe({ sensorCanvas: true, masks: [{ ...brush, enabled: true }, linear] }));
    expect(sent).not.toHaveProperty('sensorCanvas');
    expect(sent.masks?.[0].enabled).toBe(false);
    expect(sent.masks?.[1].endY).not.toBe(0.5);
    expect(brush).toMatchObject({ kind: 'brush', enabled: false, strokes: [] });
  });

  it('compares recipes by what they develop', () => {
    expect(isOriginal(recipe({ contrast: undefined, sensorCanvas: true }))).toBe(true);
    expect(isOriginal(recipe({ exposureEV: 0.5 }))).toBe(false);
    expect(
      sameRecipe(recipe({ crop: { x: 0, y: 0, w: 0.5, h: 1 }, contrast: 1.2 }), {
        contrast: 1.2,
        crop: { h: 1, w: 0.5, y: 0, x: 0 },
        ...initialNativeRecipe(),
      } as NativeRecipe),
    ).toBe(true);
    expect(
      sameRecipe(recipe({ crop: { x: 0, y: 0, w: 0.5, h: 1 } }), recipe({ crop: { x: 0, y: 0, w: 0.6, h: 1 } })),
    ).toBe(false);
    expect(originalFraming(recipe({ exposureEV: 2, rotation: 90, straighten: 3 }))).toEqual(
      recipe({ rotation: 90, straighten: 3 }),
    );
  });

  it('applies a look at its strength over the current settings', () => {
    expect(applyLook(recipe({ saturation: 1.2 }), 'mono', 100).saturation).toBe(0);
    expect(applyLook(recipe(), 'mono', 50).saturation).toBe(0.5);
    const vivid = applyLook(recipe(), 'vivid', 100);
    expect(vivid.contrast).toBe(1.18);
    expect(vivid.saturation).toBe(1.3);
    expect(applyLook(recipe({ exposureEV: 1 }), 'original', 100)).toEqual(recipe({ exposureEV: 1 }));
    expect(applyLook(recipe(), 'warm', 100).whiteBalance?.red).toBeGreaterThan(1);
    expect(applyLook(recipe(), 'fade', 100).curve?.[0].y).toBe(0.1);
  });

  it('keeps brush strokes on their own photo when syncing', () => {
    const source = syncSource(
      recipe({
        masks: [
          { ...createMask('brush', 'Brush'), strokes: [{ points: [[0.5, 0.5]], radius: 0.02, erase: false }] },
          createMask('radial', 'Radial'),
        ],
      }),
    );
    expect(source.masks?.map((mask) => mask.kind)).toEqual(['radial']);
  });

  it('counts channel histograms from RGBA pixels', () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255]);
    const bins = histogram(pixels, 4);
    expect(bins.red).toEqual([1, 0, 0, 1]);
    expect(bins.green).toEqual([2, 0, 0, 0]);
    expect(bins.max).toBe(2);
  });
});
