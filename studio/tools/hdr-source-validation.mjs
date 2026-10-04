import assert from 'node:assert/strict';

/** Validate all emitted frames, including output before a later refusal. */
export function validateMaskedRasterDiagnostic(diagnostic, size) {
  let compared = 0;
  for (const { target, width, height, points } of diagnostic.outputs) {
    assert.equal(width, size);
    assert.equal(height, size);
    for (const [region, { got, want }] of points.entries()) {
      want.forEach((value, channel) => {
        compared++;
        assert.ok(Number.isFinite(got[channel]) && Math.abs(got[channel] - value) <= 0.004,
          `masked HDR raster ${target} region ${region} channel ${channel}: ${got[channel]} vs ${value}`);
      });
      assert.ok(Math.abs(got[3] - 1) < 1e-6, `masked raster: opaque output alpha ${got[3]}`);
    }
  }
  if (diagnostic.status === 'preserved') {
    assert.deepEqual(diagnostic.outputs.map((output) => output.target), ['pq', 'hlg'],
      'complete preserved diagnostic requires both PQ and HLG outputs');
    assert.ok(diagnostic.working.some((v) => v > 1));
    assert.ok(diagnostic.working.some((v) => v < -0.01));
  }
  // A valid partial report is still unavailable fallback qualification.
  return { compared, qualified: false };
}
