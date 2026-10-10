// Expected values below are hand calculations with synthetic coverage, never GPU output.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ASCII_ALPHA_GUARD, asciiAtlasSpec, validateAsciiAtlas, renderAsciiReference, settleAsciiGuard } from './ascii-reference.mjs';
import { compareCase } from './render-goldens.mjs';

const params = {
  charSet: 'binary', customChars: 'FREECUT 01', font: 'monospace', fontSize: 4,
  letterSpacing: -2, lineHeight: 0.5, matchSourceColor: false, textColor: '#ffffff',
  bgColor: '#000000', transparentBg: false, edgeDetect: false, colorSaturation: 100,
  asciiOpacity: 100, originalOpacity: 0, contrast: 100, brightness: 0, invert: false,
};
const solid = (coverage = 255, count = 2) => ({ width: count * 24, height: 24, depth: 1,
  data: Array(count * 24 * 24 * 4).fill(coverage) });
const frame = (rgba, w = 2, h = 2) => Array.from({ length: w * h }, () => rgba).flat();
const draw = (p = {}, atlas = solid(), input = frame([0.25, 0.5, 0.75, 0.5]), w = 2, h = 2) =>
  renderAsciiReference(input, w, h, { ...params, ...p }, atlas);

// Losing a font option, ramp order, Unicode code point or truncation must fail.
test('atlas spec pins ramps, font stacks, 24px geometry and Unicode truncation', () => {
  assert.deepEqual(asciiAtlasSpec(params), { ramp: '01', font: '20px monospace', width: 48, height: 24, depth: 1, key: '01|monospace' });
  assert.equal(asciiAtlasSpec({ ...params, charSet: 'ascii', font: 'courier' }).ramp, '@%#*+=-:. ');
  assert.equal(asciiAtlasSpec({ ...params, font: 'courier' }).font, '20px "Courier New", Courier, monospace');
  assert.equal(asciiAtlasSpec({ ...params, font: 'consolas' }).font, '20px Consolas, "Lucida Console", monospace');
  assert.equal(asciiAtlasSpec({ ...params, font: 'lucida' }).font, '20px "Lucida Console", Monaco, monospace');
  assert.equal(asciiAtlasSpec({ ...params, charSet: 'custom', customChars: '😀'.repeat(65) }).width, 64 * 24);
  assert.equal(asciiAtlasSpec({ ...params, charSet: 'custom', customChars: '' }), null);
  for (const charSet of ['standard', 'simple', 'blocks', 'dots', 'minimal']) assert.equal(asciiAtlasSpec({ ...params, charSet }), null);
  assert.throws(() => asciiAtlasSpec({ ...params, font: 'unknown' }), /font/);
});

// Accepting a wrong production atlas even with a matching final frame must fail.
test('atlas validation rejects wrong coverage, size, layout, missing and non-byte data', () => {
  const expected = solid();
  assert.equal(validateAsciiAtlas(solid(), expected, params), true);
  const wrong = solid(); wrong.data[3] = 0;
  assert.throws(() => validateAsciiAtlas(wrong, expected, params), /atlas/);
  assert.throws(() => validateAsciiAtlas({ ...expected, width: 24 }, expected, params), /atlas/);
  assert.throws(() => validateAsciiAtlas(expected, { ...expected, height: 12 }, params), /atlas/);
  assert.throws(() => validateAsciiAtlas(null, expected, params), /atlas/);
  assert.throws(() => validateAsciiAtlas({ ...expected, data: expected.data.slice(4) }, expected, params), /atlas/);
  const swapped = solid(0);
  for (let y = 0; y < 24; y++) for (let x = 24; x < 48; x++) for (let c = 0; c < 4; c++) swapped.data[(y * 48 + x) * 4 + c] = 255;
  assert.throws(() => validateAsciiAtlas(swapped, expected, params), /atlas/);
  const nonfinite = solid(); nonfinite.data[0] = NaN;
  assert.throws(() => validateAsciiAtlas(nonfinite, expected, params), /atlas/);
  const nonbyte = solid(); nonbyte.data[0] = 0.5;
  assert.throws(() => validateAsciiAtlas(nonbyte, expected, params), /atlas/);
});

// These assert whole frames; the comparison cannot accept identity or an arbitrary GPU frame.
test('opaque white ink, source color, fixed hex colors and alpha have known outputs', () => {
  assert.deepEqual(draw(), frame([1, 1, 1, 0.5]));
  assert.deepEqual(draw({ matchSourceColor: true }), frame([0.25, 0.5, 0.75, 0.5]));
  assert.deepEqual(draw({ textColor: '#f00', asciiOpacity: 50 }), frame([0.5, 0, 0, 0.5]));
  assert.deepEqual(draw({ asciiOpacity: 0, originalOpacity: 50 }), frame([0.125, 0.25, 0.375, 0.5]));
  assert.deepEqual(draw({ matchSourceColor: true, colorSaturation: 0 }, solid(), frame([1,0,0,1])), frame([1225/4096,1225/4096,1225/4096,1]));
  assert.deepEqual(draw({}, solid(0)), frame([0, 0, 0, 0.5]));
  assert.deepEqual(draw({}, solid(), frame([1, 1, 1, 0])), frame([0, 0, 0, 0]));
});

test('transparent ink and underlay preserve straight color and source alpha', () => {
  assert.deepEqual(draw({ transparentBg: true, textColor: '#ff0000', asciiOpacity: 50 }), frame([1, 0, 0, 0.25]));
  assert.deepEqual(draw({ transparentBg: true, asciiOpacity: 50, originalOpacity: 50 }), frame([0.75,1707/2048,1877/2048,0.375]));
  assert.deepEqual(draw({ transparentBg: true, asciiOpacity: 0 }), frame([0, 0, 0, 0]));
  assert.deepEqual(draw({ transparentBg: true, asciiOpacity: 0, originalOpacity: 50 }), frame([0.25, 0.5, 0.75, 0.25]));
});

test('bilinear texel centers, clamped atlas taps and centered letterbox are independent', () => {
  const atlas = solid(0);
  // At local u/v = .25 the first glyph samples equally columns 5/6 and rows 5/6.
  for (let y = 0; y < 24; y++) for (let x = 6; x < 24; x++) for (let c = 0; c < 4; c++) atlas.data[(y * 48 + x) * 4 + c] = 255;
  const low = frame([0.1, 0.1, 0.1, 1]);
  assert.deepEqual(draw({}, atlas, low), [0.5,0.5,0.5,1, 1,1,1,1, 0.5,0.5,0.5,1, 1,1,1,1]);
  const corner = solid(0);
  for (let y = 6; y < 24; y++) for (let x = 6; x < 24; x++) for (let c = 0; c < 4; c++) corner.data[(y * 48 + x) * 4 + c] = 255;
  assert.deepEqual(draw({}, corner, low), [0.25,0.25,0.25,1, 0.5,0.5,0.5,1, 0.5,0.5,0.5,1, 1,1,1,1]);
  const edge = solid(0);
  for (let x = 0; x < 24; x++) for (let c = 0; c < 4; c++) edge.data[x * 4 + c] = 255;
  const tall = draw({ fontSize: 24, lineHeight: 2 }, edge, frame([0,0,0,1],12,48),12,48);
  assert.deepEqual(tall.slice(0,4), [1,1,1,1]); // y = -0.25 texels clamps to row 0.
  assert.deepEqual(tall.slice(12*4,12*4+4), [0.75,0.75,0.75,1]);
  // A 3px frame with one 2px-wide cell has .5px side padding: last pixel is outside.
  assert.deepEqual(draw({}, solid(), frame([0,0,0,1],3,2),3,2), [1,1,1,1, 1,1,1,1, 0,0,0,1, 1,1,1,1, 1,1,1,1, 0,0,0,1]);
  // A cell larger than the frame still centers its grid.
  assert.deepEqual(draw({ fontSize: 24, lineHeight: 2 }, solid()), frame([1,1,1,0.5]));
});

test('tone, inversion, edge density, contrast and brightness select known glyphs', () => {
  const atlas=solid(0);
  for(let y=0;y<24;y++) for(let x=24;x<48;x++) for(let c=0;c<4;c++) atlas.data[(y*48+x)*4+c]=255;
  assert.deepEqual(draw({},atlas,frame([0,0,0,1])),frame([0,0,0,1]));
  assert.deepEqual(draw({invert:true},atlas,frame([0,0,0,1])),frame([1,1,1,1]));
  assert.deepEqual(draw({edgeDetect:true},atlas,frame([1,1,1,1])),frame([0,0,0,1]));
  const step = [...frame([0,0,0,1],2,1), ...frame([1,1,1,1],2,1)];
  assert.deepEqual(draw({ edgeDetect:true },atlas,[...step,...step],4,2),frame([1,1,1,1],4,2));
  assert.deepEqual(draw({brightness:100},atlas,frame([0.25,0.25,0.25,1])),frame([1,1,1,1]));
  assert.deepEqual(draw({contrast:200,matchSourceColor:true},solid(),frame([0.25,0.5,0.75,1])),frame([0,0.5,1,1]));
});

test('invalid inputs fail closed and wrong output fails the unchanged comparison floor', () => {
  assert.throws(() => draw({}, null), /atlas/);
  assert.throws(() => draw({}, solid(), [NaN, 0, 0, 1]), /input/);
  assert.throws(() => draw({ brightness: NaN }), /parameter/);
  const expected=draw();
  const subject={ name:'synthetic ASCII',expected,tolerance:{abs:2/255,relative:0,outliers:0,meanAbs:1/255} };
  assert(compareCase(subject,expected).pass);
  assert(!compareCase(subject,frame([0,0,0,0.5])).pass);
  assert(!compareCase(subject,frame([0.25,0.5,0.75,0.5])).pass);
});

// Sub-guard coverage: only the equations' own segment t·Gc is accepted, and only where the reference has no ink.
test('coverage under the transparent division guard is reported only where the reference has none', () => {
  const guardedOf = (p, atlas = solid(0)) => {
    const guarded = [];
    renderAsciiReference(frame([0.25, 0.5, 0.75, 1]), 2, 2, { ...params, ...p }, atlas, guarded);
    return guarded;
  };
  assert.equal(ASCII_ALPHA_GUARD, 0.0001);
  assert.deepEqual(guardedOf({ transparentBg: true, matchSourceColor: true }), [0, 1, 2, 3].map((pixel) => ({ pixel, limit: [0.25, 0.5, 0.75] })));
  assert.deepEqual(guardedOf({ transparentBg: true }).map((entry) => entry.limit), Array(4).fill([1, 1, 1]));
  assert.deepEqual(guardedOf({ transparentBg: true, asciiOpacity: 0 }, solid()).length, 4);
  assert.deepEqual(guardedOf({ transparentBg: false }), []);
  assert.deepEqual(guardedOf({ transparentBg: true }, solid()), []);
  assert.deepEqual(guardedOf({ transparentBg: true }, solid(1)), []); // One coverage byte is 39 guards.
  assert.deepEqual(guardedOf({ transparentBg: true, originalOpacity: 1 }), []);
});

test('guarded pixels accept the segment t·Gc with matching alpha and nothing else', () => {
  const tolerance = { abs: 2 / 255, relative: 0, outliers: 0, meanAbs: 1 / 255 };
  const expected = frame([0, 0, 0, 0]);
  const guarded = [{ pixel: 1, limit: [0.25, 0.5, 0.75] }];
  const passes = (actual, zone = guarded) => {
    const settled = settleAsciiGuard(expected, actual, zone);
    return compareCase({ name: 'guard', expected: settled.expected, tolerance }, actual).pass;
  };
  const withPixel1 = (rgba) => [0, 0, 0, 0, ...rgba, 0, 0, 0, 0, 0, 0, 0, 0];
  assert(passes(withPixel1([0, 0, 0, 0])));
  // t = 0.5: half of Gc at half the guard alpha.
  const half = withPixel1([0.125, 0.25, 0.375, 0.00005]);
  assert(passes(half));
  assert.deepEqual(settleAsciiGuard(expected, half, guarded).pixels, [{ pixel: 1, t: 0.5, alpha: 0.00005 }]);
  assert.deepEqual(settleAsciiGuard(expected, half, guarded).expected.slice(4, 8), [0.125, 0.25, 0.375, 0]);
  // t = 1 is the colour at and above the guard; its alpha stays under the comparison rule.
  assert(passes(withPixel1([0.25, 0.5, 0.75, 0.004])));
  assert(!passes(withPixel1([0.25, 0.5, 0.75, 0.5])));
  // Off the segment, beyond it, or a partial t with visible alpha.
  assert(!passes(withPixel1([0.375, 0, 0, 0.00005])));
  assert(!passes(withPixel1([0.5, 1, 1, 0.00005])));
  assert(!passes(withPixel1([0.125, 0.25, 0.375, 0.004])));
  // The same colour where the reference has ink, or in an unguarded frame, still fails.
  assert(!passes([0.125, 0.25, 0.375, 0.00005, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert(!passes(half, []));
  assert.throws(() => settleAsciiGuard(expected, half.slice(4), guarded), /complete frame/);
  assert.throws(() => settleAsciiGuard(expected, withPixel1([NaN, 0, 0, 0]), guarded), /finite/);
});
