import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { type Docker, type Container } from '../src/docker.js';
import { type Fencing } from '../src/fencing.js';
import { fileHash } from '../src/files.js';
import { capturePhotoAppSource } from '../src/photo-app-capture.js';
import { identifyPhotoApp } from '../src/photo-app-sources.js';

const noFiles = async () => null;

test('PhotoPrism SQLite is identified by repository, not a pinned digest, and captured with its schema fingerprint', async (t) => {
  const fixture = JSON.parse(
    await readFile(
      new URL('../../server/src/library-import/fixtures/photoprism/261029-sqlite.json', import.meta.url),
      'utf8',
    ),
  );
  const container = {
    Id: 'a'.repeat(64),
    Name: '/photoprism',
    State: { Running: true },
    Config: {
      Image: fixture.source.runtimeImage,
      Env: ['PHOTOPRISM_DATABASE_DRIVER=sqlite', 'PHOTOPRISM_DATABASE_DSN=/photoprism/storage/index.db'],
      Labels: {},
    },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
    },
    Mounts: [
      {
        Type: 'bind',
        Source: '/fixture/storage',
        Destination: '/photoprism/storage',
        RW: true,
      },
      {
        Type: 'bind',
        Source: '/fixture/originals',
        Destination: '/photoprism/originals',
        RW: true,
      },
    ],
    NetworkSettings: { Networks: {} },
  } as unknown as Container;
  const discovered = await identifyPhotoApp(container, [container], noFiles);
  assert.equal(discovered.sqlitePath, '/fixture/storage/index.db');
  assert.equal(discovered.originalsPath, '/fixture/originals');
  assert.deepEqual(discovered.fence.workers, [container.Id]);
  assert.deepEqual(discovered.fence.restart[container.Id], container.HostConfig.RestartPolicy);
  // Owner decision FL-1149: no version pinning. Any tag of the repository is the same app.
  const latest = await identifyPhotoApp(
    {
      ...container,
      Config: { ...container.Config, Image: 'photoprism/photoprism:latest' },
    },
    [container],
    noFiles,
  );
  assert.equal(latest.kind, 'photoprism');
  assert.equal(latest.version, null);
  await assert.rejects(
    identifyPhotoApp(
      {
        ...container,
        Mounts: [
          ...container.Mounts,
          {
            Type: 'bind',
            Source: '/fixture/unreviewed',
            Destination: '/photoprism/originals/nested',
            RW: true,
          },
        ],
      },
      [container],
      noFiles,
    ),
    /source_mount_unqualified/,
  );

  const root = await realpath(await mkdtemp(join(tmpdir(), 'manager-photoprism-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, 'storage'),
    originals = join(root, 'originals'),
    stage = join(root, 'stage');
  for (const directory of [storage, originals, stage]) await mkdir(directory, { mode: 0o700 });
  const db = new DatabaseSync(join(storage, 'index.db'));
  try {
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.objects)
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) db.exec(object.sql);
  } finally {
    db.close();
  }
  const source = {
    ...container,
    Config: {
      ...container.Config,
      Image: 'photoprism/photoprism:261029-963b58c50',
    },
    Mounts: container.Mounts.map((mount, index) => ({
      ...mount,
      Source: index === 0 ? storage : originals,
    })),
  };
  const events: string[] = [];
  const fencing = {
    stop: async () => void events.push('stop'),
    verify: async () => void events.push('verify'),
  } as unknown as Fencing;
  const plan = await identifyPhotoApp(source, [source], noFiles);
  const snapshot = await capturePhotoAppSource(fencing, {} as Docker, plan, {
    operationId: 'unused',
    stagingRoot: stage,
  });
  assert.deepEqual(events, ['stop', 'verify']);
  assert.equal(snapshot.database, 'sqlite');
  assert.equal(snapshot.source.version, fixture.source.version);
  assert.equal(snapshot.source.schemaSha256, fixture.schemaSha256);
  assert.equal(snapshot.source.revision, await fileHash(snapshot.snapshotPath!));
  assert.equal(snapshot.originalsPath, originals);
});
