// Engine-free checks of the keyframe-interpolation contract (studio/spec/keyframes.md):
// golden structure and coverage, the reference implementation written from the prose
// against every engine value, the comparison rule, and the clean-room lint of the page.
// keyframe-goldens.browser.mjs checks the goldens against the engine itself.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateKeyframeGoldens, serialiseKeyframeGoldens, keyframeCases, referenceCase, classifyCase, compareKeyframeCase,
  encodeNumber, decodeNumber, encodeResult, decodeResult, resultNumbers, doubleToHex, hexToDouble,
  EASING_NAMES, BEZIER_DEFAULT, SPRING_DEFAULT, TOLERANCES,
} from './keyframe-goldens.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenText = await readFile(path.join(studio, 'spec/goldens/keyframes.json'), 'utf8');
const goldens = JSON.parse(goldenText);
const catalogue = JSON.parse(await readFile(path.join(studio, 'graph-parameters-v1.json'), 'utf8'));
const page = await readFile(path.join(studio, 'spec/keyframes.md'), 'utf8');
const cases = keyframeCases();

test('the golden file has the documented structure, case list and coverage', () => {
  const counts = validateKeyframeGoldens(goldens);
  assert(counts.cases >= 700, 'case list unexpectedly short');
  assert(counts.exact > counts.toleranced, 'most cases must be exact');
  for (const kind of ['easing', 'scalar', 'vector', 'colour', 'transform']) assert(counts.byKind[kind] > 0, `no ${kind} cases`);
  for (const cls of Object.keys(TOLERANCES)) assert(counts.byTolerance[cls] > 0, `no ${cls} tolerance cases`);
  assert.equal(goldens.engine.revision, catalogue.engine.revision, 'goldens and catalogue must pin the same engine');
  assert.equal(goldenText, serialiseKeyframeGoldens(goldens), 'keyframes.json is not in its canonical serialisation');
});

test('the catalogue easing names and defaults are the ones the page specifies', () => {
  assert.deepEqual(catalogue.easing.types, EASING_NAMES);
  assert.deepEqual(catalogue.easing.bezierDefault, BEZIER_DEFAULT);
  assert.deepEqual(catalogue.easing.springDefault, SPRING_DEFAULT);
  for (const name of EASING_NAMES) assert(page.includes(`\`${name}\``), `keyframes.md does not name ${name}`);
});

test('the reference written from the prose reproduces every engine value', () => {
  let exact = 0;
  let worst = 0;
  goldens.cases.forEach((golden, index) => {
    const reference = referenceCase(cases[index]).value;
    const outcome = compareKeyframeCase(golden, reference);
    assert(outcome.pass, `${golden.name}: prose gives ${JSON.stringify(encodeResult(golden.kind, reference))}, engine gives ${JSON.stringify(golden.expected)}`);
    if (golden.exact) {
      // Bit for bit, checked on the bit patterns themselves.
      // NaN has many bit patterns and IEEE 754 fixes none of them; every other value has one.
      const pattern = (n) => (Number.isNaN(n) ? 'NaN' : doubleToHex(n));
      const want = resultNumbers(golden.kind, decodeResult(golden.kind, golden.expected)).map(pattern);
      assert.deepEqual(resultNumbers(golden.kind, reference).map(pattern), want, golden.name);
      exact += 1;
    } else {
      worst = Math.max(worst, outcome.worst);
    }
  });
  assert.equal(exact, goldens.cases.filter((c) => c.exact).length);
  assert(worst <= 1e-9);
});

test('exact marks only what the four operations, comparisons and square roots decide', () => {
  goldens.cases.forEach((golden, index) => {
    const { notes, value } = referenceCase(cases[index]);
    const marking = classifyCase(cases[index]);
    if (golden.exact) {
      assert(marking.exact, golden.name);
      const numbers = resultNumbers(golden.kind, value);
      assert(notes.size === 0 || (numbers.length > 0 && numbers.every(Number.isNaN)), `${golden.name}: exact but used ${[...notes]}`);
    } else {
      assert(notes.size > 0, `${golden.name}: toleranced without a reason`);
      assert.equal(typeof golden.tolerance.reason, 'string');
    }
  });
  // Springs are exact only at their ends or where they are not a number.
  for (const golden of goldens.cases.filter((c) => c.kind === 'easing' && c.name.startsWith('easing/spring/') && c.exact)) {
    assert(golden.input.t <= 0 || golden.input.t >= 1 || golden.expected === 'NaN', golden.name);
  }
});

test('the rules the page states hold in the goldens', () => {
  const byName = new Map(goldens.cases.map((c) => [c.name, decodeResult(c.kind, c.expected)]));
  const get = (name) => {
    assert(byName.has(name), `no case ${name}`);
    return byName.get(name);
  };
  // K4: hold is 0 everywhere; K5 and K6 shortcuts at the ends.
  assert.equal(get('easing/hold/t=1'), 0);
  for (const c of goldens.cases.filter((x) => x.kind === 'easing' && !x.name.includes('hold') && !x.name.includes('t-is-clamped'))) {
    if (c.input.t === 0) assert.equal(c.expected, 0, c.name);
    if (c.input.t === 1) assert.equal(c.expected, 1, c.name);
  }
  // K5: overshoot leaves 0..1; K6: the ceiling, the end jump and the not-a-number springs.
  assert(get('easing/cubic-bezier/overshoot/t=0.5') > 1);
  assert(get('easing/cubic-bezier/anticipate/t=0.25') < 0);
  assert.equal(get('easing/spring/bouncy/t=0.1'), 1.2);
  assert(get('easing/spring/default/t=0.999') < 0.92);
  assert(get('easing/spring/mass-0.1/t=0.999') < 0.2);
  for (const name of ['friction-0', 'tension-0', 'tension-0-friction-0', 'mass-0']) assert(Number.isNaN(get(`easing/spring/${name}/t=0.5`)), name);
  // K7, K8.
  assert.equal(get('scalar/empty-group-gives-static-value/frame=12'), 0.625);
  assert.equal(get('scalar/linear/before-first/frame=-5'), 100);
  assert.equal(get('scalar/linear/after-last/frame=1000'), 400);
  assert.equal(get('scalar/same-frame/interior/frame=10'), 30);
  assert.equal(get('scalar/hold/inside/frame=9.999'), 5);
  // K12: spatial with zero tangents eases along the chord; K13: continuous is not read.
  assert.deepEqual(get('vector/spatial/zero-tangents-are-not-a-straight-lerp/frame=7.5'), { x: 146.875, y: 262.5 });
  assert.deepEqual(get('vector/position/linear/frame=17.5'), { x: 175, y: 300 });
  for (const frame of [5, 10, 15, 20, 25]) {
    assert.deepEqual(get(`vector/spatial/curved/continuous-true/frame=${frame}`), get(`vector/spatial/curved/frame=${frame}`));
    assert.deepEqual(get(`vector/spatial/curved/continuous-false/frame=${frame}`), get(`vector/spatial/curved/frame=${frame}`));
  }
  assert.deepEqual(get('vector/spatial/ignored-on-scale/frame=10'), { x: 200, y: 1000 / 3 });
  // K11: the rate matters, and an absent rate is 30.
  assert.deepEqual(get('vector/temporal/rate-absent-is-30/frame=10'), get('vector/temporal/rate-30/frame=10'));
  assert.deepEqual(get('vector/temporal/rate-0.5/frame=10'), get('vector/temporal/rate-1/frame=10'));
  assert.notDeepEqual(get('vector/temporal/rate-24/frame=10'), get('vector/temporal/rate-60/frame=10'));
  assert.notDeepEqual(get('transform/rate-from-project-24/frame=10'), get('transform/rate-absent-is-30/frame=10'));
  // K15: a vector lane with a keyframe owns its fields; the separated flag and the version are not read.
  const owned = get('transform/vector-lane-beats-scalar-lanes/frame=15');
  assert.deepEqual(get('transform/separated-flag-is-not-read/frame=15'), owned);
  assert.deepEqual(get('transform/animation-version-absent/frame=15'), owned);
  assert.deepEqual([owned.x, owned.y], [1150, 1200]);
  const scalarLanes = get('transform/separated-flag-without-vector-lane/frame=15');
  assert.deepEqual([scalarLanes.x, scalarLanes.y], [150, 150]);
  assert.deepEqual(get('transform/empty-vector-lane-leaves-scalar-lanes/frame=15'), scalarLanes);
});

test('comparison rule: the golden passes; a wrong bit, a wrong branch and NaN fail', () => {
  const pick = (name) => goldens.cases.find((c) => c.name === name);
  const exact = pick('scalar/linear/inside/frame=20');
  const value = decodeResult(exact.kind, exact.expected);
  assert(compareKeyframeCase(exact, value).pass);
  assert(!compareKeyframeCase(exact, hexToDouble((BigInt(`0x${doubleToHex(value)}`) + 1n).toString(16))).pass, 'one ulp off must fail an exact case');
  assert(!compareKeyframeCase(exact, NaN).pass);
  assert(!compareKeyframeCase(pick('easing/hold/t=0.5'), -0).pass, '-0 is not 0 in an exact case');
  const spring = pick('easing/spring/default/t=0.5');
  const springValue = decodeResult(spring.kind, spring.expected);
  assert(compareKeyframeCase(spring, springValue + 5e-10).pass);
  assert(!compareKeyframeCase(spring, springValue + 2e-9).pass);
  assert(!compareKeyframeCase(spring, NaN).pass);
  // The CSS curve of the same name is not this ease-in.
  assert(!compareKeyframeCase(pick('easing/ease-in/t=0.5'), 0.3153568).pass);
  const vector = pick('vector/spatial/curved/frame=15');
  const point = decodeResult(vector.kind, vector.expected);
  assert(compareKeyframeCase(vector, point).pass);
  assert(!compareKeyframeCase(vector, { x: point.x, y: point.y + 1e-12 }).pass);
  const nan = pick('easing/spring/friction-0/t=0.5');
  assert(compareKeyframeCase(nan, NaN).pass);
  assert(!compareKeyframeCase(nan, 0.5).pass);
  const colour = pick('colour/red-to-blue/frame=10');
  assert(compareKeyframeCase(colour, colour.expected).pass);
  const nudged = `#${(Number.parseInt(colour.expected.slice(1), 16) + 0x010000).toString(16).padStart(6, '0')}`;
  assert(compareKeyframeCase(colour, nudged).pass, 'one channel step is within tolerance');
  assert(!compareKeyframeCase(colour, '#800080').pass, 'an sRGB lerp is not the OKLCH mix');
  assert(!compareKeyframeCase(colour, `${colour.expected}ff`).pass);
});

test('numbers are stored losslessly', () => {
  for (const v of [0, -0, 1, 0.1, 1 / 3, 100 / 3, 2 ** -52, 5e-324, 1.7976931348623157e308, -1e9, NaN, Infinity, -Infinity, 0.25000000143119466]) {
    const stored = JSON.parse(JSON.stringify(encodeNumber(v)));
    assert(Object.is(decodeNumber(stored), v), String(v));
    assert(Object.is(hexToDouble(doubleToHex(v)), v) || Number.isNaN(v), String(v));
  }
  assert.throws(() => decodeNumber('1'));
  // Every stored value survives a parse and print unchanged.
  for (const c of goldens.cases) assert.deepEqual(encodeResult(c.kind, decodeResult(c.kind, c.expected)), c.expected, c.name);
});

test('the case list is deterministic and engine-free', async () => {
  assert.deepEqual(keyframeCases(), keyframeCases());
  const source = await readFile(path.join(studio, 'tools/keyframe-goldens.mjs'), 'utf8');
  assert(!/from\s+['"][^'"]*engine/.test(source) && !/import\(/.test(source), 'keyframe-goldens.mjs must not load the engine');
});

// The spec is prose and mathematics: no engine source text. Same rule as render-goldens.test.mjs.
const SOURCE_PATTERNS = [
  /\bfn\s+\w+\s*\(/, /@(fragment|vertex|compute|group|binding|builtin|location)\b/, /\btexture(Sample\w*|Load|Store|Dimensions)\b/,
  /\bvec[234][fiu]?\s*\(/, /\bmat[234]x?[234]?f?\s*\(/, /\blet\s+\w+\s*:\s*\w+\s*=/, /\bvar\s*(<[^>]*>)?\s+\w+\s*:/, /\bconst\s+\w+\s*[:=]/,
  /=>/, /\bctx\.\w+/, /\bnew\s+(Float32Array|Path2D|OffscreenCanvas)\b/, /\bpackUniforms\b/, /\bparams\.\w+/, /\{\s*$\n\s+\w+.*\n\s*\}/m,
];
// Constructs of the interpolation source that the shared patterns do not cover.
const KEYFRAME_SOURCE_PATTERNS = [
  /\bMath\.\w+/, /\bfunction\s+\w+\s*\(/, /\breturn\s[^.\n]*;\s*$/m, /\?\?/, /\?\./, /===|!==/, /\bfor\s*\(/, /\bif\s*\(/, /\bNumber\.\w+/,
  /\b(interpolate|apply|get|resolve|normalize|evaluate)[A-Z]\w+\s*\(/, /^\s*(import|export)\s+[\w{*]/m,
];
test('keyframes.md contains no engine source text', () => {
  for (const pattern of [...SOURCE_PATTERNS, ...KEYFRAME_SOURCE_PATTERNS]) assert(!pattern.test(page), `spec/keyframes.md matches ${pattern}`);
});

test('keyframes.md tags its rules K1 to K16 and states the case counts of the goldens', () => {
  for (let n = 1; n <= 16; n += 1) assert(page.includes(`**[K${n}] `), `K${n} is missing`);
  assert(!page.includes('[K17]'));
  const counts = validateKeyframeGoldens(goldens);
  const stated = `${counts.cases} cases: ${counts.exact} exact and ${counts.toleranced} with a tolerance (${counts.byTolerance.spring} spring, ${counts.byTolerance.distance} distance, ${counts.byTolerance.colour} colour)`;
  assert(page.includes(stated), `keyframes.md must state "${stated}"`);
  // Every fixture the page cites exists.
  const names = goldens.cases.map((c) => c.name);
  for (const [, cited] of page.matchAll(/`((?:easing|scalar|vector|colour|transform)\/[^`…]+)(?:…)?`/g)) {
    assert(names.some((n) => n.startsWith(cited)), `keyframes.md cites ${cited}, which no case matches`);
  }
});
