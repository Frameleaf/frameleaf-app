import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { Operations } from '../src/operations.js';
async function fixture(
  run: (
    store: Store,
    operations: Operations,
    effects: string[],
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'manager-desktop-control-')),
    store = new Store(directory),
    effects: string[] = [];
  const operations = new Operations(
    store,
    {
      compose: async (_directory: string, project: string) => {
        effects.push(project);
      },
    } as never,
    {} as never,
    {} as never,
    [],
    {} as never,
  );
  store.set('installation', { id: 'a'.repeat(12), project: 'first' });
  try {
    await run(store, operations, effects);
  } finally {
    if (store.history().some((o) => o.state === 'running'))
      await settled(store);
    await new Promise(setImmediate);
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function settled(store: Store) {
  for (let i = 0; i < 100; i++) {
    const operation = store.history()[0];
    if (operation.state !== 'running') return operation;
    await new Promise(setImmediate);
  }
  throw Error('operation did not settle');
}
test('desktop lifecycle intents bind the installation and refuse changed targets before launch', async () => {
  await fixture(async (store, operations, effects) => {
    assert.throws(
      () => operations.control('stop', 'wrong-target', 'b'.repeat(12)),
      /installation_changed/,
    );
    assert.deepEqual(effects, []);
    const operation = operations.control('stop', 'bound-stop', 'a'.repeat(12));
    assert.deepEqual(operation.input, { installationId: 'a'.repeat(12) });
    assert.equal((await settled(store)).state, 'complete');
    assert.deepEqual(effects, ['first']);
    assert.equal(
      operations.control('stop', 'bound-stop', 'a'.repeat(12)).id,
      operation.id,
    );
    assert.throws(
      () => operations.control('stop', 'bound-stop'),
      /request_key_reused/,
    );
  });
});
test('resuming an acknowledged old desktop stop cannot confirm a replacement installation', async () => {
  await fixture(async (store, operations, effects) => {
    const { operation } = store.start('stop', 'old-stop', {
      installationId: 'a'.repeat(12),
    });
    operation.completed.push('stop');
    operation.state = 'interrupted';
    store.save(operation);
    store.set('installation', { id: 'b'.repeat(12), project: 'replacement' });
    operations.resume(operation.id);
    const result = await settled(store);
    assert.equal(result.state, 'failed');
    assert.equal(result.error, 'installation_changed');
    assert.deepEqual(effects, []);
  });
});
