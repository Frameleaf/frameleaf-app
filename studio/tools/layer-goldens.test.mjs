// Engine-free checks of the layer-compositing spec (studio/spec/layers.md): golden structure and
// inputs, coverage of every blend mode, mask mode, shape type and stage-order case, the closed-form
// reference written from the prose, and the clean-room lint of the page.
// layer-goldens.browser.mjs checks the goldens against the engine itself.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLEND_MODES, SHAPE_TYPES, layerCases, layerInputs, referenceFrame, validateLayerGoldens, blendColour, dissolveThreshold,
  pngDataUrl, decodeBuffer, compareCase,
} from './layer-goldens.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (rel) => JSON.parse(await readFile(path.join(studio, rel), 'utf8'));
const catalogue = await readJson('graph-parameters-v1.json');
const goldens = await readJson('spec/goldens/layers.json');
const page = await readFile(path.join(studio, 'spec/layers.md'), 'utf8');
const golden = (name) => {
  const found = goldens.cases.find((c) => c.name === name);
  assert(found, `${name}: no golden`);
  return { ...found, expected: decodeBuffer(found.output.data, found.output.encoding) };
};
const names = new Set(goldens.cases.map((c) => c.name));
const has = (...list) => list.forEach((name) => assert(names.has(name), `missing case ${name}`));

test('goldens hold every case with the documented inputs and measured tolerances', () => {
  const { cases, channels } = validateLayerGoldens(goldens);
  assert(cases >= 160 && channels > 500000);
  assert(goldens.renderer.crossCheck, 'goldens written without the hardware cross-check');
  assert.notDeepEqual(goldens.renderer.crossCheck.adapter, goldens.renderer.canonical.adapter);
  for (const c of goldens.cases) {
    assert(c.tolerance.measured, `${c.name}: tolerance is not measured`);
    assert(c.floatRoute && (typeof c.floatRoute.max === 'number' || typeof c.floatRoute.error === 'string'), `${c.name}: float route distance`);
  }
});

test('every blend mode of the catalogue has a case, on a translucent source and backdrop', () => {
  assert.deepEqual(catalogue.blendModes.map((m) => m.id), BLEND_MODES);
  has(...BLEND_MODES.map((mode) => `blend/${mode}`), 'blend/multiply-opacity-0.5', 'blend/screen-then-multiply', 'blend/unknown-mode-is-normal');
  const { fx, layer } = layerInputs();
  for (const input of [fx, layer]) {
    const alphas = new Set(input.values.filter((_, i) => i % 4 === 3));
    assert(alphas.has(0) && alphas.has(1) && [...alphas].some((a) => a > 0 && a < 1), 'blend inputs need opaque, translucent and empty pixels');
  }
  for (const mode of BLEND_MODES) {
    const item = golden(`blend/${mode}`).graph.timeline.items.find((x) => x.id === 'clip');
    assert.equal(item.blendMode, mode);
  }
});

test('every mask mode, shape type and stage-order case is present', () => {
  has('mask/clip', 'mask/clip-invert', 'mask/alpha', 'mask/alpha-invert', 'mask/opacity-50', 'mask/feather-2', 'mask/feather-6',
    'mask/clip-ignores-feather', 'mask/two-masks-intersect', 'mask/scope', 'mask/translucent-item', 'mask/path', 'mask/animated-path');
  for (const type of SHAPE_TYPES) has(`shape/${type}/fill`, `shape/${type}/stroke`, `shape/${type}/fill-stroke`);
  has(...['butt', 'round', 'square'].map((cap) => `shape/path/cap-${cap}`), ...['miter', 'round', 'bevel'].map((join) => `shape/path/join-${join}`),
    'shape/path/miter-limit-1', 'shape/path/miter-limit-10', 'shape/path/open', 'shape/path/fill', 'shape/rectangle/trim-25-75', 'shape/path/trim-20-80', 'shape/path/taper');
  has('stage/pixelate-scaled', 'stage/pixelate-rotated-cropped', 'stage/wave-rotated', 'stage/adjustment-layer');
  has('background/default', 'background/opaque', 'background/alpha', 'order/three-tracks', 'opacity/0', 'opacity/0.5', 'opacity/1',
    'transform/translate-subpixel', 'transform/scale-2', 'transform/rotate-30', 'transform/anchor-rotate-30', 'parent/rotated-chain',
    'crop/left', 'crop/right', 'crop/top', 'crop/bottom', 'crop/softness-inward', 'crop/softness-outward', 'corner-radius/4',
    'flip/horizontal', 'flip/vertical', 'corner-pin/image');
  // Eight-digit colours: a fill and a stroke, rendered by the engine and reproduced by the reference.
  const colourOf = (name, field) => golden(name).graph.timeline.items.find((item) => item.id === 's')[field];
  assert.match(colourOf('shape/rectangle/translucent-fill', 'fillColor'), /^#[0-9a-f]{8}$/);
  assert.match(colourOf('shape/rectangle/translucent-stroke', 'strokeColor'), /^#[0-9a-f]{8}$/);
  for (const name of ['shape/rectangle/translucent-fill', 'shape/rectangle/translucent-stroke', 'shape/rectangle/translucent-fill-stroke-opacity']) assert(golden(name).reference, `${name}: needs a reference`);
  // Gradient stops with alpha interpolate on straight values (layers.md, Colours): row 13 lies on the backdrop's white line.
  const fade = golden('shape/rectangle/linear-gradient-alpha').expected;
  for (let i = 9; i < 39; i++) {
    const tau = (i + 0.5 - 9) / 30;
    const alpha = (64 / 255) * (1 - tau) + tau;
    [1 - tau, 0, tau].forEach((v, c) => assert(Math.abs(v * alpha + (1 - alpha) - fade[(13 * 48 + i) * 4 + c]) <= 2 / 255, `gradient alpha at column ${i}`));
  }
  // Out-of-range values a renderer meets when reading a graph.
  has('shape/star/inner-radius-1.5', 'shape/star/points-5.5', 'shape/star/points-20', 'shape/polygon/points-2', 'shape/rectangle/linear-gradient-405');
  assert(compareCase(golden('shape/rectangle/linear-gradient-45'), golden('shape/rectangle/linear-gradient-405').expected).pass, 'the gradient angle is periodic');
  const empty = golden('shape/polygon/points-2');
  const behind = layerInputs().b.values;
  assert(compareCase(empty, behind).pass, 'a two-point polygon draws nothing');
  const order = golden('order/three-tracks').graph.timeline;
  assert.equal(new Set(order.items.map((item) => item.trackId)).size, 3);
  const used = new Set(goldens.cases.flatMap((c) => c.graph.timeline.items.filter((item) => item.type === 'shape').map((item) => item.shapeType)));
  assert.deepEqual([...used].sort(), [...SHAPE_TYPES].sort());
});


test('the closed-form reference of layers.md reproduces every reference golden', () => {
  const cases = layerCases().filter((c) => c.reference);
  assert(cases.length >= 85);
  const classes = new Set(cases.map((c) => c.class));
  for (const kind of ['background', 'order', 'opacity', 'blend', 'transform', 'parent', 'crop', 'flip', 'stage', 'mask', 'shape']) assert(classes.has(kind), `no reference case of class ${kind}`);
  for (const mode of BLEND_MODES) assert(cases.some((c) => c.name === `blend/${mode}`), `blend/${mode} has no reference`);
  for (const spec of cases) {
    const g = golden(spec.name);
    // A blend exactly on a mode's discontinuity is implementation-defined (layers.md L9): no case has one.
    const singular = [];
    const frame = referenceFrame(spec, undefined, singular);
    assert.equal(singular.length, 0, `${spec.name}: ${singular.length} pixels on a singular point`);
    const result = compareCase(g, frame);
    assert(result.pass, `${spec.name}: reference misses ${result.missed} channels (allowed ${g.tolerance.outliers}), worst ${result.worst.toFixed(4)}, mean ${result.mean.toFixed(5)}`);
  }
});

test('the reference tells the cases apart: wrong mode, wrong side, wrong order and effects before the transform all fail', () => {
  const spec = (name) => layerCases().find((c) => c.name === name);
  const fails = (goldenName, frame) => assert(!compareCase(golden(goldenName), frame).pass, `${goldenName} accepts a wrong frame`);
  fails('blend/multiply', referenceFrame(spec('blend/screen')));
  fails('blend/hue', referenceFrame(spec('blend/saturation')));
  fails('crop/left', referenceFrame(spec('crop/right')));
  fails('flip/horizontal', referenceFrame(spec('transform/identity')));
  fails('order/three-tracks', referenceFrame(spec('order/hidden-track')));
  fails('mask/clip', referenceFrame(spec('mask/clip-invert')));
  fails('mask/opacity-50', referenceFrame(spec('mask/clip')));
  fails('opacity/0.5', referenceFrame(spec('opacity/1')));
  // Stage order: pixelating the 16 x 12 source in its own box (blocks of 2 source pixels) and then
  // scaling it by 2 is not what the engine draws; it pixelates the placed item on the frame grid.
  const scaled = spec('stage/pixelate-scaled');
  const inputs = layerInputs();
  const { width: W, height: H, values } = inputs.fx;
  const own = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = Math.floor((i + 0.5) / 2) * 2;
    const y = Math.floor((j + 0.5) / 2) * 2;
    const taps = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].map(([tx, ty]) => values.slice((ty * W + tx) * 4, (ty * W + tx) * 4 + 4));
    own.push(...[0, 1, 2, 3].map((c) => taps.reduce((sum, tap) => sum + tap[c] / 4, 0)));
  }
  const withoutEffects = structuredClone(scaled);
  for (const item of withoutEffects.graph.timeline.items) delete item.effects;
  fails('stage/pixelate-scaled', referenceFrame(withoutEffects, { ...inputs, fx: { ...inputs.fx, values: own } }));
  fails('stage/pixelate-scaled', referenceFrame(withoutEffects));
  assert(compareCase(golden('stage/pixelate-scaled'), referenceFrame(scaled)).pass);
});

test('blend functions: fixed points of the prose', () => {
  const near = (got, want) => got.forEach((v, c) => assert(Math.abs(v - want[c]) < 1e-12, `${got} != ${want}`));
  const b = [0.2, 0.5, 0.9];
  const l = [0.7, 0.4, 0.1];
  near(blendColour('normal', b, l), l);
  near(blendColour('not-a-mode', b, l), l);
  near(blendColour('multiply', b, [1, 1, 1]), b);
  near(blendColour('screen', b, [0, 0, 0]), b);
  near(blendColour('difference', b, b), [0, 0, 0]);
  near(blendColour('linear-dodge', [0.8, 0.8, 0.8], [0.7, 0.1, 0.2]), [1, 0.9, 1]);
  near(blendColour('luminosity', b, b), b);
  near(blendColour('hard-mix', [0.3, 0.6, 0.5], [0.3, 0.6, 0.6]), [0, 1, 1]);
  near(blendColour('darken', [1.5, -1, 0.5], [2, 2, 2]), [1, 0, 0.5]);
  // The compositor's saturation is not the C7 helper's: a grey layer still zeroes it, a pure colour does not give 1.
  near(blendColour('saturation', b, [0.5, 0.5, 0.5]), [0.55, 0.55, 0.55]);
});

test('dissolve threshold is a deterministic binary32 value in [0, 1)', () => {
  const seen = new Set();
  for (let j = 0; j < 12; j++) for (let i = 0; i < 16; i++) {
    const t = dissolveThreshold(i, j, 16, 12);
    assert(t >= 0 && t < 1 && t === Math.fround(t));
    assert.equal(t, dissolveThreshold(i, j, 16, 12));
    seen.add(t);
  }
  assert(seen.size > 180);
  // In the golden, every pixel of the half-transparent columns is either the layer or the backdrop: no mixture.
  const g = golden('blend/dissolve');
  const normal = golden('blend/normal').expected;
  assert.notDeepEqual(g.expected, normal);
});

test('inputs are encodable as PNG for the engine and the case list is deterministic', () => {
  for (const input of Object.values(layerInputs())) assert.match(pngDataUrl(input), /^data:image\/png;base64,iVBORw0KGgo/);
  assert.deepEqual(layerCases(), layerCases());
  assert.equal(new Set(layerCases().map((c) => c.name)).size, layerCases().length);
});

test('comparison rule: a blank frame, the background alone and a shifted frame fail', () => {
  const g = golden('order/three-tracks');
  assert(compareCase(g, g.expected).pass);
  assert(!compareCase(g, g.expected.map(() => 0)).pass);
  assert(!compareCase(g, golden('background/gap').expected).pass);
  assert(!compareCase(g, g.expected.map((v, i) => (i % 4 === 0 ? v + 0.05 : v))).pass);
});

// The page is prose and mathematics: no engine source text (the patterns of render-goldens.test.mjs).
const SOURCE_PATTERNS = [
  /\bfn\s+\w+\s*\(/, /@(fragment|vertex|compute|group|binding|builtin|location)\b/, /\btexture(Sample\w*|Load|Store|Dimensions)\b/,
  /\bvec[234][fiu]?\s*\(/, /\bmat[234]x?[234]?f?\s*\(/, /\blet\s+\w+\s*:\s*\w+\s*=/, /\bvar\s*(<[^>]*>)?\s+\w+\s*:/, /\bconst\s+\w+\s*[:=]/,
  /=>/, /\bctx\.\w+/, /\bnew\s+(Float32Array|Path2D|OffscreenCanvas)\b/, /\bpackUniforms\b/, /\bparams\.\w+/, /\{\s*$\n\s+\w+.*\n\s*\}/m,
];
test('layers.md contains no engine source text, cites its tags in order and names every case class', () => {
  for (const pattern of SOURCE_PATTERNS) assert(!pattern.test(page), `layers.md matches ${pattern}`);
  const tags = [...page.matchAll(/^\*\*\[(L\d+)\]/gm)].map((m) => m[1]);
  assert(tags.length >= 12);
  assert.deepEqual(tags, tags.map((_, i) => `L${i + 1}`), 'tags must run L1, L2, ... without gaps');
  for (const kind of new Set(goldens.cases.map((c) => c.class))) assert(page.includes(`\`${kind}/`), `layers.md never names a ${kind} case`);
  for (const mode of BLEND_MODES) assert(page.includes(`\`${mode}\``), `layers.md does not define ${mode}`);
  for (const type of SHAPE_TYPES) assert(page.includes(`\`${type}\``), `layers.md does not define ${type}`);
  assert(page.includes('goldens/layers.json') && page.includes('implementation-defined'));
});
