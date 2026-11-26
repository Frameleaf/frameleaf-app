import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Backups } from '../src/backups.js';
import { KEPT_RECOVERY_POINTS, Operations } from '../src/operations.js';

// FL-1732: recovery points used to be kept forever; Manager keeps the newest few and lets the owner delete one.
const id = (n: number) => n.toString(16).padStart(64, '0');

async function fixture(count: number) {
  const directory = await mkdtemp(join(tmpdir(), 'manager-points-'));
  const store = new Store(directory);
  let points = Array.from({ length: count }, (_, n) => ({ id: id(n + 1), time: new Date(Date.UTC(2026, 0, count - n)).toISOString(), paths: ['/c'] }));
  const forgotten: string[][] = [];
  const backups = {
    list: async () => points,
    forget: async (ids: string[]) => {
      forgotten.push(ids);
      points = points.filter((p) => !ids.includes(p.id));
    },
  };
  const operations = new Operations(store, {} as never, {} as never, backups as never, [directory], {} as never);
  const cleanup = async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  };
  return { store, operations, forgotten, cleanup };
}

test('pruning keeps the newest recovery points plus the rollback point and an open operation’s point', async () => {
  const f = await fixture(9);
  try {
    // The rollback point (the 8th newest) is protected while rollback is offered.
    f.store.set('installation', { id: 'i', release: 'frameleaf-v2' });
    f.store.set('rollback-point', { update: 'u', previous: 'frameleaf-v1', installed: 'frameleaf-v2', installationId: 'i', snapshot: id(8), at: Date.now() });
    // A failed operation's checkpoint (the 7th newest) may still be needed to resume or cancel it.
    const { operation } = f.store.start('update', 'k', {});
    operation.state = 'failed';
    operation.receipts['database-checkpoint'] = id(7);
    f.store.save(operation);

    await f.operations.prune();
    assert.equal(KEPT_RECOVERY_POINTS, 5);
    assert.deepEqual(f.forgotten, [[id(6), id(9)]]);
    await f.operations.prune();
    assert.equal(f.forgotten.length, 1, 'nothing more to prune');

    await assert.rejects(f.operations.deleteRecoveryPoint(id(8)), /recovery_point_protected/);
    await f.operations.deleteRecoveryPoint(id(1));
    assert.deepEqual(f.forgotten[1], [id(1)]);
  } finally {
    await f.cleanup();
  }
});

test('forget refuses an unknown point and never overlaps a backup', async () => {
  const known = 'a'.repeat(64);
  const calls: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const execute = async (_binary: string, args: string[]) => {
    if (args.includes('snapshots'))
      return JSON.stringify(args.includes('--no-lock') ? [{ id: known, time: '2026-01-01T00:00:00Z', paths: ['/c'], tags: ['frameleaf-manager-database', 'frameleaf-canonical'] }] : []);
    calls.push(args.includes('backup') ? 'backup' : args.includes('forget') ? `forget ${args.slice(-2).join(' ')}` : args.find((a) => a === 'check') ?? '');
    if (args.includes('backup')) {
      await held;
      return JSON.stringify({ message_type: 'summary', snapshot_id: 'b'.repeat(64) });
    }
    return '';
  };
  const directory = await mkdtemp(join(tmpdir(), 'manager-forget-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, 'recovery.json'), JSON.stringify({ databaseFormat: 'frameleaf-canonical' }));
    const backups = new Backups('/repo', '/key', execute);
    await assert.rejects(backups.forget(['c'.repeat(64)]), /unknown_snapshot/);
    const snapshot = backups.snapshot(directory, 'operation');
    const forget = backups.forget([known]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls, ['backup'], 'the prune waits for the backup');
    release();
    await Promise.all([snapshot, forget]);
    assert.deepEqual(calls, ['backup', 'check', `forget --prune ${known}`]);
  } finally {
    await rm(directory, { recursive: true });
  }
});
