import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Docker } from '../src/docker.js';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import { fileHash } from '../src/files.js';
import type { Installation, Mount } from '../src/contracts.js';
import type { Releases, VerifiedRelease } from '../src/releases.js';
import type { Backups } from '../src/backups.js';
import type { PostgresStorage } from '../src/postgres-storage.js';
import {
  THUMBNAIL_TARGET,
  assertComposeMountSources,
  assertMountSources,
  assertMounts,
  libraryMounts,
  seedThumbnailMarker,
  thumbnailFolder,
  thumbnailMount,
  visibility,
  withThumbnails,
} from '../src/mounts.js';

const project = 'frameleaf-' + 'a'.repeat(12);
const image = (c: string) => `ghcr.io/frameleaf/frameleaf-server@sha256:${c.repeat(64)}`;
const library = (source: string): Mount => ({ type: 'bind', source, target: '/data', readOnly: false });
const thumbs = (source: string): Mount => ({ type: 'bind', source, target: THUMBNAIL_TARGET, readOnly: false });

async function folder(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'manager-thumbnails-')));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a thumbnail mount is the second entry, beside a writable /data library bind, and is kept apart from it', () => {
  const mounts = withThumbnails([library('/mnt/user/photos')], '/mnt/fast/thumbs');
  assert.deepEqual(mounts, [library('/mnt/user/photos'), thumbs('/mnt/fast/thumbs')]);
  assert.deepEqual(thumbnailMount(mounts), thumbs('/mnt/fast/thumbs'));
  assert.deepEqual(libraryMounts(mounts), [library('/mnt/user/photos')]);
  assert.equal(thumbnailFolder(mounts), '/mnt/fast/thumbs');
  assert.equal(thumbnailFolder(libraryMounts(mounts)), '/mnt/user/photos/thumbs');
  // Moving thumbnails back into the photos folder drops the mount; an import's extra folders keep their place.
  const extra: Mount = { type: 'bind', source: '/mnt/user/external', target: '/external', readOnly: true };
  assert.deepEqual(withThumbnails([...mounts, extra], null), [library('/mnt/user/photos'), extra]);
  assert.deepEqual(withThumbnails([library('/p'), extra], '/t'), [library('/p'), thumbs('/t'), extra]);
  for (const bad of [
    [thumbs('/t'), library('/p')],
    [library('/p'), thumbs('/t'), thumbs('/u')],
    [{ ...library('/p'), readOnly: true }, thumbs('/t')],
    [{ ...library('p'), type: 'volume' as const }, thumbs('/t')],
    [library('/p'), { ...thumbs('/t'), readOnly: true }],
    [library('/p'), thumbs('/p/thumbs')],
    [library('/p/inner'), thumbs('/p')],
  ])
    assert.throws(() => assertMounts(bad), /unsupported_thumbnail_mount/, JSON.stringify(bad));
  assertMounts([library('/p')]);
});

test('a missing drive is named before a start: thumbnails, photos and any other folder', async () => {
  await folder(async (root) => {
    const photos = join(root, 'photos'),
      fast = join(root, 'fast', 'thumbs');
    await mkdir(photos);
    await assert.rejects(assertMountSources([library(photos), thumbs(fast)]), (error: any) => {
      assert.equal(error.code, 'thumbnail_folder_missing');
      assert.match(error.detail, /photos are untouched/);
      assert.ok(error.detail.includes(fast));
      return true;
    });
    await assert.rejects(assertMountSources([library(join(root, 'gone'))]), /media_folder_missing/);
    await mkdir(fast, { recursive: true });
    await assertMountSources([library(photos), thumbs(fast)]);
    // The rendered stack: Compose doubles `$`, and only the services being started are checked.
    const dollar = join(root, '$fast');
    await mkdir(join(root, 'db'));
    const compose = (thumbnails: string) => ({
      services: {
        'frameleaf-server': {
          volumes: [
            { type: 'bind', source: photos, target: '/data' },
            { type: 'bind', source: thumbnails.replaceAll('$', () => '$$'), target: THUMBNAIL_TARGET },
            { type: 'volume', source: 'model-cache', target: '/cache' },
          ],
        },
        database: { volumes: [{ type: 'bind', source: join(root, 'db'), target: '/var/lib/postgresql' }] },
      },
    });
    await writeFile(join(root, 'compose.json'), JSON.stringify(compose(dollar)));
    await assert.rejects(assertComposeMountSources(root), /thumbnail_folder_missing/);
    await assertComposeMountSources(root, ['database']);
    await mkdir(dollar);
    await assertComposeMountSources(root);
    await rm(join(root, 'db'), { recursive: true });
    await assert.rejects(assertComposeMountSources(root, ['database']), /mounted_folder_missing/);
  });
});

test('Docker is never asked to start a stack whose thumbnails drive is missing', async () => {
  await folder(async (root) => {
    const photos = join(root, 'photos'),
      fast = join(root, 'fast');
    await mkdir(photos);
    await writeFile(
      join(root, 'compose.json'),
      JSON.stringify({
        services: {
          'frameleaf-server': {
            image: image('a'),
            volumes: [
              { type: 'bind', source: photos, target: '/data' },
              { type: 'bind', source: fast, target: THUMBNAIL_TARGET },
            ],
          },
        },
      }),
    );
    const calls: string[][] = [];
    const docker = new Docker((_binary, args) => {
      calls.push(args);
      return Promise.resolve(image('a'));
    });
    for (const action of ['up', 'restart'] as const)
      await assert.rejects(docker.compose(root, project, action), /thumbnail_folder_missing/);
    assert.deepEqual(calls, []);
    await docker.compose(root, project, 'stop'); // stopping never needs the drive
    assert.equal(calls.length, 1);
    await mkdir(fast);
    await docker.compose(root, project, 'up');
    assert.ok(calls.some((args) => args[0] === 'compose' && args.includes('up')));
  });
});

test('the server marker is seeded only in a folder that is there, and an existing marker is kept', async () => {
  await folder(async (root) => {
    await assert.rejects(seedThumbnailMarker(join(root, 'unmounted-drive', 'thumbs')), /ENOENT/);
    await assert.rejects(readFile(join(root, 'unmounted-drive')), /ENOENT/, 'a missing drive is never recreated');
    const photos = join(root, 'photos');
    await mkdir(photos);
    assert.equal(await seedThumbnailMarker(join(photos, 'thumbs')), 'seeded');
    const marker = await readFile(join(photos, 'thumbs', '.frameleaf'), 'utf8');
    assert.match(marker, /^\d+$/);
    assert.equal(await seedThumbnailMarker(join(photos, 'thumbs')), 'present');
    assert.equal(await readFile(join(photos, 'thumbs', '.frameleaf'), 'utf8'), marker);
    const legacy = join(root, 'legacy');
    await mkdir(legacy);
    await writeFile(join(legacy, '.immich'), 'old');
    assert.equal(await seedThumbnailMarker(legacy), 'present');
    await assert.rejects(readFile(join(legacy, '.frameleaf')), /ENOENT/);
  });
});

test('an update stops nothing while the thumbnails drive is missing', async () => {
  await folder(async (root) => {
    const photos = join(root, 'photos');
    await mkdir(photos);
    await writeFile(join(root, 'compose.json'), JSON.stringify({ services: {} }));
    const calls: unknown[][] = [];
    const operations = Object.assign(Object.create(Operations.prototype), {
      directory: () => root,
      docker: { compose: (...args: unknown[]) => (calls.push(args), Promise.resolve()) },
      step: (_operation: unknown, name: string, action: () => Promise<unknown>) =>
        name === 'stop-application' ? action() : Promise.resolve(),
    });
    const current = { project, ml: false, mounts: [library(photos), thumbs(join(root, 'fast'))] };
    await assert.rejects(operations.applyUpdate({ receipts: {} }, { current }), /thumbnail_folder_missing/);
    assert.deepEqual(calls, []);
    const store = { get: () => ({ ...current, release: 'frameleaf-v1.0.0' }) };
    await assert.rejects(
      Object.assign(Object.create(Operations.prototype), { store, installation: () => store.get() }).reviewUpdate(
        'frameleaf-v1.0.1',
      ),
      /thumbnail_folder_missing/,
    );
    await mkdir(join(root, 'fast'));
    await operations.applyUpdate({ receipts: {} }, { current });
    assert.deepEqual(calls, [[root, project, 'stop', ['frameleaf-server']]]);
  });
});

test('a rollback puts the previous release back with its thumbnail mount, and names a missing drive', async () => {
  await folder(async (root) => {
    const photos = join(root, 'photos'),
      fast = join(root, 'fast'),
      databasePath = join(root, 'db');
    for (const path of [photos, fast, databasePath]) await mkdir(path);
    const store = new Store(join(root, 'state'));
    const directory = join(store.directory, 'stack');
    await mkdir(directory, { recursive: true });
    const previous = {
      id: 'a'.repeat(12),
      project,
      release: 'frameleaf-v1.0.0',
      mounts: [library(photos), thumbs(fast)],
      databasePath,
    } as Installation;
    const compose = {
      services: {
        database: {
          image: image('a'),
          volumes: [{ type: 'bind', source: databasePath, target: '/var/lib/postgresql' }],
        },
        'frameleaf-server': {
          image: image('a'),
          volumes: previous.mounts.map((m) => ({ type: 'bind', source: m.source, target: m.target, read_only: false })),
        },
      },
    };
    const calls: string[][] = [];
    const docker = new Docker((_binary, args) => (calls.push(args), Promise.resolve(image('a'))));
    const operations = Object.assign(Object.create(Operations.prototype), {
      store,
      docker,
      directory: () => directory,
      fencing: { assertMedia: async () => {} },
      step: async (operation: any, name: string, action: () => Promise<unknown>) => {
        if (operation.completed.includes(name)) return operation.receipts[name];
        operation.receipts[name] = await action();
        operation.completed.push(name);
        return operation.receipts[name];
      },
    });
    const rollback = async () => {
      const { operation } = store.start('update', `rollback-${calls.length}`, { reviewId: 'r' });
      await mkdir(join(store.directory, 'checkpoints', operation.id), { recursive: true });
      await writeFile(join(store.directory, 'checkpoints', operation.id, 'compose.json'), JSON.stringify(compose));
      operation.receipts['database-move-intent'] = { from: { image: image('a'), databasePath }, attempts: [] };
      await operations.rollbackUpdate(operation, { current: previous, release: { nas: { tag: 'frameleaf-v1.0.1' } } });
      return operation;
    };
    try {
      await rollback();
      assert.deepEqual(store.get<Installation>('installation')!.mounts, previous.mounts);
      const stack = JSON.parse(await readFile(join(directory, 'compose.json'), 'utf8'));
      assert.deepEqual(
        stack.services['frameleaf-server'].volumes.map((v: any) => [v.source, v.target]),
        [[photos, '/data'], [fast, THUMBNAIL_TARGET]],
      );
      assert.ok(calls.some((args) => args[0] === 'compose' && args.includes('up')));
      calls.length = 0;
      await rm(fast, { recursive: true });
      await assert.rejects(rollback(), /thumbnail_folder_missing/);
      assert.equal(calls.some((args) => args.includes('up')), false, 'Docker never sees the broken start');
    } finally {
      store.close();
    }
  });
});

async function restoreFixture(
  run: (context: {
    root: string;
    store: Store;
    operations: Operations;
    prior: Installation;
    photos: string;
    composeCalls: string[];
  }) => Promise<void>,
) {
  await folder(async (root) => {
    const store = new Store(join(root, 'state'));
    const photos = join(root, 'photos');
    await mkdir(photos);
    const prior = {
      id: 'aaaabbbbcccc',
      project: 'frameleaf-aaaabbbbcccc',
      release: 'frameleaf-v3.2.4-1',
      port: 2283,
      ml: false,
      origin: 'new_library',
      libraryId: 'aaaabbbbcccc',
      sourceId: null,
      mayHaveWrittenMedia: true,
      databaseRoot: root,
      databasePath: join(root, 'old-db'),
      mounts: [library(photos), thumbs(join(root, 'old-fast'))],
    } as Installation;
    const release = {
      directory: join(root, 'release'),
      nas: { tag: prior.release, platforms: ['linux/amd64'], images: { server: image('a'), postgres: image('b') } },
    } as unknown as VerifiedRelease;
    const composeCalls: string[] = [];
    const docker = {
      inventory: async () => [],
      compatibility: async () => ({ platform: 'linux/amd64' }),
      compose: async (_directory: string, _project: string, action: string) => {
        composeCalls.push(action);
      },
    } as unknown as Docker;
    const backups = {
      restore: async (_snapshot: string, checkpoint: string) => {
        await mkdir(checkpoint);
        await writeFile(join(checkpoint, 'database.dump'), 'fixture canonical dump');
        await writeFile(
          join(checkpoint, 'recovery.json'),
          JSON.stringify({
            schemaVersion: 2,
            mediaIncluded: false,
            databaseFormat: 'frameleaf-canonical',
            databasePassword: 'd'.repeat(48),
            application: { environment: {}, settings: null, authority: 'database' },
            dumpSha256: await fileHash(join(checkpoint, 'database.dump')),
            installation: prior,
          }),
        );
      },
    } as Backups;
    const operations = new Operations(
      store,
      docker,
      { acquire: async () => release, eligible: async () => {}, verify: async () => {} } as unknown as Releases,
      backups,
      [root],
      { validate: async () => ({}), allocate: async () => join(root, 'new-db'), verify: async () => {} } as unknown as PostgresStorage,
    );
    try {
      await run({ root, store, operations, prior, photos, composeCalls });
    } finally {
      store.close();
    }
  });
}

test('a backup from before thumbnails moved is still this library, and the restore keeps thumbnails where they are now', async () => {
  await restoreFixture(async ({ root, store, operations, prior, photos }) => {
    const now = join(root, 'new-fast');
    await mkdir(now);
    store.set('installation', { ...prior, mounts: [library(photos), thumbs(now)] });
    const review = await operations.reviewRestore('a'.repeat(64), root);
    assert.deepEqual(review.mounts, [library(photos), thumbs(now)]);
    assert.equal(review.thumbnailFallback, null);
    // Thumbnails moved back into the photos folder since the backup: no thumbnail mount is restored.
    store.set('installation', { ...prior, mounts: [library(photos)] });
    assert.deepEqual((await operations.reviewRestore('a'.repeat(64), root)).mounts, [library(photos)]);
    // A different photos folder is still another library.
    store.set('installation', { ...prior, mounts: [library(join(root, 'elsewhere')), thumbs(now)] });
    await assert.rejects(operations.reviewRestore('a'.repeat(64), root), /backup_belongs_to_another_library/);
  });
});

test('a restore whose thumbnail folder is gone offers the photos folder, and seeds the marker there before starting', async () => {
  await restoreFixture(async ({ root, store, operations, prior, photos, composeCalls }) => {
    await assert.rejects(operations.reviewRestore('a'.repeat(64), root), (error: any) => {
      assert.equal(error.code, 'thumbnail_folder_missing');
      assert.ok(error.detail.includes(join(photos, 'thumbs')), 'the fallback folder is named');
      return true;
    });
    const review = await operations.reviewRestore('a'.repeat(64), root, undefined, true);
    assert.deepEqual(review.mounts, [library(photos)]);
    assert.deepEqual(review.thumbnailFallback, { missing: join(root, 'old-fast'), folder: join(photos, 'thumbs') });
    const saved = store.get<any>(`restore:${review.id}`);
    // Only the start runs here: the database steps are covered by restore-regeneration.test.ts.
    const installation = { ...prior, id: 'ddddeeeeffff', project: 'frameleaf-ddddeeeeffff', mounts: saved.mounts };
    const { operation } = store.start('restore', 'key', { reviewId: review.id });
    operation.completed = ['download-images', 'configure', 'start-database', 'restore-new-database', 'reconstruct-execution-state'];
    operation.receipts.configure = installation;
    (operations as any).libraryStatus = async () => ({});
    await (operations as any).applyRestore(operation, saved);
    assert.match(await readFile(join(photos, 'thumbs', '.frameleaf'), 'utf8'), /^\d+$/);
    assert.deepEqual(composeCalls, ['up']);
    assert.deepEqual(store.get<Installation>('installation')!.mounts, [library(photos)]);
    // The photos drive itself going missing is never papered over by a seeded marker.
    operation.state = 'complete';
    store.save(operation);
    const again = store.start('restore', 'key-2', { reviewId: review.id }).operation;
    again.completed = operation.completed.filter((name) => name !== 'start-frameleaf');
    again.receipts.configure = installation;
    await rm(photos, { recursive: true });
    await assert.rejects((operations as any).applyRestore(again, saved), /media_folder_missing/);
    await assert.rejects(readFile(join(photos, 'thumbs', '.frameleaf')), /ENOENT/);
  });
});

test('a host folder never mapped into Manager is left to Docker; a missing drive under a mapped root is named', async () => {
  await folder(async (root) => {
    const info = join(root, 'mountinfo');
    await writeFile(
      info,
      [
        '20 1 0:20 / / rw - overlay overlay rw',
        `30 20 8:1 /mnt ${root} rw,relatime - ext4 /dev/sda1 rw`,
        '31 20 8:2 /appdata /config rw - ext4 /dev/sda2 rw',
      ].join('\n') + '\n',
    );
    assert.equal((await visibility(info, join(root, 'no-dockerenv')))('/srv/immich/library'), true, 'outside a container');
    await writeFile(join(root, '.dockerenv'), '');
    const visible = await visibility(info, join(root, '.dockerenv'));
    assert.equal(visible(join(root, 'disks', 'fast')), true);
    assert.equal(visible('/config/x'), true);
    assert.equal(visible('/srv/immich/library'), false, 'the overlay root says nothing about host folders');
    // Sibling prefixes and `..` never count as inside a mapped folder.
    assert.equal(visible('/config'), true);
    assert.equal(visible('/config2/x'), false, '/config2 is not inside /config');
    assert.equal(visible('/config/../srv/x'), false);
    assert.equal(visible('/config//nested/x'), true);
    // An imported Immich library whose folder only the Docker host can see still starts.
    await assertMountSources([library('/srv/immich/library')], 'frameleaf-server', visible);
    await assert.rejects(
      assertMountSources([library('/srv/immich/library'), thumbs(join(root, 'disks', 'fast'))], 'frameleaf-server', visible),
      /thumbnail_folder_missing/,
    );
    assert.equal((await visibility(join(root, 'no-such-mountinfo'), join(root, '.dockerenv')))('/anything'), true);
  });
});
