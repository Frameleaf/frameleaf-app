import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMaskedRasterDiagnostic } from './hdr-source-validation.mjs';

// Report-validator fixtures only; these are not rendered pixels or GPU evidence.
const partialRefusal = () => ({
  coverage: 'diagnostic-unqualified', status: 'refused',
  reason: 'HDR raster cannot fall back to a canvas',
  outputs: [{ target: 'pq', width: 64, height: 64, points: [
    { got: [0.7, 0.45, 0.25, 1], want: [0.7, 0.45, 0.25] },
    { got: [0.2, 0.2, 0.2, 1], want: [0.2, 0.2, 0.2] },
  ] }],
});

test('later documented refusal cannot hide corrupt or nonfinite earlier PQ output', () => {
  for (const value of [0.42, Number.NaN, Number.POSITIVE_INFINITY]) {
    const diagnostic = partialRefusal();
    diagnostic.outputs[0].points[0].got[0] = value;
    assert.throws(() => validateMaskedRasterDiagnostic(diagnostic, 64),
      /masked HDR raster pq region 0 channel 0/);
  }
});

test('valid partial output is checked but cannot qualify fallback coverage', () => {
  const diagnostic = partialRefusal();
  assert.deepEqual(validateMaskedRasterDiagnostic(diagnostic, 64), { compared: 6, qualified: false });
  assert.equal(diagnostic.coverage, 'diagnostic-unqualified');
  diagnostic.outputs[0].points[1].got[3] = 0.5;
  assert.throws(() => validateMaskedRasterDiagnostic(diagnostic, 64), /opaque output alpha/);
});

test('preserved status requires a complete two-policy report after validating its output', () => {
  const diagnostic = { ...partialRefusal(), status: 'preserved', working: [2, -0.5, 0.25] };
  assert.throws(() => validateMaskedRasterDiagnostic(diagnostic, 64), /requires both PQ and HLG/);
  diagnostic.outputs.push({ ...diagnostic.outputs[0], target: 'hlg' });
  assert.deepEqual(validateMaskedRasterDiagnostic(diagnostic, 64), { compared: 12, qualified: false });
});
