import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importPlanSha256, parseImportPlan } from '../src/import-plan.js';
import { reviewedImport } from './import-plan-fixture.js';

test('owner mappings reject destination UUID aliases before file transfer', () => {
  const { plan } = reviewedImport([]);
  plan.owners = [
    {
      sourceId: 'alice',
      destinationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    { sourceId: 'bob', destinationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
  ];
  assert.throws(() => parseImportPlan(plan), /import_plan_invalid/);
  assert.throws(() => importPlanSha256(plan), /import_plan_invalid/);
});

test('distinct owners retain their reviewed UUID spelling and fingerprint', () => {
  const { plan } = reviewedImport([]);
  plan.owners = [
    {
      sourceId: 'alice',
      destinationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    },
    { sourceId: 'bob', destinationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  ];
  assert.deepEqual(parseImportPlan(plan).owners, plan.owners);
  const before = importPlanSha256(plan);
  assert.equal(
    before,
    '0effc02453cd5898d18dd3442eb55cc493d7d7d572e9ba6a96d2a8da861dd9d3',
  );
  assert.equal(
    importPlanSha256({ ...plan, owners: structuredClone(plan.owners) }),
    before,
  );
});
