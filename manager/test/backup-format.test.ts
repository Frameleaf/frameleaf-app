import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backups } from '../src/backups.js';

test('source-only repositories retain exportable keys and an invalid unlock leaves the existing key intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-backup-key-')),
    repo = join(directory, 'repo'),
    key = join(directory, 'key');
  await mkdir(repo);
  await writeFile(join(repo, 'config'), 'fixture');
  const backups = new Backups(repo, key, async (_binary, args) => {
    if (args.includes('snapshots'))
      return JSON.stringify([{ id: 'a'.repeat(64), tags: ['frameleaf-manager-database', 'immich-source'] }]);
    throw Error('wrong key');
  });
  try {
    assert.deepEqual(await backups.status(), { configured: true, unlocked: false, keyAvailable: false, snapshots: [] });
    await writeFile(key, 'existing private key');
    assert.deepEqual(await backups.status(), { configured: true, unlocked: true, keyAvailable: true, snapshots: [] });
    await assert.rejects(backups.unlock('a'.repeat(43)), /wrong key/);
    assert.equal(await readFile(key, 'utf8'), 'existing private key');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ordinary restore lists canonical snapshots only and refuses source, mixed and untyped snapshots', async () => {
  const snapshots = [
    { id: 'a'.repeat(64), tags: ['frameleaf-manager-database', 'frameleaf-canonical'] },
    { id: 'b'.repeat(64), tags: ['frameleaf-manager-database', 'immich-source'] },
    { id: 'c'.repeat(64), tags: ['frameleaf-manager-database'] },
    { id: 'd'.repeat(64), tags: ['frameleaf-manager-database', 'frameleaf-canonical', 'immich-source'] },
  ].map((s) => ({ ...s, time: '2026-10-04T12:00:00Z', paths: ['/checkpoint'] }));
  const execute = async (_binary: string, args: string[]) => {
    assert.equal(args.includes('restore'), false);
    assert.equal(args.at(-1), 'frameleaf-manager-database,frameleaf-canonical');
    return JSON.stringify(snapshots);
  };
  const backups = new Backups('/repo', '/key', execute);
  assert.deepEqual(
    (await backups.list()).map((s) => s.id),
    [snapshots[0].id],
  );
  for (const snapshot of snapshots.slice(1))
    await assert.rejects(backups.restore(snapshot.id, '/unused-destination'), /unknown_snapshot/);
});

test('checkpoint database format determines its tag and unknown formats never reach Restic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-backup-format-'));
  const calls: string[][] = [];
  const execute = async (_binary: string, args: string[]) => {
    calls.push(args);
    if (args.includes('snapshots')) return '[]';
    if (args.includes('backup')) return JSON.stringify({ message_type: 'summary', snapshot_id: 'a'.repeat(64) });
    return '';
  };
  const backups = new Backups('/repo', '/key', execute);
  try {
    for (const format of ['frameleaf-canonical', 'immich-source']) {
      calls.length = 0;
      await writeFile(join(directory, 'recovery.json'), JSON.stringify({ databaseFormat: format }));
      assert.equal(await backups.snapshot(directory, 'operation'), 'a'.repeat(64));
      const backup = calls.find((args) => args.includes('backup'))!;
      assert.ok(backup.includes(format));
      assert.equal(backup.at(-1), '.');
      assert.ok(calls.some((args) => args.includes('check') && args.includes('--read-data')));
    }
    for (const format of [undefined, null, 'other-database']) {
      calls.length = 0;
      await writeFile(join(directory, 'recovery.json'), JSON.stringify({ databaseFormat: format }));
      await assert.rejects(backups.snapshot(directory, 'operation'), /unknown_checkpoint_database_format/);
      assert.equal(calls.length, 0);
    }
    await writeFile(join(directory, 'recovery.json'), JSON.stringify({ databaseFormat: 'frameleaf-canonical' }));
    const mismatched = new Backups('/repo', '/key', async () =>
      JSON.stringify([
        { id: 'b'.repeat(64), paths: [directory], tags: ['frameleaf-manager-database', 'immich-source'] },
      ]),
    );
    await assert.rejects(mismatched.snapshot(directory, 'operation'), /invalid_operation_backup/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
