import assert from 'node:assert/strict';
import test from 'node:test';

test('compiled desktop database diagnostics load through native ESM', async () => {
  const { getKyselyConfig } = await import('../../dist/utils/database.js');
  assert.equal(typeof getKyselyConfig, 'function');
});
