// Native single-account qualification only; the parent owns disposable source services and the fresh destination.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const directory = process.env.FRAMELEAF_IMPORT_TEST_DIRECTORY;
const inputPath = process.env.FRAMELEAF_PHOTOPRISM_APPLICATION_CONFIG;
assert(/^frameleaf-import-lifecycle-[A-Za-z0-9]+$/u.test(basename(directory ?? '')));
const stateDirectory = join(directory, 'state');
const { assertImportExecutionLock } = await import('src/library-import/execution-lock.js');
await assertImportExecutionLock(stateDirectory);
const { Kysely } = await import('kysely');
const { connectImportDatabase } = await import('src/immich-import/database.js');
const { writeLibraryImportBundle } = await import('src/library-import/bundle-output.js');
const { loadLibraryImportBundle } = await import('src/library-import/bundle-input.js');
const { executeLibraryImportCommand } = await import('src/library-import/command.js');
const { libraryImportDerivedRunId } = await import('src/library-import/derived-work.js');
const { default: fixture } = await import('src/library-import/fixtures/photoprism/261029-sqlite.json', {
  with: { type: 'json' },
});
const { LocalLibraryImportState } = await import('src/library-import/local-transfer-state.js');
const { verifyImportedPassword } = await import('src/library-import/passwords.js');
const { readPhotoprismInventory } = await import('src/library-import/photoprism-inventory.js');
const { assemblePhotoprismManifest } = await import('src/library-import/photoprism-manifest.js');
const { openPhotoprismSnapshot } = await import('src/library-import/photoprism.js');
const { captureSqliteSnapshot } = await import('src/library-import/sqlite.js');
const { reviewImportFiles } = await import('src/library-import/transfer-runtime.js');
const { JobName, QueueName } = await import('src/enum.js');
const { DatabaseRepository } = await import('src/repositories/database.repository.js');
const { JobRepository } = await import('src/repositories/job.repository.js');
const { getKyselyConfig } = await import('src/utils/database.js');
assert.equal(basename(inputPath ?? ''), 'test.json');
const sourceDirectory = dirname(inputPath);
assert(/^application-[A-Za-z0-9]{6}$/u.test(basename(sourceDirectory)));
const runId = process.env.FRAMELEAF_PHOTOPRISM_RUN_ID;
assert(/^\d+-\d+$/u.test(runId ?? ''));
assert.equal(basename(dirname(sourceDirectory)), 'frameleaf-photoprism-' + runId);
const input = JSON.parse(await readFile(inputPath, 'utf8'));
assert.equal(input.databasePath, join(sourceDirectory, 'storage/index.db'));
assert.equal(input.caseName, 'local-admin');
assert.equal(input.nativeLibrary.authMode, 'password');
assert.equal(input.nativeLibrary.scope, '*');
assert.match(input.nativeLibrary.containerId, /^[a-f0-9]{64}$/u);
const sourceRoot = join(sourceDirectory, 'originals');
const destinationRoot = join(directory, 'destination');
await mkdir(destinationRoot, { mode: 0o700 });
await mkdir(join(destinationRoot, 'owner/camera'), { recursive: true, mode: 0o700 });
const sha256 = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const sourceState = async () => {
  const wal = await stat(input.databasePath + '-wal').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  return {
    database: await sha256(input.databasePath),
    wal: wal?.size ? await sha256(input.databasePath + '-wal') : null,
  };
};
const sourceHash = await sourceState();
const authorize = async () => {
  const { stdout } = await execute('docker', ['inspect', input.nativeLibrary.containerId], { timeout: 10_000 });
  const [actor] = JSON.parse(stdout);
  assert.equal(actor.Id, input.nativeLibrary.containerId);
  assert.equal(actor.Image, input.nativeLibrary.imageId);
  assert.equal(actor.Name, '/frameleaf-photoprism-app-' + runId);
  assert.equal(actor.Config.Labels['app.frameleaf.qualification-family'], 'photoprism');
  assert.equal(actor.Config.Labels['app.frameleaf.qualification-run'], runId);
  assert.equal(actor.State.Running, false, 'Native source must remain stopped');
  assert.equal(actor.HostConfig.RestartPolicy.Name, 'no', 'Native source restart must remain disabled');
  assert.deepEqual(await sourceState(), sourceHash, 'Native source database changed');
};
await authorize();
const captured = await captureSqliteSnapshot(input.databasePath, directory);
assert.equal(captured.schemaSha256, fixture.schemaSha256);
const revision = await sha256(captured.path);
const records = [...readPhotoprismInventory(captured.path, fixture.source.version)];
const principals = records.filter((row) => row.type === 'principal' && !row.value.system);
assert.equal(principals.length, 1);
assert.equal(principals[0].value.id, input.sourceUserId);
const photos = records.filter((row) => row.type === 'photo').map((row) => row.value);
const albums = records.filter((row) => row.type === 'album').map((row) => row.value);
const originals = records.filter((row) => row.type === 'file' && row.value.role !== undefined).map((row) => row.value);
assert.equal(photos.length, 2);
assert.equal(originals.length, 2);
assert.deepEqual(
  new Set(photos.map((photo) => photo.id)),
  new Set(input.nativeLibrary.photos.map((photo) => photo.uid)),
);
const operationId = randomUUID(),
  destinationId = randomUUID(),
  ownerId = randomUUID();
const source = {
  kind: 'photoprism',
  version: fixture.source.version,
  identity: input.nativeLibrary.containerId,
  revision,
  schemaSha256: captured.schemaSha256,
};
const roots = [];
for (const [id, path] of [
  ['source', sourceRoot],
  ['destination', destinationRoot],
]) {
  const info = await stat(path, { bigint: true });
  roots.push({ id, path, device: String(info.dev), inode: String(info.ino) });
}
const observed = [],
  drafts = [];
for (const file of originals) {
  assert.equal(file.role, 'original');
  const expected = input.nativeLibrary.photos.find((photo) => photo.path === file.path);
  assert(expected, 'Source original must have independent API byte evidence');
  const path = join(sourceRoot, file.path);
  const info = await stat(path, { bigint: true });
  assert.equal(await sha256(path), expected.sha256);
  assert.equal(String(info.size), expected.bytes);
  observed.push({
    id: file.id,
    path: file.path,
    bytes: expected.bytes,
    sha256: expected.sha256,
    role: 'original',
    modifiedAt: info.mtime.toISOString(),
  });
  drafts.push({
    id: file.id,
    sourceAssetId: file.photoId,
    sourceFileId: file.id,
    mode: 'copy',
    sourceRoot: 'source',
    sourcePath: file.path,
    destinationRoot: 'destination',
    destinationPath: 'owner/' + file.path,
    expectedBytes: expected.bytes,
    expectedSha256: expected.sha256,
  });
}
const assembled = assemblePhotoprismManifest(records, {
  source,
  inventory: {
    complete: true,
    ownershipComplete: true,
    privacyComplete: true,
    writersStopped: true,
    revisionBefore: revision,
    revisionAfter: revision,
  },
  photoOwners: Object.fromEntries(photos.map((photo) => [photo.id, input.sourceUserId])),
  albumOwners: Object.fromEntries(albums.map((album) => [album.id, input.sourceUserId])),
  files: observed,
  materializedAlbums: input.nativeLibrary.materializedAlbums,
});
const reviewedLosses = new Set([
  'PHOTOPRISM_SOURCE_METADATA_ARCHIVED',
  'PHOTOPRISM_TITLE_ARCHIVED',
  'PHOTOPRISM_LABELS_ARCHIVED',
  'PHOTOPRISM_SHARING_RESTRICTED',
  'PHOTOPRISM_ALBUM_SNAPSHOT',
]);
for (const loss of assembled.manifest.losses) {
  assert(reviewedLosses.has(loss.code), 'Unreviewed native fixture preservation difference');
  loss.acknowledged = true;
}
const plan = await reviewImportFiles({
  version: 2,
  source,
  destinationId,
  owners: [{ sourceId: input.sourceUserId, destinationId: ownerId }],
  roots,
  files: drafts,
});
const snapshot = openPhotoprismSnapshot(captured.path, fixture.source.version);
let credential;
try {
  const user = [...snapshot.rows('users')].flat().find((row) => row.user_uid === input.sourceUserId);
  assert.equal(user.id, 1n);
  assert.equal(user.auth_provider, 'local');
  assert.equal(user.auth_method, '');
  assert.equal(user.super_admin, 1n);
  assert.equal(user.can_login, 1n);
  assert.equal(user.user_role, 'admin');
  assert.equal(user.user_scope, '*');
  assert.equal(user.user_attr, '');
  assert.equal(user.base_path, '');
  assert.equal(user.expires_at, null);
  assert.equal(user.deleted_at, null);
  credential = await snapshot.password({ operationId, sourceUserId: input.sourceUserId, destinationUserId: ownerId });
  assert(credential);
} finally {
  snapshot.close();
}
const owners = [
  {
    intent: {
      sourceUserId: input.sourceUserId,
      email: 'native-owner@example.test',
      login: {
        revision,
        snapshotSha256: revision,
        accountEnabled: true,
        passwordLoginEnabled: true,
        secondFactorRequired: false,
        externalIdentityRequired: false,
        ownedLibraryAccess: 'full',
        otherRestrictions: 'none',
      },
      disposition: { kind: 'preserve' },
    },
    credential,
  },
];
const bundle = await writeLibraryImportBundle({
  stagingRoot: directory,
  operationId,
  destinationId,
  manifest: assembled.manifest,
  plan,
  owners,
  records: assembled.archive,
});
const config = {
  format: 'frameleaf-library-import-command',
  version: 1,
  operationId,
  destinationId,
  bundleDirectory: bundle.bundleDirectory,
  stateDirectory,
  bootstrapAdmin: { userId: randomUUID(), path: join(directory, 'bootstrap-admin.json') },
};
const connection = connectImportDatabase(process.env.DB_URL, false);
const database = new Kysely(getKyselyConfig({ connectionType: 'url', url: process.env.DB_URL }));
let local;
try {
  const administrator = {
    operationId,
    destinationId,
    userId: config.bootstrapAdmin.userId,
    email: 'bootstrap@example.test',
    name: 'Fixture administrator',
    password: randomUUID(),
  };
  const writeAdministrator = (value) => writeFile(config.bootstrapAdmin.path, JSON.stringify(value), { mode: 0o600 });
  await writeAdministrator(administrator);
  local = await LocalLibraryImportState.open(stateDirectory, { create: true });
  const jobs = new JobRepository({}, {}, {}, { setContext() {} }, database);
  for (const [jobName, queueName] of [
    [JobName.AssetExtractMetadata, QueueName.MetadataExtraction],
    [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration],
    [JobName.SmartSearch, QueueName.SmartSearch],
    [JobName.AssetDetectFaces, QueueName.FaceDetection],
    [JobName.AssetEncodeVideo, QueueName.VideoConversion],
    [JobName.PersonGenerateThumbnail, QueueName.ThumbnailGeneration],
  ])
    jobs.handlers[jobName] = { jobName, queueName, handler: async () => {}, label: 'native source fixture scheduling' };
  const options = {
    source: 'photoprism',
    config,
    db: connection.db,
    jobs,
    state: local,
    manager: { installation: '110400000001', operationId },
    authorize,
  };
  await writeAdministrator({ ...administrator, destinationId: randomUUID() });
  await assert.rejects(
    executeLibraryImportCommand({ ...options, action: 'preflight' }),
    /IMPORT_BOOTSTRAP_ADMIN_BINDING_CHANGED/,
  );
  await writeAdministrator(administrator);
  assert.equal((await executeLibraryImportCommand({ ...options, action: 'preflight' })).assets, 2);
  assert.equal((await executeLibraryImportCommand({ ...options, action: 'preflight' })).assets, 2);
  await writeAdministrator({ ...administrator, password: randomUUID() });
  await assert.rejects(
    executeLibraryImportCommand({ ...options, action: 'preflight' }),
    /IMPORT_BOOTSTRAP_ADMIN_CHANGED/,
  );
  await writeAdministrator(administrator);
  await executeLibraryImportCommand({ ...options, action: 'run' });
  const verified = await executeLibraryImportCommand({ ...options, action: 'verify' });
  assert.equal(verified.run.status, 'verifying');
  const activated = await executeLibraryImportCommand({ ...options, action: 'verify', activate: true });
  assert.equal(activated.run.status, 'activated');
  const loaded = await loadLibraryImportBundle(config, 'photoprism');
  assert.deepEqual(bundle.receipt, {
    bundleName: basename(bundle.bundleDirectory),
    binding: loaded.context.binding,
    destinationId,
    requiredMediaBytes: input.nativeLibrary.photos.reduce((total, photo) => total + Number(photo.bytes), 0),
    summary: {
      owners: 1,
      assets: 2,
      files: 2,
      albums: albums.length,
      preservationDifferences: assembled.manifest.losses.length,
    },
  });
  assert.equal(activated.activation.runId, libraryImportDerivedRunId(bundle.receipt.binding));
  await new DatabaseRepository(database, { setContext() {} }, {}).assertImportActivated();
  const [owner] = await connection.db.query(
    'SELECT password,"isAdmin","importClaimPending" FROM public."user" WHERE id=$1::uuid',
    [ownerId],
  );
  assert.equal(owner.isAdmin, false);
  assert.equal(owner.importClaimPending, false);
  assert.equal(await verifyImportedPassword(input.password, owner.password), true);
  assert.equal(await verifyImportedPassword('wrong-' + input.password, owner.password), false);
  for (const expected of input.nativeLibrary.photos) {
    const rows = await connection.db.query(
      'SELECT a."ownerId"::text AS owner,a."originalPath",a."isFavorite",a.visibility,EXISTS(SELECT 1 FROM public.asset_lock l WHERE l."assetId"=a.id) AS locked,e.description,e."timeZone",e.latitude,e.longitude,e."lockedProperties" FROM public.frameleaf_library_import_mapping m JOIN public.asset a ON a.id=m.destination_id JOIN public.asset_exif e ON e."assetId"=a.id WHERE m.operation_id=$1::uuid AND m.entity_kind=\'asset\' AND m.source_id=$2',
      [operationId, expected.uid],
    );
    assert.equal(rows.length, 1);
    const asset = rows[0];
    assert.equal(asset.owner, ownerId);
    // Owner 2026-11-04: a private PhotoPrism photo imports Locked
    assert.equal(asset.visibility, 'timeline');
    assert.equal(asset.locked, true);
    assert.equal(asset.description, expected.caption);
    assert.equal(asset.isFavorite, expected.favorite);
    assert.equal(asset.timeZone, 'America/Edmonton');
    assert.equal(Number(asset.latitude), 53.5461);
    assert.equal(Number(asset.longitude), -113.4938);
    assert(asset.lockedProperties.includes('description'));
    assert.equal(await sha256(asset.originalPath), expected.sha256);
    assert.equal(await sha256(join(sourceRoot, expected.path)), expected.sha256);
  }
  const importedAlbums = await connection.db.query(
    'SELECT u."userId"::text AS owner,a."albumName",a.description FROM public.album a JOIN public.album_user u ON u."albumId"=a.id AND u.role=\'owner\' WHERE a."albumName"=$1',
    [input.nativeLibrary.album.name],
  );
  assert.equal(importedAlbums.length, 1);
  assert.equal(importedAlbums[0].owner, ownerId);
  assert.equal(importedAlbums[0].description, input.nativeLibrary.album.description);
  const [cohort] = await connection.db.query(
    'SELECT count(*)::int AS count FROM public.album_asset aa JOIN public.album a ON a.id=aa."albumId" WHERE a."albumName"=$1',
    [input.nativeLibrary.album.name],
  );
  assert.equal(cohort.count, 2);
  await authorize();
  await assert.rejects(
    executeLibraryImportCommand({ ...options, action: 'rollback' }),
    /IMPORT_POST_ACTIVATION_RECOVERY_REQUIRED/,
  );
  console.log(
    JSON.stringify({
      synthetic: true,
      sourceQualified: false,
      nativeSource: true,
      nativeScope: 'single-local-admin-copy',
      productionCoordinator: true,
      commonCommand: true,
      sidecars: 0,
      originalFiles: 2,
      phase: 'activated',
      managerRun: true,
      writerBoundary: true,
      sourceRetained: true,
      metadataAndAlbumsVerified: true,
    }),
  );
} finally {
  await local?.close();
  await connection.close();
  await database.destroy();
}
