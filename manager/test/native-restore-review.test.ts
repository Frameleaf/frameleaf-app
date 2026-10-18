import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { digest } from '../src/contracts.js';
import { stageNativeRestoreInput } from '../src/runtime/native-restore-input.js';
import { completeNativeDatabaseBackup } from '../src/runtime/native-backup-journal.js';
import { createNativeRecovery } from '../src/runtime/native-recovery.js';
import * as restoreOperation from '../src/runtime/native-restore-operation.js';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import {
  prepareNativeRestoreReview,
  revalidateNativeRestoreReview,
} from '../src/runtime/native-restore-review.js';

async function fixture(run) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'frameleaf-native-restore-review-')),
  );
  const store = new Store(join(root, 'manager'));
  const context = {
    installation: {
      runtime: 'native',
      id: 'a'.repeat(12),
      controller: join(root, 'controller'),
      candidate: join(root, 'candidate'),
      state: join(root, 'profile'),
      manifestSha256: 'b'.repeat(64),
      sourceRevision: 'c'.repeat(40),
      certified: false,
      databasePort: 54329,
      apiPort: 2283,
    },
    libraryId: 'd'.repeat(12),
    release: 'frameleaf-v3.0.0-1',
  };
  store.set('native-library-id', context.libraryId);
  const dump = Buffer.from('PGDMP logical recovery fixture');
  const recovery = {
    schemaVersion: 1,
    runtime: 'native',
    mediaIncluded: false,
    databaseFormat: 'frameleaf-canonical',
    libraryId: context.libraryId,
    createdAt: 1234,
    installation: {
      id: 'e'.repeat(12),
      name: 'Recovery library',
      release: context.release,
    },
    checkpoint: {
      protocolVersion: 1,
      state: 'checkpoint',
      schemaVersion: 1,
      operationId: '11111111-1111-4111-8111-111111111111',
      manifestSha256: 'f'.repeat(64),
      sourceRevision: context.installation.sourceRevision,
      postgresMajor: '19',
      databaseFormat: 'frameleaf-canonical',
      dump: {
        bytes: dump.length,
        sha256: createHash('sha256').update(dump).digest('hex'),
      },
    },
  };
  let calls = 0,
    destination;
  const engine = {
    restore: async (snapshot, path) => {
      calls++;
      destination = path;
      assert.equal(snapshot, '1'.repeat(64));
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, 'database.dump'), dump, { mode: 0o600 });
      await writeFile(join(path, 'recovery.json'), JSON.stringify(recovery), {
        mode: 0o600,
      });
    },
  };
  try {
    await run({
      root,
      store,
      context,
      recovery,
      dump,
      engine,
      calls: () => calls,
      path: () => destination,
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('native restore review decrypts once, persists lineage and revalidates exact bytes without host effects', async () => {
  await fixture(async ({ store, context, engine, calls, path, recovery }) => {
    const summary = await prepareNativeRestoreReview(
      store,
      engine,
      context,
      '1'.repeat(64),
    );
    assert.equal(summary.mediaIncluded, false);
    assert.equal(summary.libraryId, context.libraryId);
    assert.equal(summary.release, context.release);
    assert.equal(summary.requiresRuntimeChange, false); // Manifest differs across platform; source/release contract matches.
    assert.ok(!JSON.stringify(summary).includes(store.directory));
    const review = await revalidateNativeRestoreReview(
      store,
      context,
      summary.id,
    );
    assert.equal(review.state, 'prepared');
    assert.deepEqual(review.recovery, recovery);
    assert.equal(calls(), 1);
    assert.equal(
      path(),
      join(store.directory, 'native-restore-reviews', summary.id),
    );
    assert.equal(store.history().length, 0);
    await writeFile(join(path(), 'database.dump'), 'PGDMP changed', {
      mode: 0o600,
    });
    await assert.rejects(
      revalidateNativeRestoreReview(store, context, summary.id),
      /native_restore_review_changed/,
    );
  });
});

test('foreign library and corrupt dump produce no prepared review and retain failed evidence', async () => {
  for (const mutation of ['library', 'dump'])
    await fixture(async ({ store, context, recovery, engine, path }) => {
      if (mutation === 'library') recovery.libraryId = '2'.repeat(12);
      else recovery.checkpoint.dump.sha256 = '0'.repeat(64);
      await assert.rejects(
        prepareNativeRestoreReview(store, engine, context, '1'.repeat(64)),
        /native_restore_verification_failed/,
      );
      const id = basename(path());
      assert.equal(store.get(`native-restore-review:${id}`).state, 'failed');
      assert.ok((await readdir(path())).includes('database.dump'));
    });
});

test('expired, changed runtime and changed library reviews cannot authorize restoration', async () => {
  await fixture(async ({ store, context, engine }) => {
    const review = await prepareNativeRestoreReview(
      store,
      engine,
      context,
      '1'.repeat(64),
    );
    await assert.rejects(
      revalidateNativeRestoreReview(
        store,
        {
          ...context,
          installation: {
            ...context.installation,
            sourceRevision: '3'.repeat(40),
          },
        },
        review.id,
      ),
      /native_restore_review_changed/,
    );
    store.set('native-library-id', '4'.repeat(12));
    await assert.rejects(
      revalidateNativeRestoreReview(store, context, review.id),
      /native_restore_review_changed/,
    );
    store.set('native-library-id', context.libraryId);
    const saved = store.get(`native-restore-review:${review.id}`);
    saved.expires = 0;
    store.set(`native-restore-review:${review.id}`, saved);
    await assert.rejects(
      revalidateNativeRestoreReview(store, context, review.id),
      /native_restore_review_expired/,
    );
  });
});

test('linked files, unknown inventory and public permissions are refused before review publication', async () => {
  for (const mutation of ['symlink', 'hardlink', 'extra', 'public'])
    await fixture(async ({ store, context, engine, root, path }) => {
      const restore = engine.restore;
      engine.restore = async (...args) => {
        await restore(...args);
        const file = join(path(), 'database.dump');
        if (mutation === 'extra')
          await writeFile(join(path(), 'foreign'), 'preserve');
        else if (mutation === 'public') {
          const { chmod } = await import('node:fs/promises');
          await chmod(file, 0o644);
        } else {
          const bytes = await readFile(file);
          await rm(file);
          const other = join(root, 'other');
          await writeFile(other, bytes, { mode: 0o600 });
          if (mutation === 'symlink') await symlink(other, file);
          else await link(other, file);
        }
      };
      if (mutation === 'public' && process.platform === 'win32') return;
      await assert.rejects(
        prepareNativeRestoreReview(store, engine, context, '1'.repeat(64)),
        /native_restore_verification_failed/,
      );
    });
});

test('invalid snapshot or context is rejected before decryption; interrupted decryption is durably failed', async () => {
  await fixture(async ({ store, context, engine, calls, path }) => {
    await assert.rejects(
      prepareNativeRestoreReview(store, engine, context, 'bad'),
      /native_restore_request_invalid/,
    );
    await assert.rejects(
      prepareNativeRestoreReview(
        store,
        engine,
        { ...context, libraryId: 'bad' },
        '1'.repeat(64),
      ),
      /native_restore_request_invalid/,
    );
    assert.equal(calls(), 0);
    const restore = engine.restore;
    engine.restore = async (...args) => {
      await restore(...args);
      throw Error('private detail');
    };
    await assert.rejects(
      prepareNativeRestoreReview(store, engine, context, '1'.repeat(64)),
      /native_restore_verification_failed/,
    );
    const id = basename(path());
    assert.equal(store.get(`native-restore-review:${id}`).state, 'failed');
    assert.ok(
      !JSON.stringify(store.get(`native-restore-review:${id}`)).includes(
        'private detail',
      ),
    );
  });
});

test('reviews that expire during decryption or revalidation never become usable', async (t) => {
  await fixture(async ({ store, context, engine, path }) => {
    let clock = Date.now();
    const now = t.mock.method(Date, 'now', () => clock);
    const restore = engine.restore;
    engine.restore = async (...args) => {
      await restore(...args);
      clock =
        store.get(`native-restore-review:${basename(path())}`).expires + 1;
    };
    await assert.rejects(
      prepareNativeRestoreReview(store, engine, context, '1'.repeat(64)),
      /native_restore_verification_failed/,
    );
    now.mock.restore();
  });
  await fixture(async ({ store, context, engine }) => {
    const summary = await prepareNativeRestoreReview(
      store,
      engine,
      context,
      '1'.repeat(64),
    );
    let calls = 0;
    const now = t.mock.method(Date, 'now', () =>
      calls++ === 0 ? summary.expires - 1 : summary.expires + 1,
    );
    await assert.rejects(
      revalidateNativeRestoreReview(store, context, summary.id),
      /native_restore_review_expired/,
    );
    now.mock.restore();
  });
});

async function stageFixture(run) {
  await fixture(async (f) => {
    const summary = await prepareNativeRestoreReview(
      f.store,
      f.engine,
      f.context,
      '1'.repeat(64),
    );
    await mkdir(f.context.installation.state, { mode: 0o700 });
    await writeFile(
      join(f.context.installation.state, 'host-state.json'),
      JSON.stringify({
        schemaVersion: 1,
        manifestSha256: f.context.installation.manifestSha256,
        sourceRevision: f.context.installation.sourceRevision,
        postgresMajor: '19',
      }),
      { mode: 0o600 },
    );
    const operation = f.store.start('restore', 'restore-one', {
      reviewId: summary.id,
      runtime: 'native',
      installationId: f.context.installation.id,
      fingerprint: digest(f.context.installation),
    }).operation;
    await run({ ...f, summary, operation });
  });
}

test('restore input staging is durable, exact and reusable without changing a live database', async () => {
  await stageFixture(
    async ({ store, context, summary, operation, dump, recovery }) => {
      const stage = await stageNativeRestoreInput(store, context, operation);
      assert.equal(
        stage.directory,
        join(context.installation.state, 'restore-input', operation.id),
      );
      assert.deepEqual((await readdir(stage.directory)).sort(), [
        'input',
        'restore-intent.json',
      ]);
      assert.deepEqual(
        await readFile(join(stage.directory, 'input', 'database.dump')),
        dump,
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(stage.directory, 'input', 'recovery.json'),
            'utf8',
          ),
        ),
        recovery,
      );
      assert.equal(stage.binding.reviewId, summary.id);
      assert.equal(stage.binding.operationId, operation.id);
      assert.equal(stage.binding.recoverySha256, digest(recovery));
      assert.deepEqual(
        await stageNativeRestoreInput(store, context, operation),
        stage,
      );
      assert.equal(store.history()[0].state, 'running');
      assert.ok(
        !(await readdir(context.installation.state)).includes('database'),
      );
    },
  );
});

test('an accepted restore resumes after review expiry while a fresh expired restore is refused', async (t) => {
  await stageFixture(async ({ store, context, operation, summary }) => {
    const stage = await stageNativeRestoreInput(store, context, operation);
    const now = t.mock.method(Date, 'now', () => summary.expires + 1);
    assert.deepEqual(
      await stageNativeRestoreInput(store, context, operation),
      stage,
    );
    now.mock.restore();
  });
  await stageFixture(async ({ store, context, operation, summary }) => {
    const now = t.mock.method(Date, 'now', () => summary.expires + 1);
    await assert.rejects(
      stageNativeRestoreInput(store, context, operation),
      /native_restore_review_expired/,
    );
    await assert.rejects(
      readdir(join(context.installation.state, 'restore-input')),
      { code: 'ENOENT' },
    );
    now.mock.restore();
  });
});

test('staging rejects changed source, target, profile and operation bindings without adopting data', async () => {
  for (const mutation of [
    'source',
    'target',
    'profile',
    'operation',
    'foreign-target',
  ])
    await stageFixture(async ({ store, context, operation, path }) => {
      if (mutation === 'source')
        await writeFile(join(path(), 'database.dump'), 'changed');
      if (mutation === 'profile')
        await writeFile(
          join(context.installation.state, 'host-state.json'),
          '{}',
          { mode: 0o600 },
        );
      if (mutation === 'operation')
        operation.input.fingerprint = '0'.repeat(64);
      if (mutation === 'target') {
        const stage = await stageNativeRestoreInput(store, context, operation);
        await writeFile(
          join(stage.directory, 'input', 'database.dump'),
          'changed',
        );
      }
      if (mutation === 'foreign-target') {
        const target = join(
          context.installation.state,
          'restore-input',
          operation.id,
        );
        await mkdir(target, { recursive: true, mode: 0o700 });
        await writeFile(join(target, 'sentinel'), 'retain', { mode: 0o600 });
      }
      await assert.rejects(stageNativeRestoreInput(store, context, operation));
      if (mutation === 'foreign-target')
        assert.equal(
          await readFile(
            join(
              context.installation.state,
              'restore-input',
              operation.id,
              'sentinel',
            ),
            'utf8',
          ),
          'retain',
        );
      assert.equal(store.history()[0].state, 'running');
    });
});

test('a lost staging journal acknowledgement reuses published input and keeps the operation locked', async () => {
  await stageFixture(async ({ store, context, operation }) => {
    const save = store.save.bind(store);
    let fail = true;
    store.save = (op) => {
      if (fail && op.completed.includes('native-restore-input')) {
        fail = false;
        throw Error('lost final save');
      }
      return save(op);
    };
    await assert.rejects(
      stageNativeRestoreInput(store, context, operation),
      /native_restore_input_changed/,
    );
    const resumed = store.history()[0];
    const stage = await stageNativeRestoreInput(store, context, resumed);
    assert.equal(stage.binding.operationId, operation.id);
    assert.equal(store.history()[0].state, 'running');
    assert.equal(
      store.history()[0].completed.includes('native-restore-input'),
      true,
    );
  });
});

test('interrupted copies retain owned evidence and retry safely without deleting foreign partials', async (t) => {
  await stageFixture(async ({ store, context, operation }) => {
    const copy = t.mock.method(
      filesystem,
      'copyFile',
      async (_source, target) => {
        await writeFile(target, 'partial', { flag: 'wx', mode: 0o600 });
        throw Error('ENOSPC');
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        stageNativeRestoreInput(store, context, operation),
        /native_restore_input_changed/,
      );
    } finally {
      copy.mock.restore();
      syncBuiltinESMExports();
    }
    const root = join(context.installation.state, 'restore-input');
    const partials = await readdir(root);
    assert.equal(partials.length, 1);
    assert.ok(partials[0].endsWith('.partial'));
    const stage = await stageNativeRestoreInput(
      store,
      context,
      store.history()[0],
    );
    assert.equal(stage.binding.operationId, operation.id);
    assert.ok((await readdir(root)).includes(partials[0]));
  });
});

test('staging cannot overwrite an operation state change that occurs while copying', async (t) => {
  await stageFixture(async ({ store, context, operation }) => {
    const original = filesystem.copyFile;
    let changed = false;
    const copy = t.mock.method(filesystem, 'copyFile', async (...args) => {
      await original(...args);
      if (!changed) {
        changed = true;
        const current = store.history()[0];
        current.state = 'failed';
        current.error = 'restore_interrupted';
        store.save(current);
      }
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        stageNativeRestoreInput(store, context, operation),
        /native_restore_input_changed/,
      );
    } finally {
      copy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(store.history()[0].state, 'failed');
    assert.equal(store.history()[0].error, 'restore_interrupted');
  });
});

function restoreRunner() {
  assert.equal(typeof restoreOperation.runNativeRestorePreparation, 'function');
  return restoreOperation.runNativeRestorePreparation;
}

async function operationFixture(run) {
  await stageFixture(async (f) => {
    const calls = [];
    let state = { state: 'stopped' },
      failure = null;
    const cancellation = new AbortController();
    const runtime = {
      identity: {
        runtime: 'native',
        installationId: f.context.installation.id,
        fingerprint: digest(f.context.installation),
      },
      status: () => state,
      start: async () => {
        throw Error('must not start application');
      },
      startDatabase: async () => {
        throw Error('must not start original database');
      },
      startCheckpointCleanup: async () => {
        throw Error('wrong maintenance mode');
      },
      checkpoint: async () => {
        throw Error('must not checkpoint original database');
      },
      startRestorePreparation: async () => {
        calls.push('start');
        const saved = f.store.history()[0];
        assert.deepEqual(
          saved.receipts['native-restore-owner-intent'],
          runtime.identity,
        );
        assert.ok(saved.completed.includes('native-restore-input'));
        state = { state: 'unknown', code: 'native_restore_maintenance' };
        if (failure === 'start') throw Error('start failed');
        return {
          protocolVersion: 1,
          state: 'restore-prepare-ready',
          manifestSha256: f.context.installation.manifestSha256,
          sourceRevision: f.context.installation.sourceRevision,
          certified: false,
        };
      },
      prepareRestore: async (binding, signal) => {
        calls.push('prepare');
        assert.deepEqual(signal, cancellation.signal);
        assert.equal(binding.operationId, f.operation.id);
        if (failure === 'prepare') throw Error('restore failed');
        if (failure === 'cancel') cancellation.abort();
        return {
          protocolVersion: 1,
          schemaVersion: 1,
          state: 'restore-prepared',
          binding,
          attemptId: '22222222-2222-4222-8222-222222222222',
          profileIdentity: '1:2',
          targetIdentity: '1:3',
          databaseIdentity: '1:4',
          validation: {
            postgresMajor: 19,
            vectorVersion: '0.8.7',
            canonical: true,
            executionStateReconstructed: true,
          },
        };
      },
      stop: async () => {
        calls.push('stop');
        if (failure === 'stop') throw Error('shutdown unconfirmed');
        state = { state: 'stopped' };
        return { protocolVersion: 1, state: 'stopped' };
      },
    };
    await run({
      ...f,
      runtime,
      calls,
      cancellation,
      fail: (value) => {
        failure = value;
      },
      setState: (value) => {
        state = value;
      },
    });
  });
}

test('restore preparation journals exact receipt and confirmed shutdown but retains operation ownership for activation', async () => {
  const run = restoreRunner();
  await operationFixture(
    async ({ store, context, operation, runtime, calls, cancellation }) => {
      const result = await run(
        store,
        runtime,
        context,
        operation,
        cancellation.signal,
      );
      assert.deepEqual(calls, ['start', 'prepare', 'stop']);
      assert.equal(result.state, 'restore-prepared');
      const saved = store.history()[0];
      assert.deepEqual(saved.receipts['native-restore-prepared'], result);
      assert.ok(saved.completed.includes('native-restore-stop-owner'));
      assert.equal(saved.state, 'running');
      assert.throws(
        () => store.start('start', 'competing', {}),
        /operation_in_progress/,
      );
      calls.length = 0;
      assert.deepEqual(
        await run(store, runtime, context, operation, cancellation.signal),
        result,
      );
      assert.deepEqual(calls, ['stop']); // Fresh drain acknowledgement, never replay pg_restore into an uncertain attempt.
    },
  );
});

test('restore preparation refuses live foreign or stale owners and pre-cancelled requests without host effects', async () => {
  const run = restoreRunner();
  for (const condition of ['running', 'fault', 'stale', 'cancel', 'foreign']) {
    await operationFixture(
      async ({
        store,
        context,
        operation,
        runtime,
        calls,
        cancellation,
        setState,
      }) => {
        if (condition === 'running') setState({ state: 'running' });
        if (condition === 'fault')
          setState({ state: 'unknown', code: 'native_shutdown_unconfirmed' });
        if (condition === 'stale') {
          const other = store.history()[0];
          other.error = 'changed';
          store.save(other);
        }
        if (condition === 'cancel') cancellation.abort();
        if (condition === 'foreign')
          runtime.identity.installationId = '0'.repeat(12);
        await assert.rejects(
          run(store, runtime, context, operation, cancellation.signal),
        );
        assert.deepEqual(calls, []);
        assert.equal(store.history()[0].state, 'running');
      },
    );
  }
});

test('restore preparation drains failed starts and restores, cancellation and journal write failures', async (t) => {
  const run = restoreRunner();
  for (const condition of ['start', 'prepare', 'cancel', 'save']) {
    await operationFixture(
      async ({
        store,
        context,
        operation,
        runtime,
        calls,
        cancellation,
        fail,
      }) => {
        if (condition !== 'save') fail(condition);
        let mock;
        if (condition === 'save') {
          const original = store.save.bind(store);
          mock = t.mock.method(store, 'save', (value) => {
            if (value.receipts['native-restore-prepared'])
              throw Error('disk full');
            original(value);
          });
        }
        await assert.rejects(
          run(store, runtime, context, operation, cancellation.signal),
        );
        mock?.mock.restore();
        assert.equal(calls.at(-1), 'stop');
        assert.equal(store.history()[0].state, 'running');
        assert.throws(
          () => store.start('start', 'competing', {}),
          /operation_in_progress/,
        );
      },
    );
  }
});

test('restore preparation retains a successful target across unconfirmed shutdown and retry', async () => {
  const run = restoreRunner();
  await operationFixture(
    async ({
      store,
      context,
      operation,
      runtime,
      calls,
      cancellation,
      fail,
    }) => {
      fail('stop');
      await assert.rejects(
        run(store, runtime, context, operation, cancellation.signal),
        /shutdown unconfirmed/,
      );
      assert.ok(store.history()[0].receipts['native-restore-prepared']);
      assert.ok(
        !store.history()[0].completed.includes('native-restore-stop-owner'),
      );
      fail(null);
      calls.length = 0;
      const result = await run(
        store,
        runtime,
        context,
        operation,
        cancellation.signal,
      );
      assert.equal(result.state, 'restore-prepared');
      assert.deepEqual(calls, ['stop']);
    },
  );
});

test('restore preparation rejects wrong readiness and malformed or foreign prepared targets while draining its owner', async () => {
  const run = restoreRunner();
  for (const condition of ['ready', 'binding', 'schema', 'extra']) {
    await operationFixture(
      async ({ store, context, operation, runtime, calls, cancellation }) => {
        if (condition === 'ready') {
          const original = runtime.startRestorePreparation;
          runtime.startRestorePreparation = async () => ({
            ...(await original()),
            state: 'database-ready',
          });
        } else {
          const original = runtime.prepareRestore;
          runtime.prepareRestore = async (...args) => {
            const receipt = await original(...args);
            if (condition === 'binding')
              receipt.binding = {
                ...receipt.binding,
                reviewId: '33333333-3333-4333-8333-333333333333',
              };
            if (condition === 'schema') receipt.validation.canonical = false;
            if (condition === 'extra')
              receipt.path = '/caller/selected/database';
            return receipt;
          };
        }
        await assert.rejects(
          run(store, runtime, context, operation, cancellation.signal),
        );
        assert.equal(calls.at(-1), 'stop');
        assert.equal(
          store.history()[0].receipts['native-restore-prepared'],
          undefined,
        );
      },
    );
  }
});

test('restore preparation never overwrites a changed journal after an asynchronous host effect', async () => {
  const run = restoreRunner();
  await operationFixture(
    async ({ store, context, operation, runtime, cancellation, calls }) => {
      const original = runtime.prepareRestore;
      runtime.prepareRestore = async (...args) => {
        const receipt = await original(...args);
        const latest = store.history()[0];
        latest.error = 'new owner evidence';
        store.save(latest);
        return receipt;
      };
      await assert.rejects(
        run(store, runtime, context, operation, cancellation.signal),
      );
      assert.equal(calls.at(-1), 'stop');
      assert.equal(store.history()[0].error, 'new owner evidence');
      assert.equal(
        store.history()[0].receipts['native-restore-prepared'],
        undefined,
      );
    },
  );
});

test('restore preparation refuses a corrupted durable receipt instead of replaying or trusting it', async () => {
  const run = restoreRunner();
  await operationFixture(
    async ({ store, context, operation, runtime, cancellation, calls }) => {
      await run(store, runtime, context, operation, cancellation.signal);
      operation.receipts['native-restore-prepared'].binding.libraryId =
        '0'.repeat(12);
      store.save(operation);
      calls.length = 0;
      await assert.rejects(
        run(store, runtime, context, operation, cancellation.signal),
      );
      assert.ok(!calls.includes('prepare'));
      assert.ok(!calls.includes('start'));
      assert.equal(
        store.history()[0].receipts['native-restore-prepared'].binding
          .libraryId,
        '0'.repeat(12),
      );
      assert.equal(store.history()[0].state, 'running');
    },
  );
});

test('restore preparation preserves cancellation during readiness and does not issue a restore command', async () => {
  const run = restoreRunner();
  await operationFixture(
    async ({ store, context, operation, runtime, cancellation, calls }) => {
      const original = runtime.startRestorePreparation;
      runtime.startRestorePreparation = async () => {
        const ready = await original();
        cancellation.abort();
        return ready;
      };
      await assert.rejects(
        run(store, runtime, context, operation, cancellation.signal),
      );
      assert.deepEqual(calls, ['start', 'stop']);
      assert.equal(
        store.history()[0].receipts['native-restore-prepared'],
        undefined,
      );
    },
  );
});

async function preBackupFixture(run) {
  await stageFixture(async (f) => {
    const stage = await stageNativeRestoreInput(
      f.store,
      f.context,
      f.operation,
    );
    f.operation.receipts['native-restore-prebackup-intent'] = {
      schemaVersion: 1,
      binding: stage.binding,
    };
    f.store.save(f.operation);
    const bytes = Buffer.from('PGDMP current quiesced pre-restore database');
    const checkpoint = {
      protocolVersion: 1,
      state: 'checkpoint',
      schemaVersion: 1,
      operationId: f.operation.id,
      manifestSha256: f.context.installation.manifestSha256,
      sourceRevision: f.context.installation.sourceRevision,
      postgresMajor: '19',
      databaseFormat: 'frameleaf-canonical',
      dump: {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
    const owner = join(
      f.context.installation.state,
      'checkpoints',
      f.operation.id,
    );
    await mkdir(owner, { recursive: true, mode: 0o700 });
    await writeFile(join(owner, 'database.dump'), bytes, { mode: 0o600 });
    const { protocolVersion, state: checkpointState, ...record } = checkpoint;
    await writeFile(join(owner, 'checkpoint.json'), JSON.stringify(record), {
      mode: 0o600,
    });
    const calls = {
      checkpoint: 0,
      initialize: 0,
      snapshot: 0,
      restore: 0,
      cleanup: 0,
    };
    let state = { state: 'unknown', code: 'native_database_maintenance' };
    const runtime = {
      identity: {
        runtime: 'native',
        installationId: f.context.installation.id,
        fingerprint: digest(f.context.installation),
      },
      status: () => state,
      checkpoint: async (id) => {
        calls.checkpoint++;
        assert.equal(id, f.operation.id);
        return structuredClone(checkpoint);
      },
      cleanupCheckpoint: async (receipt) => {
        calls.cleanup++;
        assert.deepEqual(receipt, checkpoint);
        await rm(owner, { recursive: true });
        return { ...receipt, state: 'checkpoint-cleaned' };
      },
    };
    const captured = new Map();
    const engine = {
      corrupt: false,
      initialize: async () => {
        calls.initialize++;
      },
      snapshot: async (directory, operationId) => {
        calls.snapshot++;
        assert.equal(operationId, f.operation.id);
        for (const name of ['database.dump', 'recovery.json'])
          captured.set(name, await readFile(join(directory, name)));
        return 'f'.repeat(64);
      },
      restore: async (snapshotId, directory) => {
        calls.restore++;
        assert.equal(snapshotId, 'f'.repeat(64));
        await mkdir(directory, { mode: 0o700 });
        for (const [name, bytes] of captured)
          await writeFile(join(directory, name), bytes, { mode: 0o600 });
        if (engine.corrupt)
          await writeFile(
            join(directory, 'database.dump'),
            'changed readback',
            { mode: 0o600 },
          );
      },
    };
    await run({
      ...f,
      runtime,
      engine,
      calls,
      context: { ...f.context, name: 'Native library' },
      setState: (value) => {
        state = value;
      },
    });
  });
}

test('restore pre-backup reuses verified encrypted backup and receipt-bound cleanup under the parent restore lock', async () => {
  await preBackupFixture(
    async ({ store, runtime, engine, context, operation, calls }) => {
      const result = await completeNativeDatabaseBackup(
        store,
        runtime,
        engine,
        context,
        operation,
      );
      assert.equal(result.snapshotId, 'f'.repeat(64));
      assert.equal(result.recovery.checkpoint.operationId, operation.id);
      const artifact = join(
        context.installation.state,
        'restore-safety',
        operation.id,
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(artifact, 'recovery.json'), 'utf8')),
        result.recovery,
      );
      assert.equal(
        createHash('sha256')
          .update(await readFile(join(artifact, 'database.dump')))
          .digest('hex'),
        result.recovery.checkpoint.dump.sha256,
      );
      assert.equal(
        operation.receipts['native-backup-verification-intent'].directory,
        artifact,
      );
      assert.deepEqual(calls, {
        checkpoint: 1,
        initialize: 1,
        snapshot: 1,
        restore: 1,
        cleanup: 1,
      });
      assert.equal(store.history()[0].kind, 'restore');
      assert.equal(store.history()[0].state, 'running');
      assert.ok(operation.completed.includes('native-restore-input'));
      assert.ok(operation.completed.includes('native-backup-verified'));
      assert.throws(
        () => store.start('start', 'competing', {}),
        /operation_in_progress/,
      );
      assert.deepEqual(
        await completeNativeDatabaseBackup(
          store,
          runtime,
          engine,
          context,
          operation,
        ),
        result,
      );
      assert.deepEqual(calls, {
        checkpoint: 1,
        initialize: 1,
        snapshot: 1,
        restore: 2,
        cleanup: 1,
      });
    },
  );
});

test('restore pre-backup refuses missing or foreign intent, changed input and an application owner before checkpoint effects', async () => {
  for (const mutation of ['missing', 'foreign', 'input', 'owner'])
    await preBackupFixture(
      async ({
        store,
        runtime,
        engine,
        context,
        operation,
        calls,
        setState,
      }) => {
        if (mutation === 'missing')
          delete operation.receipts['native-restore-prebackup-intent'];
        if (mutation === 'foreign')
          operation.receipts['native-restore-prebackup-intent'].binding = {
            ...operation.receipts['native-restore-prebackup-intent'].binding,
            reviewId: '44444444-4444-4444-8444-444444444444',
          };
        if (mutation === 'input')
          await writeFile(
            join(
              context.installation.state,
              'restore-input',
              operation.id,
              'input',
              'database.dump',
            ),
            'changed',
            { mode: 0o600 },
          );
        if (mutation === 'owner') setState({ state: 'running' });
        store.save(operation);
        await assert.rejects(
          completeNativeDatabaseBackup(
            store,
            runtime,
            engine,
            context,
            operation,
          ),
        );
        assert.deepEqual(calls, {
          checkpoint: 0,
          initialize: 0,
          snapshot: 0,
          restore: 0,
          cleanup: 0,
        });
        assert.equal(store.history()[0].state, 'running');
      },
    );
});

test('restore pre-backup cannot advance after corrupt encrypted readback and retries without a fresh checkpoint', async () => {
  await preBackupFixture(
    async ({ store, runtime, engine, context, operation, calls }) => {
      engine.corrupt = true;
      await assert.rejects(
        completeNativeDatabaseBackup(
          store,
          runtime,
          engine,
          context,
          operation,
        ),
        /native_backup_verification_failed/,
      );
      assert.equal(calls.cleanup, 0);
      assert.equal(store.history()[0].state, 'running');
      engine.corrupt = false;
      const result = await completeNativeDatabaseBackup(
        store,
        runtime,
        engine,
        context,
        operation,
      );
      assert.equal(result.snapshotId, 'f'.repeat(64));
      assert.deepEqual(calls, {
        checkpoint: 1,
        initialize: 1,
        snapshot: 1,
        restore: 2,
        cleanup: 1,
      });
    },
  );
});

test('restore pre-backup preserves a journal changed while the encrypted snapshot is being created', async () => {
  await preBackupFixture(
    async ({ store, runtime, engine, context, operation, calls }) => {
      const original = engine.snapshot;
      engine.snapshot = async (...args) => {
        const result = await original(...args);
        const latest = store.history()[0];
        latest.error = 'new owner evidence';
        store.save(latest);
        return result;
      };
      await assert.rejects(
        completeNativeDatabaseBackup(
          store,
          runtime,
          engine,
          context,
          operation,
        ),
      );
      assert.equal(calls.snapshot, 1);
      assert.equal(calls.cleanup, 0);
      assert.equal(store.history()[0].error, 'new owner evidence');
      assert.equal(
        store.history()[0].receipts['native-backup-encrypt'],
        undefined,
      );
    },
  );
});

test('restore preparation accepts a bound cold quiescent receipt but rejects a foreign inspection', async () => {
  await operationFixture(async (f) => {
    const prepared = await restoreRunner()(
      f.store,
      f.runtime,
      f.context,
      f.operation,
      f.cancellation.signal,
    );
    const inspection = {
      protocolVersion: 1,
      state: 'quiescent',
      installationId: f.context.installation.id,
      manifestSha256: f.context.installation.manifestSha256,
      sourceRevision: f.context.installation.sourceRevision,
      certified: false,
      profileIdentity: '1'.repeat(64),
      generation: randomUUID(),
    };
    f.runtime.stop = async () => ({
      protocolVersion: 1,
      state: 'stopped',
      inspection,
    });
    assert.deepEqual(
      await restoreRunner()(
        f.store,
        f.runtime,
        f.context,
        f.operation,
        f.cancellation.signal,
      ),
      prepared,
    );
    inspection.manifestSha256 = '0'.repeat(64);
    await assert.rejects(
      restoreRunner()(
        f.store,
        f.runtime,
        f.context,
        f.operation,
        f.cancellation.signal,
      ),
      /native_shutdown_unconfirmed/,
    );
  });
});

async function selectionFixture(run) {
  await operationFixture(async (f) => {
    const context = { ...f.context, name: 'Native library' };
    const checkpoint = {
      protocolVersion: 1,
      state: 'checkpoint',
      schemaVersion: 1,
      operationId: f.operation.id,
      manifestSha256: context.installation.manifestSha256,
      sourceRevision: context.installation.sourceRevision,
      postgresMajor: '19',
      databaseFormat: 'frameleaf-canonical',
      dump: { bytes: 21, sha256: '9'.repeat(64) },
    };
    const backup = {
      snapshotId: '8'.repeat(64),
      recovery: createNativeRecovery(
        { ...context, operation: f.operation },
        checkpoint,
      ),
    };
    const values = {
      'native-backup-verified': backup,
      'native-backup-encrypt': structuredClone(backup),
      'native-backup-owner-cleaned': {
        ...checkpoint,
        state: 'checkpoint-cleaned',
      },
      'native-backup-stage-cleaned': {
        directory: join(
          f.store.directory,
          'native-backup-staging',
          f.operation.id,
        ),
        recoverySha256: digest(backup.recovery),
      },
    };
    for (const [key, value] of Object.entries(values)) {
      f.operation.receipts[key] = value;
      f.operation.completed.push(key);
    }
    f.store.save(f.operation);
    f.runtime.verifyRestore = async (prepared) => {
      f.calls.push('verify');
      const { protocolVersion, ...target } = prepared;
      return {
        protocolVersion: 1,
        state: 'restore-verified',
        prepared: target,
        offlineChecksums: true,
        schemaValidated: true,
        verificationId: randomUUID(),
      };
    };
    f.runtime.selectRestore = async (proof, safety) => {
      f.calls.push('select');
      assert.equal(proof.prepared.binding.operationId, f.operation.id);
      assert.deepEqual(safety, {
        snapshotId: backup.snapshotId,
        recoverySha256: digest(backup.recovery),
        checkpoint,
      });
      f.setState({ state: 'stopped' });
      return {
        protocolVersion: 1,
        state: 'restore-activation-pending',
        operationId: f.operation.id,
        generation: randomUUID(),
      };
    };
    await run({ ...f, context, backup });
  });
}
function selectionRunner() {
  assert.equal(typeof restoreOperation.runNativeRestoreSelection, 'function');
  return restoreOperation.runNativeRestoreSelection;
}

test('native restore runner prepares, freshly verifies and selects in the live owner but retains finalization lock', async () => {
  const run = selectionRunner();
  await selectionFixture(async (f) => {
    const selected = await run(
      f.store,
      f.runtime,
      f.context,
      f.operation,
      f.cancellation.signal,
    );
    assert.deepEqual(f.calls, [
      'start',
      'prepare',
      'stop',
      'start',
      'verify',
      'select',
    ]);
    assert.equal(selected.state, 'restore-activation-pending');
    assert.deepEqual(f.operation.receipts['native-restore-selected'], selected);
    assert.equal(f.store.history()[0].state, 'running');
    assert.throws(
      () => f.store.start('start', randomUUID(), {}),
      /operation_in_progress/,
    );
  });
});
test('selection resume always renews proof after a lost journal acknowledgement', async (t) => {
  const run = selectionRunner();
  await selectionFixture(async (f) => {
    const save = f.store.save.bind(f.store);
    let lost = false;
    const mock = t.mock.method(f.store, 'save', (operation) => {
      save(operation);
      if (!lost && operation.completed.includes('native-restore-selected')) {
        lost = true;
        throw Error('lost selection acknowledgement');
      }
    });
    await assert.rejects(
      run(f.store, f.runtime, f.context, f.operation, f.cancellation.signal),
      /lost selection acknowledgement/,
    );
    mock.mock.restore();
    f.calls.length = 0;
    await run(
      f.store,
      f.runtime,
      f.context,
      f.operation,
      f.cancellation.signal,
    );
    assert.deepEqual(f.calls, ['stop', 'start', 'verify', 'select']);
    assert.equal(f.store.history()[0].state, 'running');
  });
});
test('selection rejects missing safety cleanup, changed proof and failed selection while draining owned maintenance', async () => {
  const run = selectionRunner();
  for (const mutation of ['cleanup', 'proof', 'select'])
    await selectionFixture(async (f) => {
      if (mutation === 'cleanup') {
        delete f.operation.receipts['native-backup-owner-cleaned'];
        f.operation.completed = f.operation.completed.filter(
          (key) => key !== 'native-backup-owner-cleaned',
        );
        f.store.save(f.operation);
      }
      if (mutation === 'proof') {
        const verify = f.runtime.verifyRestore;
        f.runtime.verifyRestore = async (prepared) => {
          const proof = await verify(prepared);
          proof.prepared.databaseIdentity = '1:999';
          return proof;
        };
      }
      if (mutation === 'select')
        f.runtime.selectRestore = async () => {
          f.calls.push('select');
          throw Error('selection failed');
        };
      await assert.rejects(
        run(f.store, f.runtime, f.context, f.operation, f.cancellation.signal),
      );
      assert.equal(f.operation.receipts['native-restore-selected'], undefined);
      assert.equal(f.store.history()[0].state, 'running');
      if (mutation === 'cleanup') assert.deepEqual(f.calls, []);
      else assert.equal(f.calls.at(-1), 'stop');
    });
});

function preBackupRunner() {
  assert.equal(typeof restoreOperation.runNativeRestorePrebackup, 'function');
  return restoreOperation.runNativeRestorePrebackup;
}
async function preBackupOwnerFixture(run) {
  await preBackupFixture(async (f) => {
    delete f.operation.receipts['native-restore-prebackup-intent'];
    f.store.save(f.operation);
    f.setState({ state: 'running' });
    const lifecycle = [];
    f.runtime.stop = async () => {
      lifecycle.push('stop');
      f.setState({ state: 'stopped' });
      return { protocolVersion: 1, state: 'stopped' };
    };
    function ready(state) {
      return {
        protocolVersion: 1,
        state,
        manifestSha256: f.context.installation.manifestSha256,
        sourceRevision: f.context.installation.sourceRevision,
        certified: f.context.installation.certified,
      };
    }
    f.runtime.startDatabase = async () => {
      lifecycle.push('database');
      f.setState({ state: 'unknown', code: 'native_database_maintenance' });
      return ready('database-ready');
    };
    f.runtime.startCheckpointCleanup = async () => {
      lifecycle.push('cleanup');
      f.setState({
        state: 'unknown',
        code: 'native_checkpoint_cleanup_maintenance',
      });
      return ready('checkpoint-cleanup-ready');
    };
    await run({ ...f, lifecycle });
  });
}

test('restore prebackup owner drains writers, verifies safety and stops without releasing the restore lock', async () => {
  const run = preBackupRunner();
  await preBackupOwnerFixture(async (f) => {
    const result = await run(
      f.store,
      f.runtime,
      f.engine,
      f.context,
      f.operation,
    );
    assert.equal(result.snapshotId, 'f'.repeat(64));
    assert.deepEqual(f.lifecycle, ['stop', 'database', 'stop']);
    assert.equal(f.calls.checkpoint, 1);
    assert.equal(f.calls.cleanup, 1);
    assert.equal(f.operation.state, 'running');
    assert.throws(
      () => f.store.start('start', 'competing', {}),
      /operation_in_progress/,
    );
    await run(f.store, f.runtime, f.engine, f.context, f.operation);
    assert.equal(f.calls.checkpoint, 1);
    assert.equal(f.calls.snapshot, 1);
    assert.deepEqual(f.lifecycle, ['stop', 'database', 'stop', 'stop']);
  });
});

test('restore prebackup owner resumes checkpoint cleanup without restarting normal database mode', async () => {
  const run = preBackupRunner();
  await preBackupOwnerFixture(async (f) => {
    const cleanup = f.runtime.cleanupCheckpoint;
    f.runtime.cleanupCheckpoint = async () => {
      throw new Error('interrupted cleanup');
    };
    await assert.rejects(
      run(f.store, f.runtime, f.engine, f.context, f.operation),
      /interrupted cleanup/,
    );
    assert.deepEqual(f.lifecycle, ['stop', 'database', 'stop']);
    f.runtime.cleanupCheckpoint = cleanup;
    await run(f.store, f.runtime, f.engine, f.context, f.operation);
    assert.deepEqual(f.lifecycle, [
      'stop',
      'database',
      'stop',
      'stop',
      'cleanup',
      'stop',
    ]);
    assert.equal(f.calls.checkpoint, 1);
    assert.equal(f.calls.snapshot, 1);
  });
});

test('restore prebackup owner refuses changed input before stopping writers and drains failed readiness', async () => {
  const run = preBackupRunner();
  await preBackupOwnerFixture(async (f) => {
    f.operation.receipts['native-restore-prebackup-intent'] = {
      schemaVersion: 1,
      binding: {},
    };
    f.store.save(f.operation);
    await assert.rejects(
      run(f.store, f.runtime, f.engine, f.context, f.operation),
    );
    assert.deepEqual(f.lifecycle, []);
  });
  await preBackupOwnerFixture(async (f) => {
    const start = f.runtime.startDatabase;
    f.runtime.startDatabase = async () => ({
      ...(await start()),
      sourceRevision: '0'.repeat(40),
    });
    await assert.rejects(
      run(f.store, f.runtime, f.engine, f.context, f.operation),
      /native_host_identity_changed/,
    );
    assert.deepEqual(f.lifecycle, ['stop', 'database', 'stop']);
    assert.equal(f.calls.checkpoint, 0);
  });
});

test('restore prebackup owner drains cancelled readiness and retries a faulted owner only with matching prior intent', async () => {
  const run = preBackupRunner();
  await preBackupOwnerFixture(async (f) => {
    const cancellation = new AbortController(),
      start = f.runtime.startDatabase;
    f.runtime.startDatabase = async () => {
      const ready = await start();
      cancellation.abort();
      return ready;
    };
    await assert.rejects(
      run(
        f.store,
        f.runtime,
        f.engine,
        f.context,
        f.operation,
        cancellation.signal,
      ),
      /native_restore_cancelled/,
    );
    assert.deepEqual(f.lifecycle, ['stop', 'database', 'stop']);
    assert.equal(f.calls.checkpoint, 0);
    f.setState({ state: 'unknown', code: 'native_host_pipe_failed' });
    f.runtime.startDatabase = start;
    await run(f.store, f.runtime, f.engine, f.context, f.operation);
    assert.deepEqual(f.lifecycle, [
      'stop',
      'database',
      'stop',
      'stop',
      'database',
      'stop',
    ]);
    assert.equal(f.calls.checkpoint, 1);
  });
  await preBackupOwnerFixture(async (f) => {
    f.setState({ state: 'unknown', code: 'native_host_pipe_failed' });
    await assert.rejects(
      run(f.store, f.runtime, f.engine, f.context, f.operation),
      /native_restore_owner_unavailable/,
    );
    assert.deepEqual(f.lifecycle, []);
  });
});

test('a long bounded readback starts the review confirmation window after verification', async (t) => {
  await fixture(async ({ store, context, engine }) => {
    let clock = Date.now();
    const now = t.mock.method(Date, 'now', () => clock),
      restore = engine.restore;
    engine.restore = async (...args) => {
      await restore(...args);
      clock += 16 * 60_000;
    };
    try {
      const summary = await prepareNativeRestoreReview(
        store,
        engine,
        context,
        '1'.repeat(64),
      );
      assert.equal(summary.expires, clock + 900_000);
      assert.equal(summary.state, 'prepared');
    } finally {
      now.mock.restore();
    }
  });
});

test('restore retry freshly reads the safety snapshot and rejects corruption despite its durable verified receipt', async () => {
  await preBackupFixture(
    async ({ store, runtime, engine, context, operation, calls }) => {
      const verified = await completeNativeDatabaseBackup(
        store,
        runtime,
        engine,
        context,
        operation,
      );
      engine.corrupt = true;
      await assert.rejects(
        completeNativeDatabaseBackup(
          store,
          runtime,
          engine,
          context,
          operation,
        ),
        /native_backup_verification_failed/,
      );
      assert.deepEqual(operation.receipts['native-backup-verified'], verified);
      assert.equal(store.history()[0].state, 'running');
      assert.deepEqual(calls, {
        checkpoint: 1,
        initialize: 1,
        snapshot: 1,
        restore: 2,
        cleanup: 1,
      });
      engine.corrupt = false;
      assert.deepEqual(
        await completeNativeDatabaseBackup(
          store,
          runtime,
          engine,
          context,
          operation,
        ),
        verified,
      );
      assert.deepEqual(calls, {
        checkpoint: 1,
        initialize: 1,
        snapshot: 1,
        restore: 3,
        cleanup: 1,
      });
      operation.receipts['native-backup-encrypt'].snapshotId = 'e'.repeat(64);
      store.save(operation);
      await assert.rejects(
        completeNativeDatabaseBackup(
          store,
          runtime,
          engine,
          context,
          operation,
        ),
        /native_backup_journal_invalid/,
      );
      assert.equal(calls.restore, 3);
    },
  );
});

test('restore safety readback preserves an unknown preexisting artifact before any engine restore', async () => {
  await preBackupFixture(
    async ({ store, runtime, engine, context, operation, calls }) => {
      const artifact = join(
        context.installation.state,
        'restore-safety',
        operation.id,
      );
      await mkdir(artifact, { recursive: true, mode: 0o700 });
      await writeFile(join(artifact, 'database.dump'), 'foreign artifact', {
        mode: 0o600,
      });
      await assert.rejects(
        completeNativeDatabaseBackup(
          store,
          runtime,
          engine,
          context,
          operation,
        ),
        /native_backup_verification_failed/,
      );
      assert.equal(
        await readFile(join(artifact, 'database.dump'), 'utf8'),
        'foreign artifact',
      );
      assert.equal(calls.restore, 0);
      assert.equal(store.history()[0].state, 'running');
    },
  );
});
