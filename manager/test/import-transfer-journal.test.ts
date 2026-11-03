import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ImportTransferJournal } from '../src/import-transfer-journal.js';
import { reviewedImport } from './import-plan-fixture.js';

const binding = { manifestSha256: 'a'.repeat(64), planSha256: 'b'.repeat(64) };
test('native SQLite automatic transaction rollback returns a stable error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-journal-'));
  const store = new Store(directory);
  try {
    const operation = store.start('import', 'request', {}).operation;
    const journal = new ImportTransferJournal(store);
    store.db.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON library_import_runs BEGIN SELECT RAISE(ROLLBACK,'private synthetic database detail'); END",
    );
    assert.throws(
      () => journal.begin(operation.id, binding),
      /import_journal_unavailable/,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('automatic rollback failure preserves safe refusals and redacts database details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-journal-'));
  const store = new Store(directory);
  try {
    const operation = store.start('import', 'request', {}).operation;
    const journal = new ImportTransferJournal(store);
    journal.begin(operation.id, binding);
    const exec = store.db.exec.bind(store.db);
    const patched = mock.method(store.db, 'exec', (sql: string) => {
      if (sql === 'ROLLBACK') {
        exec(sql);
        throw new Error('private rollback details');
      }
      return exec(sql);
    });
    assert.throws(
      () =>
        journal.begin(operation.id, { ...binding, planSha256: 'd'.repeat(64) }),
      /import_plan_changed/,
    );
    patched.mock.restore();
    const begin = mock.method(store.db, 'exec', (sql: string) => {
      if (sql === 'BEGIN IMMEDIATE') throw new Error('private begin details');
      return exec(sql);
    });
    assert.throws(
      () => journal.begin(operation.id, binding),
      /import_journal_unavailable/,
    );
    begin.mock.restore();
  } finally {
    mock.restoreAll();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
const file = {
  id: 'physical-file-1',
  mode: 'relocate' as const,
  sourceRoot: 'source-root',
  sourcePath: 'owner/photo.jpg',
  destinationRoot: 'destination-root',
  destinationPath: 'owner/photo.jpg',
  sha256: 'c'.repeat(64),
  bytes: '123',
  sourceIdentity: {
    device: '1',
    inode: '2',
    bytes: '123',
    mtimeNs: '4',
    ctimeNs: '5',
    links: '1',
  },
  destinationDevice: '1',
};
test('transfer intent survives restart and rollback keeps separate durable evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-journal-'));
  let store = new Store(directory);
  try {
    const { operation } = store.start('import', 'request', {});
    let journal = new ImportTransferJournal(store);
    journal.begin(operation.id, binding);
    journal.intent(operation.id, file);
    store.close();
    store = new Store(directory);
    store.interrupt();
    journal = new ImportTransferJournal(store);
    assert.equal(journal.files(operation.id)[0].state, 'intent');
    journal.verified(operation.id, file.id, {
      sha256: file.sha256,
      bytes: file.bytes,
    });
    journal.rollbackIntent(operation.id, file.id);
    assert.throws(
      () => journal.intent(operation.id, file),
      /import_transfer_state_changed/,
    );
    store.close();
    store = new Store(directory);
    journal = new ImportTransferJournal(store);
    assert.equal(journal.files(operation.id)[0].state, 'rollback-intent');
    journal.rolledBack(operation.id, file.id, {
      sha256: file.sha256,
      bytes: file.bytes,
    });
    assert.equal(journal.files(operation.id)[0].state, 'rolled-back');
    assert.throws(
      () => journal.intent(operation.id, file),
      /import_transfer_state_changed/,
    );
    assert.deepEqual(journal.files(operation.id)[0].file, file);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an intent interrupted before any effect can be cancelled using verified unchanged-source evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-journal-'));
  let store = new Store(directory);
  try {
    const { operation } = store.start('import', 'request', {});
    let journal = new ImportTransferJournal(store);
    journal.begin(operation.id, binding);
    journal.intent(operation.id, file);
    store.close();
    store = new Store(directory);
    store.interrupt();
    journal = new ImportTransferJournal(store);
    const receipt = {
      sha256: file.sha256,
      bytes: file.bytes,
      sourceIdentity: file.sourceIdentity,
      destinationAbsent: true as const,
    };
    assert.throws(
      () =>
        journal.cancelIntent(operation.id, file.id, {
          ...receipt,
          destinationAbsent: false,
        } as never),
      /import_transfer_verification_failed/,
    );
    assert.throws(
      () =>
        journal.cancelIntent(operation.id, file.id, {
          ...receipt,
          sourceIdentity: { ...file.sourceIdentity, inode: '999' },
        }),
      /import_transfer_verification_failed/,
    );
    journal.cancelIntent(operation.id, file.id, receipt);
    assert.equal(journal.files(operation.id)[0].state, 'cancelled');
    assert.throws(
      () => journal.intent(operation.id, file),
      /import_transfer_state_changed/,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('changed plans, destination collisions and unsafe relocation are refused before effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-journal-'));
  const store = new Store(directory);
  try {
    const { operation } = store.start('import', 'request', {});
    const journal = new ImportTransferJournal(store);
    journal.begin(operation.id, binding);
    journal.intent(operation.id, file);
    journal.intent(operation.id, file);
    assert.throws(
      () =>
        journal.begin(operation.id, { ...binding, planSha256: 'd'.repeat(64) }),
      /import_plan_changed/,
    );
    assert.throws(
      () => journal.intent(operation.id, { ...file, bytes: '124' }),
      /import_transfer_invalid|import_transfer_changed/,
    );
    assert.throws(
      () => journal.intent(operation.id, { ...file, id: 'other' }),
      /import_transfer_collision/,
    );
    assert.throws(
      () => journal.intent(operation.id, { ...file, destinationDevice: '2' }),
      /import_relocation_cross_filesystem/,
    );
    assert.throws(
      () => journal.intent(operation.id, { ...file, sourcePath: '../escape' }),
      /import_transfer_invalid/,
    );
    assert.equal(journal.files(operation.id).length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('checksums, activation boundary and abandonment cannot erase recovery evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-journal-'));
  const store = new Store(directory);
  try {
    const { operation } = store.start('import', 'request', {});
    const journal = new ImportTransferJournal(store);
    const review = reviewedImport([file]);
    journal.begin(operation.id, review.binding);
    journal.sealPlan(operation.id, review.plan);
    journal.intent(operation.id, file);
    assert.throws(
      () =>
        journal.verified(operation.id, file.id, {
          sha256: 'd'.repeat(64),
          bytes: file.bytes,
        }),
      /import_transfer_verification_failed/,
    );
    assert.throws(
      () => journal.verified(operation.id, file.id, undefined as never),
      /import_transfer_verification_failed/,
    );
    assert.throws(
      () => journal.writersStarting(operation.id),
      /import_transfers_unverified/,
    );
    journal.verified(operation.id, file.id, {
      sha256: file.sha256,
      bytes: file.bytes,
    });
    journal.recordVerification(operation.id, review.verification);
    journal.writersStarting(operation.id);
    assert.throws(
      () => journal.rollbackIntent(operation.id, file.id),
      /import_post_activation_recovery_required/,
    );
    journal.abandon(operation.id);
    assert.equal(journal.files(operation.id).length, 1);
    assert.throws(() => journal.intent(operation.id, file), /import_abandoned/);
    assert.throws(
      () => store.start('import', 'next', {}),
      /operation_in_progress/,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('competing journal instances serialize state changes and refuse operations outside the import lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-journal-'));
  const first = new Store(directory),
    second = new Store(directory);
  try {
    const { operation } = first.start('import', 'request', {});
    const a = new ImportTransferJournal(first),
      b = new ImportTransferJournal(second);
    a.begin(operation.id, binding);
    a.intent(operation.id, file);
    b.verified(operation.id, file.id, {
      sha256: file.sha256,
      bytes: file.bytes,
    });
    a.rollbackIntent(operation.id, file.id);
    assert.throws(
      () =>
        b.verified(operation.id, file.id, {
          sha256: file.sha256,
          bytes: file.bytes,
        }),
      /import_transfer_state_changed/,
    );
    assert.throws(
      () => b.begin('missing', binding),
      /import_operation_not_owned/,
    );
    operation.state = 'complete';
    first.save(operation);
    assert.throws(
      () =>
        a.rolledBack(operation.id, file.id, {
          sha256: file.sha256,
          bytes: file.bytes,
        }),
      /import_operation_not_owned/,
    );
    assert.equal(a.files(operation.id)[0].state, 'rollback-intent');
    const other = first.start('backup', 'backup', {}).operation;
    assert.throws(
      () => a.begin(other.id, binding),
      /import_operation_not_owned/,
    );
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared original placements survive restart with independent rollback receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'import-placements-'));
  let store = new Store(directory);
  try {
    const { operation } = store.start('import', 'placements', {});
    const { importPlanSha256 } = await import('../src/import-plan.js');
    const first = {
      ...file,
      id: 'placement-one',
      mode: 'copy' as const,
      sourceAssetId: 'photo-one',
      sourceFileId: 'shared-file',
    };
    const second = {
      ...first,
      id: 'placement-two',
      sourceAssetId: 'photo-two',
      destinationPath: 'second/photo.jpg',
    };
    const base = reviewedImport([]).plan;
    const plan = {
      ...base,
      version: 2,
      roots: [
        {
          id: 'source-root',
          path: '/synthetic/source',
          device: '1',
          inode: '20',
        },
        {
          id: 'destination-root',
          path: '/synthetic/destination',
          device: '1',
          inode: '30',
        },
      ],
      files: [first, second],
    };
    const reviewed = {
      manifestSha256: binding.manifestSha256,
      planSha256: importPlanSha256(plan),
    };
    let journal = new ImportTransferJournal(store);
    journal.begin(operation.id, reviewed);
    journal.sealPlan(operation.id, plan);
    journal.intent(operation.id, first);
    journal.intent(operation.id, second);
    journal.verified(operation.id, first.id, {
      sha256: first.sha256,
      bytes: first.bytes,
    });
    store.close();
    store = new Store(directory);
    store.interrupt();
    journal = new ImportTransferJournal(store);
    assert.deepEqual(journal.review(operation.id).plan, plan);
    assert.deepEqual(
      journal
        .files(operation.id)
        .map(({ file, state }) => [file.sourcePath, state]),
      [
        [first.sourcePath, 'verified'],
        [first.sourcePath, 'intent'],
      ],
    );
    assert.throws(
      () =>
        journal.intent(operation.id, {
          ...second,
          sourceAssetId: 'wrong-photo',
        }),
      /import_transfer_not_planned/,
    );
    journal.verified(operation.id, second.id, {
      sha256: second.sha256,
      bytes: second.bytes,
    });
    journal.rollbackIntent(operation.id, second.id);
    journal.rolledBack(operation.id, second.id, {
      sha256: second.sha256,
      bytes: second.bytes,
    });
    assert.deepEqual(
      journal.files(operation.id).map(({ state }) => state),
      ['verified', 'rolled-back'],
    );
    assert.deepEqual(
      journal.files(operation.id).map(({ file }) => file),
      [first, second],
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
