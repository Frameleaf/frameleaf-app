// Engine-free checks of the render spec (studio/spec): coverage of the parameter catalogue,
// golden structure and inputs, the progress curve re-derived from the prose, the comparison
// rule, and a clean-room lint of the spec text. render-goldens.browser.mjs checks the goldens
// against the engine itself.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asciiAtlasSpec, ASCII_ATLASES_FORMAT, decodeAsciiAtlas, renderAsciiReference, settleAsciiGuard } from './ascii-reference.mjs';
import {
  CLIP_TRANSITIONS, CURVED_CLIPS, STROKE_TRANSITIONS, renderClipTransition, renderStrokeTransition, outgoingCoverage,
} from './clip-reference.mjs';
import {
  validateGoldens, compareCase, decodeBuffer, effectCases, transitionCases, GPU_TRANSITIONS, LINEAR_HDR_EFFECTS,
  toHalfBits, fromHalfBits, encodeBuffer, buildIndex, renderIndexMarkdown, replaceIndexMarkdown,
  effectSdrInput, transitionInputs, EFFECT_SIZE, TRANSITION_SIZE, EFFECT_EXTRA_CASES, TRANSITION_EXTRA_CASES,
} from './render-goldens.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (rel) => JSON.parse(await readFile(path.join(studio, rel), 'utf8'));
const catalogue = await readJson('graph-parameters-v1.json');
const effects = await readJson('spec/goldens/effects.json');
const transitions = await readJson('spec/goldens/transitions.json');
const index = await readJson('spec/index.json');

test('goldens cover every catalogue case with the documented inputs', () => {
  assert.equal(catalogue.effects.length, 54);
  assert.equal(catalogue.transitions.length, 44);
  const e = validateGoldens('effects', effects, catalogue);
  const t = validateGoldens('transitions', transitions, catalogue);
  assert(e.cases > 400 && t.cases > 300, 'golden case lists unexpectedly short');
  assert.deepEqual(new Set(effects.cases.map((c) => c.id)), new Set(catalogue.effects.map((x) => x.id)));
  assert.deepEqual(new Set(transitions.cases.map((c) => c.id)), new Set(catalogue.transitions.map((x) => x.id)));
});

test('HDR goldens: the linear effects render, every other effect is refused', () => {
  for (const c of effects.cases.filter((x) => x.domain === 'hdr')) {
    assert.equal(c.outcome, LINEAR_HDR_EFFECTS.includes(c.id) ? 'rendered' : 'refused', c.name);
  }
  assert.equal(effects.cases.filter((c) => c.domain === 'hdr' && c.outcome === 'rendered').length > 0, true);
});

test('the GPU and Canvas 2D transition routes match the index and the catalogue', () => {
  for (const t of catalogue.transitions) {
    const entry = index.transitions.find((x) => x.id === t.id);
    assert(entry, `${t.id}: missing from spec/index.json`);
    assert.equal(entry.route, GPU_TRANSITIONS.includes(t.id) ? 'gpu' : 'canvas', t.id);
  }
});

// Section T1 of studio/spec/README.md, implemented from the prose alone.
function progressFromProse(localFrame, duration, timing, bezier) {
  const t = Math.max(0, Math.min(1, localFrame / Math.max(1, duration - 1)));
  if (timing === 'ease-in') return t * t;
  if (timing === 'ease-out') return t * (2 - t);
  if (timing === 'ease-in-out') return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  if (timing !== 'cubic-bezier' || !bezier) return t;
  if (t === 0) return 0;
  if (t === 1) return 1;
  const cx = 3 * bezier.x1;
  const bx = 3 * (bezier.x2 - bezier.x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * bezier.y1;
  const by = 3 * (bezier.y2 - bezier.y1) - cy;
  const ay = 1 - cy - by;
  let s = t;
  for (let i = 0; i < 8; i++) {
    const x = ((ax * s + bx) * s + cx) * s - t;
    if (Math.abs(x) < 1e-6) break;
    const slope = (3 * ax * s + 2 * bx) * s + cx;
    if (Math.abs(slope) < 1e-6) break;
    s = Math.max(0, Math.min(1, s - x / slope));
  }
  return ((ay * s + by) * s + cy) * s;
}

test('the progress curve of T1 reproduces every engine value bit for bit', () => {
  assert(transitions.progressCurve.length >= 100);
  for (const c of transitions.progressCurve) {
    assert.equal(progressFromProse(c.localFrame, c.duration, c.timing, c.bezierPoints), c.progress, JSON.stringify(c));
  }
});

test('every catalogue id has a spec page and an index entry, and the index counts match the goldens', async () => {
  for (const [kind, list, goldens] of [['effects', catalogue.effects, effects], ['transitions', catalogue.transitions, transitions]]) {
    const files = new Set(await readdir(path.join(studio, 'spec', kind)));
    assert.deepEqual(index[kind].map((x) => x.id), list.map((x) => x.id), `${kind}: index order must follow the catalogue`);
    for (const entry of index[kind]) {
      assert(files.has(`${entry.id}.md`), `${kind}/${entry.id}.md missing`);
      assert.equal(entry.spec, `${kind}/${entry.id}.md`);
      assert(['full', 'partial'].includes(entry.status), `${entry.id}: status`);
      if (entry.status === 'partial') assert(entry.notSpecifiable?.length > 0, `${entry.id}: partial without a reason`);
      const cases = goldens.cases.filter((c) => c.id === entry.id);
      assert.deepEqual(entry.goldens, {
        cases: cases.length,
        pixel: cases.filter((c) => c.tolerance?.class === 'pixel').length,
        edge: cases.filter((c) => c.tolerance?.class === 'edge').length,
        statistical: cases.filter((c) => c.tolerance?.class === 'statistical').length,
        refused: cases.filter((c) => c.outcome === 'refused').length,
      }, `${entry.id}: golden counts`);
    }
    for (const file of files) if (file !== 'README.md') assert(index[kind].some((x) => `${x.id}.md` === file), `${kind}/${file} is not in the index`);
  }
});

// The spec is prose and mathematics: no engine source text.
const SOURCE_PATTERNS = [
  /\bfn\s+\w+\s*\(/, /@(fragment|vertex|compute|group|binding|builtin|location)\b/, /\btexture(Sample\w*|Load|Store|Dimensions)\b/,
  /\bvec[234][fiu]?\s*\(/, /\bmat[234]x?[234]?f?\s*\(/, /\blet\s+\w+\s*:\s*\w+\s*=/, /\bvar\s*(<[^>]*>)?\s+\w+\s*:/, /\bconst\s+\w+\s*[:=]/,
  /=>/, /\bctx\.\w+/, /\bnew\s+(Float32Array|Path2D|OffscreenCanvas)\b/, /\bpackUniforms\b/, /\bparams\.\w+/, /\{\s*$\n\s+\w+.*\n\s*\}/m,
];
test('index.json and the README index are current', async () => {
  const rebuilt = buildIndex(catalogue, effects, transitions, index);
  assert.deepEqual(index, rebuilt, 'spec/index.json is stale: run render-goldens.browser.mjs --write');
  const readme = await readFile(path.join(studio, 'spec/README.md'), 'utf8');
  assert.equal(readme, replaceIndexMarkdown(readme, renderIndexMarkdown(index, transitions.progressCurve.length)), 'spec/README.md index is stale');
});

test('spec pages contain no engine source text', async () => {
  let pages = 0;
  for (const kind of ['effects', 'transitions']) {
    for (const file of await readdir(path.join(studio, 'spec', kind))) {
      const text = await readFile(path.join(studio, 'spec', kind, file), 'utf8');
      for (const pattern of SOURCE_PATTERNS) assert(!pattern.test(text), `${kind}/${file} matches ${pattern}`);
      pages++;
    }
  }
  assert.equal(pages, 98);
});

test('comparison rule: identity, NaN, wrong size and gross error fail; the golden passes', () => {
  const golden = effects.cases.find((c) => c.name === 'gpu-sepia/sdr/default');
  const expected = decodeBuffer(golden.output.data, golden.output.encoding);
  const subject = { ...golden, expected };
  assert(compareCase(subject, expected).pass);
  const input = decodeBuffer(effects.inputs.sdr.data, effects.inputs.sdr.encoding);
  assert(!compareCase(subject, input).pass, 'identity must fail');
  assert.throws(() => compareCase(subject, expected.map((v, i) => (i === 5 ? NaN : v))), /not finite/);
  assert(!compareCase(subject, expected.slice(0, -4)).pass, 'short buffer must fail');
  assert(!compareCase(subject, expected.map((v, i) => (i % 4 === 0 ? v + 0.05 : v))).pass, 'shifted red must fail');
  // A statistical case still rejects a blank frame through its mean bound.
  const noisy = effects.cases.find((c) => c.tolerance?.class === 'statistical');
  const noisyExpected = decodeBuffer(noisy.output.data, noisy.output.encoding);
  assert(!compareCase({ ...noisy, expected: noisyExpected }, noisyExpected.map(() => 0)).pass, 'blank frame must fail');
});

test('buffer encodings round-trip and binary16 conversion rounds to nearest even', () => {
  for (const v of [0, -0, 1, -2, 65504, 0.1, 1e-5, 6e-8, 2.98e-8, 0.333, 65520]) {
    const h = fromHalfBits(toHalfBits(v));
    if (v === 65520) assert.equal(h, Infinity);
    else assert(Math.abs(h - v) <= Math.max(2 ** -25, Math.abs(v) * 2 ** -11), `${v} -> ${h}`);
  }
  const values = [0, 0.25, 1, -0.5, 4, 0.1];
  assert.deepEqual(decodeBuffer(encodeBuffer(values, 'f16le-deflate-base64'), 'f16le-deflate-base64'), values.map((v) => fromHalfBits(toHalfBits(v))));
  assert.deepEqual(decodeBuffer(encodeBuffer([0, 0.5, 1], 'rgba8-deflate-base64'), 'rgba8-deflate-base64'), [0, 128 / 255, 1]);
});

test('case lists are deterministic', () => {
  assert.deepEqual(effectCases(catalogue), effectCases(catalogue));
  assert.deepEqual(transitionCases(catalogue), transitionCases(catalogue));
});

test('ASCII coverage keeps 23 platform-atlas cases, five shape goldens and the HDR refusal', () => {
  const cases = effectCases(catalogue).filter((c) => c.id === 'gpu-ascii');
  const atlas = cases.filter((c) => c.domain === 'sdr' && asciiAtlasSpec(c.params));
  assert.equal(atlas.length, 23);
  assert.equal(cases.filter((c) => c.domain === 'sdr' && !asciiAtlasSpec(c.params)).length, 5);
  assert.equal(cases.filter((c) => c.refused).length, 1);
  const custom = atlas.filter((c) => c.name === 'gpu-ascii/sdr/charSet=custom');
  assert.equal(custom.length, 2);
  assert.notEqual(asciiAtlasSpec(custom[0].params).key, asciiAtlasSpec(custom[1].params).key);
});

// ---- README T6, from the prose alone (clip-reference.mjs) ----
const { width: TW, height: TH } = TRANSITION_SIZE;
const eightBit = (values) => values.map((v) => Math.round(v * 255) / 255);
const clipInputs = { a: eightBit(transitionInputs().a), b: eightBit(transitionInputs().b) };
// A pixel differs when any channel is more than the SDR floor of 2/255 from the golden (the
// canvas rounds premultiplied 8-bit values, so a translucent blend can sit two steps away).
const differingPixels = (expected, actual) => {
  let count = 0;
  for (let k = 0; k < expected.length; k += 4) {
    if ([0, 1, 2, 3].some((ch) => Math.abs(expected[k + ch] - actual[k + ch]) > 2.01 / 255)) count++;
  }
  return count;
};

test('T6: the fixed-point scan conversion reproduces every straight-edged clip golden exactly', () => {
  const cases = transitions.cases.filter((c) => CLIP_TRANSITIONS.includes(c.id) && !CURVED_CLIPS.includes(c.id));
  assert.equal(new Set(cases.map((c) => c.id)).size, 18);
  assert(cases.length >= 100, 'straight-edged clip cases unexpectedly few');
  for (const c of cases) {
    const expected = decodeBuffer(c.output.data, c.output.encoding);
    const actual = renderClipTransition(c, clipInputs.a, clipInputs.b, TW, TH);
    // The centre row of radialWipe at p = 0.25 is implementation-defined (README T6): 24 pixels.
    const allowed = c.name === 'radialWipe/p=0.25' ? 24 : 0;
    assert.equal(differingPixels(expected, actual), allowed, `${c.name}: pixels that differ from the engine`);
    assert(compareCase({ ...c, expected }, actual).pass, `${c.name}: outside tolerance`);
  }
});

test('T6: the centre row of radialWipe follows the native rule except where the goldens record the engine', () => {
  for (const p of [0.25, 0.5, 0.75]) {
    const keep = outgoingCoverage('radialWipe', p, TW, TH);
    const row = Array.from({ length: TW }, (_, i) => keep[13 * TW + i]);
    assert.deepEqual(row, Array.from({ length: TW }, (_, i) => (i >= TW / 2 ? 1 : 0)), `p=${p}: right of the centre A, left of it B`);
  }
  const golden = transitions.cases.find((c) => c.name === 'radialWipe/p=0.25');
  const expected = decodeBuffer(golden.output.data, golden.output.encoding);
  for (let i = TW / 2; i < TW; i++) {
    const at = (13 * TW + i) * 4;
    assert.deepEqual(expected.slice(at, at + 3), clipInputs.b.slice(at, at + 3), `engine pixel (${i}, 13) at p=0.25 shows B`);
  }
});

test('T6: curved clip outlines, tested as true curves, stay inside the measured pixel counts and the tolerances', () => {
  const worst = { ovalIris: 0, eyeIris: 0, heartShape: 0 };
  for (const c of transitions.cases.filter((x) => CURVED_CLIPS.includes(x.id))) {
    const expected = decodeBuffer(c.output.data, c.output.encoding);
    const actual = renderClipTransition(c, clipInputs.a, clipInputs.b, TW, TH);
    worst[c.id] = Math.max(worst[c.id], differingPixels(expected, actual));
    assert(compareCase({ ...c, expected }, actual).pass, `${c.name}: outside tolerance`);
  }
  assert.deepEqual(worst, { ovalIris: 12, eyeIris: 13, heartShape: 4 }, 'the pages state these counts');
});

test('T6: stroke coverage as area fraction passes every spiralWipe and xWipe golden', () => {
  const cases = transitions.cases.filter((c) => STROKE_TRANSITIONS.includes(c.id));
  assert.equal(cases.length, 10);
  for (const c of cases) {
    const expected = decodeBuffer(c.output.data, c.output.encoding);
    assert(compareCase({ ...c, expected }, renderStrokeTransition(c, clipInputs.a, clipInputs.b, TW, TH)).pass, `${c.name}: outside tolerance`);
  }
});

test('the published ASCII atlases are the ones the font-atlas goldens were rendered with', async () => {
  const published = await readJson('spec/goldens/ascii-atlases.json');
  assert.equal(published.format, ASCII_ATLASES_FORMAT);
  const cases = effects.cases.filter((c) => c.id === 'gpu-ascii' && c.outcome === 'rendered' && asciiAtlasSpec(c.params));
  assert.equal(cases.length, 23);
  assert.equal(published.atlases.length, new Set(cases.map((c) => asciiAtlasSpec(c.params).key)).size);
  assert.equal(published.atlases.reduce((n, entry) => n + entry.cases.length, 0), 23);
  for (const c of cases) {
    const spec = asciiAtlasSpec(c.params);
    const entry = published.atlases.find((x) => x.key === spec.key);
    assert(entry, `${c.name}: no published atlas for ${spec.key}`);
    for (const field of ['ramp', 'width', 'height']) assert.equal(entry[field], spec[field], `${spec.key}: ${field}`);
    assert.equal(entry.cssFont, spec.font);
    assert(entry.cases.includes(c.name));
    const guarded = [];
    const reference = renderAsciiReference(effectSdrInput(), EFFECT_SIZE.width, EFFECT_SIZE.height, c.params, decodeAsciiAtlas(entry), guarded);
    const expected = decodeBuffer(c.output.data, c.output.encoding);
    // The stored engine frame must be what the equations give for the published strip.
    assert(compareCase({ ...c, expected }, settleAsciiGuard(reference, expected, guarded).expected).pass, `${c.name}: the published atlas does not give the golden`);
  }
});

test('extra cases: absent and non-finite keys, the block glitch that glitches, the radial blur tap count', () => {
  const byName = (name) => effects.cases.filter((c) => c.name === name);
  const pixels = (c) => decodeBuffer(c.output.data, c.output.encoding);
  const same = (x, y) => compareCase({ ...x, expected: pixels(x) }, pixels(y)).pass;
  const one = (name) => { const found = byName(name); assert.equal(found.length, 1, name); return found[0]; };
  // Curves: four keys present but not finite draw the default two-point curve, the identity.
  const notFinite = one('gpu-curves/sdr/master-keys-not-finite');
  assert.equal(notFinite.params.masterShadowX, null);
  assert(same(one('gpu-curves/sdr/default'), notFinite));
  assert(!same(one('gpu-curves/sdr/default'), one('gpu-curves/sdr/master-one-finite-key')));
  const legacy = one('gpu-curves/sdr/master-keys-absent-legacy');
  assert(!('masterShadowX' in legacy.params) && legacy.params.shadows === 40);
  assert(!same(one('gpu-curves/sdr/default'), legacy), 'legacy sliders must be read when the four keys are absent');
  // Motion blur: 360 with any other key, 180 for an empty object or a present non-finite value.
  for (const domain of ['sdr', 'hdr']) {
    const at = (name) => one(`gpu-motion-blur/${domain}/${name}`);
    assert.deepEqual(at('empty-parameters').params, {});
    assert.deepEqual(at('only-an-undeclared-key').params, { note: 1 });
    assert(same(at('default'), at('empty-parameters')), `${domain}: an empty object draws the 180 degree default`);
    assert(same(at('default'), at('shutterAngle-not-finite')), `${domain}: a present non-finite shutter is the default`);
    assert(same(at('shutterAngle-absent'), at('only-an-undeclared-key')), `${domain}: an undeclared key counts as another key`);
    assert(!same(at('default'), at('shutterAngle-absent')), `${domain}: an absent shutter with other keys is 360`);
  }
  // Block glitch: the extra cases change the picture, and the wrapped step repeats the pattern.
  const input = eightBit(effectSdrInput());
  const glitched = effects.cases.filter((c) => c.id === 'gpu-block-glitch' && c.params.blockSize === 8);
  assert.equal(glitched.length, EFFECT_EXTRA_CASES['gpu-block-glitch'].length - 1);
  for (const c of glitched) assert(differingPixels(input, pixels(c)) >= 24, `${c.name}: the glitch must be visible`);
  // Step 70 wraps to step 6: the frame at 8.75 s is the frame of the same block at 0.75 s.
  assert.deepEqual(one('gpu-block-glitch/sdr/coverage=1@t=8.75').output, one('gpu-block-glitch/sdr/coverage=0.65').output);
  // Radial blur: the hidden tap count changes the picture.
  assert.equal(TRANSITION_EXTRA_CASES.radialBlur.length, 2);
  const blur = (name) => transitions.cases.find((c) => c.name === name);
  const twelve = blur('radialBlur/p=0.5/blurStrength=3');
  const five = blur('radialBlur/p=0.5/blurStrength=3,samples=5');
  assert(!compareCase({ ...twelve, expected: pixels(twelve) }, pixels(five)).pass, 'five taps must not pass as twelve');
});

// The keyframe page and its goldens (studio/spec/keyframes.md) are checked with this file.
await import('./keyframe-goldens.test.mjs');

// The HDR and colour-management page (studio/spec/hdr.md) has its own engine-free checks.
import './hdr-goldens.test.mjs';
