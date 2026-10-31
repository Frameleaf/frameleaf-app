import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Backups } from '../src/backups.js';

async function fixture(
  paths: unknown,
  work: (
    backup: Backups,
    target: string,
    calls: string[][],
    root: string,
  ) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'frameleaf-native-restore-path-')),
  );
  const calls: string[][] = [];
  const id = 'f'.repeat(64);
  const backup = new Backups(
    join(root, 'repository'),
    async () => 'k'.repeat(43),
    async (_binary, args) => {
      if (args.includes('snapshots'))
        return JSON.stringify([
          {
            id,
            paths,
            time: '2026-10-17T00:00:00Z',
            tags: ['frameleaf-manager-database', 'frameleaf-canonical'],
          },
        ]);
      calls.push(args);
      return '';
    },
  );
  try {
    await work(backup, join(root, 'restored'), calls, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const label of [
  '/source/stage',
  'C:\\Frameleaf\\stage',
  '\\\\nas\\share\\stage',
]) {
  test(`restore accepts absolute source metadata ${JSON.stringify(label)} and uses only the owned target`, async () => {
    await fixture([label], async (backup, target, calls) => {
      await backup.restore('f'.repeat(64), target);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes('restore') && calls[0].includes('--verify'));
      assert.equal(calls[0][calls[0].indexOf('--target') + 1], target);
      assert.ok(!calls[0].includes(label));
    });
  });
}
for (const paths of [
  ['relative/stage'],
  ['C:relative'],
  ['relative\\stage'],
  ['bad\0path'],
  ['/source\nstage'],
  ['/source\rstage'],
  ['/' + 'x'.repeat(4096)],
  [],
  ['/one', '/two'],
  undefined,
  '/',
  [null],
  { 0: '/source', length: 1 },
]) {
  test(`restore rejects malformed source metadata ${JSON.stringify(paths)} before target creation`, async () => {
    await fixture(paths, async (backup, target, calls, root) => {
      await assert.rejects(
        backup.restore('f'.repeat(64), target),
        /unknown_snapshot/,
      );
      assert.deepEqual(calls, []);
      assert.deepEqual(await readdir(root), []);
    });
  });
}
