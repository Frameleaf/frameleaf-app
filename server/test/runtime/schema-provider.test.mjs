import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getFrameleafBaselineSchema,
  getFrameleafSchema,
  verifyFrameleafSchemaSources,
} from '../../dist/schema/frameleaf-schema.js';

// The standalone SQL-tools CLI imports this build with native ESM, without application aliases.
test('compiled schema provider loads both pinned catalogs and validates source provenance', async () => {
  await verifyFrameleafSchemaSources();
  for (const schema of [getFrameleafBaselineSchema(), getFrameleafSchema()]) {
    assert.equal(schema.schemaName, 'public');
    assert.ok(schema.tables.some(({ name }) => name === 'asset'));
    assert.ok(schema.tables.some(({ name }) => name === 'job_run_item'));
    assert.deepEqual(schema.warnings, []);
  }
});
