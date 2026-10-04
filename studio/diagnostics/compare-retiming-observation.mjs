import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [baselinePath, observedPath] = process.argv.slice(2);
assert.ok(baselinePath && observedPath, 'Provide baseline and observed reports');
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const observed = JSON.parse(readFileSync(observedPath, 'utf8'));
assert.equal(baseline.diagnosticOnly, true);
assert.equal(observed.diagnosticOnly, true);
assert.equal(baseline.observed, false);
assert.equal(observed.observed, true);
assert.deepEqual(baseline.fftProcessorInterval, [48000, 52800]);
assert.deepEqual(observed.fftProcessorInterval, baseline.fftProcessorInterval);
assert.equal(baseline.records.length, 1);
assert.equal(observed.records.length, 1);
const original = baseline.records[0];
const measured = observed.records[0];
assert.ok(original.outputFrames >= 52800);
assert.equal(measured.outputFrames, original.outputFrames);
assert.match(original.pcmSha256, /^[a-f0-9]{64}$/);
assert.equal(measured.pcmSha256, original.pcmSha256, 'Observer changed genuine produced PCM');
assert.equal(original.overlaps.length, 0);
assert.ok(measured.overlaps.length > 0);
let coveredThrough = 48000;
for (const row of measured.overlaps) {
  const [start, end] = row.outputInterval;
  assert.ok(start <= coveredThrough && end > coveredThrough, 'Missing FFT overlap coverage');
  coveredThrough = end;
  for (const offset of [row.selected, row.exhaustiveOffset])
    assert.ok(Number.isInteger(offset) && offset >= 0 && offset < row.seekLength);
  assert.ok(Number.isFinite(row.selectedScore) && Number.isFinite(row.exhaustiveScore));
  assert.ok(row.exhaustiveScore >= row.selectedScore);
  for (const scores of [row.selectedAlignment, row.exhaustiveAlignment]) {
    assert.equal(scores.length, 8);
    assert.ok(scores.every((score) => score === null || (Number.isFinite(score) && Math.abs(score) <= 1.0000001)));
  }
}
assert.ok(coveredThrough >= 52800, 'Incomplete failing FFT interval coverage');
console.log(JSON.stringify({ diagnosticOnly: true, identicalProducedPcm: true, report: measured }, null, 2));
