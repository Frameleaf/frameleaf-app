// Native Lychee qualification: the parent owns the stopped disposable application; this imports its capture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  nativeContext,
  runNativeCommonImport,
  sha256,
  stoppedContainerAuthority,
  // The lifecycle spec copies the shared helper beside this runner in its isolated build.
  // eslint-disable-next-line import-x/no-unresolved
} from './native-common.mjs';

const { directory, stateDirectory, sourceDirectory, runId, input } = await nativeContext('lychee');
const { default: fixture } = await import('src/library-import/fixtures/lychee/7.12.0-sqlite.json', {
  with: { type: 'json' },
});
const { verifyImportedPassword } = await import('src/library-import/passwords.js');
const { captureSqliteSnapshot } = await import('src/library-import/sqlite.js');

assert.equal(input.databasePath, path.join(sourceDirectory, 'database/database.sqlite'));
assert.equal(input.uploadsRoot, path.join(sourceDirectory, 'uploads'));
assert.equal(input.sourceUserId, '1');
assert.equal(input.containers.length, 1);
assert.match(input.containers[0].id, /^[a-f0-9]{64}$/u);
assert.equal(input.photos.length, 2);
const ordered = (left, right) => left.localeCompare(right);
const absent = async (path) => {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return true;
  }
};
const authorize = stoppedContainerAuthority({
  family: 'lychee',
  runId,
  containers: input.containers,
  // Lychee's SQLite connection uses a rollback journal; a hot journal or WAL would mean an unfinished writer.
  fingerprint: async () => ({
    database: await sha256(input.databasePath),
    journal: !(await absent(input.databasePath + '-journal')),
    wal: !(await absent(input.databasePath + '-wal')),
  }),
});
await authorize();
const captured = await captureSqliteSnapshot(input.databasePath, directory);
assert.equal(captured.schemaSha256, fixture.schemaSha256);
const revision = await sha256(captured.path);
const verifySource = async () => {
  await authorize();
  assert.equal(await sha256(captured.path), revision, 'Captured Lychee snapshot changed');
};
await verifySource();
const operationId = randomUUID(),
  destinationId = randomUUID(),
  ownerId = randomUUID();
const destinationRoot = path.join(directory, 'destination');
await mkdir(path.join(destinationRoot, 'library', ownerId), { recursive: true, mode: 0o700 });
// The Manager path (FL-1149): the production preparation command reads the capture through the Lychee adapter,
// first to review it (inspect), then to publish the bundle with the administrator's owner and loss choices.
const { prepareLibraryImport } = await import('src/library-import/prepare-command.js');
const source = {
  kind: 'lychee',
  version: fixture.source.version,
  identity: input.containers[0].id,
  revision,
  schemaSha256: captured.schemaSha256,
};
const mounts = { '/import-media/source': input.uploadsRoot, '/data': destinationRoot };
const preparation = async (request) => {
  const configPath = path.join(directory, 'prepare.json');
  await writeFile(configPath, JSON.stringify(request), { mode: 0o600 });
  try {
    return await prepareLibraryImport(configPath, verifySource, (mount) => mounts[mount] ?? assert.fail(mount));
  } finally {
    await rm(configPath, { force: true });
  }
};
const request = {
  format: 'frameleaf-prepare-library-import',
  version: 2,
  operationId,
  destinationId,
  source,
  snapshotPath: captured.path,
  originalsRoot: '/import-media/source',
  sourceRootPath: '/app/public/uploads',
};
const inspection = await preparation({ ...request, action: 'inspect', approvedLossCodes: [], owners: [] });
assert.equal(inspection.tested, true, 'The pinned Lychee build must read as tested');
assert.equal(inspection.summary.assets, input.photos.length);
assert.equal(inspection.summary.albums, 1);
assert.deepEqual(
  inspection.owners.map(({ sourceId, assets, restrictions }) => ({ sourceId, assets, restrictions })),
  [{ sourceId: input.sourceUserId, assets: input.photos.length, restrictions: [] }],
);
// Reviewed differences: source-only columns stay in the protected archive and Lychee titles have no destination field.
const approvedLossCodes = inspection.losses.map(({ code }) => code);
assert.deepEqual(approvedLossCodes.toSorted(ordered), ['LYCHEE_SOURCE_METADATA_ARCHIVED', 'LYCHEE_TITLE_ARCHIVED']);
const receipt = await preparation({
  ...request,
  action: 'prepare',
  approvedLossCodes,
  owners: [{ sourceId: input.sourceUserId, destinationId: ownerId, email: 'lychee-owner@example.test' }],
});
const bundle = { bundleDirectory: path.join(directory, receipt.bundleName), receipt };
await runNativeCommonImport({
  source: 'lychee',
  directory,
  stateDirectory,
  bundleDirectory: bundle.bundleDirectory,
  receipt: bundle.receipt,
  operationId,
  destinationId,
  authorize: verifySource,
  expectedAssets: input.photos.length,
  async verify({ query, assets, albums }) {
    const [owner] = await query('SELECT password,"isAdmin","importClaimPending" FROM public."user" WHERE id=$1::uuid', [
      ownerId,
    ]);
    assert.equal(owner.isAdmin, false);
    assert.equal(owner.importClaimPending, false);
    assert.equal(await verifyImportedPassword(input.password, owner.password), true);
    assert.equal(await verifyImportedPassword('wrong-' + input.password, owner.password), false);
    for (const expected of input.photos) {
      const asset = assets.find((row) => row.sourceId === expected.id);
      assert.ok(asset, 'Seeded Lychee photo missing from destination');
      assert.equal(asset.owner, ownerId);
      assert.equal(await sha256(asset.originalPath), expected.sha256);
      assert.equal(await sha256(path.join(input.uploadsRoot, expected.path)), expected.sha256);
      assert.equal(asset.originalFileName, expected.path.split('/').at(-1));
      assert.equal(asset.description, expected.caption);
      assert.ok(asset.lockedProperties.includes('description'));
      assert.equal(asset.isFavorite, expected.favorite);
      assert.equal(asset.rating, expected.rating);
      assert.equal(asset.visibility, 'timeline');
      assert.equal(asset.locked, false);
      assert.equal(new Date(asset.fileCreatedAt).toISOString(), expected.takenAt);
      assert.equal(new Date(asset.localDateTime).toISOString(), expected.localDateTime);
    }
    assert.equal(albums.length, 1);
    assert.deepEqual(
      { ...albums[0], members: albums[0].members.toSorted(ordered) },
      {
        name: input.album.name,
        description: input.album.description,
        owner: ownerId,
        members: input.photos.map((photo) => photo.id).toSorted(ordered),
      },
    );
  },
  result: {
    nativeScope: 'single-local-admin-copy',
    originalFiles: input.photos.length,
    passwordPreserved: true,
    approvedLossCodes,
  },
});
