import assert from 'node:assert/strict';
import { readFile, realpath, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256 } from '../src/contracts.js';
import { nativeBackupCommand } from '../src/runtime/native-service.js';

async function protectedEngine() {
  const executable = await realpath('/bin/echo');
  return { executable, sha256: sha256(await readFile(executable)) };
}

test(
  'native backup uses its protected descriptor with an empty PATH and literal arguments',
  { skip: process.platform === 'win32' },
  async () => {
    const binding = await protectedEngine();
    const execute = nativeBackupCommand(binding);
    binding.executable = '/must-not-adopt-a-mutated-descriptor';
    const output = await execute(
      'restic',
      ['literal;still-data', 'synthetic-argument'],
      { env: { PATH: '' } },
    );
    assert.equal(output.trim(), 'literal;still-data synthetic-argument');
  },
);

test(
  'native backup refuses changed hash, other commands and caller executable overrides before execution',
  { skip: process.platform === 'win32' },
  async () => {
    const engine = await protectedEngine();
    let effects = 0;
    const effect = async () => {
      effects++;
      return '';
    };
    await assert.rejects(
      nativeBackupCommand({ ...engine, sha256: 'f'.repeat(64) }, effect)(
        'restic',
        [],
      ),
      /native_backup_engine_changed/,
    );
    const execute = nativeBackupCommand(engine, effect);
    await assert.rejects(
      execute('docker', []),
      /native_backup_command_invalid/,
    );
    await assert.rejects(
      execute('restic', [], { executable: engine.executable }),
      /native_backup_command_invalid/,
    );
    assert.equal(effects, 0);
  },
);

test(
  'native backup does not execute a correctly hashed but user-writable engine',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'frameleaf-engine-binding-')),
    );
    try {
      const executable = join(root, 'restic');
      const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
      await writeFile(executable, bytes, { mode: 0o700 });
      let effects = 0;
      const execute = nativeBackupCommand(
        { executable, sha256: sha256(bytes) },
        async () => {
          effects++;
          return '';
        },
      );
      await assert.rejects(
        execute('restic', []),
        /native_backup_engine_changed/,
      );
      assert.equal(effects, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
