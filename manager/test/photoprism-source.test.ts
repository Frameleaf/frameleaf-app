import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { type Container } from '../src/docker.js';
import { type Fencing } from '../src/fencing.js';
import { fileHash } from '../src/files.js';
import { capturePhotoprismSqliteSource, identifyPhotoprismSqliteSource } from '../src/photoprism-source.js';

test('discovers the pinned PhotoPrism SQLite binds and refuses unqualified layouts', async (t) => {
  const fixture = JSON.parse(
    await readFile(
      new URL('../../server/src/library-import/fixtures/photoprism/261029-sqlite.json', import.meta.url),
      'utf8',
    ),
  );
  const container = {
    Id: 'a'.repeat(64),
    Config: {
      Image: fixture.source.runtimeImage,
      Env: ['PHOTOPRISM_DATABASE_DRIVER=sqlite', 'PHOTOPRISM_DATABASE_DSN=/photoprism/storage/index.db'],
    },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
    Mounts: [
      { Type: 'bind', Source: '/fixture/storage', Destination: '/photoprism/storage', RW: true },
      { Type: 'bind', Source: '/fixture/originals', Destination: '/photoprism/originals', RW: true },
    ],
    NetworkSettings: { Networks: {} },
  } as Container;
  const discovered = identifyPhotoprismSqliteSource(container, 'docker');
  assert.equal(discovered?.databasePath, '/fixture/storage/index.db');
  assert.equal(discovered.originalsPath, '/fixture/originals');
  assert.deepEqual(discovered.fence.workers, [container.Id]);
  assert.deepEqual(discovered.fence.restart[container.Id], container.HostConfig.RestartPolicy);
  assert.equal(
    identifyPhotoprismSqliteSource(
      { ...container, Config: { ...container.Config, Image: 'photoprism/photoprism:latest' } },
      'docker',
    ),
    null,
  );
  assert.throws(
    () =>
      identifyPhotoprismSqliteSource(
        {
          ...container,
          Mounts: [
            ...container.Mounts,
            { Type: 'bind', Source: '/fixture/unreviewed', Destination: '/photoprism/originals/nested', RW: true },
          ],
        },
        'docker',
      ),
    /photoprism_source_mount_unqualified/,
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
    Mounts: container.Mounts.map((mount, index) => ({
      ...mount,
      Source: index === 0 ? storage : originals,
    })),
  };
  const events: string[] = [];
  const fencing = {
    stop: async () => {
      events.push('stop');
    },
    verify: async () => {
      events.push('verify');
    },
  } as unknown as Fencing;
  const snapshot = await capturePhotoprismSqliteSource(fencing, source, 'docker', stage);
  assert.deepEqual(events, ['stop', 'verify']);
  assert.equal(snapshot.source.version, fixture.source.version);
  assert.equal(snapshot.source.schemaSha256, fixture.schemaSha256);
  assert.equal(snapshot.source.revision, await fileHash(snapshot.snapshotPath));
});
