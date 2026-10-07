import { BadRequestException } from '@nestjs/common';
import {
  assertRenderableDevelopRecipe,
  developEnvelope,
  preserveDevelopEnvelope,
  renderDevelopProjection,
  renderHdrDevelopProjection,
} from 'src/utils/develop-envelope.js';
import {
  applyDevelopMasks,
  applyDevelopTone,
  defaultDevelopRecipe,
  effectiveDevelop,
  normalizeDevelopRecipe,
} from 'src/utils/develop-recipe.js';

describe('develop recipe envelope', () => {
  it('routes explicit native recipes while retaining unknown content without silently rendering it', () => {
    const recipe = { version: 2, renderer: 'darktable/5.6.1', exposureEV: 1 };
    expect(assertRenderableDevelopRecipe(recipe)).toEqual(recipe);
    const extended = { ...recipe, masks: [{ kind: 'depth' }] };
    expect(developEnvelope(extended)).toEqual(extended);
    expect(() => assertRenderableDevelopRecipe(extended)).toThrow(BadRequestException);
    expect(assertRenderableDevelopRecipe({ version: 1 })).toEqual(defaultDevelopRecipe());
  });
  it('keeps arbitrary future shapes verbatim, including future meanings of current field names', () => {
    const value = { version: 2, crop: { mesh: [1, 2] }, masks: { future: true }, contrast: { curve: [0, 1] } };
    expect(developEnvelope(value)).toEqual(value);
    expect(() => renderDevelopProjection(value)).toThrow(BadRequestException);
  });
  it('keeps the existing known version1 render projection byte-identical', () => {
    for (const recipe of [
      { version: 1 as const },
      defaultDevelopRecipe(),
      { version: 1 as const, contrast: 30, rotation: 90 },
    ]) {
      expect(renderDevelopProjection(recipe)).toEqual(normalizeDevelopRecipe(recipe));
    }
  });
  it('keeps supported version1 zero-operation pixel bytes identical to the previous normalizer', () => {
    const input = Uint8Array.from({ length: 48 }, (_, index) => (index * 37) % 256);
    const output = (recipe: ReturnType<typeof normalizeDevelopRecipe>) => {
      const { params, look } = effectiveDevelop(recipe);
      const pixels = applyDevelopTone(new Uint8Array(input), { width: 4, height: 4, channels: 3 }, params, look);
      return applyDevelopMasks(pixels, { width: 4, height: 4, channels: 3 }, recipe.masks);
    };
    expect(output(renderDevelopProjection({ version: 1 }))).toEqual(output(normalizeDevelopRecipe({ version: 1 })));
    expect(output(renderDevelopProjection({ version: 1 }))).toEqual(input);
  });

  it.each([
    { future: 'new operation' },
    { crop: { x: 0, y: 0, w: 1, h: 1, future: true } },
    { masks: [{ id: 'a', kind: 'radial', x: 0.5, y: 0.5, adjustments: { future: 12 } }] },
    { masks: [{ id: 'a', kind: 'depth', bitmap: 'opaque' }] },
    { cleanUp: [] },
    { masks: [{ id: 'a', kind: 'radial', x: 0.5, y: 0.5, maskWeight: 'future' }] },
  ])('retains but never renders unknown semantics %j', (extension) => {
    const value = { version: 1, ...extension };
    expect(developEnvelope(value)).toEqual(value);
    expect(() => renderDevelopProjection(value)).toThrow(BadRequestException);
  });
  it('preserves omitted nested fields by stable mask ID without importing removed/reordered masks', () => {
    const source = {
      version: 1,
      future: { jobs: [1] },
      crop: { x: 0, y: 0, w: 1, h: 1, future: true },
      masks: [
        { id: 'a', kind: 'radial', x: 0.5, y: 0.5, future: { bitmap: 'opaque' }, adjustments: { future: 5 } },
        { id: 'b', kind: 'radial', x: 0.5, y: 0.5 },
      ],
    };
    const incoming = {
      version: 1,
      contrast: 20,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      masks: [{ id: 'a', kind: 'radial', x: 0.5, y: 0.5, adjustments: { exposure: 1 } }],
    };
    const merged = preserveDevelopEnvelope(developEnvelope(source), developEnvelope(incoming));
    expect(merged).toMatchObject({
      future: { jobs: [1] },
      crop: { future: true },
      masks: [{ id: 'a', future: { bitmap: 'opaque' }, adjustments: { future: 5, exposure: 1 } }],
    });
    expect(merged.masks as unknown[]).toHaveLength(1);
    expect(source.masks).toHaveLength(2);
    expect(() => preserveDevelopEnvelope(developEnvelope(source), { version: 2 })).toThrow(BadRequestException);
  });
  it.each([
    JSON.parse('{"version":1,"future":{"__proto__":{}}}'),
    { version: 1, future: { constructor: 'unsafe' } },
    { version: 1, future: Array.from({ length: 4097 }, () => 0) },
    { version: 1, future: 'a'.repeat(65_536) },
    { version: 1, future: NaN },
    { version: 1, future: new Date() },
    { version: 1, future: undefined },
    { version: 1, future: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [i, 0])) },
  ])('rejects unsafe or over-budget JSON %j', (value) =>
    expect(() => developEnvelope(value)).toThrow(BadRequestException),
  );
  it('bounds the number of values and the size of the JSON (FL-233)', () => {
    // over the value budget
    expect(() =>
      developEnvelope({ version: 1, future: Array.from({ length: 9 }, () => Array.from({ length: 4096 }, () => 0)) }),
    ).toThrow(BadRequestException);
    // within the value budget, over 512 KiB of JSON
    expect(() =>
      developEnvelope({
        version: 1,
        future: Array.from({ length: 8 }, () => Array.from({ length: 4000 }, () => 0.1234567890123456)),
      }),
    ).toThrow(BadRequestException);
    // within both
    expect(() =>
      developEnvelope({ version: 1, future: Array.from({ length: 7 }, () => Array.from({ length: 4000 }, () => 0.5)) }),
    ).not.toThrow();
  });
  it('bounds recursive depth and handles cycles without overflow', () => {
    let item: unknown = null;
    for (let i = 0; i < 17; i++) item = { nested: item };
    expect(() => developEnvelope({ version: 1, future: item })).toThrow(BadRequestException);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => developEnvelope({ version: 1, future: cycle })).toThrow(BadRequestException);
  });
});

it('preserves omitted unsupported masks but removes omitted known masks and merges by canonical stable ID', () => {
  const source = developEnvelope({
    version: 1,
    masks: [
      { id: ' a ', kind: 'radial', x: 0.5, y: 0.5, future: 'opaque' },
      { id: 'b', kind: 'radial', x: 0.5, y: 0.5 },
      { id: 'subject', kind: 'depth', bitmap: 'opaque' },
    ],
  });
  const result = preserveDevelopEnvelope(
    source,
    developEnvelope({ version: 1, masks: [{ id: 'a', kind: 'radial', x: 0.5, y: 0.5 }] }),
  );
  expect(result.masks).toEqual([
    { id: 'a', kind: 'radial', x: 0.5, y: 0.5, future: 'opaque' },
    { id: 'subject', kind: 'depth', bitmap: 'opaque' },
  ]);
  expect(() =>
    preserveDevelopEnvelope(
      developEnvelope({ version: 1, masks: [{ kind: 'depth' }] }),
      developEnvelope({ version: 1, masks: [] }),
    ),
  ).toThrow(BadRequestException);
});

it('keeps Brilliance, brush strokes and Clean Up through a save from a client that does not know them (FL-233)', () => {
  const source = developEnvelope({
    version: 1,
    exposure: 0.5,
    brilliance: 35,
    masks: [
      {
        id: 'b',
        kind: 'brush',
        x: 0.5,
        y: 0.5,
        strokes: [{ points: [[0.2, 0.2]], radius: 0.05 }],
        adjustments: { exposure: 1 },
      },
    ],
    cleanup: [{ id: 'p', method: 'pixelate', region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }],
  });
  // an older client names the source and sends only what it knows: the exposure, and the mask by id
  const older = developEnvelope({
    version: 1,
    exposure: 1,
    masks: [{ id: 'b', kind: 'brush', x: 0.5, y: 0.5, amount: 50 }],
  });
  const saved = preserveDevelopEnvelope(source, older);
  expect(saved).toMatchObject({
    exposure: 1,
    brilliance: 35,
    masks: [{ id: 'b', amount: 50, strokes: [{ points: [[0.2, 0.2]], radius: 0.05 }] }],
    cleanup: [{ id: 'p', method: 'pixelate' }],
  });
  // and the renderer v3 projection renders all of it
  expect(renderDevelopProjection(saved)).toMatchObject({ brilliance: 35, cleanup: [{ id: 'p' }] });
});

it('defaults the HDR preservation policy without reinterpreting historical recipes', () => {
  expect(renderHdrDevelopProjection({ version: 3, exposure: 1 })).toMatchObject({
    version: 3,
    renderer: 'frameleaf-develop-hdr/1',
    exposure: 1,
    hdr: { version: 1, intent: 'preserve', referenceWhite: 203, sdrToneMapper: 'libultrahdr/2.0.2' },
  });
  expect(() => renderHdrDevelopProjection({ version: 1 })).toThrow(BadRequestException);
  expect(() => renderDevelopProjection({ version: 3 })).toThrow(BadRequestException);
});

it.each([
  { hdr: { intent: 'flatten' } },
  { hdr: { future: true } },
  { renderer: 'frameleaf-develop-hdr/2' },
  { crop: { x: 0, y: 0, w: 1, h: 1, future: true } },
  { masks: [{ id: 'a', kind: 'radial', adjustments: { future: 1 } }] },
  { future: 'operation' },
])('keeps but refuses unsupported HDR semantics %j', (extension) => {
  const value = { version: 3, ...extension };
  expect(developEnvelope(value)).toEqual(value);
  expect(() => renderHdrDevelopProjection(value)).toThrow(BadRequestException);
});

it('prevents older clients from replacing fields through a different recipe version', () => {
  expect(() => preserveDevelopEnvelope(developEnvelope({ version: 3 }), developEnvelope({ version: 1 }))).toThrow(
    'same contract version',
  );
});

it('pins version 4 to the corrected codec policy and preserves the version 3 identity', () => {
  expect(renderHdrDevelopProjection({ version: 4, exposure: 1 })).toMatchObject({
    version: 4,
    renderer: 'frameleaf-develop-hdr/2',
    exposure: 1,
    hdr: { version: 2, sdrToneMapper: 'libultrahdr/2.0.2-frameleaf.2' },
  });
  expect(() => renderHdrDevelopProjection({ version: 4, renderer: 'frameleaf-develop-hdr/1' })).toThrow();
  expect(() => renderHdrDevelopProjection({ version: 3, renderer: 'frameleaf-develop-hdr/2' })).toThrow();
  expect(() => preserveDevelopEnvelope(developEnvelope({ version: 4 }), developEnvelope({ version: 3 }))).toThrow();
});
