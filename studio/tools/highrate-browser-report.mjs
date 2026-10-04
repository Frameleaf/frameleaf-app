import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [file] = process.argv.slice(2);
assert.ok(file, 'Provide the mandatory native high-rate Vitest JSON report');
const report = JSON.parse(await readFile(file, 'utf8'));
assert.equal(report.success, true);
assert.equal(report.numTotalTests, 8);
assert.equal(report.numPassedTests, 8);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
assert.equal(report.testResults.length, 1);
const cases = report.testResults.flatMap((suite) => suite.assertionResults);
assert.equal(cases.length, 8);
const expected = [1, 2, 6, 8].flatMap((channels) => [1, 15].map((frames) =>
  `${channels} decoded planes at 192 kHz speed 1.5/pitch +12 retain a ${frames}-frame clip`));
assert.deepEqual(cases.map((entry) => entry.title).sort(), expected.sort());
for (const entry of cases) {
  assert.equal(entry.status, 'passed');
  assert.deepEqual(entry.ancestorTitles, ['FL-103 actual high-rate pitch-up export']);
  assert.deepEqual(entry.failureMessages, []);
}
console.log('Native Chromium high-rate export: exactly 8 passed, 0 skipped/todo/failed.');
