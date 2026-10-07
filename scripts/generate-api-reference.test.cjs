const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const run = () => spawnSync(process.execPath, ['scripts/generate-api-reference.cjs', '--check'], { cwd: root, encoding: 'utf8' });
assert.equal(run().status, 0, 'complete reference must pass');
const coveragePath = path.join(root, 'internal-docs/api-reference/coverage.json');
const savedCoverage = fs.readFileSync(coveragePath);
try {
  fs.unlinkSync(coveragePath);
  assert.match(run().stderr, /Set API_REFERENCE_REVISION/, 'missing source revision must fail');
} finally {
  fs.writeFileSync(coveragePath, savedCoverage);
}

const spec = JSON.parse(fs.readFileSync(path.join(root, 'open-api/immich-openapi-specs.json'), 'utf8'));
assert.equal(spec.paths['/admin/cloud/ml'].get['x-immich-admin-only'], true);
const coverage = JSON.parse(fs.readFileSync(path.join(root, 'internal-docs/api-reference/coverage.json'), 'utf8'));
const page = coverage.operations.getCloudMlStatus.split('#')[0];
const section = fs.readFileSync(path.join(root, 'internal-docs/api-reference', page), 'utf8').split('## getCloudMlStatus\n')[1].split('\n## ')[0];
assert.match(section, /Admin only: `true`\./, 'getCloudMlStatus must retain its admin-only requirement');

const target = path.join(root, 'server/src/repositories/websocket.repository.ts');
const original = fs.readFileSync(target, 'utf8');
try {
  fs.writeFileSync(target, original + '\n// source drift\n');
  const result = run();
  assert.notEqual(result.status, 0, 'stale protocol source must fail');
  assert(result.stderr.includes('Generated document drift: coverage.json'), result.stderr);
} finally {
  fs.writeFileSync(target, original);
}
console.log('Verified admin-only semantics, complete coverage and refusal of protocol source drift');
