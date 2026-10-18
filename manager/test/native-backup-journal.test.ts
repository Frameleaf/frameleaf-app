import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { digest } from '../src/contracts.js';
import { createNativeDatabaseBackup } from '../src/runtime/native-backup-journal.js';

async function fixture(work: (f: any) => Promise<void>) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'frameleaf-native-journal-')),
  );
  const store = new Store(join(root, 'manager'));
  const installation = {
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
  };
  const context = {
    installation,
    libraryId: 'dddddddddddd',
    name: 'Native library',
    release: 'frameleaf-v3.0.0-1',
  };
  const calls = { checkpoint: 0, initialize: 0, snapshot: 0, restore: 0 };
  let checkpoint: any;
  const runtime = {
    identity: {
      runtime: 'native' as const,
      installationId: installation.id,
      fingerprint: digest(installation),
    },
    start: async () => {
      throw Error('backup must not start the full application');
    },
    stop: async () => {
      throw Error('backup must not stop the full application');
    },
    checkpoint: async (id: string) => {
      calls.checkpoint++;
      assert.equal(id, checkpoint.operationId);
      return structuredClone(checkpoint);
    },
  };
  const { operation } = store.start('backup', randomUUID(), {
    ...runtime.identity,
  });
  const bytes = Buffer.from('PGDMP synthetic journal checkpoint');
  checkpoint = {
    protocolVersion: 1,
    state: 'checkpoint',
    schemaVersion: 1,
    operationId: operation.id,
    manifestSha256: installation.manifestSha256,
    sourceRevision: installation.sourceRevision,
    postgresMajor: '19',
    databaseFormat: 'frameleaf-canonical',
    dump: {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
  const owner = join(installation.state, 'checkpoints', operation.id);
  await mkdir(owner, { recursive: true, mode: 0o700 });
  await writeFile(join(owner, 'database.dump'), bytes);
  const { protocolVersion, state, ...record } = checkpoint;
  await writeFile(join(owner, 'checkpoint.json'), JSON.stringify(record));
  const snapshotId = 'f'.repeat(64);
  let captured: Record<string, Buffer> | null = null;
  const engine = {
    corruptReadback: false,
    initialize: async () => {
      calls.initialize++;
    },
    snapshot: async (directory: string, id: string) => {
      calls.snapshot++;
      assert.equal(id, operation.id);
      if (!captured)
        captured = {
          'database.dump': await readFile(join(directory, 'database.dump')),
          'recovery.json': await readFile(join(directory, 'recovery.json')),
        };
      return snapshotId;
    },
    restore: async (id: string, destination: string) => {
      calls.restore++;
      assert.equal(id, snapshotId);
      assert.ok(captured);
      await mkdir(destination, { mode: 0o700 });
      for (const [name, data] of Object.entries(captured!))
        await writeFile(join(destination, name), data);
      if (engine.corruptReadback)
        await writeFile(
          join(destination, 'database.dump'),
          'corrupt synthetic readback',
        );
    },
  };
  try {
    await work({
      root,
      store,
      context,
      runtime,
      operation,
      checkpoint,
      owner,
      engine,
      calls,
      snapshotId,
      bytes,
    });
  } finally {
    try {
      store.db.close();
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
}

function resume(store: Store) {
  const operation = store.history()[0];
  operation.state = 'running';
  operation.error = null;
  store.save(operation);
  return operation;
}

test('a durable verified backup receipt survives scratch cleanup and never regenerates a live dump on retry', async () => {
  await fixture(async (f) => {
    const result = await createNativeDatabaseBackup(
      f.store,
      f.runtime,
      f.engine,
      f.context,
      f.operation,
    );
    assert.equal(result.snapshotId, f.snapshotId);
    assert.equal(result.recovery.libraryId, f.context.libraryId);
    assert.deepEqual(f.calls, {
      checkpoint: 1,
      initialize: 1,
      snapshot: 1,
      restore: 1,
    });
    assert.equal(f.store.history()[0].state, 'running');
    assert.throws(
      () => f.store.start('start', randomUUID(), { ...f.runtime.identity }),
      /operation_in_progress/,
    );
    await rm(f.owner, { recursive: true });
    await rm(join(f.store.directory, 'native-backup-staging', f.operation.id), {
      recursive: true,
    });
    f.store.interrupt();
    const retried = await createNativeDatabaseBackup(
      f.store,
      f.runtime,
      f.engine,
      f.context,
      resume(f.store),
    );
    assert.deepEqual(retried, result);
    assert.deepEqual(f.calls, {
      checkpoint: 1,
      initialize: 1,
      snapshot: 1,
      restore: 1,
    });
    const broken = f.store.history()[0];
    broken.receipts['native-backup-verified'].snapshotId = 'invalid';
    f.store.save(broken);
    await assert.rejects(
      createNativeDatabaseBackup(
        f.store,
        f.runtime,
        f.engine,
        f.context,
        broken,
      ),
      /native_backup_journal_invalid/,
    );
    assert.equal(f.calls.checkpoint, 1);
  });
});

test('a failed verified-receipt write recovers the existing encrypted snapshot after reopening SQLite', async (t) => {
  await fixture(async (f) => {
    const original = f.store.save.bind(f.store);
    let injected = false;
    const save = t.mock.method(f.store, 'save', (operation: any) => {
      if (!injected && operation.completed.includes('native-backup-verified')) {
        injected = true;
        throw Error('synthetic journal write failure');
      }
      return original(operation);
    });
    try {
      await assert.rejects(
        createNativeDatabaseBackup(
          f.store,
          f.runtime,
          f.engine,
          f.context,
          f.operation,
        ),
        /synthetic journal write failure/,
      );
    } finally {
      save.mock.restore();
    }
    assert.ok(injected);
    assert.deepEqual(await readFile(join(f.owner, 'database.dump')), f.bytes);
    f.store.db.close();
    const reopened = new Store(f.store.directory);
    try {
      reopened.interrupt();
      const result = await createNativeDatabaseBackup(
        reopened,
        f.runtime,
        f.engine,
        f.context,
        resume(reopened),
      );
      assert.equal(result.snapshotId, f.snapshotId);
      assert.deepEqual(f.calls, {
        checkpoint: 1,
        initialize: 1,
        snapshot: 1,
        restore: 2,
      });
    } finally {
      reopened.db.close();
    }
  });
});

test('corrupt encrypted-snapshot readback cannot become a verified receipt or remove the owner checkpoint', async () => {
  await fixture(async (f) => {
    f.engine.corruptReadback = true;
    await assert.rejects(
      createNativeDatabaseBackup(
        f.store,
        f.runtime,
        f.engine,
        f.context,
        f.operation,
      ),
      /native_backup_verification_failed/,
    );
    assert.ok(
      !f.store.history()[0].completed.includes('native-backup-verified'),
    );
    assert.deepEqual(await readFile(join(f.owner, 'database.dump')), f.bytes);
    f.engine.corruptReadback = false;
    const result = await createNativeDatabaseBackup(
      f.store,
      f.runtime,
      f.engine,
      f.context,
      resume(f.store),
    );
    assert.equal(result.snapshotId, f.snapshotId);
    assert.deepEqual(f.calls, {
      checkpoint: 1,
      initialize: 1,
      snapshot: 1,
      restore: 2,
    });
  });
});

test('a preexisting verification cache without durable intent is preserved rather than adopted', async () => {
  await fixture(async (f) => {
    const cache = join(
      f.store.directory,
      'native-backup-verification',
      f.operation.id,
    );
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await writeFile(join(cache, 'database.dump'), 'retain foreign cache');
    await assert.rejects(
      createNativeDatabaseBackup(
        f.store,
        f.runtime,
        f.engine,
        f.context,
        f.operation,
      ),
      /native_backup_verification_failed/,
    );
    assert.equal(
      await readFile(join(cache, 'database.dump'), 'utf8'),
      'retain foreign cache',
    );
    assert.ok(
      !f.store.history()[0].receipts['native-backup-verification-intent'],
    );
    assert.equal(f.calls.restore, 0);
    await rm(cache, { recursive: true });
    const result = await createNativeDatabaseBackup(
      f.store,
      f.runtime,
      f.engine,
      f.context,
      resume(f.store),
    );
    assert.equal(result.snapshotId, f.snapshotId);
    assert.deepEqual(f.calls, {
      checkpoint: 1,
      initialize: 1,
      snapshot: 1,
      restore: 1,
    });
  });
});

test('a reopened journal reconciles only the partial verification cache covered by its durable intent', async (t) => {
  await fixture(async (f) => {
    const original = f.store.save.bind(f.store);
    let injected = false;
    const save = t.mock.method(f.store, 'save', (operation: any) => {
      original(operation);
      if (
        !injected &&
        operation.receipts['native-backup-verification-intent'] &&
        !operation.completed.includes('native-backup-verified')
      ) {
        injected = true;
        throw Error('synthetic crash after durable verification intent');
      }
    });
    try {
      await assert.rejects(
        createNativeDatabaseBackup(
          f.store,
          f.runtime,
          f.engine,
          f.context,
          f.operation,
        ),
        /native_backup_verification_failed/,
      );
    } finally {
      save.mock.restore();
    }
    assert.ok(injected);
    const cache = join(
      f.store.directory,
      'native-backup-verification',
      f.operation.id,
    );
    await mkdir(cache, { mode: 0o700 });
    await writeFile(
      join(cache, 'database.dump'),
      'crash-abandoned partial readback',
    );
    f.store.db.close();
    const reopened = new Store(f.store.directory);
    try {
      reopened.interrupt();
      const result = await createNativeDatabaseBackup(
        reopened,
        f.runtime,
        f.engine,
        f.context,
        resume(reopened),
      );
      assert.equal(result.snapshotId, f.snapshotId);
      assert.deepEqual(f.calls, {
        checkpoint: 1,
        initialize: 1,
        snapshot: 1,
        restore: 1,
      });
      await assert.rejects(readFile(join(cache, 'database.dump')), {
        code: 'ENOENT',
      });
      assert.deepEqual(await readFile(join(f.owner, 'database.dump')), f.bytes);
    } finally {
      reopened.db.close();
    }
  });
});
