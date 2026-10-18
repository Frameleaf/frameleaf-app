import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Backups } from '../src/backups.js';

const key = 'a'.repeat(43);
test('an OS-backed backup key uses a fresh private stdin pipe without a plaintext key file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-memory-backup-'));
  try {
    const calls: string[][] = [];
    let reads = 0;
    const backups = new Backups(
      join(root, 'repo'),
      async () => {
        reads++;
        return key;
      },
      async (binary, args, options) => {
        assert.equal(binary, 'restic');
        assert.equal(options?.input, key + '\n');
        assert.equal(options?.inputFile, undefined);
        assert.equal(options?.env?.RESTIC_PASSWORD, undefined);
        assert.ok(!args.includes('--password-file') && !args.includes(key));
        calls.push(args);
        if (args.includes('snapshots')) return '[]';
        return '';
      },
    );
    await backups.initialize();
    assert.ok(calls.some((args) => args.includes('init')));
    assert.equal(await backups.recoveryKey(), key);
    await writeFile(join(root, 'repo/config'), 'encrypted repository fixture');
    assert.deepEqual(await backups.status(), {
      configured: true,
      unlocked: true,
      keyAvailable: true,
      snapshots: [],
    });
    assert.ok(reads >= calls.length);
    assert.deepEqual(await readdir(root), ['repo']);
    await assert.rejects(
      backups.unlock('b'.repeat(43)),
      /backup_key_requires_secure_persistence/,
    );
    assert.equal(await backups.recoveryKey(), key);
    assert.deepEqual(await readdir(root), ['repo']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing, malformed and locked key providers cannot initialize a repository or create fallback credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-locked-backup-'));
  try {
    for (const value of ['', 'short', key + '\n', key + 'x']) {
      let effects = 0;
      const backups = new Backups(
        join(root, 'repo'),
        async () => value,
        async () => {
          effects++;
          return '';
        },
      );
      await assert.rejects(backups.initialize(), /invalid_recovery_key/);
      assert.equal(effects, 0);
      assert.deepEqual(await readdir(root), []);
    }
    const locked = new Backups(join(root, 'repo'), async () => {
      throw Error('credential_store_locked');
    });
    await assert.rejects(locked.initialize(), /credential_store_locked/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed memory-key unlock preserves existing repository bytes and never replaces its key authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-memory-unlock-'));
  try {
    await mkdir(join(root, 'repo'));
    await writeFile(join(root, 'repo/config'), 'unchanged');
    const backups = new Backups(join(root, 'repo'), async () => key);
    await assert.rejects(
      backups.unlock('b'.repeat(43)),
      /backup_key_requires_secure_persistence/,
    );
    assert.equal(
      await readFile(join(root, 'repo/config'), 'utf8'),
      'unchanged',
    );
    assert.equal(await backups.recoveryKey(), key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
