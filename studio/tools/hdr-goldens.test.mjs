// Engine-free checks of the HDR and colour-management page of the render spec (studio/spec/hdr.md):
// golden structure and coverage, the independent reference written from the page's prose against
// every engine value, the comparison rules, and the clean-room lint of the page.
// hdr-goldens.browser.mjs checks the goldens against the engine itself.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STAGES, IMAGE_FLOOR, stageCases, imageCases, imageInputs, decodeBuffer, encodeBuffer, compareStage, compareCase,
  validateHdrGoldens, referenceStage, referenceImage, deriveHdrTolerance,
} from './hdr-goldens.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldens = JSON.parse(await readFile(path.join(studio, 'spec/goldens/hdr.json'), 'utf8'));
const page = await readFile(path.join(studio, 'spec/hdr.md'), 'utf8');
const expectedOf = (c) => decodeBuffer(c.output.data, c.output.encoding);

test('HDR goldens are complete, ordered and built from the documented inputs', () => {
  const counts = validateHdrGoldens(goldens);
  assert.deepEqual(counts, { stages: stageCases().length, exact: stageCases().filter((c) => c.exact).length, images: imageCases().length });
  assert(counts.stages > 300 && counts.exact > 100 && counts.images > 20, 'case lists unexpectedly short');
  assert.equal(new Set(goldens.stages.map((c) => c.name)).size, counts.stages);
  assert.equal(new Set(goldens.images.map((c) => c.name)).size, counts.images);
});

test('tolerances were measured against a second GPU backend and the reference', () => {
  assert(goldens.renderer.crossCheck, 'goldens written without GOLDENS_CROSS_CHECK_ARGS must not be committed');
  assert.notDeepEqual(goldens.renderer.crossCheck.adapter, goldens.renderer.canonical.adapter);
  const inputs = imageInputs();
  for (const c of goldens.images) {
    assert(c.tolerance.measured?.crossBackend && c.tolerance.measured?.reference, `${c.name}: tolerance was not measured`);
    // The stored bound is the derivation rule applied to the stored measurements' worst case.
    const { abs, relative } = IMAGE_FLOOR[c.kind];
    const rebuilt = deriveHdrTolerance(c.kind, expectedOf(c), null, referenceImage(c, inputs));
    assert(c.tolerance.abs >= rebuilt.abs && c.tolerance.meanAbs >= rebuilt.meanAbs && c.tolerance.relative === relative && c.tolerance.abs >= abs, `${c.name}: tolerance`);
  }
});

test('the reference written from hdr.md reproduces every stage vector, bit for bit where exact', () => {
  let exact = 0;
  for (const c of goldens.stages) {
    const actual = JSON.parse(JSON.stringify(referenceStage(c)));
    assert(compareStage(c, actual), `${c.name}: expected ${JSON.stringify(c.expected)}, reference gives ${JSON.stringify(actual)}`);
    if (c.exact) {
      assert.deepEqual(actual, c.expected, `${c.name}: an exact case must match bit for bit`);
      exact++;
    }
  }
  assert.equal(exact, goldens.stages.filter((c) => c.exact).length);
});

test('the reference written from hdr.md reproduces every image within its tolerance', () => {
  const inputs = imageInputs();
  for (const c of goldens.images) {
    const result = compareCase({ ...c, expected: expectedOf(c) }, referenceImage(c, inputs));
    assert(result.pass, `${c.name}: ${result.missed} channels outside tolerance (worst ${result.worst}, mean ${result.mean})`);
  }
});

test('stage comparison: exact cases reject one ulp, the others reject an error of 1e-6, structure must match', () => {
  const nudge = (value, change) => JSON.parse(JSON.stringify(value), (_, v) => (typeof v === 'number' && v !== 0 ? change(v) : v));
  for (const c of goldens.stages) {
    assert(compareStage(c, c.expected), c.name);
    const coarse = nudge(c.expected, (v) => v * (1 + 1e-6) + Math.sign(v) * 1e-9);
    if (JSON.stringify(coarse) === JSON.stringify(c.expected)) continue; // no non-zero number in the answer
    assert(!compareStage(c, coarse), `${c.name}: an error of 1e-6 must fail`);
    if (c.exact) assert(!compareStage(c, nudge(c.expected, (v) => v * (1 + 2 ** -52))), `${c.name}: one ulp must fail`);
  }
  const triple = goldens.stages.find((c) => c.name === 'bt709ToBt2020/2');
  assert(!compareStage(triple, triple.expected.slice(0, 2)), 'a short triplet must fail');
  assert(!compareStage(triple, [NaN, ...triple.expected.slice(1)]), 'NaN must fail');
  const record = goldens.stages.find((c) => c.name === 'resolve/0');
  assert(!compareStage(record, { ...record.expected, workingRange: 'hdr' }), 'a wrong range must fail');
  assert(!compareStage(record, { ...record.expected, transfer: 'pq' }), 'an invented field must fail');
});

test('image comparison: no image case passes for another, and identity, NaN and short buffers fail', () => {
  const images = goldens.images.map((c) => ({ ...c, expected: expectedOf(c) }));
  for (const c of images) {
    assert(compareCase(c, c.expected).pass, c.name);
    for (const other of images) {
      if (other !== c) assert(!compareCase(c, other.expected).pass, `${other.name} must not pass as ${c.name}`);
    }
    assert(!compareCase(c, c.expected.slice(0, -4)).pass, `${c.name}: short buffer must fail`);
    assert.throws(() => compareCase(c, c.expected.map((v, i) => (i === 9 ? NaN : v))), /not finite/);
  }
  const inputs = imageInputs();
  const toneMapped = images.find((c) => c.name === 'output/hdr/sdr-display');
  assert(!compareCase(toneMapped, inputs.working).pass, 'identity must fail');
});

test('buffer encodings round-trip, binary32 included', () => {
  const values = [0, 0.1, 1, -0.5, 7.309559025783966e-7, 0.5806888810416109];
  assert.deepEqual(decodeBuffer(encodeBuffer(values, 'f32le-deflate-base64'), 'f32le-deflate-base64'), values.map(Math.fround));
  assert.deepEqual(decodeBuffer(encodeBuffer([0, 0.25, 4], 'f16le-deflate-base64'), 'f16le-deflate-base64'), [0, 0.25, 4]);
});

test('hdr.md names every rule H1 to H17 once, cites only rules it defines, and maps every golden stage', () => {
  const defined = [...page.matchAll(/\*\*\[H(\d+)\]/g)].map((m) => Number(m[1]));
  assert.deepEqual(defined, Array.from({ length: 17 }, (_, i) => i + 1));
  for (const [, n] of page.matchAll(/\bH(\d+)\b/g)) assert(Number(n) >= 1 && Number(n) <= 17, `H${n} is cited but not defined`);
  for (const stage of STAGES) assert(page.includes(`\`${stage}\``), `hdr.md does not map the golden stage ${stage}`);
  assert(page.includes('A project is HDR automatically when it holds a PQ/HLG clip; SDR displays tone-map with BT.2390.'), 'the owner decision must be quoted');
  for (const field of ['workingRange', 'referenceWhiteNits', 'masteringPeakNits', 'sdrMonitoring']) assert(page.includes(`\`${field}\``), field);
});

// The spec is prose and mathematics: no engine source text (the patterns of render-goldens.test.mjs).
const SOURCE_PATTERNS = [
  /\bfn\s+\w+\s*\(/, /@(fragment|vertex|compute|group|binding|builtin|location)\b/, /\btexture(Sample\w*|Load|Store|Dimensions)\b/,
  /\bvec[234][fiu]?\s*\(/, /\bmat[234]x?[234]?f?\s*\(/, /\blet\s+\w+\s*:\s*\w+\s*=/, /\bvar\s*(<[^>]*>)?\s+\w+\s*:/, /\bconst\s+\w+\s*[:=]/,
  /=>/, /\bctx\.\w+/, /\bnew\s+(Float32Array|Path2D|OffscreenCanvas)\b/, /\bpackUniforms\b/, /\bparams\.\w+/, /\{\s*$\n\s+\w+.*\n\s*\}/m,
];
test('hdr.md contains no engine source text', () => {
  for (const pattern of SOURCE_PATTERNS) assert(!pattern.test(page), `hdr.md matches ${pattern}`);
  // Engine identifiers of the colour code must not appear either; the page uses its own names.
  for (const name of ['resolveColorManagement', 'workingRangeOfSources', 'signalToWorking(', 'workingToSdrDisplay', 'bt2390Eetf', 'fl_', 'ColorOutputPipeline', 'HdrRasterSources', 'HdrFrameUploader']) {
    assert(!page.includes(name), `hdr.md names the engine symbol ${name}`);
  }
});
