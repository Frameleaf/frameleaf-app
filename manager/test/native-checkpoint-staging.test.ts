import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as filesystem } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdtemp,
  link,
  rename,
  symlink,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as staging from '../src/runtime/native-checkpoint-staging.js';
import { stageNativeCheckpoint } from '../src/runtime/native-checkpoint-staging.js';

async function fixture(work: (f: any) => Promise<void>) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'frameleaf-native-stage-')),
  );
  const operation = {
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: 1760000000000,
  };
  const context = {
    operation,
    libraryId: 'dddddddddddd',
    name: 'Native library',
    release: 'frameleaf-v3.0.0-1',
    installation: {
      runtime: 'native' as const,
      id: 'aaaaaaaaaaaa',
      controller: join(root, 'controller'),
      candidate: join(root, 'runtime'),
      state: join(root, 'state'),
      manifestSha256: 'b'.repeat(64),
      sourceRevision: 'c'.repeat(40),
      certified: false,
      databasePort: 54329,
      apiPort: 2283,
    },
  };
  const bytes = Buffer.from('PGDMP synthetic checkpoint');
  const checkpoint = {
    protocolVersion: 1,
    state: 'checkpoint',
    schemaVersion: 1,
    operationId: operation.id,
    manifestSha256: context.installation.manifestSha256,
    sourceRevision: context.installation.sourceRevision,
    postgresMajor: '19',
    databaseFormat: 'frameleaf-canonical',
    dump: {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
  const { protocolVersion, state, ...record } = checkpoint;
  const owner = join(context.installation.state, 'checkpoints', operation.id);
  const manager = join(root, 'manager');
  await mkdir(owner, { recursive: true, mode: 0o700 });
  await mkdir(manager, { mode: 0o700 });
  await writeFile(join(owner, 'database.dump'), bytes);
  await writeFile(join(owner, 'checkpoint.json'), JSON.stringify(record));
  try {
    await work({ root, operation, context, checkpoint, owner, manager, bytes });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('native staging copies the verified dump and recovery record without changing the immutable owner directory', async () => {
  await fixture(async ({ context, checkpoint, owner, manager, bytes }) => {
    const before = await readFile(join(owner, 'checkpoint.json'));
    const result = await stageNativeCheckpoint(manager, context, checkpoint);
    assert.equal(
      result.directory,
      join(manager, 'native-backup-staging', context.operation.id),
    );
    assert.deepEqual((await readdir(result.directory)).sort(), [
      'database.dump',
      'recovery.json',
    ]);
    assert.deepEqual(
      await readFile(join(result.directory, 'database.dump')),
      bytes,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(result.directory, 'recovery.json'), 'utf8'),
      ),
      result.recovery,
    );
    assert.deepEqual((await readdir(owner)).sort(), [
      'checkpoint.json',
      'database.dump',
    ]);
    assert.deepEqual(await readFile(join(owner, 'checkpoint.json')), before);
    assert.deepEqual(
      await stageNativeCheckpoint(manager, context, checkpoint),
      result,
    );
  });
});

test('native staging refuses changed owner bytes, foreign disk receipts, extra owner files and oversized metadata', async () => {
  for (const mode of ['dump', 'receipt', 'extra', 'oversized'])
    await fixture(async ({ context, checkpoint, owner, manager }) => {
      if (mode === 'dump')
        await writeFile(join(owner, 'database.dump'), 'changed');
      if (mode === 'receipt') {
        const { protocolVersion, state, ...record } = checkpoint;
        await writeFile(
          join(owner, 'checkpoint.json'),
          JSON.stringify({
            ...record,
            operationId: '22222222-2222-4222-8222-222222222222',
          }),
        );
      }
      if (mode === 'extra') await writeFile(join(owner, 'foreign'), 'retain');
      if (mode === 'oversized')
        await writeFile(join(owner, 'checkpoint.json'), ' '.repeat(4097));
      await assert.rejects(
        stageNativeCheckpoint(manager, context, checkpoint),
        /native_checkpoint_changed/,
      );
      assert.ok((await readdir(owner)).includes('database.dump'));
      if (mode === 'extra')
        assert.equal(await readFile(join(owner, 'foreign'), 'utf8'), 'retain');
    });
});

test('native staging refuses an existing changed stage rather than overwriting or deleting it', async () => {
  await fixture(async ({ context, checkpoint, manager }) => {
    const first = await stageNativeCheckpoint(manager, context, checkpoint);
    await writeFile(
      join(first.directory, 'database.dump'),
      'retain changed stage',
    );
    await assert.rejects(
      stageNativeCheckpoint(manager, context, checkpoint),
      /native_checkpoint_changed/,
    );
    assert.equal(
      await readFile(join(first.directory, 'database.dump'), 'utf8'),
      'retain changed stage',
    );
  });
});

test('invalid checkpoint requests fail before creating a stage or accepting caller paths', async () => {
  await fixture(async ({ context, checkpoint, manager }) => {
    await assert.rejects(
      stageNativeCheckpoint(
        manager,
        { ...context, operation: { ...context.operation, id: '../escape' } },
        checkpoint,
      ),
      /native_recovery_invalid/,
    );
    assert.deepEqual(await readdir(manager), []);
  });
});

for (const mode of [
  'source-file',
  'source-directory',
  'stage-root',
  'hardlink',
]) {
  test(`native staging refuses ${mode} links without changing their targets`, async (t) => {
    await fixture(
      async ({ root, context, checkpoint, owner, manager, bytes }) => {
        const retained = join(root, 'retained');
        try {
          if (mode === 'source-directory') {
            await rename(owner, retained);
            await symlink(
              retained,
              owner,
              process.platform === 'win32' ? 'junction' : 'dir',
            );
          } else if (mode === 'stage-root') {
            await mkdir(retained, { mode: 0o700 });
            await writeFile(join(retained, 'sentinel'), 'retain foreign data');
            await symlink(
              retained,
              join(manager, 'native-backup-staging'),
              process.platform === 'win32' ? 'junction' : 'dir',
            );
          } else {
            await rename(join(owner, 'database.dump'), retained);
            if (mode === 'hardlink')
              await link(retained, join(owner, 'database.dump'));
            else await symlink(retained, join(owner, 'database.dump'), 'file');
          }
        } catch (error) {
          if (
            process.platform === 'win32' &&
            ['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          ) {
            t.skip('test account cannot create this link type');
            return;
          }
          throw error;
        }
        await assert.rejects(
          stageNativeCheckpoint(manager, context, checkpoint),
          /native_checkpoint_changed/,
        );
        if (mode === 'stage-root') {
          assert.deepEqual(await readdir(retained), ['sentinel']);
          assert.equal(
            await readFile(join(retained, 'sentinel'), 'utf8'),
            'retain foreign data',
          );
        } else
          assert.deepEqual(
            await readFile(
              mode === 'source-directory'
                ? join(retained, 'database.dump')
                : retained,
            ),
            bytes,
          );
      },
    );
  });
}

test('an interrupted copy removes only its own scratch and preserves foreign partials and owner bytes', async (t) => {
  await fixture(async ({ context, checkpoint, owner, manager, bytes }) => {
    const root = join(manager, 'native-backup-staging');
    await mkdir(root, { mode: 0o700 });
    const foreign = join(root, 'foreign.partial');
    await mkdir(foreign);
    await writeFile(join(foreign, 'sentinel'), 'retain');
    const copy = t.mock.method(
      filesystem,
      'copyFile',
      async (_source, destination) => {
        await writeFile(destination, 'partial dump', {
          flag: 'wx',
          mode: 0o600,
        });
        throw Object.assign(new Error('synthetic storage failure'), {
          code: 'ENOSPC',
        });
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        stageNativeCheckpoint(manager, context, checkpoint),
        /native_checkpoint_changed/,
      );
      assert.equal(copy.mock.callCount(), 1);
      assert.deepEqual(await readdir(root), ['foreign.partial']);
      assert.equal(await readFile(join(foreign, 'sentinel'), 'utf8'), 'retain');
      assert.deepEqual(await readFile(join(owner, 'database.dump')), bytes);
    } finally {
      copy.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test('a source change after copying is refused and cannot publish a mismatched recovery stage', async (t) => {
  await fixture(async ({ context, checkpoint, owner, manager }) => {
    const original = filesystem.copyFile;
    const copy = t.mock.method(
      filesystem,
      'copyFile',
      async (...args: Parameters<typeof filesystem.copyFile>) => {
        await original(...args);
        await writeFile(args[0], 'synthetic concurrent source change');
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        stageNativeCheckpoint(manager, context, checkpoint),
        /native_checkpoint_changed/,
      );
      assert.equal(copy.mock.callCount(), 1);
      assert.deepEqual(
        await readdir(join(manager, 'native-backup-staging')),
        [],
      );
      assert.equal(
        await readFile(join(owner, 'database.dump'), 'utf8'),
        'synthetic concurrent source change',
      );
    } finally {
      copy.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test('completed staging cleanup removes only verified Manager copies and is idempotent', async () => {
  await fixture(async (f) => {
    const stage = await stageNativeCheckpoint(
      f.manager,
      f.context,
      f.checkpoint,
    );
    assert.equal(typeof staging.cleanupNativeCheckpointStage, 'function');
    const cleaned = await staging.cleanupNativeCheckpointStage(
      f.manager,
      stage.recovery,
    );
    assert.equal(cleaned.directory, stage.directory);
    await assert.rejects(readdir(stage.directory), { code: 'ENOENT' });
    assert.deepEqual(
      await staging.cleanupNativeCheckpointStage(f.manager, stage.recovery),
      cleaned,
    );
    assert.deepEqual(await readFile(join(f.owner, 'database.dump')), f.bytes);
  });
});

for (const changed of ['dump', 'metadata', 'unknown', 'hardlink']) {
  test(`staging cleanup preserves ${changed} instead of adopting changed data`, async () => {
    await fixture(async (f) => {
      const stage = await stageNativeCheckpoint(
        f.manager,
        f.context,
        f.checkpoint,
      );
      assert.equal(typeof staging.cleanupNativeCheckpointStage, 'function');
      if (changed === 'dump')
        await writeFile(
          join(stage.directory, 'database.dump'),
          'foreign bytes',
        );
      if (changed === 'metadata')
        await writeFile(join(stage.directory, 'recovery.json'), '{}');
      if (changed === 'unknown')
        await writeFile(join(stage.directory, 'foreign'), 'keep');
      if (changed === 'hardlink')
        await link(
          join(stage.directory, 'database.dump'),
          join(f.root, 'external-copy'),
        );
      const before = await readdir(stage.directory);
      await assert.rejects(
        staging.cleanupNativeCheckpointStage(f.manager, stage.recovery),
        /native_checkpoint_changed/,
      );
      assert.deepEqual(await readdir(stage.directory), before);
      assert.deepEqual(await readFile(join(f.owner, 'database.dump')), f.bytes);
    });
  });
}

test('interrupted staging deletion resumes a matching known-file partial', async () => {
  await fixture(async (f) => {
    const stage = await stageNativeCheckpoint(
      f.manager,
      f.context,
      f.checkpoint,
    );
    assert.equal(typeof staging.cleanupNativeCheckpointStage, 'function');
    const original = filesystem.rm;
    filesystem.rm = async (...args) => {
      if (args[0] === join(stage.directory, 'database.dump'))
        throw Object.assign(Error('synthetic unlink interruption'), {
          code: 'EIO',
        });
      return original(...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        staging.cleanupNativeCheckpointStage(f.manager, stage.recovery),
        /native_checkpoint_changed/,
      );
    } finally {
      filesystem.rm = original;
      syncBuiltinESMExports();
    }
    assert.deepEqual(await readdir(stage.directory), ['database.dump']);
    await staging.cleanupNativeCheckpointStage(f.manager, stage.recovery);
    await assert.rejects(readdir(stage.directory), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(f.owner, 'database.dump')), f.bytes);
  });
});
