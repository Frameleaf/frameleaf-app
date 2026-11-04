// Executed only from the isolated compiled test package; the parent supplies a fresh synthetic database and directory.
/* eslint-disable unicorn/no-null -- Missing journal records have an explicit null API contract. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
const runDirectory = process.env.FRAMELEAF_IMPORT_TEST_DIRECTORY;
if (!runDirectory || !runDirectory.split('/').at(-1).startsWith('frameleaf-import-lifecycle-'))
  throw new Error('Synthetic test directory required');
const stateDirectory = runDirectory + '/state';
await mkdir(stateDirectory, { mode: 0o700, recursive: true });
const { assertImportExecutionLock } = await import('src/library-import/execution-lock.js');
await assertImportExecutionLock(stateDirectory);
const { Kysely } = await import('kysely');
const { getKyselyConfig } = await import('src/utils/database.js');
const { DatabaseRepository } = await import('src/repositories/database.repository.js');
const { connectImportDatabase } = await import('src/immich-import/database.js');
const { executeLibraryImportCommand } = await import('src/library-import/command.js');
const { LibraryImportJournal } = await import('src/library-import/state.js');
const { LibrarySourceArchive } = await import('src/library-import/source-archive.js');
const { loadLibraryImportBundle, loadRetainedLibraryImportBundle } = await import('src/library-import/bundle-input.js');
const { withLibraryImportExecution } = await import('src/library-import/execution-binding.js');
const { LocalLibraryImportState } = await import('src/library-import/local-transfer-state.js');
const { libraryImportDerivedRunId } = await import('src/library-import/derived-work.js');
const { JobRepository } = await import('src/repositories/job.repository.js');
const { JobName, QueueName } = await import('src/enum.js');
const { manifestFingerprint } = await import('src/library-import/manifest.js');
const { importPlanSha256, reviewImportFiles } = await import('src/library-import/transfer-runtime.js');
const { default: sharp } = await import('sharp');
const { encodeSourceArchiveRecord, advanceSourceArchiveHash, EMPTY_SOURCE_ARCHIVE_HASH } =
  await import('src/library-import/source-archive-codec.js');
const database = new Kysely(getKyselyConfig({ connectionType: 'url', url: process.env.DB_URL }));
const connection = connectImportDatabase(process.env.DB_URL, false);
let local;
try {
  await connection.db.query(`WITH g AS (INSERT INTO public.cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO public."user"(email,"clusterGroupId","isAdmin") SELECT 'bootstrap@example.test',id,true FROM g`);
  const source = {
    kind: 'photoprism',
    version: 'synthetic-unqualified',
    identity: 'synthetic',
    revision: 'frozen-synthetic',
    schemaSha256: 'a'.repeat(64),
  };
  const destinationId = randomUUID(),
    operationId = randomUUID();
  const sourceRoot = runDirectory + '/source',
    destinationRoot = runDirectory + '/destination';
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(destinationRoot, { mode: 0o700 });
  const roots = [];
  for (const [id, path] of [
    ['source', sourceRoot],
    ['destination', destinationRoot],
  ]) {
    const info = await stat(path, { bigint: true });
    roots.push({ id, path, device: String(info.dev), inode: String(info.ino) });
  }
  const drafts = [],
    files = [],
    assets = [];
  for (const [index, mode] of ['copy', 'adopt', 'relocate'].entries()) {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: index * 70, g: 50, b: 200 } },
    })
      .png()
      .toBuffer();
    const path = mode + '.png',
      id = 'file-' + mode,
      assetId = 'asset-' + mode;
    await writeFile(sourceRoot + '/' + path, bytes, { mode: 0o600 });
    files.push({
      id,
      path,
      bytes: String(bytes.length),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      role: 'original',
    });
    drafts.push({
      id: 'placement-' + mode,
      sourceAssetId: assetId,
      sourceFileId: id,
      mode,
      sourceRoot: 'source',
      sourcePath: path,
      destinationRoot: mode === 'adopt' ? 'source' : 'destination',
      destinationPath: path,
    });
    assets.push({
      id: assetId,
      ownerId: 'owner',
      fileIds: [id],
      primaryFileId: id,
      type: 'IMAGE',
      fileModifiedAt: '2020-01-01T00:00:00Z',
      originalFileNames: { [id]: path },
      visibility: 'archive',
      metadata: {
        takenAt: '2020-01-01T00:00:00Z',
        timeZone: 'UTC',
        description: 'Manual caption ' + mode,
        favorite: true,
        tags: ['synthetic/manual'],
      },
    });
  }
  const sidecarBytes = Buffer.from('<x:xmpmeta>synthetic source metadata</x:xmpmeta>');
  await writeFile(sourceRoot + '/copy.xmp', sidecarBytes, { mode: 0o600 });
  files.push({
    id: 'file-sidecar',
    path: 'copy.xmp',
    bytes: String(sidecarBytes.length),
    sha256: createHash('sha256').update(sidecarBytes).digest('hex'),
    role: 'sidecar',
  });
  drafts.push({
    id: 'placement-sidecar',
    sourceAssetId: 'asset-copy',
    sourceFileId: 'file-sidecar',
    mode: 'copy',
    sourceRoot: 'source',
    sourcePath: 'copy.xmp',
    destinationRoot: 'destination',
    destinationPath: 'copy.xmp',
  });
  assets[0].fileIds.push('file-sidecar');
  const plan = await reviewImportFiles({
    version: 2,
    source,
    destinationId,
    owners: [{ sourceId: 'owner', destinationId: randomUUID() }],
    roots,
    files: drafts,
  });
  const manifest = {
    format: 'frameleaf-library-import',
    version: 3,
    source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: source.revision,
      revisionAfter: source.revision,
    },
    users: [{ id: 'owner', name: 'Imported owner' }],
    files,
    assets,
    albums: [
      {
        id: 'private-album',
        ownerId: 'owner',
        name: 'Private synthetic album',
        assetIds: assets.map((asset) => asset.id),
        members: [],
      },
    ],
    losses: [],
  };
  const owners = {
    format: 'frameleaf-private-owner-inputs',
    version: 1,
    owners: [
      {
        intent: {
          sourceUserId: 'owner',
          email: 'owner@example.test',
          login: {
            revision: source.revision,
            snapshotSha256: 'e'.repeat(64),
            accountEnabled: true,
            passwordLoginEnabled: true,
            secondFactorRequired: false,
            externalIdentityRequired: false,
            ownedLibraryAccess: 'full',
            otherRestrictions: 'none',
          },
          disposition: { kind: 'claim', reason: 'no-local-verifier', claimPermitted: true },
        },
      },
    ],
  };
  const records = Array.from({ length: 1001 }, (_, id) => ({
    table: 'photos',
    value: { id: BigInt(id), caption: 'Synthetic manual caption' },
  }));
  const encoded = records.map((record) => encodeSourceArchiveRecord(record));
  let sha256 = EMPTY_SOURCE_ARCHIVE_HASH;
  for (const row of encoded) sha256 = advanceSourceArchiveHash(sha256, row);
  const descriptor = { format: 'frameleaf-source-archive', version: 1, rows: String(records.length), sha256 };
  const bundleDirectory = runDirectory + '/bundle';
  await mkdir(bundleDirectory, { mode: 0o700 });
  for (const [name, value] of [
    ['manifest.json', manifest],
    ['plan.json', plan],
    ['owners.json', owners],
    ['archive.json', descriptor],
  ])
    await writeFile(`${bundleDirectory}/${name}`, JSON.stringify(value), { mode: 0o600 });
  await writeFile(`${bundleDirectory}/archive.jsonl`, encoded.map((row) => JSON.stringify(row)).join('\n') + '\n', {
    mode: 0o600,
  });
  const config = {
    format: 'frameleaf-library-import-command',
    version: 1,
    operationId,
    destinationId,
    bundleDirectory,
    stateDirectory,
  };
  const bundle = await loadLibraryImportBundle(config, source.kind);
  assert.equal(bundle.context.binding.manifestSha256, manifestFingerprint(manifest));
  assert.equal(bundle.context.binding.planSha256, importPlanSha256(plan));
  await bundle.assertUnchanged();
  local = await LocalLibraryImportState.open(stateDirectory, { create: true });
  {
    const jobs = new JobRepository({}, {}, {}, { setContext() {} }, database);
    for (const [jobName, queueName] of [
      [JobName.AssetExtractMetadata, QueueName.MetadataExtraction],
      [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration],
      [JobName.SmartSearch, QueueName.SmartSearch],
      [JobName.AssetDetectFaces, QueueName.FaceDetection],
      [JobName.AssetEncodeVideo, QueueName.VideoConversion],
      [JobName.PersonGenerateThumbnail, QueueName.ThumbnailGeneration],
    ])
      jobs.handlers[jobName] = { jobName, queueName, handler: async () => {}, label: 'synthetic import' };
    const manager = { installation: '110100000001', operationId };
    let currentBundle = bundle,
      isSourceReady = true,
      authorityCalls = 0;
    const options = () => ({
      db: connection.db,
      jobs,
      state: local,
      config,
      source: source.kind,
      manager,
      authorize: async () => {
        authorityCalls++;
        assert.equal(isSourceReady, true, 'synthetic source must remain fenced');
      },
    });
    const fresh = await executeLibraryImportCommand({ ...options(), action: 'status' });
    assert.equal(fresh.run, null);
    assert.equal(fresh.execution, null);
    isSourceReady = false;
    await assert.rejects(executeLibraryImportCommand({ ...options(), action: 'preflight' }), /must remain fenced/);
    assert.equal(local.inspect(operationId), null);
    const preflightReservations = await connection.db.query(
      "SELECT 1 FROM public.system_metadata WHERE key='frameleaf-library-import-execution'",
    );
    assert.equal(preflightReservations.length, 0);
    isSourceReady = true;
    const extraPath = runDirectory + '/reviewed-extra';
    await mkdir(extraPath, { mode: 0o700 });
    const extra = await stat(extraPath, { bigint: true });
    const revised = {
      ...plan,
      roots: [
        ...plan.roots,
        { id: 'reviewed-extra', path: extraPath, device: String(extra.dev), inode: String(extra.ino) },
      ],
    };
    await writeFile(bundleDirectory + '/plan.json', JSON.stringify(revised), { mode: 0o600 });
    await executeLibraryImportCommand({ ...options(), action: 'preflight' });
    await writeFile(bundleDirectory + '/plan.json', JSON.stringify(plan), { mode: 0o600 });
    const preflight = await executeLibraryImportCommand({ ...options(), action: 'preflight' });
    assert.equal(preflight.status, 'fresh');
    assert.equal(preflight.assets, 3);
    assert.equal(preflight.files, 4);
    assert.equal(local.inspect(operationId), null);
    isSourceReady = false;
    await assert.rejects(executeLibraryImportCommand({ ...options(), action: 'run' }), /must remain fenced/);
    const rejectedRunReservations = await connection.db.query(
      "SELECT 1 FROM public.system_metadata WHERE key='frameleaf-library-import-execution'",
    );
    assert.equal(rejectedRunReservations.length, 0);
    isSourceReady = true;
    const destinationNonce = await withLibraryImportExecution(
      connection.db,
      { binding: bundle.context.binding, destinationId, identity: local.identity },
      async (nonce) => nonce,
    );
    const [untouched] = await connection.db.query(`SELECT
      (SELECT count(*)::text FROM public."user") AS users,
      (SELECT count(*)::text FROM public.asset) AS assets`);
    assert.deepEqual(untouched, { users: '1', assets: '0' });
    for (const file of plan.files)
      if (file.mode !== 'adopt')
        await assert.rejects(readFile(destinationRoot + '/' + file.destinationPath), { code: 'ENOENT' });
    const preparationMode = process.env.FRAMELEAF_INTEGRATION_MODE?.startsWith('prepare-');
    if (preparationMode) {
      const prototype =
        process.env.FRAMELEAF_INTEGRATION_MODE === 'prepare-empty'
          ? LibraryImportJournal.prototype
          : LibrarySourceArchive.prototype;
      const method = process.env.FRAMELEAF_INTEGRATION_MODE === 'prepare-empty' ? 'begin' : 'append';
      const original = prototype[method];
      prototype[method] = async function (...arguments_) {
        // eslint-disable-next-line unicorn/no-this-outside-of-class -- Fail only after this instance commits its real checkpoint.
        await original.apply(this, arguments_);
        throw new Error('synthetic interruption during metadata retention');
      };
      try {
        await assert.rejects(executeLibraryImportCommand({ ...options(), action: 'run' }));
      } finally {
        prototype[method] = original;
      }
      const progress = await executeLibraryImportCommand({ ...options(), action: 'status' });
      assert.equal(progress.run.status, 'copying');
      assert.equal(progress.execution.phase, 'prepared');
      assert.equal(progress.execution.files.length, 0);
    }
    if (process.env.FRAMELEAF_INTEGRATION_MODE === 'prepare-abandon') {
      await rm(bundleDirectory, { recursive: true });
      const before = await executeLibraryImportCommand({ ...options(), action: 'status' });
      isSourceReady = false;
      for (const action of ['rollback', 'abandon']) {
        await assert.rejects(executeLibraryImportCommand({ ...options(), action }), /must remain fenced/);
        assert.deepEqual(await executeLibraryImportCommand({ ...options(), action: 'status' }), before);
      }
      isSourceReady = true;
      const abandoned = await executeLibraryImportCommand({ ...options(), action: 'abandon' });
      assert.equal(abandoned.run.status, 'abandoned');
      assert.equal(abandoned.execution.abandoned, true);
      const rolledBack = await executeLibraryImportCommand({ ...options(), action: 'rollback' });
      assert.equal(rolledBack.run.status, 'abandoned');
      for (const file of plan.files) {
        assert.equal(
          createHash('sha256')
            .update(await readFile(sourceRoot + '/' + file.sourcePath))
            .digest('hex'),
          file.sha256,
        );
        if (file.mode !== 'adopt')
          await assert.rejects(readFile(destinationRoot + '/' + file.destinationPath), { code: 'ENOENT' });
      }
      console.log(
        JSON.stringify({
          synthetic: true,
          sourceQualified: false,
          productionCoordinator: true,
          commonCommand: true,
          sidecars: 1,
          phase: 'abandoned',
          noMediaTransferred: true,
          interruptedPreparationRecovered: true,
        }),
      );
    } else {
      const mark = local.mark.bind(local);
      let isInterrupt = true;
      local.mark = (...arguments_) => {
        mark(...arguments_);
        if (!(isInterrupt && arguments_[1] === 'copying')) {
          return;
        }

        isInterrupt = false;
        throw new Error('synthetic interruption after preparing recovery');
      };
      await assert.rejects(
        executeLibraryImportCommand({ ...options(), action: preparationMode ? 'resume' : 'run' }),
        /synthetic interruption after preparing recovery/,
      );
      local.mark = mark;
      assert.equal(local.inspect(operationId).phase, 'copying');
      assert.deepEqual(await connection.db.query('SELECT id FROM public."user" WHERE NOT "isAdmin"'), []);
      await rm(bundleDirectory, { recursive: true });
      currentBundle = await loadRetainedLibraryImportBundle(connection.db, config, source.kind);
      const recovered = await Array.fromAsync(currentBundle.records());
      assert.deepEqual(recovered, records);
      const resumed = await executeLibraryImportCommand({ ...options(), action: 'resume' });
      assert.equal(resumed.run.status, 'verifying');
      const progress = await executeLibraryImportCommand({ ...options(), action: 'status' });
      assert.equal(progress.run.status, 'verifying');
      assert.equal(JSON.stringify(progress).includes(sourceRoot), false);
      await assert.rejects(executeLibraryImportCommand({ ...options(), action: 'preflight' }), /USE_RESUME/);
      const actualRoots = Object.fromEntries(roots.map((root) => [root.id, root]));
      await assert.rejects(readFile(sourceRoot + '/relocate.png'), { code: 'ENOENT' });
      for (const file of plan.files)
        assert.equal(
          createHash('sha256')
            .update(await readFile(actualRoots[file.destinationRoot].path + '/' + file.destinationPath))
            .digest('hex'),
          file.sha256,
        );
      const verified = await executeLibraryImportCommand({ ...options(), action: 'verify' });
      assert.equal(verified.verification.assets.assets, 3);
      assert.equal(verified.verification.assets.originals, 3);
      assert.equal(verified.verification.assets.sidecars, 1);
      assert.equal(verified.verification.albums.memberships, 3);
      assert.equal(local.inspect(operationId).writersMayHaveStarted, false);
      const sidecars = await connection.db.query(
        'SELECT id::text,"assetId"::text,type,path,"physicalFileId"::text,"isEdited" FROM public.asset_file',
      );
      assert.equal(sidecars.length, 1);
      const sidecar = sidecars[0];
      assert.equal(sidecar.type, 'sidecar');
      assert.equal(sidecar.path, destinationRoot + '/copy.xmp');
      assert.equal(sidecar.physicalFileId, null);
      assert.equal(sidecar.isEdited, false);
      for (const mutation of [
        "type='preview'",
        '"assetId"=(SELECT id FROM public.asset WHERE id<>$2::uuid LIMIT 1)',
        '"physicalFileId"=(SELECT "physicalOriginalFileId" FROM public.asset WHERE id=$2::uuid)',
      ]) {
        await connection.db.query(`UPDATE public.asset_file SET ${mutation} WHERE id=$1::uuid AND "assetId"=$2::uuid`, [
          sidecar.id,
          sidecar.assetId,
        ]);
        await assert.rejects(
          executeLibraryImportCommand({ ...options(), action: 'verify' }),
          /ASSET_RECONCILIATION_MISMATCH/,
        );
        await connection.db.query(
          'UPDATE public.asset_file SET type=\'sidecar\',"assetId"=$2::uuid,"physicalFileId"=NULL WHERE id=$1::uuid',
          [sidecar.id, sidecar.assetId],
        );
      }
      await writeFile(sidecar.path, Buffer.alloc(sidecarBytes.length, 120));
      await assert.rejects(executeLibraryImportCommand({ ...options(), action: 'verify' }), /BUNDLE_FILE_MISMATCH/);
      await writeFile(sidecar.path, sidecarBytes);
      if (process.env.FRAMELEAF_INTEGRATION_MODE === 'rollback') {
        const realBind = local.bind.bind(local);
        const journal = realBind(operationId, { binding: bundle.context.binding, destinationId, destinationNonce });
        const complete = journal.rolledBack.bind(journal);
        let isStopped = false;
        journal.rolledBack = () => {
          isStopped = true;
          throw new Error('synthetic interruption after reverse rename');
        };
        local.bind = () => journal;
        await assert.rejects(executeLibraryImportCommand({ ...options(), action: 'rollback' }));
        assert.equal(isStopped, true);
        assert.equal(local.inspect(operationId).phase, 'rolling-back');
        assert.equal(journal.files(operationId).find(({ file }) => file.mode === 'relocate').state, 'rollback-intent');
        const moved = plan.files.find((file) => file.mode === 'relocate');
        assert.equal(
          createHash('sha256')
            .update(await readFile(sourceRoot + '/' + moved.sourcePath))
            .digest('hex'),
          moved.sha256,
        );
        await assert.rejects(readFile(destinationRoot + '/' + moved.destinationPath), { code: 'ENOENT' });
        journal.rolledBack = complete;
        local.bind = realBind;
        const result = await executeLibraryImportCommand({ ...options(), action: 'rollback' });
        assert.equal(result.run.status, 'abandoned');
        assert.equal(result.execution.abandoned, true);
        currentBundle = await loadRetainedLibraryImportBundle(connection.db, config, source.kind);
        const abandoned = await executeLibraryImportCommand({ ...options(), action: 'abandon' });
        assert.equal(abandoned.run.status, 'abandoned');
        for (const file of plan.files) {
          assert.equal(
            createHash('sha256')
              .update(await readFile(sourceRoot + '/' + file.sourcePath))
              .digest('hex'),
            file.sha256,
          );
          if (file.mode === 'copy')
            assert.equal(
              createHash('sha256')
                .update(await readFile(destinationRoot + '/' + file.destinationPath))
                .digest('hex'),
              file.sha256,
            );
        }
        console.log(
          JSON.stringify({
            synthetic: true,
            sourceQualified: false,
            productionCoordinator: true,
            commonCommand: true,
            phase: 'abandoned',
            originalFilesRestored: 3,
            sidecars: 1,
            interruptedForwardCheckpointRecovered: true,
            interruptedPreparationRecovered: !!preparationMode,
            interruptedReverseMoveRecovered: true,
          }),
        );
      } else {
        const activated = await executeLibraryImportCommand({ ...options(), action: 'verify', activate: true });
        assert.equal(activated.run.status, 'activated');
        assert.equal(activated.execution.writersMayHaveStarted, true);
        assert.equal(activated.activation.runId, libraryImportDerivedRunId(bundle.context.binding));
        await connection.db.query(`UPDATE public."user" SET name='User edited after activation' WHERE NOT "isAdmin"`);
        isSourceReady = false;
        const beforeAudit = authorityCalls;
        const audited = await executeLibraryImportCommand({ ...options(), action: 'verify' });
        assert.equal(audited.activation.sha256, activated.activation.sha256);
        assert.equal(authorityCalls, beforeAudit);
        const [edited] = await connection.db.query('SELECT name FROM public."user" WHERE NOT "isAdmin"');
        assert.equal(edited.name, 'User edited after activation');
        await assert.rejects(
          executeLibraryImportCommand({ ...options(), action: 'rollback' }),
          /IMPORT_POST_ACTIVATION_RECOVERY_REQUIRED/,
        );
        await new DatabaseRepository(database, { setContext() {} }, {}).assertImportActivated();
        console.log(
          JSON.stringify({
            synthetic: true,
            sourceQualified: false,
            productionCoordinator: true,
            commonCommand: true,
            originalFiles: 3,
            sidecars: 1,
            transferModes: ['copy', 'adopt', 'relocate'],
            archiveRows: recovered.length,
            phase: 'activated',
            managerRun: true,
            writerBoundary: true,
            interruptedForwardCheckpointRecovered: true,
            interruptedPreparationRecovered: !!preparationMode,
            retainedReplayPreservesAccountEdits: true,
          }),
        );
      }
    }
  }
} finally {
  await local?.close();
  await connection.close();
  await database.destroy();
}
