import { applyHdrDevelopMasks, applyHdrDevelopTone, transformHdrGeometry } from 'src/queue/image-hdr-develop.js';
import { defaultDevelopRecipe, normalizeDevelopMasks, planDevelopGeometry } from 'src/utils/develop-recipe.js';

it('turns, mirrors and crops floating HDR without clipping or changing source pixels', () => {
  const pixels = new Float32Array([2.125, 3, 4, 1, 8.25, 9, 10, 1]);
  const image = {
    data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    width: 2,
    height: 1,
    gamut: 1 as const,
    referenceWhite: 203 as const,
  };
  const original = Buffer.from(image.data);
  const recipe = { ...defaultDevelopRecipe(), rotation: 90, flipVertical: true };
  const result = transformHdrGeometry(image, planDevelopGeometry(recipe, 2, 1), 1024);
  expect([result.width, result.height]).toEqual([1, 2]);
  expect([...new Float32Array(result.data.buffer, result.data.byteOffset, 8)]).toEqual([
    8.25, 9, 10, 1, 2.125, 3, 4, 1,
  ]);
  expect(image.data).toEqual(original);
});

it('filters geometry with premultiplied alpha and admits all float surfaces together', () => {
  const pixels = new Float32Array([32, 32, 32, 0, 4, 4, 4, 1, 4, 4, 4, 1, 4, 4, 4, 1]);
  const image = {
    data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    width: 2,
    height: 2,
    gamut: 0 as const,
    referenceWhite: 203 as const,
  };
  const plan = planDevelopGeometry({ ...defaultDevelopRecipe(), straighten: 12 }, 2, 2);
  expect(() => transformHdrGeometry(image, plan, image.data.length)).toThrow('budget');
  const result = transformHdrGeometry(image, plan, 1024);
  const output = new Float32Array(result.data.buffer, result.data.byteOffset, result.data.length / 4);
  for (let i = 0; i < output.length; i += 4) {
    if (output[i + 3] > 0) expect(output[i]).toBeCloseTo(4, 5);
    expect(output[i + 3]).toBeGreaterThanOrEqual(0);
    expect(output[i + 3]).toBeLessThanOrEqual(1);
  }
});

it('keeps neutral HDR pixels and alpha exact, and applies exposure in linear EV', () => {
  const pixels = new Float32Array([0.03125, 1.125, 8.25, 0.75]);
  const image = {
    data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    width: 1,
    height: 1,
    gamut: 1 as const,
    referenceWhite: 203 as const,
  };
  applyHdrDevelopTone(image, defaultDevelopRecipe());
  expect([...pixels]).toEqual([0.03125, 1.125, 8.25, 0.75]);
  applyHdrDevelopTone(image, { ...defaultDevelopRecipe(), exposure: 2 });
  expect([...pixels]).toEqual([0.125, 4.5, 33, 0.75]);
});

it('changes highlights and colour without clipping HDR to SDR or quantizing fractional light', () => {
  const pixels = new Float32Array([2.125, 4.25, 8.5, 1]);
  const image = {
    data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    width: 1,
    height: 1,
    gamut: 2 as const,
    referenceWhite: 203 as const,
  };
  applyHdrDevelopTone(image, { ...defaultDevelopRecipe(), highlights: -50, saturation: -100 });
  expect(pixels[0]).toBeGreaterThan(1);
  expect(pixels[0]).toBeLessThan(8.5);
  expect(pixels[0]).toBeCloseTo(pixels[1], 6);
  expect(pixels[1]).toBeCloseTo(pixels[2], 6);
  expect(pixels[3]).toBe(1);
});

it('keeps a selective HDR adjustment in its oriented frame and counts its scratch surfaces', () => {
  const pixels = new Float32Array([4, 4, 4, 1, 8, 8, 8, 1]);
  const image = {
    data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    width: 2,
    height: 1,
    gamut: 0 as const,
    referenceWhite: 203 as const,
  };
  const masks = normalizeDevelopMasks([
    {
      id: 'spot',
      kind: 'radial',
      x: 0.25,
      y: 0.5,
      radiusX: 0.2,
      radiusY: 0.5,
      feather: 0,
      adjustments: { exposure: 1 },
    },
  ]);
  const plan = planDevelopGeometry(defaultDevelopRecipe(), 2, 1);
  expect(() => applyHdrDevelopMasks(image, masks, plan, 32)).toThrow('budget');
  applyHdrDevelopMasks(image, masks, plan, 1024);
  expect([...pixels]).toEqual([8, 8, 8, 1, 8, 8, 8, 1]);
});

it('reserves refinement and stroke temporaries before admitting bitmap masks', () => {
  const pixels = new Float32Array([4, 4, 4, 1]);
  const image = {
    data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    width: 1,
    height: 1,
    gamut: 0 as const,
    referenceWhite: 203 as const,
  };
  const artifact = 'a'.repeat(64);
  const masks = normalizeDevelopMasks([
    {
      id: 'subject',
      kind: 'subject',
      artifact,
      strokes: [{ points: [[0.5, 0.5]], radius: 0.1, erase: false }],
      adjustments: { exposure: 1 },
    },
  ]);
  masks[0].strokes = [{ points: [[0.5, 0.5]], radius: 0.1, erase: false }];
  const bitmaps = new Map([[artifact, { data: new Uint8Array([255]), width: 1, height: 1, channels: 1 as const }]]);
  const plan = planDevelopGeometry(defaultDevelopRecipe(), 1, 1);
  expect(() => applyHdrDevelopMasks(image, masks, plan, 37, bitmaps)).toThrow('budget');
  applyHdrDevelopMasks(image, masks, plan, 45, bitmaps);
  expect([...pixels]).toEqual([8, 8, 8, 1]);
});

it('maps a selective adjustment to the same source after cropping', () => {
  const pixels = new Float32Array([2, 2, 2, 1, 4, 4, 4, 1, 6, 6, 6, 1, 8, 8, 8, 1]);
  const source = {
    data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    width: 4,
    height: 1,
    gamut: 0 as const,
    referenceWhite: 203 as const,
  };
  const plan = planDevelopGeometry({ ...defaultDevelopRecipe(), crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }, 4, 1);
  const image = transformHdrGeometry(source, plan, 1024);
  const masks = normalizeDevelopMasks([
    {
      id: 'crop',
      kind: 'radial',
      x: 0.625,
      y: 0.5,
      radiusX: 0.1,
      radiusY: 0.5,
      feather: 0,
      adjustments: { exposure: 1 },
    },
  ]);
  applyHdrDevelopMasks(image, masks, plan, 1024);
  expect([...new Float32Array(image.data.buffer, image.data.byteOffset, 8)]).toEqual([12, 12, 12, 1, 8, 8, 8, 1]);
  expect([...pixels]).toEqual([2, 2, 2, 1, 4, 4, 4, 1, 6, 6, 6, 1, 8, 8, 8, 1]);
});
