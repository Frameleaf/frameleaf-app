import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { importPlanSha256, parseImportPlan } from '../src/import-plan.js';
import { reviewedImport } from './import-plan-fixture.js';

const placements = JSON.parse(
  readFileSync(
    new URL(
      '../../server/src/library-import/fixtures/manager-plan-v2.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

test('shared original placements retain both references and a stable Server fingerprint', () => {
  assert.deepEqual(parseImportPlan(placements.plan), placements.plan);
  assert.equal(importPlanSha256(placements.plan), placements.sha256);
});

for (const scenario of [
  'adopt',
  'relocate',
  'identity',
  'hash',
  'source-path',
  'duplicate-pair',
  'missing-reference',
  'unknown-field',
]) {
  test(`refuses unsafe shared original placements: ${scenario}`, () => {
    const plan = structuredClone(placements.plan);
    const file = plan.files[1];
    switch (scenario) {
      case 'adopt':
      case 'relocate':
        file.mode = scenario;
        break;
      case 'identity':
        file.sourceIdentity.inode = '99';
        break;
      case 'hash':
        file.sha256 = 'b'.repeat(64);
        break;
      case 'source-path':
        file.sourcePath = 'different.jpg';
        break;
      case 'duplicate-pair':
        file.sourceAssetId = 'asset-1';
        break;
      case 'missing-reference':
        delete file.sourceAssetId;
        break;
      case 'unknown-field':
        file.password = 'synthetic';
        break;
    }
    assert.throws(() => parseImportPlan(plan), /import_plan_invalid/);
  });
}

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

test('refuses destination paths that collide through different reviewed roots', () => {
  const plan = structuredClone(placements.plan);
  plan.roots.push({
    ...plan.roots[1],
    id: 'nested',
    path: plan.roots[1].path + '/owner',
    inode: '99',
  });
  plan.files[1].destinationRoot = 'nested';
  plan.files[1].destinationPath = 'camera.jpg';
  assert.throws(() => parseImportPlan(plan), /import_plan_invalid/);
});
