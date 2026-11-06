import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { type Operation } from '../src/contracts.js';
import { type Docker, type ImportInspection } from '../src/docker.js';
import { Operations } from '../src/operations.js';
import type { PostgresStorage } from '../src/postgres-storage.js';
import type { Releases } from '../src/releases.js';
import type { Backups } from '../src/backups.js';
import { Store } from '../src/store.js';

const serverImage = `ghcr.io/frameleaf/frameleaf-server@sha256:${'a'.repeat(64)}`;
const userID = '1580559962386438';

/** A Manager whose storage root holds an Ente export; Docker and releases are fakes, fencing and files are real. */
async function folderFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'manager-ente-folder-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const roots = join(root, 'storage');
  const exported = join(roots, 'ente-export');
  for (const folder of [join(exported, 'Holiday', 'metadata'), join(exported, 'Trash'), join(roots, 'destination'), join(root, 'databases')])
    await mkdir(folder, { recursive: true });
  await writeFile(join(exported, 'export.json'), JSON.stringify({ format: 'ente-photos-export', version: 1, userID }));
  await writeFile(join(exported, 'ente-files.json'), JSON.stringify([{ id: '10000000', ownerId: userID }]));
  await writeFile(join(exported, 'Holiday', 'metadata.json'), '{}');
  await writeFile(join(exported, 'Holiday', 'beach.jpg'), 'jpeg');
  const store = new Store(join(root, 'manager'));
  t.after(() => store.close());
  const events: string[] = [];
  const docker = {
    inventory: async () => [],
    compatibility: async () => ({ platform: 'linux/arm64' }),
    pull: async () => void events.push('pull'),
    start: async (id: string) => void events.push(`start:${id}`),
    removeSourceRestore: async (name: string) => void events.push(`remove:${name}`),
  } as unknown as Docker;
  const releases = {
    available: async () => [{ tag: 'frameleaf-v1.2.4' }],
    acquire: async () => ({ nas: { platforms: ['linux/arm64'], images: { server: serverImage } } }),
  } as unknown as Releases;
  const operations = new Operations(store, docker, releases, {} as Backups, [roots], {
    validate: async () => ({ root: join(root, 'databases') }),
  } as unknown as PostgresStorage);
  const settle = async (id: string) => {
    for (let tries = 0; tries < 200; tries++) {
      const operation = store.history().find((o) => o.id === id)!;
      if (operation.state !== 'running') return operation;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('operation did not settle');
  };
  return { root, roots, exported, store, events, docker, operations, settle };
}

test('an export folder outside the storage roots, or without the export and file list, is refused up front', async (t) => {
  const f = await folderFixture(t);
  const outside = join(f.root, 'elsewhere');
  await mkdir(outside);
  await assert.rejects(f.operations.startFolderImport('ente', outside, 'k1'), /import_folder_outside_roots/);
  await assert.rejects(f.operations.startFolderImport('ente', 'relative/path', 'k1'), /import_folder_invalid/);
  await assert.rejects(f.operations.startFolderImport('ente', join(f.roots, 'missing'), 'k1'), /import_folder_unreachable/);
  await assert.rejects(f.operations.startFolderImport('ente', join(f.roots, 'destination'), 'k1'), /ente_export_not_found/);
  await rm(join(f.exported, 'ente-files.json'));
  await assert.rejects(f.operations.startFolderImport('ente', f.exported, 'k1'), /ente_inventory_required/);
  await writeFile(join(f.exported, 'ente-files.json'), '{"files":[]}');
  await assert.rejects(f.operations.startFolderImport('ente', f.exported, 'k1'), /ente_inventory_required/);
  assert.equal(f.store.history().length, 0);
});

test('an Ente export folder is read without stopping anything and reviewed with no database', async (t) => {
  const f = await folderFixture(t);
  const started = await f.operations.startFolderImport('ente', f.exported, 'folder-key');
  assert.equal((await f.operations.startFolderImport('ente', f.exported, 'folder-key')).id, started.id);
  const operation = await f.settle(started.id);
  assert.equal(operation.state, 'awaiting-review', operation.error ?? '');
  const capture = operation.receipts['capture-common-source'] as Record<string, any>;
  assert.equal(capture.database, 'export');
  assert.equal(capture.originalsPath, f.exported);
  assert.equal(capture.sourceRootPath, undefined);
  assert.deepEqual(capture.source, {
    kind: 'ente',
    version: 'ente-cli',
    identity: userID,
    revision: capture.fence.folder.revision,
    schemaSha256: capture.fence.folder.revision,
  });
  assert.match(capture.source.revision, /^[a-f0-9]{64}$/u);
  assert.deepEqual(capture.fence.workers, []);
  assert.deepEqual(f.operations.history().find((o) => o.id === operation.id)?.photoApp, { kind: 'ente', name: 'Ente Photos' });
  assert.deepEqual(f.events, []);

  const inspection: ImportInspection = {
    format: 'frameleaf-library-import-inspection',
    source: capture.source,
    tested: true,
    testedVersion: 'ente-cli-v0.4.2',
    summary: { owners: 1, assets: 1, albums: 1, files: 1, bytes: '4' },
    owners: [{ sourceId: userID, name: `Ente account ${userID}`, email: null, assets: 1, restrictions: [] }],
    losses: [{ code: 'ENTE_SHARED_FILE_NOT_IMPORTED', count: 2 }],
  };
  const staging = join(f.operations.directory(), `import-runtime-${operation.id}`);
  f.docker.inspectImportSource = async (_directory, _image, authority, media, restore) => {
    assert.equal(restore, undefined);
    assert.deepEqual(media, [{ source: f.exported, target: '/import-media/source' }]);
    const request = JSON.parse(await readFile(join(staging, 'prepare.json'), 'utf8'));
    assert.deepEqual(request, {
      format: 'frameleaf-prepare-library-import',
      version: 2,
      action: 'inspect',
      operationId: operation.id,
      destinationId: authority.destinationId,
      source: capture.source,
      originalsRoot: '/import-media/source',
      approvedLossCodes: [],
      owners: [],
    });
    await authority.verify();
    return inspection;
  };
  // Changes to the CLI's export history do not matter.
  await writeFile(join(f.exported, 'Trash', 'old.jpg'), 'old');
  assert.deepEqual(await f.operations.inspectPhotoApp(operation.id), inspection);

  const review = {
    tag: 'frameleaf-v1.2.4' as const,
    databaseRoot: join(f.root, 'databases'),
    mediaPath: join(f.roots, 'destination'),
    port: 2390,
    ml: false,
  };
  let prepared: Record<string, any> | undefined;
  f.docker.prepareImportBundle = async (_directory, _image, authority, media, restore) => {
    assert.equal(restore, undefined);
    assert.deepEqual(media, [
      { source: review.mediaPath, target: '/data', readOnly: false },
      { source: f.exported, target: '/import-media/source', readOnly: true },
    ]);
    prepared = JSON.parse(await readFile(join(staging, 'prepare.json'), 'utf8'));
    await authority.verify();
    return {
      bundleName: `bundle-${operation.id}-aBc123`,
      binding: { operationId: operation.id, source: capture.source, manifestSha256: 'a'.repeat(64), planSha256: 'b'.repeat(64) },
      destinationId: authority.destinationId,
      requiredMediaBytes: 4,
      summary: { owners: 1, assets: 1, files: 1, albums: 1, preservationDifferences: 0 },
    };
  };
  const result = await f.operations.preparePhotoApp({
    operationId: operation.id,
    owners: [{ sourceId: userID, email: 'owner@example.com' }],
    approvedLossCodes: ['ENTE_SHARED_FILE_NOT_IMPORTED'],
    review,
  });
  assert.equal(result.commonImport?.source, 'ente');
  assert.equal(prepared?.action, 'prepare');
  assert.equal('snapshotPath' in prepared!, false);
  assert.equal('databaseUrl' in prepared!, false);
  assert.equal('sourceRootPath' in prepared!, false);
  assert.deepEqual(prepared?.approvedLossCodes, ['ENTE_SHARED_FILE_NOT_IMPORTED']);
});

test('a changed export folder must be reviewed again', async (t) => {
  const f = await folderFixture(t);
  const operation = await f.settle((await f.operations.startFolderImport('ente', f.exported, 'folder-key')).id);
  assert.equal(operation.state, 'awaiting-review', operation.error ?? '');
  let inspected = 0;
  f.docker.inspectImportSource = async () => {
    inspected++;
    throw new Error('not reached');
  };
  await writeFile(join(f.exported, 'Holiday', 'new.jpg'), 'new');
  await assert.rejects(f.operations.inspectPhotoApp(operation.id), /source_changed_review_again/);
  await rm(join(f.exported, 'Holiday', 'new.jpg'));
  await writeFile(join(f.exported, 'ente-files.json'), JSON.stringify([]));
  await assert.rejects(f.operations.inspectPhotoApp(operation.id), /source_changed_review_again/);
  assert.equal(inspected, 0);
});

test('cancelling an export-folder import only discards what Manager read', async (t) => {
  const f = await folderFixture(t);
  const operation = await f.settle((await f.operations.startFolderImport('ente', f.exported, 'folder-key')).id);
  const staging = join(f.operations.directory(), `import-runtime-${operation.id}`);
  await access(staging);
  await f.operations.cancelPhotoApp(operation.id);
  await assert.rejects(access(staging), /ENOENT/);
  assert.deepEqual(f.events, []);
  const cancelled = f.store.history().find((o) => o.id === operation.id) as Operation;
  assert.equal(cancelled.state, 'complete');
  assert.equal(cancelled.error, 'photo_app_import_cancelled');
  // The export is untouched.
  assert.equal(await readFile(join(f.exported, 'Holiday', 'beach.jpg'), 'utf8'), 'jpeg');
  assert.equal(f.store.start('install', 'next', {}).created, true);
});
