import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Operations } from '../src/operations.js';
import { Retention } from '../src/retention.js';
import { Store } from '../src/store.js';
import type { Container, Docker } from '../src/docker.js';

// Review M3: dumps, recovery records, restore reviews, move state and release bundles were never collected.

const exists = (path: string) => stat(path).then(() => true, () => false);
async function checkpoint(directory: string, id: string) {
  await mkdir(join(directory, 'checkpoints', id), { recursive: true });
  for (const name of ['database.dump', 'recovery.json', 'compose.json'])
    await writeFile(join(directory, 'checkpoints', id, name), name);
}
async function bundle(root: string, id: string, ageMinutes: number) {
  await mkdir(join(root, id), { recursive: true });
  await writeFile(join(root, id, 'nas-manifest.json'), '{}');
  const when = new Date(Date.now() - ageMinutes * 60_000);
  await utimes(join(root, id), when, when);
}

test('settled operations lose their plaintext dump and recovery record; open ones keep everything', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-retention-'));
  const store = new Store(directory);
  try {
    const done = store.start('backup', 'done', {}).operation;
    done.state = 'complete';
    store.save(done);
    const failed = store.start('backup', 'failed', {}).operation;
    failed.state = 'failed';
    store.save(failed);
    const forgotten = randomUUID(); // beyond the journal: nothing can resume it
    for (const id of [done.id, failed.id, forgotten]) await checkpoint(directory, id);
    await mkdir(join(directory, 'checkpoints', 'not-an-operation'));
    await writeFile(join(directory, 'checkpoints', 'not-an-operation', 'database.dump'), 'x');
    await mkdir(join(directory, 'imports'));
    for (const id of [done.id, failed.id, forgotten]) await writeFile(join(directory, 'imports', `${id}.dump`), 'dump');
    await writeFile(join(directory, 'imports', 'notes.txt'), 'keep');

    const removed = await new Retention(store, directory, join(directory, 'releases')).sweep();
    assert.equal(removed.length, 6);
    for (const id of [done.id, forgotten]) {
      assert.equal(await exists(join(directory, 'checkpoints', id, 'database.dump')), false, id);
      assert.equal(await exists(join(directory, 'checkpoints', id, 'recovery.json')), false, id);
      assert.equal(await exists(join(directory, 'checkpoints', id, 'compose.json')), true, 'compose.json is kept');
      assert.equal(await exists(join(directory, 'imports', `${id}.dump`)), false, id);
    }
    assert.deepEqual((await readdir(join(directory, 'checkpoints', failed.id))).sort(), ['compose.json', 'database.dump', 'recovery.json']);
    assert.equal(await exists(join(directory, 'imports', `${failed.id}.dump`)), true, 'a failed import can still resume');
    assert.equal(await exists(join(directory, 'imports', 'notes.txt')), true);
    assert.equal(await exists(join(directory, 'checkpoints', 'not-an-operation', 'database.dump')), true);
    // Cancelling the failed operation settles it; the next sweep collects it.
    failed.state = 'complete';
    store.save(failed);
    assert.equal((await new Retention(store, directory, join(directory, 'releases')).sweep()).length, 3);
    assert.equal(await exists(join(directory, 'imports', `${failed.id}.dump`)), false);
    assert.deepEqual(await new Retention(store, directory, join(directory, 'releases')).sweep(), []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// An operation that starts while the sweep lists the directories must be in the journal snapshot the sweep
// judges those listings by; a checkpoint written in that window was collected as "forgotten" otherwise.
test('the journal is read after the directories are listed, so a checkpoint that appears mid-sweep is kept', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-retention-race-'));
  const store = new Store(directory);
  try {
    let started: string | undefined;
    const retention = new Retention(store, directory, join(directory, 'releases'));
    const entries = (retention as any).entries.bind(retention);
    (retention as any).entries = async (path: string) => {
      const listed = await entries(path);
      if (path.endsWith('checkpoints') && !started) {
        // The listing has happened; now an operation starts and takes its checkpoint before history() is read.
        const operation = store.start('backup', 'late', {}).operation;
        started = operation.id;
        await checkpoint(directory, operation.id);
        return listed.concat(operation.id);
      }
      return listed;
    };
    await mkdir(join(directory, 'checkpoints'));
    await mkdir(join(directory, 'imports'));
    const removed = await retention.sweep();
    assert.ok(started);
    assert.deepEqual(removed, []);
    assert.deepEqual((await readdir(join(directory, 'checkpoints', started!))).sort(), ['compose.json', 'database.dump', 'recovery.json']);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('restore reviews, move state and release bundles are kept only while a review or open operation needs them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-retention-reviews-'));
  const store = new Store(directory);
  const releases = join(directory, 'releases');
  try {
    const now = Date.now();
    const review = (prefix: string, expires: number, extra: Record<string, unknown> = {}) => {
      const id = randomUUID();
      store.set(`${prefix}:${id}`, { id, expires, ...extra });
      return id;
    };
    const expired = review('restore', now - 1, { checkpoint: 'x' });
    const fresh = review('restore', now + 60_000, { checkpoint: 'x' });
    const spent = review('restore', now + 60_000, { checkpoint: 'x' });
    const open = review('restore', now - 1, { checkpoint: 'x' });
    const orphan = randomUUID();
    for (const id of [expired, fresh, spent, open, orphan]) {
      await mkdir(join(directory, `restore-${id}`));
      await writeFile(join(directory, `restore-${id}`, 'database.dump'), 'dump');
    }
    await mkdir(join(directory, 'restore-notes'));
    const finished = store.start('restore', 'finished', { reviewId: spent }).operation;
    finished.state = 'complete';
    store.save(finished);
    const interrupted = store.start('restore', 'interrupted', { reviewId: open }).operation;
    interrupted.state = 'interrupted';
    store.save(interrupted);
    const staleMove = review('media-move', now - 1);
    const liveMove = review('media-move', now + 60_000);
    for (const id of [staleMove, liveMove]) await mkdir(join(directory, 'media-moves', id), { recursive: true });
    // Five bundles: the oldest is pinned by a fresh install review, the other four keep the newest three.
    const pinnedBundle = randomUUID();
    const ages = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), pinnedBundle];
    for (const [index, id] of ages.entries()) await bundle(releases, id, index * 10);
    review('review', now + 60_000, { release: { directory: join(releases, pinnedBundle) } });
    await mkdir(join(releases, 'not-a-bundle'));

    const removed = await new Retention(store, directory, releases).sweep(now);
    assert.deepEqual(
      removed.sort(),
      [join(directory, `restore-${expired}`), join(directory, `restore-${spent}`), join(directory, `restore-${orphan}`),
        join(directory, 'media-moves', staleMove), join(releases, ages[3])].sort(),
    );
    for (const id of [fresh, open]) assert.equal(await exists(join(directory, `restore-${id}`)), true, id);
    assert.equal(await exists(join(directory, 'restore-notes')), true);
    assert.ok(store.get(`restore:${spent}`), 'the review record stays for the operation history');
    assert.equal(await exists(join(directory, 'media-moves', liveMove)), true);
    for (const id of [...ages.slice(0, 3), pinnedBundle]) assert.equal(await exists(join(releases, id)), true, id);
    assert.equal(await exists(join(releases, 'not-a-bundle')), true);
    // The pinned bundle outlives newer unpinned ones; once its review expires it joins the rotation.
    await bundle(releases, randomUUID(), 0);
    await new Retention(store, directory, releases).sweep(now);
    assert.equal(await exists(join(releases, pinnedBundle)), true);
    assert.equal(await exists(join(releases, ages[2])), false);
    await new Retention(store, directory, releases).sweep(now + 120_000);
    assert.equal(await exists(join(releases, pinnedBundle)), false, 'oldest of the unpinned bundles');
    assert.equal((await readdir(releases)).filter((name) => name !== 'not-a-bundle').length, 3);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Manager prunes at start and after every operation settles, and the sweep never fails an operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-retention-ops-'));
  const store = new Store(directory);
  try {
    store.set('installation', { id: 'a'.repeat(12), project: 'frameleaf-aaaaaaaaaaaa', mounts: [], sourceId: null });
    const previous = store.start('backup', 'previous', {}).operation;
    previous.state = 'complete';
    store.save(previous);
    await checkpoint(directory, previous.id);
    const stopped = Promise.withResolvers<void>();
    const docker = { compose: () => stopped.promise, inventory: async () => [] } as unknown as Docker;
    const operations = new Operations(store, docker, {} as never, {} as never, [], { verify: async () => {} } as never);
    (operations as any).fencing = { assertMedia: async () => {} };
    assert.equal((await operations.prune()).length, 2);
    const stop = operations.control('stop', 'stop-1');
    try {
      await checkpoint(directory, stop.id);
    } finally {
      stopped.resolve();
    }
    for (const deadline = Date.now() + 5000; store.history()[0].state === 'running' && Date.now() < deadline; )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(store.history()[0].state, 'complete');
    // The sweep runs after the operation settles; emulated arm64 runners need more than a few hundred ms.
    for (const deadline = Date.now() + 5000; (await exists(join(directory, 'checkpoints', stop.id, 'database.dump'))) && Date.now() < deadline; )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await exists(join(directory, 'checkpoints', stop.id, 'database.dump')), false);
    assert.equal(await exists(join(directory, 'checkpoints', stop.id, 'compose.json')), true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Review L2: Manager guessed its own port as 2282 when MANAGER_ORIGIN was unset.
test('the port Manager itself is reached on is never offered to the stack', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-own-port-'));
  const store = new Store(directory);
  const origin = process.env.MANAGER_ORIGIN;
  delete process.env.MANAGER_ORIGIN;
  try {
    const self = {
      Id: 'c'.repeat(64),
      Name: '/frameleaf-manager',
      State: { Running: true },
      Config: { Env: [`MANAGER_DATA=${directory}`], Labels: { 'app.frameleaf.manager.role': 'controller' } },
      HostConfig: { PortBindings: { '9443/tcp': [{ HostIp: '0.0.0.0', HostPort: '9443' }] } },
      Mounts: [],
    } as unknown as Container;
    const other = { ...self, Id: 'd'.repeat(64), Config: { Env: ['MANAGER_DATA=/elsewhere'], Labels: self.Config.Labels },
      HostConfig: { PortBindings: { '9443/tcp': [{ HostIp: '0.0.0.0', HostPort: '2284' }] } } } as unknown as Container;
    const docker = { inventory: async () => [self, other] } as unknown as Docker;
    const operations = new Operations(store, docker, {} as never, {} as never, [], {} as never);
    await assert.rejects(operations.checkPort(9443), /port_in_use/);
    await assert.rejects(operations.checkPort(2282), /port_in_use/);
    await assert.rejects(operations.checkPort(2284), /port_in_use/);
    await assert.rejects(operations.checkPort(2283, null, null, 2283), /port_in_use/);
    await operations.checkPort(2283);
    await operations.checkPort(2285, null, null, 9443);
  } finally {
    if (origin !== undefined) process.env.MANAGER_ORIGIN = origin;
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
