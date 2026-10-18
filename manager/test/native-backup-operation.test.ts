import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { digest, Refusal } from '../src/contracts.js';
import { NativeService } from '../src/runtime/native-service.js';
import { NativeOperations } from '../src/runtime/native.js';
import { runNativeDatabaseBackup } from '../src/runtime/native-backup-operation.js';

async function fixture(run, initiallyRunning = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'frameleaf-backup-operation-')),
  );
  const store = new Store(join(root, 'manager'));
  const installation = {
    runtime: 'native',
    id: 'a'.repeat(12),
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
    libraryId: 'd'.repeat(12),
    name: 'Native library',
    release: 'frameleaf-v3.0.0-1',
  };
  const counts = { start: 0, stop: 0, checkpoint: 0, snapshot: 0, cleanup: 0 };
  const bytes = Buffer.from('PGDMP synthetic operation checkpoint');
  let live = initiallyRunning ? 'server' : 'stopped',
    captured,
    failSnapshot = false,
    failStop = false;
  const runtime = {
    identity: {
      runtime: 'native',
      installationId: installation.id,
      fingerprint: digest(installation),
    },
    status: () =>
      live === 'faulted'
        ? { state: 'unknown', code: 'native_shutdown_unconfirmed' }
        : live === 'server'
          ? { state: 'running' }
          : live === 'database'
            ? { state: 'unknown', code: 'native_database_maintenance' }
            : { state: 'stopped' },
    start: async () => {
      throw Error('backup must not start the application');
    },
    startRestorePreparation: async () => {
      throw new Refusal('native_restore_unavailable');
    },
    prepareRestore: async () => {
      throw new Refusal('native_restore_unavailable');
    },
    startCheckpointCleanup: async () => {
      live = 'cleanup';
      return {
        protocolVersion: 1,
        state: 'checkpoint-cleanup-ready',
        manifestSha256: installation.manifestSha256,
        sourceRevision: installation.sourceRevision,
        certified: false,
      };
    },
    startDatabase: async () => {
      counts.start++;
      const operation = store.history()[0];
      assert.equal(operation.state, 'running');
      assert.equal(operation.step, 'native-backup-start-database');
      assert.deepEqual(
        operation.receipts['native-backup-database-intent'],
        runtime.identity,
      );
      live = 'database';
      return {
        protocolVersion: 1,
        state: 'database-ready',
        manifestSha256: installation.manifestSha256,
        sourceRevision: installation.sourceRevision,
        certified: false,
      };
    },
    stop: async () => {
      counts.stop++;
      assert.equal(store.history()[0].state, 'running');
      assert.throws(
        () => store.start('stop', 'concurrent-stop', {}),
        /operation_in_progress/,
      );
      live = 'stopped';
      if (failStop) {
        failStop = false;
        live = 'faulted';
        throw new Refusal('native_shutdown_unconfirmed');
      }
      return { protocolVersion: 1, state: 'stopped' };
    },
    checkpoint: async (operationId) => {
      counts.checkpoint++;
      assert.notEqual(live, 'stopped');
      const receipt = {
        schemaVersion: 1,
        operationId,
        manifestSha256: installation.manifestSha256,
        sourceRevision: installation.sourceRevision,
        postgresMajor: '19',
        databaseFormat: 'frameleaf-canonical',
        dump: {
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      };
      const directory = join(installation.state, 'checkpoints', operationId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, 'database.dump'), bytes, { mode: 0o600 });
      await writeFile(
        join(directory, 'checkpoint.json'),
        JSON.stringify(receipt),
        { mode: 0o600 },
      );
      return { protocolVersion: 1, state: 'checkpoint', ...receipt };
    },
    cleanupCheckpoint: async (receipt) => {
      counts.cleanup++;
      assert.notEqual(live, 'stopped');
      const directory = join(
        installation.state,
        'checkpoints',
        receipt.operationId,
      );
      for (const name of ['checkpoint.json', 'database.dump'])
        await unlink(join(directory, name));
      await rmdir(directory);
      return { ...receipt, state: 'checkpoint-cleaned' };
    },
  };
  const engine = {
    initialize: async () => {},
    snapshot: async (directory) => {
      counts.snapshot++;
      if (failSnapshot) {
        failSnapshot = false;
        throw new Refusal('synthetic_snapshot_failure');
      }
      captured = Object.fromEntries(
        await Promise.all(
          ['database.dump', 'recovery.json'].map(async (n) => [
            n,
            await readFile(join(directory, n)),
          ]),
        ),
      );
      return 'f'.repeat(64);
    },
    restore: async (id, destination) => {
      assert.equal(id, 'f'.repeat(64));
      await mkdir(destination, { mode: 0o700 });
      for (const [name, data] of Object.entries(captured))
        await writeFile(join(destination, name), data, { mode: 0o600 });
    },
  };
  const operations = new NativeOperations(store, runtime, (operation) =>
    runNativeDatabaseBackup(store, runtime, engine, context, operation),
  );
  try {
    await run({
      store,
      runtime,
      engine,
      context,
      operations,
      counts,
      failSnapshot: () => {
        failSnapshot = true;
      },
      failStop: () => {
        failStop = true;
      },
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('offline native backup holds the lock through verified cleanup and temporary database shutdown', async () => {
  await fixture(async ({ store, operations, counts }) => {
    const op = operations.control('backup', 'offline');
    assert.equal(operations.control('backup', 'offline').id, op.id);
    assert.equal((await operations.wait(op.id)).state, 'complete');
    assert.deepEqual(counts, {
      start: 1,
      stop: 1,
      checkpoint: 1,
      snapshot: 1,
      cleanup: 1,
    });
    assert.equal(
      store.history()[0].receipts['native-backup-stop-database'].state,
      'stopped',
    );
    assert.equal(store.start('stop', 'after-complete', {}).created, true);
  });
});

test('an attached application owner stays running throughout a native backup', async () => {
  await fixture(async ({ operations, runtime, counts }) => {
    const op = operations.control('backup', 'online');
    assert.equal((await operations.wait(op.id)).state, 'complete');
    assert.deepEqual(counts, {
      start: 0,
      stop: 0,
      checkpoint: 1,
      snapshot: 1,
      cleanup: 1,
    });
    assert.deepEqual(runtime.status(), { state: 'running' });
  }, true);
});

test('snapshot failure stops the temporary owner and recovery reuses the durable checkpoint', async () => {
  await fixture(async ({ operations, counts, failSnapshot, store }) => {
    failSnapshot();
    const op = operations.control('backup', 'snapshot-failure');
    assert.equal((await operations.wait(op.id)).state, 'failed');
    assert.equal(counts.stop, 1);
    assert.throws(
      () => store.start('start', 'other', {}),
      /operation_in_progress/,
    );
    operations.resume(op.id);
    assert.equal((await operations.wait(op.id)).state, 'complete');
    assert.deepEqual(counts, {
      start: 2,
      stop: 2,
      checkpoint: 1,
      snapshot: 2,
      cleanup: 1,
    });
  });
});

test('a lost shutdown acknowledgement retains the lock and resumes without starting or backing up again', async () => {
  await fixture(async ({ operations, counts, failStop, store }) => {
    failStop();
    const op = operations.control('backup', 'lost-stop');
    assert.equal((await operations.wait(op.id)).state, 'failed');
    assert.equal(store.history()[0].error, 'native_shutdown_unconfirmed');
    assert.throws(
      () => store.start('start', 'other', {}),
      /operation_in_progress/,
    );
    operations.resume(op.id);
    assert.equal((await operations.wait(op.id)).state, 'complete');
    assert.deepEqual(counts, {
      start: 1,
      stop: 2,
      checkpoint: 1,
      snapshot: 1,
      cleanup: 1,
    });
  });
});

test('a failed final operation save can recover without redoing verified backup effects', async () => {
  await fixture(async ({ operations, counts, store }) => {
    const save = store.save.bind(store);
    let failed = false;
    store.save = (operation) => {
      if (
        !failed &&
        operation.kind === 'backup' &&
        operation.state === 'complete'
      ) {
        failed = true;
        throw Error('synthetic journal commit failure');
      }
      return save(operation);
    };
    const op = operations.control('backup', 'final-save');
    assert.equal((await operations.wait(op.id)).state, 'failed');
    operations.resume(op.id);
    assert.equal((await operations.wait(op.id)).state, 'complete');
    assert.deepEqual(counts, {
      start: 1,
      stop: 2,
      checkpoint: 1,
      snapshot: 1,
      cleanup: 1,
    });
  });
});

test('a transitioning or faulted application owner cannot be adopted or stopped by backup', async () => {
  for (const status of [
    { state: 'starting' },
    { state: 'stopping' },
    { state: 'unknown', code: 'native_host_pipe_failed' },
  ])
    await fixture(async ({ operations, runtime, counts }) => {
      runtime.status = () => status;
      const op = operations.control('backup', 'busy');
      assert.equal((await operations.wait(op.id)).state, 'failed');
      assert.deepEqual(counts, {
        start: 0,
        stop: 0,
        checkpoint: 0,
        snapshot: 0,
        cleanup: 0,
      });
    });
});

test('shutdown still drains the temporary owner when saving its shutdown intent fails', async () => {
  await fixture(async ({ operations, store, counts }) => {
    const save = store.save.bind(store);
    let failed = false;
    store.save = (operation) => {
      if (!failed && operation.step === 'native-backup-stop-database') {
        failed = true;
        throw Error('synthetic disk failure');
      }
      return save(operation);
    };
    const op = operations.control('backup', 'shutdown-disk-failure');
    assert.equal((await operations.wait(op.id)).state, 'failed');
    assert.equal(counts.stop, 1);
    operations.resume(op.id);
    assert.equal((await operations.wait(op.id)).state, 'complete');
    assert.deepEqual(counts, {
      start: 1,
      stop: 2,
      checkpoint: 1,
      snapshot: 1,
      cleanup: 1,
    });
  });
});

test('wrong database readiness and wrong shutdown state cannot complete a backup', async () => {
  for (const phase of ['ready', 'stopped'])
    await fixture(async ({ operations, runtime, counts }) => {
      if (phase === 'ready') {
        const start = runtime.startDatabase;
        runtime.startDatabase = async () => ({
          ...(await start()),
          state: 'running',
        });
      } else {
        const stop = runtime.stop;
        runtime.stop = async () => ({ ...(await stop()), state: 'running' });
      }
      const op = operations.control('backup', 'wrong-state');
      assert.equal((await operations.wait(op.id)).state, 'failed');
      assert.equal(counts.stop, 1);
      if (phase === 'ready') assert.equal(counts.checkpoint, 0);
    });
});

test('a foreign runtime context or intent is refused before owner or backup effects', async () => {
  for (const changed of ['context', 'intent'])
    await fixture(async ({ store, runtime, engine, context, counts }) => {
      const { operation } = store.start('backup', 'foreign', runtime.identity);
      if (changed === 'context')
        context.installation = { ...context.installation, id: 'e'.repeat(12) };
      else {
        operation.receipts['native-backup-database-intent'] = {
          ...runtime.identity,
          fingerprint: 'e'.repeat(64),
        };
        store.save(operation);
      }
      await assert.rejects(
        runNativeDatabaseBackup(store, runtime, engine, context, operation),
        /native_backup_journal_invalid/,
      );
      assert.deepEqual(counts, {
        start: 0,
        stop: 0,
        checkpoint: 0,
        snapshot: 0,
        cleanup: 0,
      });
    });
});

test('verified online-backup completion does not require or touch a subsequently faulted application owner', async () => {
  await fixture(async ({ operations, store, runtime, counts }) => {
    const save = store.save.bind(store);
    let failed = false;
    store.save = (operation) => {
      if (!failed && operation.state === 'complete') {
        failed = true;
        throw Error('lost final commit');
      }
      return save(operation);
    };
    const op = operations.control('backup', 'verified-online');
    assert.equal((await operations.wait(op.id)).state, 'failed');
    runtime.status = () => ({
      state: 'unknown',
      code: 'native_host_pipe_failed',
    });
    operations.resume(op.id);
    assert.equal((await operations.wait(op.id)).state, 'complete');
    assert.deepEqual(counts, {
      start: 0,
      stop: 0,
      checkpoint: 1,
      snapshot: 1,
      cleanup: 1,
    });
  }, true);
});

test('backup failure plus failed shutdown drains the recorded owner before continuing checkpoint recovery', async () => {
  await fixture(async ({ operations, counts, failSnapshot, failStop }) => {
    failSnapshot();
    failStop();
    const op = operations.control('backup', 'both-fail');
    assert.equal((await operations.wait(op.id)).state, 'failed');
    operations.resume(op.id);
    assert.equal((await operations.wait(op.id)).state, 'complete');
    assert.deepEqual(counts, {
      start: 2,
      stop: 3,
      checkpoint: 1,
      snapshot: 2,
      cleanup: 1,
    });
  });
});

function bootstrap(context) {
  return {
    protocolVersion: 2,
    installation: context.installation,
    backupKey: 'k'.repeat(43),
    password: 'synthetic private service password',
    controllerSha256: 'e'.repeat(64),
    backupEngine: {
      executable: context.installation.controller,
      sha256: 'f'.repeat(64),
    },
    tls: {
      certificatePem: 'synthetic certificate',
      privateKeyPem: 'synthetic private key',
    },
    name: context.name,
    release: context.release,
  };
}

test('native service dispatches backups through its configured engine and preserves installed library lineage', async () => {
  await fixture(async ({ store, runtime, engine, context, counts }) => {
    store.set('native-library-id', 'e'.repeat(12));
    const configuration = bootstrap(context);
    const first = new NativeService(store, configuration, runtime, engine);
    const one = first.control(
      'backup',
      'service-backup',
      context.installation.id,
    );
    assert.equal((await first.wait(one.id)).state, 'complete');
    assert.equal(
      store.history()[0].receipts['native-backup-verified'].recovery.libraryId,
      'e'.repeat(12),
    );
    const second = new NativeService(store, configuration, runtime, engine);
    const two = second.control(
      'backup',
      'service-backup-two',
      context.installation.id,
    );
    assert.equal((await second.wait(two.id)).state, 'complete');
    assert.equal(
      store.history()[0].receipts['native-backup-verified'].recovery.libraryId,
      'e'.repeat(12),
    );
    assert.deepEqual(counts, {
      start: 2,
      stop: 2,
      checkpoint: 2,
      snapshot: 2,
      cleanup: 2,
    });
  });
});

test('native library lineage starts from the installed profile and corrupt persisted lineage is refused', async () => {
  await fixture(async ({ store, runtime, engine, context, counts }) => {
    const configuration = bootstrap(context);
    new NativeService(store, configuration, runtime, engine);
    assert.equal(store.get('native-library-id'), context.installation.id);
    store.set('native-library-id', { id: 'foreign' });
    assert.throws(
      () => new NativeService(store, configuration, runtime, engine),
      /native_library_identity_invalid/,
    );
    assert.deepEqual(counts, {
      start: 0,
      stop: 0,
      checkpoint: 0,
      snapshot: 0,
      cleanup: 0,
    });
  });
});

test('a verified backup resumes checkpoint retirement without starting the database again', async () => {
  await fixture(async ({ store, operations, runtime, counts }) => {
    const cleanup = runtime.cleanupCheckpoint;
    runtime.cleanupCheckpoint = async () => {
      throw new Refusal('native_checkpoint_cleanup_failed');
    };
    const op = operations.control('backup', 'cleanup-only-recovery');
    assert.equal((await operations.wait(op.id)).state, 'failed');
    assert.ok(store.history()[0].completed.includes('native-backup-verified'));
    assert.equal(counts.start, 1);
    runtime.startDatabase = async () => {
      throw Error('database must remain offline during verified retirement');
    };
    let cleanupStarts = 0;
    const startCleanup = runtime.startCheckpointCleanup;
    runtime.startCheckpointCleanup = async () => {
      cleanupStarts++;
      assert.equal(store.history()[0].step, 'native-backup-start-cleanup');
      return startCleanup();
    };
    runtime.cleanupCheckpoint = cleanup;
    operations.resume(op.id);
    assert.equal((await operations.wait(op.id)).state, 'complete');
    assert.equal(cleanupStarts, 1);
    assert.equal(counts.start, 1);
    assert.equal(counts.snapshot, 1);
    assert.equal(counts.checkpoint, 1);
  });
});
test('temporary backup owner drains without overwriting newer evidence after start, snapshot or stop', async () => {
  for (const phase of ['start', 'snapshot', 'stop']) {
    await fixture(async ({ store, runtime, engine, context, counts }) => {
      const { operation } = store.start(
        'backup',
        'owner-fence-' + phase,
        runtime.identity,
      );
      const target = phase === 'snapshot' ? engine : runtime;
      const method = phase === 'start' ? 'startDatabase' : phase;
      const original = target[method];
      target[method] = async (...args) => {
        const result = await original(...args);
        const latest = store.history()[0];
        latest.error = 'new owner evidence';
        store.save(latest);
        return result;
      };
      await assert.rejects(
        runNativeDatabaseBackup(store, runtime, engine, context, operation),
        /native_backup_journal_invalid/,
      );
      assert.equal(store.history()[0].error, 'new owner evidence');
      assert.equal(store.history()[0].state, 'running');
      assert.equal(counts.start, 1);
      assert.equal(counts.stop, 1);
      assert.equal(counts.cleanup, phase === 'stop' ? 1 : 0);
      assert.equal(counts.snapshot, phase === 'start' ? 0 : 1);
      assert.throws(
        () => store.start('start', 'competing', {}),
        /operation_in_progress/,
      );
    });
  }
});
