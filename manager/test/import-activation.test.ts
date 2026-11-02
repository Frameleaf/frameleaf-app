import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ImportTransferJournal } from '../src/import-transfer-journal.js';
import { importPlanSha256 } from '../src/import-plan.js';

const digest = 'a'.repeat(64);
const file = {
  id: 'original',
  mode: 'copy' as const,
  sourceRoot: 'source',
  sourcePath: 'original.jpg',
  destinationRoot: 'destination',
  destinationPath: 'original.jpg',
  sha256: digest,
  bytes: '123',
  destinationDevice: '2',
  sourceIdentity: {
    device: '1',
    inode: '4',
    bytes: '123',
    mtimeNs: '5',
    ctimeNs: '6',
    links: '1',
  },
};
const plan = {
  version: 1 as const,
  source: {
    kind: 'photoview' as const,
    version: '2.4.0',
    identity: 'synthetic-catalog',
    revision: 'frozen-1',
    schemaSha256: digest,
  },
  destinationId: '11111111-1111-4111-8111-111111111111',
  owners: [
    {
      sourceId: 'alice',
      destinationId: '22222222-2222-4222-8222-222222222222',
    },
  ],
  roots: [
    { id: 'source', path: '/synthetic/source', device: '1', inode: '2' },
    {
      id: 'destination',
      path: '/synthetic/destination',
      device: '2',
      inode: '3',
    },
  ],
  files: [file],
};
const binding = {
  manifestSha256: digest,
  planSha256: importPlanSha256(plan),
};
const comparison = { expectedSha256: digest, actualSha256: digest };
const verification = {
  ...binding,
  records: comparison,
  relationships: comparison,
  permissions: comparison,
  regenerationRunId: '33333333-3333-4333-8333-333333333333',
};

test('activation requires the whole reviewed inventory and matching reconciliation receipts across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-activation-'));
  let store = new Store(directory);
  try {
    const { operation } = store.start('import', 'reviewed', {});
    let journal = new ImportTransferJournal(store);
    journal.begin(operation.id, binding);
    assert.throws(
      () => journal.writersStarting(operation.id),
      /import_plan_not_sealed/,
    );
    journal.sealPlan(operation.id, plan);
    assert.throws(
      () => journal.writersStarting(operation.id),
      /import_transfers_unverified/,
    );
    journal.intent(operation.id, file);
    journal.verified(operation.id, file.id, { sha256: digest, bytes: '123' });
    assert.throws(
      () => journal.writersStarting(operation.id),
      /import_reconciliation_missing/,
    );
    assert.throws(
      () =>
        journal.recordVerification(operation.id, {
          ...verification,
          permissions: { ...comparison, actualSha256: 'b'.repeat(64) },
        }),
      /import_reconciliation_failed/,
    );
    journal.recordVerification(operation.id, verification);
    store.close();
    store = new Store(directory);
    store.interrupt();
    journal = new ImportTransferJournal(store);
    assert.deepEqual(journal.review(operation.id), { plan, verification });
    journal.sealPlan(operation.id, plan);
    journal.writersStarting(operation.id);
    assert.throws(
      () => journal.rollbackIntent(operation.id, file.id),
      /import_post_activation_recovery_required/,
    );
    journal.abandon(operation.id);
    assert.deepEqual(journal.review(operation.id), { plan, verification });
    assert.equal(journal.files(operation.id).length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('changed source, owners, roots and transfer inventories cannot reuse a reviewed plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-activation-'));
  const store = new Store(directory);
  try {
    const { operation } = store.start('import', 'reviewed', {});
    const journal = new ImportTransferJournal(store);
    journal.begin(operation.id, binding);
    for (const changed of [
      { ...plan, source: { ...plan.source, revision: 'changed' } },
      { ...plan, owners: [{ ...plan.owners[0], sourceId: 'bob' }] },
      { ...plan, roots: [{ ...plan.roots[0], inode: '99' }, plan.roots[1]] },
      { ...plan, files: [] },
    ])
      assert.throws(
        () => journal.sealPlan(operation.id, changed),
        /import_plan_changed/,
      );
    journal.sealPlan(operation.id, plan);
    assert.throws(
      () => journal.intent(operation.id, { ...file, id: 'unexpected' }),
      /import_transfer_not_planned/,
    );
    assert.throws(
      () => journal.intent(operation.id, { ...file, sha256: 'b'.repeat(64) }),
      /import_transfer_not_planned/,
    );
    assert.throws(
      () => journal.recordVerification(operation.id, verification),
      /import_transfers_unverified/,
    );
    journal.intent(operation.id, file);
    journal.verified(operation.id, file.id, { sha256: digest, bytes: '123' });
    assert.throws(
      () =>
        journal.recordVerification(operation.id, {
          ...verification,
          manifestSha256: 'c'.repeat(64),
        }),
      /import_reconciliation_failed/,
    );
    journal.recordVerification(operation.id, verification);
    journal.rollbackIntent(operation.id, file.id);
    assert.throws(
      () => journal.writersStarting(operation.id),
      /import_transfers_unverified/,
    );
    assert.deepEqual(journal.review(operation.id), { plan, verification });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid plans cannot hide duplicate owners, unsafe roots or missing file roots', () => {
  for (const changed of [
    { ...plan, owners: [plan.owners[0], plan.owners[0]] },
    {
      ...plan,
      owners: [plan.owners[0], { ...plan.owners[0], sourceId: 'bob' }],
    },
    {
      ...plan,
      roots: [
        { ...plan.roots[0], path: '/synthetic/../outside' },
        plan.roots[1],
      ],
    },
    { ...plan, roots: [plan.roots[0]] },
    { ...plan, files: [file, file] },
    { ...plan, source: { ...plan.source, password: 'must-not-be-persisted' } },
  ])
    assert.throws(() => importPlanSha256(changed), /import_plan_invalid/);
});

test('sealing refuses existing unplanned intents without losing recovery records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-activation-'));
  const first = new Store(directory),
    second = new Store(directory);
  try {
    const { operation } = first.start('import', 'reviewed', {});
    const a = new ImportTransferJournal(first),
      b = new ImportTransferJournal(second);
    a.begin(operation.id, binding);
    a.intent(operation.id, { ...file, id: 'unplanned' });
    assert.throws(
      () => b.sealPlan(operation.id, plan),
      /import_transfer_not_planned/,
    );
    assert.deepEqual(a.review(operation.id), {
      plan: null,
      verification: null,
    });
    assert.equal(a.files(operation.id).length, 1);
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a competing verifier cannot replace retained reconciliation evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-activation-'));
  const first = new Store(directory),
    second = new Store(directory);
  try {
    const { operation } = first.start('import', 'reviewed', {});
    const a = new ImportTransferJournal(first),
      b = new ImportTransferJournal(second);
    a.begin(operation.id, binding);
    a.intent(operation.id, file);
    b.sealPlan(operation.id, plan);
    assert.throws(
      () => a.intent(operation.id, { ...file, id: 'unplanned' }),
      /import_transfer_not_planned/,
    );
    b.verified(operation.id, file.id, { sha256: digest, bytes: '123' });
    a.recordVerification(operation.id, verification);
    b.recordVerification(operation.id, verification);
    assert.throws(
      () =>
        b.recordVerification(operation.id, {
          ...verification,
          regenerationRunId: '44444444-4444-4444-8444-444444444444',
        }),
      /import_reconciliation_changed/,
    );
    assert.deepEqual(a.review(operation.id), { plan, verification });
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
