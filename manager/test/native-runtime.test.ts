import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refusal } from '../src/contracts.js';
import { Store } from '../src/store.js';
import { NativeOperations, type NativeRuntime } from '../src/runtime/native.js';

async function fixture(
  run: (store: Store, runtime: NativeRuntime) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-native-manager-'));
  const store = new Store(directory);
  const runtime: NativeRuntime = {
    identity: Object.freeze({
      runtime: 'native',
      installationId: 'a'.repeat(12),
      fingerprint: 'b'.repeat(64),
    }),
    start: async () => ({
      protocolVersion: 1,
      state: 'running',
      manifestSha256: 'c'.repeat(64),
      sourceRevision: 'd'.repeat(40),
      certified: false,
    }),
    stop: async () => ({ protocolVersion: 1, state: 'stopped' }),
  };
  try {
    await run(store, runtime);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('native effects have durable intent and public receipts in the existing Manager journal', async () => {
  await fixture(async (store, runtime) => {
    runtime.start = async () => {
      const [operation] = store.history();
      assert.equal(operation.state, 'running');
      assert.equal(operation.step, 'start-native-host');
      assert.deepEqual(operation.input, runtime.identity);
      return {
        protocolVersion: 1,
        state: 'running',
        manifestSha256: 'c'.repeat(64),
        sourceRevision: 'd'.repeat(40),
        certified: false,
      };
    };
    const operations = new NativeOperations(store, runtime);
    const started = operations.control('start', 'start-one');
    assert.equal((await operations.wait(started.id)).state, 'complete');
    assert.equal(
      store.history()[0].receipts['start-native-host']['state'],
      'running',
    );
    assert.equal(operations.control('start', 'start-one').id, started.id);
    const stopped = operations.control('stop', 'stop-one');
    assert.equal((await operations.wait(stopped.id)).state, 'complete');
    assert.equal(
      store.history()[0].receipts['stop-native-host']['state'],
      'stopped',
    );
  });
});

test('the existing global operation lock blocks a second native or Docker operation', async () => {
  await fixture(async (store, runtime) => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = runtime.start;
    runtime.start = async () => {
      await paused;
      return start();
    };
    const operations = new NativeOperations(store, runtime);
    const operation = operations.control('start', 'held');
    assert.throws(
      () => operations.control('stop', 'other'),
      /operation_in_progress/,
    );
    assert.throws(
      () => store.start('backup', 'docker-backup', {}),
      /operation_in_progress/,
    );
    assert.equal(operations.control('start', 'held').id, operation.id);
    release();
    assert.equal((await operations.wait(operation.id)).state, 'complete');
  });
});

test('a lost start acknowledgement retains the lock and resumes against current runtime authority', async () => {
  await fixture(async (store, runtime) => {
    let launched = false;
    let launches = 0;
    const start = runtime.start;
    runtime.start = async () => {
      if (!launched) {
        launched = true;
        launches++;
        throw new Refusal('native_host_failed');
      }
      return start();
    };
    const operations = new NativeOperations(store, runtime);
    const operation = operations.control('start', 'lost-ready');
    assert.equal((await operations.wait(operation.id)).state, 'failed');
    assert.throws(
      () => operations.control('stop', 'new-request'),
      /operation_in_progress/,
    );
    operations.resume(operation.id);
    assert.equal((await operations.wait(operation.id)).state, 'complete');
    assert.equal(launches, 1);
  });
});

test('restart recovery keeps its acknowledged stop but rechecks start even after a saved receipt', async () => {
  await fixture(async (store, runtime) => {
    let stops = 0;
    let starts = 0;
    runtime.stop = async () => {
      stops++;
      return { protocolVersion: 1, state: 'stopped' };
    };
    const start = runtime.start;
    runtime.start = async () => {
      if (++starts === 1) throw new Refusal('native_host_failed');
      return start();
    };
    const operations = new NativeOperations(store, runtime);
    const operation = operations.control('restart', 'restart-one');
    assert.equal((await operations.wait(operation.id)).state, 'failed');
    const saved = store.history()[0];
    saved.completed.push('start-native-host');
    saved.receipts['start-native-host'] = { state: 'running', obsolete: true };
    store.save(saved);
    operations.resume(operation.id);
    assert.equal((await operations.wait(operation.id)).state, 'complete');
    assert.equal(stops, 1);
    assert.equal(starts, 2);
    assert.equal(
      store.history()[0].receipts['start-native-host']['obsolete'],
      undefined,
    );
  });
});

test('an unattached Manager cannot complete a stop from an old stopped receipt', async () => {
  await fixture(async (store, runtime) => {
    const { operation } = store.start('stop', 'old-stop', {
      ...runtime.identity,
    });
    operation.completed = ['stop-native-host'];
    operation.receipts['stop-native-host'] = {
      protocolVersion: 1,
      state: 'stopped',
    };
    store.save(operation);
    store.interrupt();
    runtime.stop = async () => {
      throw new Refusal('native_owner_not_attached');
    };
    const operations = new NativeOperations(store, runtime);
    operations.resume(operation.id);
    const outcome = await operations.wait(operation.id);
    assert.equal(outcome.state, 'failed');
    assert.equal(outcome.error, 'native_owner_not_attached');
    assert.throws(
      () => store.start('restore', 'unsafe-restore', {}),
      /operation_in_progress/,
    );
  });
});

test('native recovery refuses another installation or a Docker operation', async () => {
  await fixture(async (store, runtime) => {
    const { operation } = store.start('start', 'another-installation', {
      ...runtime.identity,
      fingerprint: 'e'.repeat(64),
    });
    store.interrupt();
    const operations = new NativeOperations(store, runtime);
    assert.throws(
      () => operations.resume(operation.id),
      /operation_not_recoverable/,
    );
    operation.input = {};
    operation.state = 'interrupted';
    store.save(operation);
    assert.throws(
      () => operations.resume(operation.id),
      /operation_not_recoverable/,
    );
  });
});

test('a lost stop receipt is reconciled without repeating the shutdown effect', async () => {
  await fixture(async (store, runtime) => {
    let stopped = false;
    let effects = 0;
    runtime.stop = async () => {
      if (!stopped) {
        stopped = true;
        effects++;
      }
      return { protocolVersion: 1, state: 'stopped' };
    };
    const save = store.save.bind(store);
    let loseReceipt = true;
    store.save = (operation) => {
      if (loseReceipt && operation.completed.includes('stop-native-host')) {
        loseReceipt = false;
        throw Error('synthetic-private-storage-error');
      }
      save(operation);
    };
    const operations = new NativeOperations(store, runtime);
    const operation = operations.control('stop', 'lost-stop');
    assert.equal(
      (await operations.wait(operation.id)).error,
      'operation_failed',
    );
    assert.throws(
      () => operations.control('start', 'cannot-race-recovery'),
      /operation_in_progress/,
    );
    operations.resume(operation.id);
    assert.equal((await operations.wait(operation.id)).state, 'complete');
    assert.equal(effects, 1);
    assert.doesNotMatch(JSON.stringify(store.history()), /synthetic-private/);
  });
});

test('journal failure before the effect retains its lock and returns a stable refusal', async () => {
  await fixture(async (store, runtime) => {
    const save = store.save.bind(store);
    let starts = 0;
    const start = runtime.start;
    runtime.start = async () => {
      starts++;
      return start();
    };
    store.save = () => {
      throw Error('synthetic-private-journal-error');
    };
    const operations = new NativeOperations(store, runtime);
    const operation = operations.control('start', 'journal-failure');
    await assert.rejects(
      operations.wait(operation.id),
      /operation_journal_unavailable/,
    );
    assert.equal(starts, 0);
    assert.equal(store.history()[0].state, 'running');
    assert.throws(
      () => store.start('restore', 'cannot-race-journal-failure', {}),
      /operation_in_progress/,
    );
    store.save = save;
    store.interrupt();
    operations.resume(operation.id);
    assert.equal((await operations.wait(operation.id)).state, 'complete');
    assert.equal(starts, 1);
    assert.doesNotMatch(JSON.stringify(store.history()), /synthetic-private/);
  });
});
