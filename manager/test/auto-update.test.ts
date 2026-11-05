import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';

test('automatic updates: on by default, one release step at a time, off or after a failed update does nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-auto-update-'));
  const store = new Store(directory);
  try {
    const releases = { available: async () => ['frameleaf-v1.3.0', 'frameleaf-v1.2.0', 'frameleaf-v1.1.0', 'frameleaf-v1.2.1'].map((tag) => ({ tag, publishedAt: '', notes: '' })) };
    const operations = new Operations(store, {} as never, releases as never, {} as never, [], {} as never);
    const reviewed: string[] = [];
    (operations as any).reviewUpdate = async (tag: string) => (reviewed.push(tag), { id: tag });
    (operations as any).update = (id: string) => ({ id });

    assert.equal(await operations.autoUpdate(), null, 'no installation');
    store.set('installation', { release: 'frameleaf-v1.1.0' });
    assert.deepEqual(await operations.autoUpdate(), { id: 'frameleaf-v1.2.0' });
    assert.deepEqual(reviewed, ['frameleaf-v1.2.0']);

    store.set('auto-update', false);
    assert.equal(await operations.autoUpdate(), null, 'turned off');
    store.set('auto-update', true);

    (operations as any).reviewUpdate = async (tag: string) => (store.set('auto-update', false), { id: tag });
    assert.equal(await operations.autoUpdate(), null, 'turned off during the review');
    store.set('auto-update', true);

    (operations as any).reviewUpdate = async (tag: string) => (reviewed.push(tag), { id: tag });
    const pending = store.start('import', 'pending', {}).operation;
    for (const state of ['running', 'awaiting-review'] as const) {
      pending.state = state;
      store.save(pending);
      assert.equal(await operations.autoUpdate(), null, `another operation is ${state}`);
    }
    pending.state = 'complete';
    store.save(pending);

    const failed = store.start('update', 'failed', {}).operation;
    failed.state = 'failed';
    store.save(failed);
    assert.equal(await operations.autoUpdate(), null, 'failed update waits for the administrator');
    assert.deepEqual(reviewed, ['frameleaf-v1.2.0']);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
