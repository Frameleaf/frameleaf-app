import assert from 'node:assert/strict';
import test from 'node:test';
import { photometricCases, photometricExpected, photometricInput, photometricSdrExpected, linearColorCases, validatePhotometricResults } from './photometric-goldens.mjs';

// Synthetic checker fixtures only. Hosted browser execution supplies actual
// production GPU pixels; these CPU fixtures cannot establish GPU qualification.
const fixture = () => photometricCases.map((entry) => ({ ...entry, pixels: photometricExpected(entry) }));
test('aggregate requires all 1024 channels and accepts its independent mathematical fixture', () => {
  assert.deepEqual(validatePhotometricResults(fixture()), { cases: 8, channels: 1024 });
});
for (const [name, change] of [
  ['identity', (entry) => { entry.pixels = [...photometricInput]; }],
  ['negative clipping', (entry) => { entry.pixels = entry.pixels.map((v, i) => i % 4 === 3 ? v : Math.max(0, v)); }],
  ['white clipping', (entry) => { entry.pixels = entry.pixels.map((v, i) => i % 4 === 3 ? v : Math.min(1, v)); }],
  ['unsigned gamma', (entry) => { entry.pixels = photometricExpected(entry, true); }],
  ['wrong alpha', (entry) => { entry.pixels[3] = 0.5; }],
  ['wrong finite RGB', (entry) => { entry.pixels[0] += 0.1; }],
  ['NaN', (entry) => { entry.pixels[0] = Number.NaN; }],
  ['Infinity', (entry) => { entry.pixels[0] = Infinity; }],
]) {
  test(`aggregate rejects ${name} in an otherwise complete output`, () => {
    const results = fixture();
    // Exposure has nonlinear signed gamma and deliberately nonidentity params.
    change(results[4]);
    assert.throws(() => validatePhotometricResults(results), /exposure-lift-gamma: channel/);
  });
}
test('case omission, duplication, parameter change, partial pixels and GPU refusal fail', () => {
  const omitted = fixture(); omitted.pop();
  assert.throws(() => validatePhotometricResults(omitted), /complete, ordered, unique/);
  const duplicate = fixture(); duplicate[7] = duplicate[6];
  assert.throws(() => validatePhotometricResults(duplicate), /complete, ordered, unique/);
  const changed = fixture(); changed[0] = { ...changed[0], params: { amount: 0 } };
  assert.throws(() => validatePhotometricResults(changed), /retain their parameters/);
  const partial = fixture(); partial[7].pixels.pop();
  assert.throws(() => validatePhotometricResults(partial), /incomplete GPU pixels/);
  const refused = fixture(); refused[7].error = 'unavailable';
  assert.throws(() => validatePhotometricResults(refused), /GPU render failed/);
});


test('current SDR measurements use pinned clamps and gamma; the historical signed oracle cannot qualify linear HDR', () => {
  const sdr = photometricCases.map(entry => ({ ...entry, pixels: photometricSdrExpected(entry) }));
  assert.deepEqual(validatePhotometricResults(sdr, 'srgb-display-bt709'), { cases: 8, channels: 1024 });
  assert.throws(() => validatePhotometricResults(sdr, 'linear-display-bt709-v1'), /complete, ordered, unique/);
  assert.throws(() => validatePhotometricResults(sdr), /channel/);
  const wrong = structuredClone(sdr); wrong[4].pixels = photometricExpected(wrong[4]);
  assert.throws(() => validatePhotometricResults(wrong, 'srgb-display-bt709'), /channel/);
});

test('linear HDR admits exactly brightness/contrast/exposure cases and rejects clipping, identity and changed alpha', () => {
  const samples = () => linearColorCases.map(entry => ({ ...entry, pixels: photometricExpected(entry) }));
  assert.deepEqual(validatePhotometricResults(samples(), 'linear-display-bt709-v1'), { cases: 6, channels: 768 });
  assert.throws(() => validatePhotometricResults(fixture(), 'linear-display-bt709-v1'), /complete, ordered, unique/);
  for (const mutate of [
    entry => { entry.pixels = [...photometricInput]; },
    entry => { entry.pixels = entry.pixels.map((v,i) => i%4 === 3 ? v : Math.max(0, Math.min(1,v))); },
    entry => { entry.pixels[3] = .5; },
  ]) {
    const results = samples(); mutate(results[0]);
    assert.throws(() => validatePhotometricResults(results, 'linear-display-bt709-v1'), /channel/);
  }
});

test('linear exposure retains EV gain, linear offset, signed gamma and straight alpha', () => {
  const samples = () => linearColorCases.map(entry => ({ ...entry, pixels: photometricExpected(entry) }));
  for (const mutate of [
    entry => { entry.pixels = photometricExpected(entry, true); },
    entry => { entry.pixels = photometricInput.map((v,i) => i%4 === 3 ? v : Math.sign(v+entry.params.offset)*Math.abs(v+entry.params.offset)**(1/entry.params.gamma)*2**entry.params.exposure); },
    entry => { entry.pixels = [...photometricInput]; },
    entry => { entry.pixels = entry.pixels.map((v,i) => i%4 === 3 ? v : Math.max(0,Math.min(1,v))); },
    entry => { entry.pixels[3] = .5; },
  ]) {
    const results=samples();mutate(results.find(entry=>entry.id==='gpu-exposure'));
    assert.throws(()=>validatePhotometricResults(results,'linear-display-bt709-v1'),/exposure-lift-gamma: channel/);
  }
});

test('linear contrast has a fixed half-reference-white pivot, dimensionless gain and signed RGB', () => {
  const samples = () => linearColorCases.map(entry => ({ ...entry, pixels: photometricExpected(entry) }));
  for (const mutate of [
    entry => { entry.pixels = photometricInput.map((v,i) => i%4 === 3 ? v : (v-.18)*entry.params.amount+.18); },
    entry => { entry.pixels = [...photometricInput]; },
    entry => { entry.pixels = entry.pixels.map((v,i) => i%4 === 3 ? v : Math.max(0,Math.min(1,v))); },
  ]) {
    const results=samples();mutate(results.find(entry=>entry.id==='gpu-contrast'));
    assert.throws(()=>validatePhotometricResults(results,'linear-display-bt709-v1'),/contrast-expand: channel/);
  }
});
