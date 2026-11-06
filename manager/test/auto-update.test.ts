import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import { Refusal } from '../src/contracts.js';

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

// FL-1255: a failed or interrupted operation keeps the single-operation lock, so a review would only fail at update().
// FL-1231: a rolled-back or cancelled update completes with its code as the error; neither may be retried automatically.
test('automatic updates wait for the lock and the administrator, never retry a rolled-back release, and record why a check failed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-auto-update-held-'));
  const store = new Store(directory);
  try {
    const releases = {
      available: async () =>
        ['frameleaf-v1.3.0', 'frameleaf-v1.2.0', 'frameleaf-v1.1.5'].map((tag) => ({ tag, publishedAt: '', notes: '' })),
    };
    const operations = new Operations(store, {} as never, releases as never, {} as never, [], {} as never);
    const reviewed: string[] = [];
    (operations as any).reviewUpdate = async (tag: string) => (reviewed.push(tag), { id: tag });
    (operations as any).update = (id: string) => ({ id });
    store.set('installation', { release: 'frameleaf-v1.1.0' });

    const held = store.start('import', 'held', {}).operation;
    for (const state of ['failed', 'interrupted'] as const) {
      held.state = state;
      store.save(held);
      assert.equal(await operations.autoUpdate(), null, `an ${state} import holds the lock`);
    }
    held.state = 'complete';
    store.save(held);

    const settled = (key: string, error: string | null) => {
      const operation = store.start('update', key, {}).operation;
      operation.state = 'complete';
      operation.error = error;
      if (error) operation.receipts['cancelled'] = error;
      store.save(operation);
    };
    settled('rolled-back', 'update_failed_rolled_back');
    store.set('rolled-back-releases', ['frameleaf-v1.2.0']);
    assert.equal(await operations.autoUpdate(), null, 'a rolled-back update waits for the administrator');
    settled('cancelled', 'update_cancelled_previous_release_running');
    assert.equal(await operations.autoUpdate(), null, 'a cancelled update waits for the administrator');
    assert.deepEqual(reviewed, []);

    // The administrator's own update to v1.1.5 succeeds: automatic updates resume, past the rolled-back v1.2.0.
    settled('manual', null);
    store.set('installation', { release: 'frameleaf-v1.1.5' });
    (operations as any).reviewUpdate = async () => {
      throw new Refusal('release_download_failed');
    };
    await assert.rejects(operations.autoUpdate(), /release_download_failed/);
    const failure = store.get<{ code: string; at: string }>('auto-update-failure');
    assert.equal(failure?.code, 'release_download_failed');
    assert.ok(!Number.isNaN(Date.parse(failure!.at)));

    (operations as any).reviewUpdate = async (tag: string) => (reviewed.push(tag), { id: tag });
    assert.deepEqual(await operations.autoUpdate(), { id: 'frameleaf-v1.3.0' });
    assert.deepEqual(reviewed, ['frameleaf-v1.3.0'], 'the rolled-back release is skipped');
    assert.equal(store.get('auto-update-failure'), null, 'a check that starts an update clears the failure');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
