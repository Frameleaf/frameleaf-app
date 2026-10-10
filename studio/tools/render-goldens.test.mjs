// Engine-free checks of the render spec (studio/spec): coverage of the parameter catalogue,
// golden structure and inputs, the progress curve re-derived from the prose, the comparison
// rule, and a clean-room lint of the spec text. render-goldens.browser.mjs checks the goldens
// against the engine itself.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asciiAtlasSpec } from './ascii-reference.mjs';
import {
  validateGoldens, compareCase, decodeBuffer, effectCases, transitionCases, GPU_TRANSITIONS, LINEAR_HDR_EFFECTS,
  toHalfBits, fromHalfBits, encodeBuffer, buildIndex, renderIndexMarkdown, replaceIndexMarkdown,
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

// The layer and text pages (studio/spec/layers.md, text.md) are checked with this file.
await import('./layer-goldens.test.mjs');
await import('./text-goldens.test.mjs');
