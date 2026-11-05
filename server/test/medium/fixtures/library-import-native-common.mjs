// Shared destination half of every native-source qualification runner. The source runner owns the
// disposable application, its stopped-writer authority and the bundle; this module imports it through
// the common command into the fresh destination and hands the database to source-specific assertions.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const sha256 = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

/** Locate the parent's dedicated qualification input and test directory. */
export async function nativeContext(family) {
  const directory = process.env.FRAMELEAF_IMPORT_TEST_DIRECTORY;
  assert(/^frameleaf-import-lifecycle-[A-Za-z0-9]+$/u.test(basename(directory ?? '')));
  const stateDirectory = join(directory, 'state');
  const { assertImportExecutionLock } = await import('src/library-import/execution-lock.js');
  await assertImportExecutionLock(stateDirectory);
  const inputPath = process.env.FRAMELEAF_NATIVE_IMPORT_CONFIG;
  assert.equal(basename(inputPath ?? ''), 'test.json');
  const sourceDirectory = dirname(inputPath);
  assert(/^application-[A-Za-z0-9]{6}$/u.test(basename(sourceDirectory)));
  const runId = process.env.FRAMELEAF_NATIVE_IMPORT_RUN_ID;
  assert(/^\d+-\d+$/u.test(runId ?? ''));
  assert.equal(basename(dirname(sourceDirectory)), `frameleaf-${family}-${runId}`);
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  return { directory, stateDirectory, sourceDirectory, runId, input };
}

/** Authority for a disposable source: the labelled container stays stopped and its state stays unchanged. */
export function stoppedContainerAuthority({ family, runId, containers, fingerprint }) {
  let baseline;
  return async () => {
    for (const { id, image, name } of containers) {
      const { stdout } = await execute('docker', ['inspect', id], { timeout: 10_000 });
      const [actor] = JSON.parse(stdout);
      assert.equal(actor.Id, id);
      assert.equal(actor.Image, image);
      assert.equal(actor.Name, '/' + name);
      assert.equal(actor.Config.Labels['app.frameleaf.qualification-family'], family);
      assert.equal(actor.Config.Labels['app.frameleaf.qualification-run'], runId);
      assert.equal(actor.State.Running, false, 'Native source must remain stopped');
      assert.equal(actor.HostConfig.RestartPolicy.Name, 'no', 'Native source restart must remain disabled');
    }
    const current = await fingerprint();
    baseline ??= current;
    assert.deepEqual(current, baseline, 'Native source state changed');
  };
}

/** Root identities and copy placements for originals under one source root. */
export async function copyPlacements({ sourceRoot, destinationRoot, files }) {
  const roots = [];
  for (const [id, path] of [
    ['source', sourceRoot],
    ['destination', destinationRoot],
  ]) {
    const info = await stat(path, { bigint: true });
    roots.push({ id, path, device: String(info.dev), inode: String(info.ino) });
  }
  const observed = [],
    placements = [];
  for (const file of files) {
    const path = join(sourceRoot, file.path);
    const info = await stat(path, { bigint: true });
    const digest = await sha256(path);
    if (file.sha256) assert.equal(digest, file.sha256, 'Source original must match independent seed bytes');
    observed.push({
      id: file.id,
      path: file.path,
      bytes: String(info.size),
      sha256: digest,
      role: file.role ?? 'original',
      modifiedAt: info.mtime.toISOString(),
    });
    placements.push({
      id: file.id,
      sourceAssetId: file.assetId,
      sourceFileId: file.id,
      mode: 'copy',
      sourceRoot: 'source',
      sourcePath: file.path,
      destinationRoot: 'destination',
      destinationPath: 'owner/' + file.path,
      expectedBytes: String(info.size),
      expectedSha256: digest,
    });
  }
  return { roots, observed, placements };
}

/** Owner intent for one qualified local account (or a secure claim when no portable credential exists). */
export const ownerIntent = (sourceUserId, revision, disposition = { kind: 'preserve' }) => ({
  sourceUserId,
  email: `native-${String(sourceUserId).replaceAll(/[^A-Za-z0-9]/gu, '') || 'owner'}@example.test`,
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
  disposition,
});

/** Run preflight → run → verify → activate through the common command, then source-specific checks. */
export async function runNativeCommonImport({
  source,
  directory,
  stateDirectory,
  bundleDirectory,
  receipt,
  operationId,
  destinationId,
  authorize,
  expectedAssets,
  verify,
  result,
}) {
  const { Kysely } = await import('kysely');
  const { connectImportDatabase } = await import('src/immich-import/database.js');
  const { loadLibraryImportBundle } = await import('src/library-import/bundle-input.js');
  const { executeLibraryImportCommand } = await import('src/library-import/command.js');
  const { libraryImportDerivedRunId } = await import('src/library-import/derived-work.js');
  const { LocalLibraryImportState } = await import('src/library-import/local-transfer-state.js');
  const { JobName, QueueName } = await import('src/enum.js');
  const { DatabaseRepository } = await import('src/repositories/database.repository.js');
  const { JobRepository } = await import('src/repositories/job.repository.js');
  const { getKyselyConfig } = await import('src/utils/database.js');
  const config = {
    format: 'frameleaf-library-import-command',
    version: 1,
    operationId,
    destinationId,
    bundleDirectory,
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
    const { writeFile } = await import('node:fs/promises');
    await writeFile(config.bootstrapAdmin.path, JSON.stringify(administrator), { mode: 0o600 });
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
      jobs.handlers[jobName] = {
        jobName,
        queueName,
        handler: async () => {},
        label: 'native source fixture scheduling',
      };
    const options = {
      source,
      config,
      db: connection.db,
      jobs,
      state: local,
      manager: { installation: '110400000001', operationId },
      authorize,
    };
    assert.equal((await executeLibraryImportCommand({ ...options, action: 'preflight' })).assets, expectedAssets);
    await executeLibraryImportCommand({ ...options, action: 'run' });
    assert.equal((await executeLibraryImportCommand({ ...options, action: 'verify' })).run.status, 'verifying');
    const activated = await executeLibraryImportCommand({ ...options, action: 'verify', activate: true });
    assert.equal(activated.run.status, 'activated');
    const loaded = await loadLibraryImportBundle(config, source);
    assert.deepEqual(receipt.binding, loaded.context.binding);
    assert.equal(activated.activation.runId, libraryImportDerivedRunId(receipt.binding));
    await new DatabaseRepository(database, { setContext() {} }, {}).assertImportActivated();
    const query = (text, values) => connection.db.query(text, values);
    const assets = await query(
      `SELECT m.source_id AS "sourceId",a."ownerId"::text AS owner,a."originalPath",a."originalFileName",a."isFavorite",a.visibility,
        EXISTS(SELECT 1 FROM public.asset_lock l WHERE l."assetId"=a.id) AS locked,a."fileCreatedAt",a."localDateTime",
        e.description,e."timeZone",e.latitude,e.longitude,e.rating,e."lockedProperties"
       FROM public.frameleaf_library_import_mapping m JOIN public.asset a ON a.id=m.destination_id
       LEFT JOIN public.asset_exif e ON e."assetId"=a.id
       WHERE m.operation_id=$1::uuid AND m.entity_kind='asset' ORDER BY m.source_id`,
      [operationId],
    );
    assert.equal(assets.length, expectedAssets);
    for (const asset of assets) assert.match(await sha256(asset.originalPath), /^[a-f0-9]{64}$/u);
    const albums = await query(
      `SELECT a."albumName" AS name,a.description,u."userId"::text AS owner,
        ARRAY(SELECT am.source_id FROM public.album_asset aa JOIN public.frameleaf_library_import_mapping am
          ON am.destination_id=aa."assetId" AND am.entity_kind='asset' AND am.operation_id=$1::uuid
          WHERE aa."albumId"=a.id ORDER BY am.source_id) AS members
       FROM public.frameleaf_library_import_mapping m JOIN public.album a ON a.id=m.destination_id
       JOIN public.album_user u ON u."albumId"=a.id AND u.role='owner'
       WHERE m.operation_id=$1::uuid AND m.entity_kind='album' ORDER BY a."albumName"`,
      [operationId],
    );
    await verify({ query, assets, albums, operationId });
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
        productionCoordinator: true,
        commonCommand: true,
        sidecars: 0,
        phase: 'activated',
        managerRun: true,
        writerBoundary: true,
        sourceRetained: true,
        metadataAndAlbumsVerified: true,
        ...result,
      }),
    );
  } finally {
    await local?.close();
    await connection.close();
    await database.destroy();
  }
}
