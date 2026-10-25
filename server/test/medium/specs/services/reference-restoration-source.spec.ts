import { type Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AssetStatus, ChecksumAlgorithm, MediaOperationDestination, MediaOperationKind } from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PhotoSourceRepository } from 'src/repositories/photo-source.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { holdOwnedOutputAdmission, holdSourceAdmission } from 'src/repositories/studio-source-admission.js';
import { type DB } from 'src/schema/index.js';
import { AssetRestorationService } from 'src/services/asset-restoration.service.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

// Approved reference metadata only; registration stays gated and no device byte grant is issued.
const fixture = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const session = await new SessionRepository(db).create({ userId: user.id, token: randomBytes(32) });
  const device = (await new DesktopDeviceRepository(db).enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: randomBytes(32).toString('base64'),
    name: 'Reference metadata fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'awaiting-approval',
  }))!;
  const repository = new PhotoSourceRepository(db);
  const authority = { ownerId: user.id, sessionId: session.id };
  const source = await repository.create(authority, {
    id: randomUUID(),
    deviceId: device.id,
    kind: 'folder',
    mode: 'copy',
    name: 'Reference metadata fixture',
    scopeFingerprint: 'a'.repeat(64),
  });
  const run = await repository.run(authority, source.id, { id: randomUUID(), maxBytes: 100, maxItems: 2 });
  const sha256 = createHash('sha256').update('hello').digest('hex');
  const resource = await repository.plan(authority, source.id, run.id, {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256,
    bytes: 5,
  });
  const library = await new LibraryRepository(db).create({
    ownerId: user.id,
    name: 'Reference metadata fixture',
    readOnly: true,
    importPaths: [],
    exclusionPatterns: [],
  });
  const originalPath = `frameleaf-source://${source.id}/${resource.resourceKey}`;
  const checksum = createHash('sha1').update(originalPath).digest();
  const { asset } = await ctx.newAsset({
    ownerId: user.id,
    libraryId: library.id,
    isExternal: true,
    originalPath,
    checksum,
    checksumAlgorithm: ChecksumAlgorithm.sha1Path,
    originalFileName: 'photo.jpg',
  });
  await ctx.newExif({ assetId: asset.id, exifImageWidth: 32, exifImageHeight: 24, fileSizeInByte: 5 });
  await db
    .updateTable('photo_source_resource')
    .set({ assetId: asset.id, state: 'verified', verifiedAt: new Date() })
    .where('id', '=', resource.id)
    .execute();
  await sql`UPDATE photo_source SET mode='reference' WHERE id=${source.id}::uuid`.execute(db);
  await db
    .insertInto('source_original')
    .values({
      assetId: asset.id,
      resourceId: resource.id,
      scopeFingerprint: source.scopeFingerprint,
      authorizationEpoch: device.authorizationEpoch,
    })
    .execute();
  const service = Object.assign(Object.create(AssetRestorationService.prototype), {
    assetRepository: new AssetRepository(db),
    integrityRepository: new IntegrityRepository(db),
  });
  return { service, asset, checksum, sha256, session, device, resource, source };
};

it('uses verified resource bytes rather than the logical-locator checksum for restoration intake', async () => {
  const f = await fixture();
  const source = await f.service.requireSource(f.asset.id);
  expect(source.checksum).toEqual(Buffer.from(f.sha256, 'hex'));
  expect(source.originalPath).toBe(f.asset.originalPath);
  expect(source.sourceEpochs).toEqual([
    {
      assetId: f.asset.id,
      ownerId: f.asset.ownerId,
      epoch: '0',
      reference: { resourceId: f.resource.id, version: f.resource.version, sha256: f.sha256 },
    },
  ]);
  expect(
    (await db.selectFrom('asset').select('checksum').where('id', '=', f.asset.id).executeTakeFirstOrThrow()).checksum,
  ).toEqual(f.checksum);
});

it.each(['checksum', 'algorithm', 'device', 'session', 'resource', 'source'] as const)(
  'refuses changed reference %s metadata before restoration intake',
  async (change) => {
    const f = await fixture();
    switch (change) {
      case 'checksum': {
        await db
          .updateTable('asset')
          .set({ checksum: Buffer.alloc(20, 1) })
          .where('id', '=', f.asset.id)
          .execute();
        break;
      }
      case 'algorithm': {
        await db
          .updateTable('asset')
          .set({ checksumAlgorithm: ChecksumAlgorithm.sha256File })
          .where('id', '=', f.asset.id)
          .execute();
        break;
      }
      case 'device': {
        await new DesktopDeviceRepository(db).revoke(f.asset.ownerId, f.device.id);
        break;
      }
      case 'session': {
        await db
          .updateTable('session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', f.session.id)
          .execute();
        break;
      }
      case 'resource': {
        await db
          .updateTable('photo_source_resource')
          .set({ state: 'planned' })
          .where('id', '=', f.resource.id)
          .execute();
        break;
      }
      case 'source': {
        await db.updateTable('photo_source').set({ revokedAt: new Date() }).where('id', '=', f.source.id).execute();
        break;
      }
    }
    await expect(f.service.requireSource(f.asset.id)).rejects.toThrow('Source admission changed');
    expect(await db.selectFrom('asset_restoration').select('id').where('assetId', '=', f.asset.id).execute()).toEqual(
      [],
    );
  },
);

it('requires exact resource evidence instead of silently upgrading legacy lifecycle snapshots', async () => {
  const f = await fixture();
  const [bound] = await AssetLocalEffectRepository.sourceEpochs(db, [f.asset.id]);
  expect(bound.reference).toEqual({ resourceId: f.resource.id, version: f.resource.version, sha256: f.sha256 });
  await expect(
    db.transaction().execute((tx) => holdSourceAdmission(tx, { sourceEpochs: [bound] })),
  ).resolves.toBeUndefined();
  const legacy = { assetId: bound.assetId, ownerId: bound.ownerId, epoch: bound.epoch };
  await expect(db.transaction().execute((tx) => holdSourceAdmission(tx, { sourceEpochs: [legacy] }))).rejects.toThrow(
    'studio_source_admission_changed',
  );
  await db
    .updateTable('photo_source_resource')
    .set({ version: 'e'.repeat(64) })
    .where('id', '=', f.resource.id)
    .execute();
  await expect(db.transaction().execute((tx) => holdSourceAdmission(tx, { sourceEpochs: [bound] }))).rejects.toThrow(
    'studio_source_admission_changed',
  );
});

it('keeps lifecycle revocation recordable and owned output fenced after source access is revoked', async () => {
  const f = await fixture();
  const [bound] = await AssetLocalEffectRepository.sourceEpochs(db, [f.asset.id]);
  await db.updateTable('photo_source').set({ revokedAt: new Date() }).where('id', '=', f.source.id).execute();
  expect(await AssetLocalEffectRepository.sourceEpochs(db, [f.asset.id])).toEqual([]);
  expect(await AssetLocalEffectRepository.lifecycleEpochs(db, [f.asset.id])).toEqual([
    { assetId: f.asset.id, ownerId: f.asset.ownerId, epoch: '0' },
  ]);
  await expect(db.transaction().execute((tx) => holdOwnedOutputAdmission(tx, [bound]))).resolves.toBeUndefined();
  await expect(db.transaction().execute((tx) => holdSourceAdmission(tx, { sourceEpochs: [bound] }))).rejects.toThrow(
    'studio_source_admission_changed',
  );
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable('asset')
      .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
      .where('id', '=', f.asset.id)
      .execute();
    const effect = await new AssetLocalEffectRepository(db).append(tx, f.asset.ownerId, randomUUID(), {
      origin: { kind: 'trash' },
      assets: [{ assetId: f.asset.id, status: AssetStatus.Trashed, revoke: true }],
      stacks: [],
    });
    expect(effect.assets[0].sourceEpoch).not.toBe('0');
  });
  await expect(db.transaction().execute((tx) => holdOwnedOutputAdmission(tx, [bound]))).rejects.toThrow(
    'studio_source_admission_changed',
  );
});

it.each(['writable-library', 'deleted-library', 'managed-label', 'trashed', 'offline', 'algorithm'] as const)(
  'refuses reference epochs with an invalid original boundary: %s',
  async (change) => {
    const f = await fixture();
    if (change === 'writable-library' || change === 'deleted-library')
      await db
        .updateTable('library')
        .set(change === 'writable-library' ? { readOnly: false } : { deletedAt: new Date() })
        .where('id', '=', f.asset.libraryId!)
        .execute();
    else
      await db
        .updateTable('asset')
        .set(
          change === 'managed-label'
            ? { isExternal: false }
            : change === 'trashed'
              ? { status: AssetStatus.Trashed, deletedAt: new Date() }
              : change === 'offline'
                ? { isOffline: true }
                : { checksumAlgorithm: ChecksumAlgorithm.sha256File },
        )
        .where('id', '=', f.asset.id)
        .execute();
    expect(await AssetLocalEffectRepository.sourceEpochs(db, [f.asset.id])).toEqual([]);
    expect(await AssetLocalEffectRepository.lifecycleEpochs(db, [f.asset.id])).toEqual([
      { assetId: f.asset.id, ownerId: f.asset.ownerId, epoch: '0' },
    ]);
  },
);

it('rechecks reference source expiry after waiting on an interactive stream fence', async () => {
  const f = await fixture();
  const actingSession = await new SessionRepository(db).create({ userId: f.asset.ownerId, token: randomBytes(32) });
  const head = await db.transaction().execute((tx) => AssetLocalEffectRepository.lockStreamHead(tx, f.asset.ownerId));
  await db
    .updateTable('session')
    .set({ expiresAt: new Date(Date.now() + 500) })
    .where('id', '=', f.session.id)
    .execute();
  const sourceEpochs = await AssetLocalEffectRepository.sourceEpochs(db, [f.asset.id]);
  expect(sourceEpochs).toHaveLength(1);
  const snapshot = {
    kind: 'studio-preview',
    sourceEpochs,
    interactiveAdmissionView: {
      actorId: f.asset.ownerId,
      sessionId: actingSession.id,
      owners: [{ ownerId: f.asset.ownerId, streamEpoch: head.streamEpoch, sequence: '0' }],
    },
  };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = db.transaction().execute(async (tx) => {
    await tx
      .selectFrom('asset_local_effect_stream')
      .select('ownerId')
      .where('ownerId', '=', f.asset.ownerId)
      .forUpdate()
      .execute();
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const pending = db.transaction().execute((tx) => holdSourceAdmission(tx, snapshot, f.asset.ownerId));
  void pending.catch(() => {});
  try {
    await expect
      .poll(
        async () =>
          (
            await sql<{ waiting: boolean }>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock') AS waiting`.execute(db)
          ).rows[0].waiting,
      )
      .toBe(true);
    await sql`SELECT pg_sleep(0.6)`.execute(db);
  } finally {
    release.resolve();
    await blocker;
  }
  await expect(pending).rejects.toThrow('studio_source_admission_changed');
});

it('holds source authority before waiting for a publication metadata fence', async () => {
  const f = await fixture();
  const sourceEpochs = await AssetLocalEffectRepository.sourceEpochs(db, [f.asset.id]);
  const operations = new MediaOperationRepository(db);
  const operation = await operations.create({
    ownerId: f.asset.ownerId,
    assetId: f.asset.id,
    kind: MediaOperationKind.RestorationPreview,
    destination: MediaOperationDestination.Local,
    label: 'Publication fence fixture',
    snapshot: { sourceEpochs },
    settings: {},
  });
  const claim = (await operations.claimNext({
    kinds: [MediaOperationKind.RestorationPreview],
    workerId: 'fixture',
    leaseMs: 60_000,
  }))!;
  expect(claim.operation.id).toBe(operation.id);
  expect(await operations.beginValidation(operation.id, claim.claimToken)).toBe(true);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${f.asset.id})::int)`.execute(tx);
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const pending = operations.publishValidated(operation.id, claim.claimToken, () => Promise.resolve(true));
  void pending.catch(() => {});
  try {
    await expect
      .poll(
        async () =>
          (
            await sql<{ waiting: boolean }>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock') AS waiting`.execute(db)
          ).rows[0].waiting,
      )
      .toBe(true);
    await expect(
      db
        .transaction()
        .execute((tx) => sql`SELECT id FROM photo_source WHERE id=${f.source.id}::uuid FOR UPDATE NOWAIT`.execute(tx)),
    ).rejects.toMatchObject({ code: '55P03' });
  } finally {
    release.resolve();
    await blocker;
    await pending;
  }
});

it('rolls back publication and completion if provider authority expires in its callback', async () => {
  const f = await fixture();
  const sourceEpochs = await AssetLocalEffectRepository.sourceEpochs(db, [f.asset.id]);
  const operations = new MediaOperationRepository(db);
  const operation = await operations.create({
    ownerId: f.asset.ownerId,
    assetId: f.asset.id,
    kind: MediaOperationKind.RestorationPreview,
    destination: MediaOperationDestination.Local,
    label: 'Expiry fixture',
    snapshot: { sourceEpochs },
    settings: {},
  });
  const claim = (await operations.claimNext({
    kinds: [MediaOperationKind.RestorationPreview],
    workerId: 'fixture',
    leaseMs: 60_000,
  }))!;
  expect(claim.operation.id).toBe(operation.id);
  expect(await operations.beginValidation(operation.id, claim.claimToken)).toBe(true);
  await db
    .updateTable('session')
    .set({ expiresAt: new Date(Date.now() + 500) })
    .where('id', '=', f.session.id)
    .execute();
  await expect(
    operations.publishValidated(operation.id, claim.claimToken, async (tx) => {
      await tx
        .updateTable('asset')
        .set({ originalFileName: 'must-rollback.jpg' })
        .where('id', '=', f.asset.id)
        .execute();
      await sql`SELECT pg_sleep(0.6)`.execute(tx);
      return true;
    }),
  ).rejects.toThrow('studio_source_admission_changed');
  expect((await operations.getForOwner(operation.id, f.asset.ownerId))?.status).toBe('validating');
  expect(
    (await db.selectFrom('asset').select('originalFileName').where('id', '=', f.asset.id).executeTakeFirstOrThrow())
      .originalFileName,
  ).toBe('photo.jpg');
});

it.each(['library', 'photo_source_run'] as const)(
  'pins the reference %s through the admission transaction',
  async (table) => {
    const f = await fixture();
    const sourceEpochs = await AssetLocalEffectRepository.sourceEpochs(db, [f.asset.id]);
    await db.transaction().execute(async (tx) => {
      await holdSourceAdmission(tx, { sourceEpochs });
      const id = table === 'library' ? f.asset.libraryId! : f.resource.runId;
      await expect(
        db
          .transaction()
          .execute((other) =>
            sql`SELECT id FROM ${sql.table(table)} WHERE id=${id}::uuid FOR UPDATE NOWAIT`.execute(other),
          ),
      ).rejects.toMatchObject({ code: '55P03' });
    });
  },
);
