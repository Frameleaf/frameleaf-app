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
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { digest } from '../src/contracts.js';
import { stageNativeRestoreInput } from '../src/runtime/native-restore-input.js';
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
  await fixture(async ({ store, context, engine }) => {
    let clock = Date.now();
    const now = t.mock.method(Date, 'now', () => clock);
    const restore = engine.restore;
    engine.restore = async (...args) => {
      await restore(...args);
      clock += 900_001;
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
