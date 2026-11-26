import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Refusal } from '../src/contracts.js';
import { holdsLock, Store } from '../src/store.js';

const withStore = (work: (store: Store, directory: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'manager-lock-'));
  const store = new Store(directory, { releaseFailedControl: true });
  try {
    work(store, directory);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

test('a failed Start, Stop or Restart releases the lock; other failures keep it', () => {
  for (const kind of ['start', 'stop', 'restart'] as const) assert.equal(holdsLock({ kind, state: 'failed' }), false);
  for (const kind of ['start', 'stop', 'restart'] as const) assert.equal(holdsLock({ kind, state: 'interrupted' }), true);
  for (const kind of ['backup', 'restore', 'update', 'rollback', 'import'] as const)
    assert.equal(holdsLock({ kind, state: 'failed' }), true);
  assert.equal(holdsLock({ kind: 'start', state: 'complete' }), false);
  // Native keeps it: a failed native Stop can leave the server running.
  assert.equal(holdsLock({ kind: 'stop', state: 'failed' }, false), true);
});

test('restore and backup can start after a failed Start; Resume waits for them', () => {
  withStore((store) => {
    const { operation: start } = store.start('start', 'key-start', {});
    assert.throws(() => store.start('restore', 'key-restore', { reviewId: 'r' }), (e: Refusal) => e.code === 'operation_in_progress');
    start.state = 'failed';
    start.error = 'docker_operation_failed';
    store.save(start);
    assert.equal(store.locked(), null);
    const { operation: backup, created } = store.start('backup', 'key-backup', {});
    assert.equal(created, true);
    assert.equal(store.locked()?.id, backup.id);
    const failed = store.history().find((o) => o.id === start.id)!;
    failed.state = 'running';
    assert.throws(() => store.save(failed), (e: Refusal) => e.code === 'operation_in_progress');
    backup.state = 'complete';
    store.save(backup);
    const retried = store.history().find((o) => o.id === start.id)!;
    retried.state = 'running';
    store.save(retried);
    assert.equal(store.locked()?.id, start.id);
  });
});

test('a failed Start saved by an older Manager is released when the store opens', () => {
  const directory = mkdtempSync(join(tmpdir(), 'manager-lock-'));
  try {
    const store = new Store(directory, { releaseFailedControl: true });
    const { operation } = store.start('restart', 'key-restart', {});
    operation.state = 'failed';
    // An older Manager kept active=1 for every state but complete.
    store.db.prepare('UPDATE operations SET active=1, value=? WHERE id=?').run(JSON.stringify(operation), operation.id);
    store.close();
    const reopened = new Store(directory, { releaseFailedControl: true });
    try {
      assert.equal(reopened.locked(), null);
      assert.equal(reopened.start('update', 'key-update', { reviewId: 'u' }).created, true);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
