import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { fileHash } from '../src/files.js';
import { Operations, ROLLBACK_DAYS } from '../src/operations.js';

// FL-973: going back to the release before the last update, with the database as it was just before it.
const image = (name: string) => `fixture.invalid/${name}@sha256:${'a'.repeat(64)}`;

async function fixture(options: { snapshotRelease?: string; snapshotUnreadable?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'manager-rollback-'));
  const store = new Store(directory);
  const media = join(directory, 'photos');
  await mkdir(media);
  const previous = {
    id: 'a'.repeat(12),
    project: `frameleaf-${'a'.repeat(12)}`,
    release: 'frameleaf-v1.2.13',
    port: 2283,
    ml: false,
    origin: 'new_library' as const,
    sourceId: null,
    mayHaveWrittenMedia: true,
    databaseRoot: directory,
    databasePath: join(directory, 'db-$before'),
    mounts: [{ type: 'bind' as const, source: media, target: '/data', readOnly: false }],
  };
  const current = { ...previous, release: 'frameleaf-v1.2.14', databasePath: join(directory, 'db-after') };
  const previousCompose = {
    services: {
      database: { image: image('postgres'), volumes: [{ type: 'bind', source: join(directory, 'db-$$before'), target: '/var/lib/postgresql' }] },
      'frameleaf-server': { image: image('server-1.2.13') },
    },
  };
  await mkdir(join(directory, 'stack'));
  await writeFile(join(directory, 'stack', 'compose.json'), JSON.stringify({ services: { 'frameleaf-server': { image: image('server-1.2.14') } } }));
  store.set('installation', current);
  store.set('database-password', 'p'.repeat(48));
  const updatedAt = Date.now() - 86_400_000;
  store.set('rollback-point', {
    update: 'u',
    previous: previous.release,
    installed: current.release,
    installationId: current.id,
    snapshot: 'snap-before',
    at: updatedAt,
  });

  const events: string[] = [];
  const docker = {
    compatibility: async () => ({ platform: 'linux/amd64' }),
    pull: async (name: string) => { events.push(`pull ${name}`); },
    compose: async (_dir: string, _project: string, action: string, services: string[] = []) => {
      const stack = JSON.parse(await readFile(join(directory, 'stack', 'compose.json'), 'utf8'));
      events.push(`${action}${services.length ? ` ${services.join(',')}` : ''} ${stack.services['frameleaf-server']?.image ?? ''}`.trim());
    },
    inventory: async () => [
      {
        Id: 'b'.repeat(64),
        Config: { Labels: { 'app.frameleaf.manager': current.id, 'com.docker.compose.service': 'database' } },
        Mounts: [{ Type: 'bind', Source: store.get<any>('installation').databasePath, RW: true, Destination: '/var/lib/postgresql' }],
      },
    ],
    sql: async () => JSON.stringify({ uploads: 6, libraryFiles: 3, albums: 2, names: 1 }),
    verifyDump: async () => { events.push('verify-dump'); },
    restore: async () => { events.push('restore'); },
  };
  const backups = {
    restore: async (snapshot: string, checkpoint: string) => {
      if (options.snapshotUnreadable) throw new Error('restic: no such snapshot');
      assert.equal(snapshot, 'snap-before');
      await mkdir(checkpoint);
      await writeFile(join(checkpoint, 'database.dump'), 'pre-update dump');
      await writeFile(join(checkpoint, 'compose.json'), JSON.stringify(previousCompose));
      await writeFile(
        join(checkpoint, 'recovery.json'),
        JSON.stringify({
          schemaVersion: 2,
          mediaIncluded: false,
          databaseFormat: 'frameleaf-canonical',
          databasePassword: 'p'.repeat(48),
          application: { environment: {}, settings: null, authority: 'database' },
          dumpSha256: await fileHash(join(checkpoint, 'database.dump')),
          installation: { ...previous, release: options.snapshotRelease ?? previous.release },
        }),
      );
    },
  };
  const databaseStorage = { verify: async () => {}, allocate: async () => join(directory, 'db-$rollback') };
  const operations = new Operations(store, docker as never, {} as never, backups as never, [directory], databaseStorage as never);
  (operations as any).fencing = { assertMedia: async () => {}, verify: async () => {} };
  const cleanup = async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, store, operations, events, previous, current, updatedAt, cleanup };
}

async function settle(operations: Operations, id: string) {
  for (let i = 0; i < 200; i++) {
    const operation = operations.history().find((o) => o.id === id)!;
    if (operation.state !== 'running') return operation;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('operation did not settle');
}

test('going back restores the pre-update database into a new folder and starts the previous release', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.operations.rollbackOffer(), {
      from: 'frameleaf-v1.2.14',
      to: 'frameleaf-v1.2.13',
      updatedAt: f.updatedAt,
      until: f.updatedAt + ROLLBACK_DAYS * 86_400_000,
    });
    const review = await f.operations.reviewRollback();
    assert.equal(review.to, 'frameleaf-v1.2.13');
    // What was done since the update is shown before anything is confirmed.
    assert.deepEqual(review.since, { uploads: 6, libraryFiles: 3, albums: 2, names: 1 });

    const operation = f.operations.rollback(review.id, 'k');
    const done = await settle(f.operations, operation.id);
    assert.equal(done.state, 'complete', String(done.error));
    // Every image is fetched before anything stops; one version runs at a time; the new release never starts again.
    assert.deepEqual(f.events, [
      `pull ${image('postgres')}`,
      `pull ${image('server-1.2.13')}`,
      `stop ${image('server-1.2.14')}`,
      `up database ${image('server-1.2.13')}`,
      'verify-dump',
      'restore',
      `up ${image('server-1.2.13')}`,
    ]);
    const installation = f.store.get<any>('installation');
    assert.equal(installation.release, 'frameleaf-v1.2.13');
    assert.equal(installation.databasePath, join(f.directory, 'db-$rollback'), 'restored into an empty folder');
    assert.deepEqual(f.store.get('retained-database-directories'), [f.current.databasePath], 'the newer database folder is kept');
    const stack = JSON.parse(await readFile(join(f.directory, 'stack', 'compose.json'), 'utf8'));
    assert.equal(stack.services.database.volumes[0].source, join(f.directory, 'db-$$rollback'));
    assert.deepEqual(f.store.get('rolled-back-releases'), ['frameleaf-v1.2.14'], 'automatic updates skip it');
    assert.equal(f.store.get('rollback-point'), null, 'only one release back');
    assert.equal(f.operations.rollbackOffer(), null);
  } finally {
    await f.cleanup();
  }
});

test('going back is refused, with a reason, when there is nothing safe to go back to', async () => {
  const f = await fixture();
  try {
    // A day past the window.
    assert.equal(f.operations.rollbackOffer(f.updatedAt + (ROLLBACK_DAYS + 1) * 86_400_000), null);
    // A restore after the update replaced the library the checkpoint describes.
    const { operation } = f.store.start('restore', 'r', {});
    operation.state = 'complete';
    f.store.save(operation);
    assert.equal(f.operations.rollbackOffer(), null);
    await assert.rejects(f.operations.reviewRollback(), /rollback_unavailable/);
    f.store.delete('rollback-point');
    await assert.rejects(f.operations.reviewRollback(), /rollback_unavailable/);
  } finally {
    await f.cleanup();
  }
  const unreadable = await fixture({ snapshotUnreadable: true });
  try {
    await assert.rejects(unreadable.operations.reviewRollback(), /rollback_checkpoint_unreadable/);
    assert.deepEqual(unreadable.events, [], 'nothing stopped');
  } finally {
    await unreadable.cleanup();
  }
  const other = await fixture({ snapshotRelease: 'frameleaf-v1.2.12' });
  try {
    await assert.rejects(other.operations.reviewRollback(), /rollback_checkpoint_mismatch/);
  } finally {
    await other.cleanup();
  }
});

test('an interrupted rollback stays stopped until it is resumed, and resuming never starts both versions', async () => {
  const f = await fixture();
  try {
    const review = await f.operations.reviewRollback();
    const docker = (f.operations as any).docker;
    const restore = docker.restore;
    docker.restore = async () => { throw new Error('connection reset during restore'); };
    const operation = f.operations.rollback(review.id, 'k');
    const failed = await settle(f.operations, operation.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.canCancel, false, 'it cannot be cancelled back onto a half-restored database');
    await assert.rejects(f.operations.recover(operation.id), /rollback_resume_required/);
    assert.ok(!f.events.some((event) => event === `up ${image('server-1.2.14')}`), 'the newer release was not started');

    docker.restore = restore;
    f.events.length = 0;
    f.operations.resume(operation.id);
    const done = await settle(f.operations, operation.id);
    assert.equal(done.state, 'complete', String(done.error));
    assert.deepEqual(f.events, [`up database ${image('server-1.2.13')}`, 'verify-dump', 'restore', `up ${image('server-1.2.13')}`]);
  } finally {
    await f.cleanup();
  }
});

test('a rollback cancelled before anything stopped leaves the library as it was', async () => {
  const f = await fixture();
  try {
    const review = await f.operations.reviewRollback();
    const docker = (f.operations as any).docker;
    docker.pull = async () => { throw new Error('registry unreachable'); };
    const operation = f.operations.rollback(review.id, 'k');
    const failed = await settle(f.operations, operation.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.canCancel, true);
    await f.operations.recover(operation.id);
    const cancelled = f.operations.history().find((o) => o.id === operation.id)!;
    assert.equal(cancelled.state, 'complete');
    assert.equal(cancelled.error, 'rollback_cancelled');
    assert.equal(f.store.get<any>('installation').release, 'frameleaf-v1.2.14');
    assert.ok(!f.events.some((event) => event.startsWith('stop')));
  } finally {
    await f.cleanup();
  }
});

test('a finished update records the release it replaced and its checkpoint, so it can be undone', async () => {
  const f = await fixture();
  try {
    f.store.delete('rollback-point');
    await writeFile(join(f.directory, 'stack', 'compose.json'), JSON.stringify({ services: { database: { image: image('postgres') } } }));
    const { operation } = f.store.start('update', 'u', { reviewId: 'r' });
    operation.completed = ['download-images', 'stop-application', 'database-checkpoint'];
    operation.receipts['database-checkpoint'] = 'snap-before';
    f.store.save(operation);
    (f.operations as any).applyRelease = async () => {};
    const review = {
      current: f.previous,
      platform: 'linux/amd64',
      release: { nas: { tag: 'frameleaf-v1.2.14', images: { postgres: image('postgres') } } },
    };
    await (f.operations as any).applyUpdate(operation, review);
    const point = f.store.get<any>('rollback-point');
    assert.equal(point.update, operation.id);
    assert.equal(point.previous, 'frameleaf-v1.2.13');
    assert.equal(point.installed, 'frameleaf-v1.2.14');
    assert.equal(point.snapshot, 'snap-before');
  } finally {
    await f.cleanup();
  }
});
