import { type Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import type { CloudBackupRestoreSnapshot } from 'src/services/cloud-backup-restore.js';
import type { BuddyRecovery } from 'src/utils/buddy-backup-recovery.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import {
  AssetStatus,
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  PhysicalFileType,
  StorageFolder,
} from 'src/enum.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { BuddyBackupFidelityRepository } from 'src/repositories/buddy-backup-fidelity.repository.js';
import { BuddyBackupMetadataRepository } from 'src/repositories/buddy-backup-metadata.repository.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { SourceResourceCacheRepository } from 'src/repositories/source-resource-cache.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { BuddyBackupRestoreService, type RestoreJob } from 'src/services/buddy-backup-restore.service.js';
import { CloudBackupDetailsService } from 'src/services/cloud-backup-details.service.js';
import { CloudBackupRestorer, emptyRestoreResult } from 'src/services/cloud-backup-restore.js';
import { buddyLibraryForOwner } from 'src/utils/buddy-backup-metadata.js';
import { BuddyRecoveryFiles, buddyFileHash, readBuddyRecovery } from 'src/utils/buddy-backup-recovery.js';
import { type BuddyReferenceAdoption, adoptBuddyReferenceOriginal } from 'src/utils/buddy-reference-adoption.js';
import { buddyReferenceIntent } from 'src/utils/buddy-reference-intent.js';
import { referenceOriginalPath } from 'src/utils/buddy-reference-originals.js';
import { recoverBuddyReferenceOriginals } from 'src/utils/buddy-reference-recovery.js';
import { ownerRestoreHash } from 'src/utils/cloud-backup-owner-restore.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { resetSourceResourcesAfterRestore } from 'src/utils/source-resource-restore.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe('Buddy independent reference recovery in stopped-server maintenance', () => {
  let db: Kysely<DB>;
  let root: string;
  let owners: string[];
  beforeAll(async () => {
    db = await getKyselyDB();
  }, 30_000);
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(async () => {
    owners = [];
    root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-reference-recovery-')));
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(root);
  });
  afterEach(async () => {
    await db.deleteFrom('user').where('id', 'in', owners).execute();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  const fixture = async (trashed = false) => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    owners.push(user.id);
    const device = (await new DesktopDeviceRepository(db).enroll({
      userId: user.id,
      installationId: randomUUID(),
      publicKey: randomBytes(32).toString('base64'),
      name: 'Offline desktop',
      platform: 'linux',
      architecture: 'x86_64',
      mode: 'client-worker',
      state: 'revoked',
    }))!;
    const source = await db
      .insertInto('photo_source')
      .values({
        ownerId: user.id,
        deviceId: device.id,
        photoSessionId: randomUUID(),
        kind: 'folder',
        mode: 'copy',
        name: 'Offline source',
        scopeFingerprint: 'a'.repeat(64),
        revokedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await sql`UPDATE photo_source SET mode='reference' WHERE id=${source.id}::uuid`.execute(db);
    const run = await db
      .insertInto('photo_source_run')
      .values({ sourceId: source.id, maxBytes: 100, maxItems: 2 })
      .returningAll()
      .executeTakeFirstOrThrow();
    const library = await new LibraryRepository(db).create({
      ownerId: user.id,
      name: 'Offline reference library',
      readOnly: true,
      importPaths: [],
      exclusionPatterns: [],
    });
    const sourcePath = `frameleaf-source://${source.id}/${'b'.repeat(64)}`;
    const checksum = createHash('sha1').update(sourcePath).digest();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      libraryId: library.id,
      isExternal: true,
      isOffline: true,
      originalPath: sourcePath,
      originalFileName: 'original.CR2',
      checksum,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      status: trashed ? AssetStatus.Trashed : AssetStatus.Active,
      deletedAt: trashed ? new Date() : null,
      isFavorite: true,
    });
    const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
    const bytes = Buffer.from('hello');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const resource = await db
      .insertInto('photo_source_resource')
      .values({
        runId: run.id,
        resourceKey: 'b'.repeat(64),
        version: 'c'.repeat(64),
        checksum: Buffer.from(sha256, 'hex'),
        bytes: bytes.length,
        assetId: asset.id,
        state: 'verified',
        verifiedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('source_original')
      .values({
        assetId: asset.id,
        resourceId: resource.id,
        scopeFingerprint: source.scopeFingerprint,
        authorizationEpoch: device.authorizationEpoch,
      })
      .execute();
    await db.updateTable('user').set({ quotaUsageInBytes: 100 }).where('id', '=', user.id).execute();
    // The actual recovery transaction has already revoked all restored sessions.
    await db.deleteFrom('session').execute();
    const path = referenceOriginalPath(root, user.id, asset.id, asset.originalFileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const file = { path, sha256, size: bytes.length, role: 'original', mtime: null };
    const state = await new BuddyBackupFidelityRepository(db).capture(asset.id, sha256, [], []);
    const plan = {
      version: 1,
      scope: 'server',
      mode: 'replace',
      files: [file],
      manifest: {
        version: 2,
        storageRoot: root,
        storageRoots: [root],
        library: {
          assets: {
            [asset.id]: { owner: user.id, type: asset.type, originalFileName: asset.originalFileName, files: [file] },
          },
        },
        contents: { [sha256]: { bytes: bytes.length, keyVersion: 1, blocks: ['d'.repeat(64)] } },
        referenceOriginals: {
          [asset.id]: {
            version: 1,
            sourcePath,
            sourceEpoch: {
              assetId: asset.id,
              ownerId: user.id,
              epoch: '0',
              reference: { resourceId: resource.id, version: resource.version, sha256 },
            },
          },
        },
        assetFidelity: { [asset.id]: state },
      },
    } as unknown as BuddyRecovery;
    return { ctx, user, asset, album, source, resource, plan, file };
  };
  const submitted = async (admin = false) => {
    const f = await fixture();
    const actor = admin ? (await f.ctx.newUser()).user : f.user;
    if (admin) {
      owners.push(actor.id);
      await db.updateTable('user').set({ isAdmin: true }).where('id', '=', actor.id).execute();
    }
    const session = await db
      .insertInto('session')
      .values({ userId: actor.id, token: randomBytes(32), pinExpiresAt: new Date(Date.now() + 60_000) })
      .returningAll()
      .executeTakeFirstOrThrow();
    const index = new CloudBackupIndexRepository(db);
    const owner = {
      ownerId: actor.id,
      sessionId: session.id,
      current: await index.getOwnerRestoreIdentities([f.asset.id]),
      assetHashes: { [f.asset.id]: 'a'.repeat(64) },
    };
    const adoption: BuddyReferenceAdoption = {
      assetId: f.asset.id,
      ownerId: f.user.id,
      type: f.asset.type,
      source: f.plan.manifest.referenceOriginals![f.asset.id],
      file: f.file,
      physicalFileId: randomUUID(),
    };
    const job = {
      version: 1,
      request: { scope: 'asset', assetIds: [f.asset.id], snapshotId: randomUUID(), mode: 'replace', confirm: true },
      sessionId: session.id,
      admin,
      owner,
      vaultId: randomUUID(),
      fingerprint: 'b'.repeat(64),
      manifestHash: 'c'.repeat(64),
      referenceAdoptions: { [f.asset.id]: adoption },
    } as RestoreJob;
    const operations = new MediaOperationRepository(db);
    const operation = await operations.create({
      ownerId: actor.id,
      kind: MediaOperationKind.BuddyRestore,
      destination: MediaOperationDestination.Local,
      label: 'Synthetic confirmed restore',
      snapshot: job as unknown as Record<string, unknown>,
      settings: {},
    });
    const claim = (await operations.claimNext({
      kinds: [MediaOperationKind.BuddyRestore],
      workerId: 'synthetic-reference-admission',
      leaseMs: 60_000,
    }))!;
    expect(claim.operation.id).toBe(operation.id);
    await operations.reportProgress(operation.id, claim.claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: 0,
      totalUnits: null,
      progress: 0,
    });
    const lease = { operationId: operation.id, claimToken: claim.claimToken };
    const identity = {
      bucketRef: job.vaultId,
      keyFingerprint: job.fingerprint,
      manifestKey: job.request.snapshotId,
      owner,
    };
    const intent = buddyReferenceIntent(operation.id, job, f.asset.id)!;
    const verify = async () => {
      expect(await buddyFileHash(f.file.path)).toEqual({ sha256: f.file.sha256, size: f.file.size });
    };
    const run = (action: Parameters<CloudBackupIndexRepository['withOwnerRestore']>[4], expected = intent) =>
      index.withOwnerRestore(owner, identity, f.asset.id, lease, action, {
        authorize: () => Promise.resolve(),
        reference: { intent: expected, verify },
        ...(admin && { administrator: { assetOwnerId: f.user.id } }),
      });
    return { ...f, actor, session, index, job, operation, owner, identity, intent, lease, verify, run };
  };

  const onlinePublisher = async (admin = false) => {
    const f = await submitted(admin);
    const details = (await f.index.getAssetDetails([f.asset.id])).get(f.asset.id)!;
    const manifest = {
      ...f.plan.manifest,
      snapshotId: f.job.request.snapshotId,
      assetLinks: { [f.asset.id]: { isExternal: true, libraryId: f.asset.libraryId } },
      library: {
        format: 'frameleaf-backup-manifest',
        version: 3,
        instanceId: randomUUID(),
        createdAt: new Date().toISOString(),
        database: null,
        profiles: {},
        albums: {},
        people: {},
        assets: {
          [f.asset.id]: {
            ...details.record,
            owner: f.user.id,
            files: [f.file],
            details: details.details,
          },
        },
      },
    } as unknown as BuddyManifest;
    const metadata = new BuddyBackupMetadataRepository(db);
    manifest.metadata = await metadata.capture([]);
    f.job.albums = await metadata.plan(manifest.metadata, [f.album.id], f.job.request.mode);
    f.job.owner.assetHashes[f.asset.id] = ownerRestoreHash(
      manifest.library.assets[f.asset.id],
      buddyLibraryForOwner(manifest, f.user.id),
    );
    await db
      .updateTable('media_operation')
      .set({ snapshot: f.job as unknown as Record<string, unknown> })
      .where('id', '=', f.operation.id)
      .execute();
    const snapshot: CloudBackupRestoreSnapshot = {
      ...f.identity,
      version: 1,
      scope: 'asset',
      assetIds: [f.asset.id],
      details: f.job.request.mode,
    };
    const logger = LoggingRepository.create();
    const crypto = new CryptoRepository();
    const storage = new StorageRepository(logger);
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      repository: { db, root: () => root },
      index: f.index,
      crypto,
      binding: () => Promise.resolve(),
      storage,
      logger,
      operations: new MediaOperationRepository(db),
      open: () =>
        Promise.resolve({
          manifest,
          reader: { download: (_manifest: unknown, hash: string, path: string) => read('', path, hash) },
        }),
      fingerprint: () => f.job.manifestHash,
      details: Object.assign(Object.create(CloudBackupDetailsService.prototype), { logger }),
      drainRestoreJobs: vi.fn().mockResolvedValue(undefined),
    });
    const file = {
      fileKey: `${f.asset.id}:000`,
      assetId: f.asset.id,
      role: 'original',
      target: f.file.path,
      sha256: f.file.sha256,
      size: f.file.size,
      inPlace: true,
    };
    const read = vi.fn(async (_key: string, path: string, _hash?: string) => {
      await writeFile(path, 'hello');
      return buddyFileHash(path);
    });
    const run = (afterPublish?: (trx: Kysely<DB>) => Promise<void>) =>
      new CloudBackupRestorer(null, storage, crypto, logger).restore({
        manifest: manifest.library,
        scope: 'asset',
        files: [file],
        destination: null,
        stageBesideTarget: true,
        mediaLocation: root,
        backupsFolder: join(root, 'backups'),
        operationId: f.operation.id,
        start: emptyRestoreResult(),
        checkpoint: () => Promise.resolve(true),
        read,
        publish: (entry, staged, publish, phase, proof) =>
          service.guarded(
            f.operation,
            f.lease.claimToken,
            f.job,
            manifest,
            snapshot,
            entry,
            async (trx: Kysely<DB>) => {
              const outcome =
                phase === 'inspect' ? await publish() : await service.publishStaged(entry, staged, publish, proof);
              if (phase === 'publish') await afterPublish?.(trx);
              return outcome;
            },
            phase === 'inspect' ? 'inspect' : { kind: 'publish', proof },
          ),
      });
    const persist = () =>
      db
        .updateTable('media_operation')
        .set({ snapshot: f.job as unknown as Record<string, unknown> })
        .where('id', '=', f.operation.id)
        .execute();
    const worker = () => service.runClaim({ ...f.operation, snapshot: f.job }, f.lease.claimToken);
    return { ...f, manifest, snapshot, service, file, read, publish: run, persist, worker };
  };

  it.each([false, true])('publishes an independent managed original and verifies replay: admin=%s', async (admin) => {
    const f = await onlinePublisher(admin);
    await rm(f.file.target);
    expect(await f.publish()).toMatchObject({ files: 1, skipped: 0, replaced: 0 });
    const asset = await db.selectFrom('asset').selectAll().where('id', '=', f.asset.id).executeTakeFirstOrThrow();
    expect(asset).toMatchObject({
      originalPath: f.file.target,
      isExternal: false,
      isOffline: false,
      libraryId: null,
      physicalOriginalFileId: f.intent.adoption.physicalFileId,
    });
    expect(await readFile(f.file.target, 'utf8')).toBe('hello');
    expect((await f.publish())?.skipped).toBe(1);
    expect(await db.selectFrom('physical_file').select('id').where('path', '=', f.file.target).execute()).toEqual([
      { id: f.intent.adoption.physicalFileId },
    ]);
    expect(
      Number(
        (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', f.user.id).executeTakeFirstOrThrow())
          .quotaUsageInBytes,
      ),
    ).toBe(105);
    expect(f.owner.current[f.asset.id].isExternal).toBe(true);
  });

  it.each([false, true])(
    'runs the online worker through managed original and metadata completion: admin=%s',
    async (admin) => {
      const f = await onlinePublisher(admin);
      await rm(f.file.target);
      await f.worker();
      const operation = await new MediaOperationRepository(db).getOfKind(
        f.operation.id,
        MediaOperationKind.BuddyRestore,
      );
      expect(operation).toMatchObject({ status: MediaOperationStatus.Completed, error: null });
      expect(f.read).toHaveBeenCalledOnce();
      expect(
        await db
          .selectFrom('asset')
          .select(['originalPath', 'isExternal', 'isOffline'])
          .where('id', '=', f.asset.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ originalPath: f.file.target, isExternal: false, isOffline: false });
      expect(
        await db
          .selectFrom('asset_local_effect')
          .select('effectId')
          .where('effectId', '=', f.intent.adoption.physicalFileId)
          .execute(),
      ).toEqual([{ effectId: f.intent.adoption.physicalFileId }]);
    },
  );

  it('checks quota before downloading independent original bytes', async () => {
    const f = await onlinePublisher();
    await rm(f.file.target);
    await db.updateTable('user').set({ quotaSizeInBytes: 104 }).where('id', '=', f.user.id).execute();
    await expect(f.publish()).rejects.toThrow('Not enough quota');
    expect(f.read).not.toHaveBeenCalled();
    expect(
      await db.selectFrom('source_original').select('assetId').where('assetId', '=', f.asset.id).execute(),
    ).toHaveLength(1);
  });

  it.each(['PIN', 'claim'] as const)(
    'rolls back adoption when %s expires before commit and safely retries retained bytes',
    async (change) => {
      const f = await onlinePublisher();
      await rm(f.file.target);
      await expect(
        f.publish(async (trx) => {
          if (change === 'PIN')
            await trx
              .updateTable('session')
              .set({ pinExpiresAt: new Date(0) })
              .where('id', '=', f.session.id)
              .execute();
          else
            await trx
              .updateTable('media_operation')
              .set({ claimExpiresAt: new Date(0) })
              .where('id', '=', f.operation.id)
              .execute();
        }),
      ).rejects.toThrow();
      expect(await readFile(f.file.target, 'utf8')).toBe('hello');
      expect(
        await db.selectFrom('source_original').select('assetId').where('assetId', '=', f.asset.id).execute(),
      ).toHaveLength(1);
      expect(
        await db.selectFrom('physical_file').select('id').where('path', '=', f.file.target).execute(),
      ).toHaveLength(0);
      expect((await f.publish())?.skipped).toBe(1);
      expect(
        Number(
          (
            await db
              .selectFrom('user')
              .select('quotaUsageInBytes')
              .where('id', '=', f.user.id)
              .executeTakeFirstOrThrow()
          ).quotaUsageInBytes,
        ),
      ).toBe(105);
    },
  );

  it('refuses reference metadata before the independent original has been adopted', async () => {
    const f = await onlinePublisher();
    const action = vi.fn().mockResolvedValue(undefined);
    await expect(
      f.service.guarded(f.operation, f.lease.claimToken, f.job, f.manifest, f.snapshot, f.file, action, 'metadata'),
    ).rejects.toThrow('Reference original must be restored first');
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps an occupied managed destination untouched in keep mode', async () => {
    const f = await onlinePublisher();
    f.job.request.mode = 'keep';
    await f.persist();
    await writeFile(f.file.target, 'other original');
    await expect(f.publish()).rejects.toThrow('Reference restore destination is occupied');
    expect(f.read).not.toHaveBeenCalled();
    expect(await readFile(f.file.target, 'utf8')).toBe('other original');
  });

  it('adopts a hash-equal destination in keep mode instead of bypassing reference publication', async () => {
    const f = await onlinePublisher();
    f.job.request.mode = 'keep';
    f.job.albums = { version: 1, albums: {} };
    await f.persist();
    await f.worker();
    expect(
      await new MediaOperationRepository(db).getOfKind(f.operation.id, MediaOperationKind.BuddyRestore),
    ).toMatchObject({ status: MediaOperationStatus.Completed, result: { skipped: 1 } });
    expect(
      await db
        .selectFrom('asset')
        .select('physicalOriginalFileId')
        .where('id', '=', f.asset.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ physicalOriginalFileId: f.intent.adoption.physicalFileId });
  });

  it.each([false, true])(
    'keeps a confirmed newer source reference without downloading or adopting it: admin=%s',
    async (admin) => {
      const f = await onlinePublisher(admin);
      f.job.request.mode = 'keep';
      f.job.referenceAdoptions = {};
      f.job.albums = { version: 1, albums: {} };
      const newer = createHash('sha256').update('newer').digest();
      await db.updateTable('photo_source_resource').set({ checksum: newer }).where('id', '=', f.resource.id).execute();
      f.job.owner.current = await f.index.getOwnerRestoreIdentities([f.asset.id]);
      await f.persist();
      await rm(f.file.target);
      await f.worker();
      const operation = await new MediaOperationRepository(db).getOfKind(
        f.operation.id,
        MediaOperationKind.BuddyRestore,
      );
      expect(operation).toMatchObject({
        status: MediaOperationStatus.Completed,
        result: { preservedReferenceAssetIds: [f.asset.id], files: 0 },
      });
      expect(f.read).not.toHaveBeenCalled();
      expect(
        await db
          .selectFrom('asset')
          .select(['originalPath', 'isExternal'])
          .where('id', '=', f.asset.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ originalPath: f.asset.originalPath, isExternal: true });
      expect(
        Number(
          (
            await db
              .selectFrom('user')
              .select('quotaUsageInBytes')
              .where('id', '=', f.user.id)
              .executeTakeFirstOrThrow()
          ).quotaUsageInBytes,
        ),
      ).toBe(100);
    },
  );

  it('preserves the selected Live Photo group when only the still reference is newer', async () => {
    const f = await onlinePublisher();
    const sourcePath = `frameleaf-source://${f.source.id}/${'d'.repeat(64)}`;
    const { asset: motion } = await f.ctx.newAsset({
      ownerId: f.user.id,
      libraryId: f.asset.libraryId,
      isExternal: true,
      isOffline: true,
      originalPath: sourcePath,
      originalFileName: 'motion.mov',
      type: AssetType.Video,
      visibility: AssetVisibility.Hidden,
      checksum: createHash('sha1').update(sourcePath).digest(),
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
    });
    const sha256 = createHash('sha256').update('movie').digest('hex');
    const resource = await db
      .insertInto('photo_source_resource')
      .values({
        runId: f.resource.runId,
        resourceKey: 'd'.repeat(64),
        version: 'e'.repeat(64),
        checksum: Buffer.from(sha256, 'hex'),
        bytes: 5,
        assetId: motion.id,
        state: 'verified',
        verifiedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('source_original')
      .values({
        assetId: motion.id,
        resourceId: resource.id,
        scopeFingerprint: f.source.scopeFingerprint,
        authorizationEpoch: (
          await db
            .selectFrom('source_original')
            .select('authorizationEpoch')
            .where('assetId', '=', f.asset.id)
            .executeTakeFirstOrThrow()
        ).authorizationEpoch,
      })
      .execute();
    await db.updateTable('asset').set({ livePhotoVideoId: motion.id }).where('id', '=', f.asset.id).execute();
    const details = (await f.index.getAssetDetails([motion.id])).get(motion.id)!;
    f.manifest.library.assets[motion.id] = {
      ...details.record,
      details: details.details,
      owner: f.user.id,
      files: [
        {
          role: 'original',
          path: referenceOriginalPath(root, f.user.id, motion.id, motion.originalFileName),
          size: 5,
          sha256,
          mtime: null,
        },
      ],
    };
    f.manifest.assetLinks![f.asset.id].livePhotoVideoId = motion.id;
    f.manifest.assetLinks![motion.id] = {
      isExternal: true,
      libraryId: motion.libraryId ?? null,
      livePhotoVideoId: null,
    };
    f.job.request.mode = 'keep';
    f.job.request.assetIds!.push(motion.id);
    f.job.referenceAdoptions = {};
    f.job.albums = { version: 1, albums: {} };
    await db
      .updateTable('photo_source_resource')
      .set({ checksum: createHash('sha256').update('newer').digest() })
      .where('id', '=', f.resource.id)
      .execute();
    f.job.owner.current = await f.index.getOwnerRestoreIdentities([f.asset.id, motion.id]);
    f.job.owner.assetHashes[motion.id] = ownerRestoreHash(
      f.manifest.library.assets[motion.id],
      buddyLibraryForOwner(f.manifest, f.user.id),
    );
    await f.persist();
    await f.worker();
    expect(
      await new MediaOperationRepository(db).getOfKind(f.operation.id, MediaOperationKind.BuddyRestore),
    ).toMatchObject({
      status: MediaOperationStatus.Completed,
      result: { preservedReferenceAssetIds: [f.asset.id, motion.id].sort(), files: 0 },
    });
    expect(f.read).not.toHaveBeenCalled();
    expect(
      await db.selectFrom('asset').select(['id', 'isExternal']).where('id', 'in', [f.asset.id, motion.id]).execute(),
    ).toEqual(
      expect.arrayContaining([
        { id: f.asset.id, isExternal: true },
        { id: motion.id, isExternal: true },
      ]),
    );
  });

  it.each([false, true])(
    'admits only the submitted owner transition and verifies committed replay: admin=%s',
    async (admin) => {
      const f = await submitted(admin);
      await expect(
        f.run(async (trx, adopted, pending) => {
          expect(adopted).toBeUndefined();
          expect(pending).toEqual(f.intent.adoption);
          return adoptBuddyReferenceOriginal(trx, pending!, f.verify);
        }),
      ).resolves.toBe('adopted');
      await expect(
        f.run((_trx, adopted, pending) => {
          expect(adopted).toEqual(f.intent.adoption);
          expect(pending).toBeUndefined();
          return Promise.resolve('verified');
        }),
      ).resolves.toBe('verified');
      expect(f.owner.current[f.asset.id].isExternal).toBe(true);
      expect(
        Number(
          (
            await db
              .selectFrom('user')
              .select('quotaUsageInBytes')
              .where('id', '=', f.user.id)
              .executeTakeFirstOrThrow()
          ).quotaUsageInBytes,
        ),
      ).toBe(105);
    },
  );

  it.each([
    'physical-id',
    'mode',
    'source-version',
    'scope',
    'lifecycle',
    'claim',
    'pin',
    'admin-role',
    'target-owner',
  ] as const)('refuses changed confirmation authority before any callback: %s', async (change) => {
    const f = await submitted(true);
    const intent = structuredClone(f.intent);
    switch (change) {
      case 'physical-id': {
        intent.adoption.physicalFileId = randomUUID();
        break;
      }
      case 'mode': {
        intent.mode = 'keep';
        break;
      }
      case 'source-version': {
        await db
          .updateTable('photo_source_resource')
          .set({ version: 'e'.repeat(64) })
          .where('id', '=', f.resource.id)
          .execute();
        break;
      }
      case 'scope': {
        await db
          .updateTable('photo_source')
          .set({ scopeFingerprint: 'e'.repeat(64) })
          .where('id', '=', f.source.id)
          .execute();
        break;
      }
      case 'lifecycle': {
        await db.transaction().execute(async (tx) => {
          await tx
            .updateTable('asset')
            .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
            .where('id', '=', f.asset.id)
            .execute();
          await new AssetLocalEffectRepository(tx).append(tx, f.user.id, randomUUID(), {
            origin: { kind: 'trash' },
            assets: [{ assetId: f.asset.id, status: AssetStatus.Trashed, revoke: true }],
            stacks: [],
          });
          await tx
            .updateTable('asset')
            .set({ status: AssetStatus.Active, deletedAt: null })
            .where('id', '=', f.asset.id)
            .execute();
        });
        break;
      }
      case 'claim': {
        await db
          .updateTable('media_operation')
          .set({ claimToken: randomUUID() })
          .where('id', '=', f.operation.id)
          .execute();
        break;
      }
      case 'pin': {
        await db
          .updateTable('session')
          .set({ pinExpiresAt: new Date(0) })
          .where('id', '=', f.session.id)
          .execute();
        break;
      }
      case 'admin-role': {
        await db.updateTable('user').set({ isAdmin: false }).where('id', '=', f.actor.id).execute();
        break;
      }
      case 'target-owner': {
        intent.adoption.ownerId = f.actor.id;
        break;
      }
    }
    const callback = vi.fn().mockResolvedValue('must not publish');
    await expect(f.run(callback, intent)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });

  it('rolls back callback changes when PIN authority expires before commit', async () => {
    const f = await submitted();
    const before = (
      await db.selectFrom('asset').select('isFavorite').where('id', '=', f.asset.id).executeTakeFirstOrThrow()
    ).isFavorite;
    await expect(
      f.run(async (trx) => {
        await trx.updateTable('asset').set({ isFavorite: !before }).where('id', '=', f.asset.id).execute();
        await trx
          .updateTable('session')
          .set({ pinExpiresAt: new Date(0) })
          .where('id', '=', f.session.id)
          .execute();
      }),
    ).rejects.toThrow('Owner restore authorization unavailable');
    expect(
      (await db.selectFrom('asset').select('isFavorite').where('id', '=', f.asset.id).executeTakeFirstOrThrow())
        .isFavorite,
    ).toBe(before);
  });

  it('revokes restored grants and read claims while retaining cache writer and reader ownership', async () => {
    const f = await fixture();
    const session = await db
      .insertInto('session')
      .values({ userId: f.user.id, token: randomBytes(32) })
      .returningAll()
      .executeTakeFirstOrThrow();
    const grant = await db
      .insertInto('source_resource_grant')
      .values({
        sourceId: f.source.id,
        photoSessionId: session.id,
        tokenHash: randomBytes(32),
        scopeFingerprint: f.source.scopeFingerprint,
        authorizationEpoch: 1,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const read = await db
      .insertInto('source_resource_read')
      .values({
        assetId: f.asset.id,
        resourceId: f.resource.id,
        sourceId: f.source.id,
        ownerId: f.user.id,
        deviceId: f.source.deviceId,
        scopeFingerprint: f.source.scopeFingerprint,
        authorizationEpoch: 1,
        state: 'claimed',
        claimFence: 1,
        claimTokenHash: randomBytes(32),
        claimCredentialHash: randomBytes(32),
        leaseUntil: new Date(Date.now() + 60_000),
        deadline: new Date(Date.now() + 600_000),
        backupOperationId: null,
        backupClaimTokenHash: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const cache = await db
      .insertInto('source_resource_cache')
      .values({
        readId: read.id,
        claimFence: 1,
        assetId: f.asset.id,
        resourceId: f.resource.id,
        sourceId: f.source.id,
        ownerId: f.user.id,
        deviceId: f.source.deviceId,
        scopeFingerprint: f.source.scopeFingerprint,
        authorizationEpoch: 1,
        resourceKey: f.resource.resourceKey,
        version: f.resource.version,
        sha256: f.resource.checksum,
        bytes: f.resource.bytes,
        writerId: randomUUID(),
        writerOwnerId: randomUUID(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const lease = await db
      .insertInto('source_resource_cache_lease')
      .values({ cacheId: cache.id, readerId: randomUUID(), readerOwnerId: randomUUID(), kind: 'http' })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db.transaction().execute(resetSourceResourcesAfterRestore);
    expect(
      (
        await db
          .selectFrom('source_resource_grant')
          .select('revokedAt')
          .where('id', '=', grant.id)
          .executeTakeFirstOrThrow()
      ).revokedAt,
    ).not.toBeNull();
    expect(
      await db
        .selectFrom('source_resource_read')
        .select(['state', 'claimTokenHash', 'claimCredentialHash', 'leaseUntil'])
        .where('id', '=', read.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'unavailable', claimTokenHash: null, claimCredentialHash: null, leaseUntil: null });
    expect(
      await db.selectFrom('source_resource_cache').selectAll().where('id', '=', cache.id).executeTakeFirstOrThrow(),
    ).toEqual({ ...cache, restoreHeld: true });
    expect(
      await db
        .selectFrom('source_resource_cache_lease')
        .selectAll()
        .where('id', '=', lease.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(lease);
    expect(await new SourceResourceCacheRepository(db).claimRemoval(cache.id)).toBeUndefined();
  });

  const restore = (plan: BuddyRecovery) =>
    db.transaction().execute((trx) => recoverBuddyReferenceOriginals(trx, plan, async () => {}));

  const interrupted = async (status: AssetDevelopRevisionStatus.Queued | AssetDevelopRevisionStatus.Rendering) => {
    const f = await fixture();
    const source = {
      assetId: f.asset.id,
      path: f.asset.originalPath,
      checksum: f.asset.checksum.toString('hex'),
      reference: { resourceId: f.resource.id, version: f.resource.version, sha256: f.file.sha256 },
    };
    const recipe = defaultDevelopRecipe();
    const { rows } = await sql<{ id: string }>`INSERT INTO public.asset_develop_revision
      ("assetId","ownerId",revision,recipe,status,"sourceAssetId","sourceBinding","sourceChecksum",
        "renderAttemptId","renderGenerationId",progress,attempts,"cancelRequested")
      VALUES (${f.asset.id}::uuid,${f.user.id}::uuid,1,${JSON.stringify(recipe)}::text::jsonb,${status},
        ${f.asset.id}::uuid,${JSON.stringify({ kind: 'bound', parent: source, input: source })}::text::jsonb,
        ${Buffer.from(f.file.sha256, 'hex')},${randomUUID()}::uuid,${randomUUID()}::uuid,70,3,true) RETURNING id`.execute(
      db,
    );
    f.plan.manifest.assetFidelity![f.asset.id] = await new BuddyBackupFidelityRepository(db).capture(
      f.asset.id,
      f.file.sha256,
      [],
      [],
    );
    const revisions = new AssetDevelopRepository(db);
    const previous = (await revisions.get(rows[0].id))!;
    return { ...f, recipe, revisions, previous };
  };

  it.each([AssetDevelopRevisionStatus.Queued, AssetDevelopRevisionStatus.Rendering] as const)(
    'recovers an interrupted %s recipe as saved without reviving its execution',
    async (status) => {
      const f = await interrupted(status);
      await restore(f.plan);
      const recovered = (await f.revisions.get(f.previous.id))!;
      expect(recovered).toMatchObject({
        recipe: f.recipe,
        status: AssetDevelopRevisionStatus.Saved,
        progress: 0,
        attempts: 0,
        cancelRequested: false,
        renderAttemptId: null,
        renderGenerationId: null,
        isCurrent: false,
      });
      const source = { assetId: f.asset.id, path: f.file.path, checksum: f.file.sha256, reference: null };
      expect(recovered.sourceBinding).toEqual({ kind: 'bound', parent: source, input: source });
      expect((await f.revisions.listUnfinished()).some((revision) => revision.id === f.previous.id)).toBe(false);
      expect(await f.revisions.progressAttempt(f.previous, 99)).toBe(false);
      await f.revisions.settleAttempt(f.previous, {
        status: AssetDevelopRevisionStatus.Failed,
        error: 'Late old worker',
      });
      expect((await f.revisions.get(f.previous.id))?.status).toBe(AssetDevelopRevisionStatus.Saved);
      await restore(f.plan);
      expect((await f.revisions.get(f.previous.id))?.status).toBe(AssetDevelopRevisionStatus.Saved);
    },
  );

  it('rolls back interrupted-render normalization when recovery authority ends', async () => {
    const f = await interrupted(AssetDevelopRevisionStatus.Rendering);
    await expect(
      db.transaction().execute((trx) =>
        recoverBuddyReferenceOriginals(trx, f.plan, async () => {
          const { rows } = await sql<{ status: string }>`SELECT status FROM public.asset_develop_revision
        WHERE id=${f.previous.id}::uuid`.execute(trx);
          if (rows[0].status === AssetDevelopRevisionStatus.Saved) throw new Error('recovery authority lost');
        }),
      ),
    ).rejects.toThrow('recovery authority lost');
    expect(await f.revisions.get(f.previous.id)).toEqual(f.previous);
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', f.asset.id).executeTakeFirstOrThrow())
        .originalPath,
    ).toBe(f.asset.originalPath);
  });

  it('still refuses a busy edit in ordinary scoped metadata publication', async () => {
    const f = await interrupted(AssetDevelopRevisionStatus.Rendering);
    await expect(
      db.transaction().execute((trx) =>
        new BuddyBackupFidelityRepository(trx).publish({
          state: f.plan.manifest.assetFidelity![f.asset.id],
          ownerId: f.user.id,
          mode: 'replace',
          originalSha256: f.file.sha256,
          paths: new Map(),
          verify: async () => {},
        }),
      ),
    ).rejects.toThrow('An edit is changing');
    expect(await f.revisions.get(f.previous.id)).toEqual(f.previous);
  });

  it('publishes the prepared offline original and converts the restored SQL identity with no source session', async () => {
    const { user, asset, plan, file } = await fixture();
    const recoveryId = randomUUID();
    const recoveryRoot = join(root, 'recovered');
    const directory = join(recoveryRoot, 'recovery', recoveryId);
    await mkdir(join(directory, 'objects'), { recursive: true });
    await writeFile(join(directory, 'objects', file.sha256), await readFile(file.path));
    await rm(file.path);
    await writeFile(join(directory, 'prepared.json'), JSON.stringify(plan));
    const prepared = await readBuddyRecovery(recoveryRoot, recoveryId);
    const publisher = new BuddyRecoveryFiles(recoveryRoot, recoveryId, async () => {});
    await publisher.publish(prepared, [root], []);
    expect(await readFile(file.path, 'utf8')).toBe('hello');
    await restore(prepared);
    await publisher.verify(prepared, [root], []);
    expect(
      await db
        .selectFrom('asset')
        .select(['id', 'ownerId', 'originalPath', 'isExternal', 'libraryId'])
        .where('id', '=', asset.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ id: asset.id, ownerId: user.id, originalPath: file.path, isExternal: false, libraryId: null });
    expect(await db.selectFrom('source_original').select('assetId').where('assetId', '=', asset.id).execute()).toEqual(
      [],
    );
  });

  it.each([true, false])('rebinds a saved recipe only when its source pixels match: %s', async (matching) => {
    const { user, asset, plan, file, resource } = await fixture();
    const source = {
      assetId: asset.id,
      path: asset.originalPath,
      checksum: asset.checksum.toString('hex'),
      reference: {
        resourceId: resource.id,
        version: resource.version,
        sha256: matching ? file.sha256 : 'e'.repeat(64),
      },
    };
    const binding = { kind: 'bound', parent: source, input: source };
    await sql`INSERT INTO public.asset_develop_revision
      ("assetId","ownerId",revision,recipe,status,"sourceAssetId","sourceBinding","sourceChecksum")
      VALUES (${asset.id}::uuid,${user.id}::uuid,1,${JSON.stringify(defaultDevelopRecipe())}::text::jsonb,'saved',
        ${asset.id}::uuid,${JSON.stringify(binding)}::text::jsonb,${Buffer.from(file.sha256, 'hex')})`.execute(db);
    plan.manifest.assetFidelity![asset.id] = await new BuddyBackupFidelityRepository(db).capture(
      asset.id,
      file.sha256,
      [],
      [],
    );
    await restore(plan);
    const { rows } = await sql<{ binding: unknown; status: string }>`SELECT "sourceBinding" AS binding,status
      FROM public.asset_develop_revision WHERE "assetId"=${asset.id}::uuid`.execute(db);
    const managed = { assetId: asset.id, path: file.path, checksum: file.sha256, reference: null };
    expect(rows).toEqual([
      { binding: matching ? { kind: 'bound', parent: managed, input: managed } : binding, status: 'saved' },
    ]);
    await restore(plan);
  });

  it.each([
    ['matching', true, false],
    ['matching', false, false],
    ['changed', false, false],
    ['omitted', false, false],
    ['unrelated', false, false],
    ['trashed', false, false],
    ['unbound', false, false],
    ['matching', true, true],
    ['matching', false, true],
    ['changed', false, true],
  ] as const)(
    'restores a Live Photo key-frame binding with %s motion proof, motion first=%s, online=%s',
    async (proof, motionFirst, online) => {
      const active = online ? await onlinePublisher() : undefined;
      const f = active ? { ...active, file: active.plan.files[0] } : await fixture();
      const sourcePath = `frameleaf-source://${f.source.id}/${'d'.repeat(64)}`;
      const { asset: motion } = await f.ctx.newAsset({
        id: `${motionFirst ? '00000000' : 'ffffffff'}-${randomUUID().slice(9)}`,
        ownerId: f.user.id,
        libraryId: f.asset.libraryId,
        isExternal: true,
        isOffline: true,
        originalPath: sourcePath,
        originalFileName: 'motion.mov',
        type: AssetType.Video,
        visibility: AssetVisibility.Hidden,
        checksum: createHash('sha1').update(sourcePath).digest(),
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      });
      const sha256 = createHash('sha256').update('movie').digest('hex');
      const resource = await db
        .insertInto('photo_source_resource')
        .values({
          runId: f.resource.runId,
          resourceKey: 'd'.repeat(64),
          version: 'e'.repeat(64),
          checksum: Buffer.from(sha256, 'hex'),
          bytes: 5,
          assetId: motion.id,
          state: 'verified',
          verifiedAt: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const original = await db
        .selectFrom('source_original')
        .selectAll()
        .where('assetId', '=', f.asset.id)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('source_original')
        .values({ ...original, assetId: motion.id, resourceId: resource.id })
        .execute();
      await db.updateTable('asset').set({ livePhotoVideoId: motion.id }).where('id', '=', f.asset.id).execute();
      const file = {
        path: referenceOriginalPath(root, f.user.id, motion.id, motion.originalFileName),
        role: 'original',
        size: 5,
        sha256,
        mtime: null,
      };
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, 'movie');
      const reference = { resourceId: resource.id, version: resource.version, sha256 };
      if (proof !== 'omitted') {
        const details = (await new CloudBackupIndexRepository(db).getAssetDetails([motion.id])).get(motion.id)!;
        f.plan.manifest.library.assets[motion.id] = {
          ...details.record,
          details: details.details,
          owner: f.user.id,
          files: [file],
        };
        f.plan.manifest.referenceOriginals![motion.id] = {
          version: 1,
          sourcePath,
          sourceEpoch: { assetId: motion.id, ownerId: f.user.id, epoch: '0', reference },
        };
        f.plan.manifest.assetFidelity![motion.id] = await new BuddyBackupFidelityRepository(db).capture(
          motion.id,
          sha256,
          [],
          [],
        );
        f.plan.manifest.contents[sha256] = { bytes: 5, keyVersion: 1, blocks: ['d'.repeat(64)] };
        f.plan.files.push(file);
      }
      const parent = {
        assetId: f.asset.id,
        path: f.asset.originalPath,
        checksum: f.asset.checksum.toString('hex'),
        reference: { resourceId: f.resource.id, version: f.resource.version, sha256: f.file.sha256 },
      };
      const input = {
        assetId: motion.id,
        path: sourcePath,
        checksum: motion.checksum.toString('hex'),
        reference: { ...reference, sha256: proof === 'changed' ? 'f'.repeat(64) : sha256 },
      };
      const binding = { kind: 'bound', parent, input };
      const recipe = { ...defaultDevelopRecipe(), keyFrame: { timeMs: 500 } };
      const master = join(root, 'rendered.jpg');
      await writeFile(master, 'rendered');
      const masterFile = { path: master, role: 'edited', ...(await buddyFileHash(master)), mtime: null };
      f.plan.files.push(masterFile);
      f.plan.manifest.contents[masterFile.sha256] = { bytes: masterFile.size, keyVersion: 1, blocks: ['d'.repeat(64)] };
      await sql`INSERT INTO public.asset_develop_revision
      ("assetId","ownerId",revision,recipe,status,"sourceAssetId","sourceBinding","sourceChecksum","masterPath","isCurrent","renditionChecksum")
      VALUES (${f.asset.id}::uuid,${f.user.id}::uuid,1,${JSON.stringify(recipe)}::text::jsonb,'rendered',
        ${motion.id}::uuid,${JSON.stringify(binding)}::text::jsonb,${Buffer.from(sha256, 'hex')},${master},true,${Buffer.from(masterFile.sha256, 'hex')})`.execute(
        db,
      );
      const fidelity = new BuddyBackupFidelityRepository(db);
      const state = await fidelity.capture(f.asset.id, f.file.sha256, [], []);
      fidelity.bindFiles(state, new Map([[master, masterFile]]));
      switch (proof) {
        case 'unrelated': {
          await db.updateTable('asset').set({ livePhotoVideoId: null }).where('id', '=', f.asset.id).execute();
          break;
        }
        case 'trashed': {
          await db
            .updateTable('asset')
            .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
            .where('id', '=', motion.id)
            .execute();
          break;
        }
        case 'unbound': {
          state.source = { ...state.source, checksum: f.file.sha256, checksumAlgorithm: ChecksumAlgorithm.sha256File };
          state.developRevisions[0].sourceBinding = null;
          state.developRevisions[0].sourceChecksum = f.file.sha256;
          await sql`UPDATE public.asset_develop_revision SET "sourceBinding"=NULL,"sourceChecksum"=${Buffer.from(f.file.sha256, 'hex')}
          WHERE "assetId"=${f.asset.id}::uuid`.execute(db);

          break;
        }
        // No default
      }
      f.plan.manifest.assetFidelity![f.asset.id] = state;
      if (active) {
        await mkdir(StorageCore.getBaseFolder(StorageFolder.Thumbnails), { recursive: true });
        active.manifest.library.assets[motion.id] = f.plan.manifest.library.assets[motion.id];
        active.manifest.assetLinks![f.asset.id].livePhotoVideoId = motion.id;
        active.manifest.assetLinks![motion.id] = {
          isExternal: true,
          libraryId: motion.libraryId ?? null,
          livePhotoVideoId: null,
        };
        active.job.request.assetIds!.push(motion.id);
        active.job.owner.current = await active.index.getOwnerRestoreIdentities(active.job.request.assetIds!);
        active.job.owner.assetHashes[motion.id] = ownerRestoreHash(
          active.manifest.library.assets[motion.id],
          buddyLibraryForOwner(active.manifest, f.user.id),
        );
        active.job.referenceAdoptions![motion.id] = {
          assetId: motion.id,
          ownerId: f.user.id,
          type: AssetType.Video,
          source: f.plan.manifest.referenceOriginals![motion.id],
          file,
          physicalFileId: randomUUID(),
        };
        active.read.mockImplementation(async (_key, path, hash) => {
          const source = f.plan.files.find((entry) => entry.sha256 === hash)!;
          await writeFile(path, await readFile(source.path));
          return buddyFileHash(path);
        });
        await active.persist();
        const errors = vi.spyOn(active.service.logger, 'error');
        await active.worker();
        expect(errors).not.toHaveBeenCalled();
        expect(
          await new MediaOperationRepository(db).getOfKind(active.operation.id, MediaOperationKind.BuddyRestore),
        ).toMatchObject({ status: MediaOperationStatus.Completed, error: null });
      } else await restore(f.plan);
      const { rows } = await sql<{
        binding: unknown;
        isCurrent: boolean;
        sourceAssetId: string;
      }>`SELECT "sourceBinding" AS binding,"isCurrent","sourceAssetId"
      FROM public.asset_develop_revision WHERE "assetId"=${f.asset.id}::uuid`.execute(db);
      expect(rows).toEqual([
        {
          binding:
            proof === 'matching'
              ? {
                  kind: 'bound',
                  parent: { assetId: f.asset.id, path: f.file.path, checksum: f.file.sha256, reference: null },
                  input: { assetId: motion.id, path: file.path, checksum: sha256, reference: null },
                }
              : proof === 'unbound'
                ? null
                : binding,
          isCurrent: proof === 'matching',
          sourceAssetId: motion.id,
        },
      ]);
      if (!active) await restore(f.plan);
    },
  );

  it('preserves omitted offline reference metadata without reviving provider authority', async () => {
    const { ctx, user, plan } = await fixture();
    const path = `frameleaf-source://${randomUUID()}/${'f'.repeat(64)}`;
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalPath: path,
      isExternal: true,
      isOffline: true,
      deletedAt: new Date(),
    });
    await restore(plan);
    expect(
      await db
        .selectFrom('asset')
        .select(['originalPath', 'isOffline', 'deletedAt'])
        .where('id', '=', asset.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ originalPath: path, isOffline: true, deletedAt: asset.deletedAt });
  });

  it('refuses an uncaptured reference and rolls back the whole conversion', async () => {
    const { ctx, user, asset, plan } = await fixture();
    await ctx.newAsset({ ownerId: user.id, originalPath: `frameleaf-source://${randomUUID()}/${'f'.repeat(64)}` });
    await expect(restore(plan)).rejects.toThrow('uncaptured original');
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirstOrThrow())
        .originalPath,
    ).toBe(asset.originalPath);
  });

  const adoption = (f: Awaited<ReturnType<typeof fixture>>): BuddyReferenceAdoption => ({
    assetId: f.asset.id,
    ownerId: f.user.id,
    type: f.asset.type,
    source: f.plan.manifest.referenceOriginals![f.asset.id],
    file: f.file,
    physicalFileId: randomUUID(),
  });
  const adopt = (intent: BuddyReferenceAdoption) =>
    db.transaction().execute((trx) =>
      adoptBuddyReferenceOriginal(trx, intent, async () => {
        const actual = await buddyFileHash(intent.file.path);
        expect(actual).toEqual({ sha256: intent.file.sha256, size: intent.file.size });
      }),
    );

  it('reconciles committed physical identity after a lost response without charging twice', async () => {
    const f = await fixture();
    const intent = adoption(f);
    await expect(
      (async () => {
        await adopt(intent);
        throw new Error('commit response lost');
      })(),
    ).rejects.toThrow('commit response lost');
    const current = await db
      .selectFrom('asset')
      .select('physicalOriginalFileId')
      .where('id', '=', f.asset.id)
      .executeTakeFirstOrThrow();
    expect(current.physicalOriginalFileId).toBe(intent.physicalFileId);
    await expect(adopt(structuredClone(intent))).resolves.toBe('verified');
    await expect(adopt({ ...intent, physicalFileId: randomUUID() })).rejects.toThrow('physical original changed');
    expect(
      Number(
        (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', f.user.id).executeTakeFirstOrThrow())
          .quotaUsageInBytes,
      ),
    ).toBe(105);
  });

  it('does not turn an uncommitted intent into adoption authority', async () => {
    const f = await fixture();
    const intent = adoption(f);
    await expect(
      db.transaction().execute(async (trx) => {
        await adoptBuddyReferenceOriginal(trx, intent, async () => {
          await buddyFileHash(intent.file.path);
        });
        throw new Error('metadata rolled back');
      }),
    ).rejects.toThrow('metadata rolled back');
    expect(await db.selectFrom('physical_file').select('id').where('id', '=', intent.physicalFileId).execute()).toEqual(
      [],
    );
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', f.asset.id).executeTakeFirstOrThrow())
        .originalPath,
    ).toBe(f.asset.originalPath);
    expect(
      Number(
        (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', f.user.id).executeTakeFirstOrThrow())
          .quotaUsageInBytes,
      ),
    ).toBe(100);
    await expect(adopt(intent)).resolves.toBe('adopted');
  });

  it.each(['older independent original', ''])(
    'adopts explicitly selected archived bytes while fencing the current reference: %j',
    async (bytes) => {
      const f = await fixture();
      const intent = adoption(f);
      await writeFile(intent.file.path, bytes);
      const incoming = await buddyFileHash(intent.file.path);
      intent.file = { ...intent.file, ...incoming };
      await expect(adopt(intent)).resolves.toBe('adopted');
      const current = await db
        .selectFrom('asset')
        .select(['id', 'checksum', 'checksumAlgorithm'])
        .where('id', '=', f.asset.id)
        .executeTakeFirstOrThrow();
      expect(current).toEqual({
        id: f.asset.id,
        checksum: Buffer.from(incoming.sha256, 'hex'),
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
      });
    },
  );

  it('refuses a changed current version before adopting independently archived bytes', async () => {
    const f = await fixture();
    const intent = adoption(f);
    await db
      .updateTable('photo_source_resource')
      .set({ version: 'e'.repeat(64) })
      .where('id', '=', f.resource.id)
      .execute();
    await expect(adopt(intent)).rejects.toThrow('source provenance changed');
    expect(await db.selectFrom('physical_file').select('id').where('id', '=', intent.physicalFileId).execute()).toEqual(
      [],
    );
  });

  it.each(['algorithm', 'digest'] as const)('refuses a corrupt reference path identity: %s', async (change) => {
    const f = await fixture();
    await db
      .updateTable('asset')
      .set(
        change === 'algorithm' ? { checksumAlgorithm: ChecksumAlgorithm.sha1File } : { checksum: Buffer.alloc(20, 9) },
      )
      .where('id', '=', f.asset.id)
      .execute();
    await expect(restore(f.plan)).rejects.toThrow('Reference recovery source provenance changed');
    expect(await db.selectFrom('physical_file').select('id').where('path', '=', f.file.path).execute()).toEqual([]);
  });

  it('refuses changed managed byte accounting on adoption replay', async () => {
    const f = await fixture();
    await restore(f.plan);
    await db.updateTable('asset_exif').set({ fileSizeInByte: 99 }).where('assetId', '=', f.asset.id).execute();
    await expect(restore(f.plan)).rejects.toThrow('Reference recovery physical original changed');
  });

  it('refuses a changed physical record on retry', async () => {
    const { plan, file } = await fixture();
    await restore(plan);
    await db.updateTable('physical_file').set({ sizeInBytes: 99 }).where('path', '=', file.path).execute();
    await expect(restore(plan)).rejects.toThrow('physical original changed');
  });

  it.each([false, true])(
    'restores without a live provider, preserves identity/organization/trash, and retries without charging again: trash=%s',
    async (trashed) => {
      const { user, asset, album, resource, plan, file } = await fixture(trashed);
      await restore(plan);
      const restored = await db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow();
      expect(restored).toMatchObject({
        id: asset.id,
        ownerId: user.id,
        originalPath: file.path,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
        isExternal: false,
        isOffline: false,
        libraryId: null,
        isFavorite: true,
        status: asset.status,
        deletedAt: asset.deletedAt,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
      });
      expect(restored.checksum.toString('hex')).toBe(file.sha256);
      expect(await db.selectFrom('album_asset').selectAll().where('assetId', '=', asset.id).execute()).toEqual([
        expect.objectContaining({ albumId: album.id }),
      ]);
      expect(await db.selectFrom('source_original').selectAll().where('assetId', '=', asset.id).execute()).toEqual([]);
      expect(
        await db.selectFrom('photo_source_resource').select('assetId').where('id', '=', resource.id).executeTakeFirst(),
      ).toEqual({ assetId: asset.id });
      const physical = await db
        .selectFrom('physical_file')
        .selectAll()
        .where('id', '=', restored.physicalOriginalFileId!)
        .executeTakeFirstOrThrow();
      expect(physical).toMatchObject({ canonicalAssetId: asset.id, path: file.path, type: 'original' });
      expect(physical.checksum.toString('hex')).toBe(file.sha256);
      expect(Number(physical.sizeInBytes)).toBe(file.size);
      await restore(plan);
      expect(
        Number(
          (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', user.id).executeTakeFirstOrThrow())
            .quotaUsageInBytes,
        ),
      ).toBe(105);
    },
  );

  it.each(['owner', 'epoch', 'resource', 'bytes', 'closure', 'duplicate', 'physical', 'session'] as const)(
    'refuses %s conflicts atomically',
    async (kind) => {
      const { ctx, user, asset, plan, file, resource } = await fixture();
      switch (kind) {
        case 'owner': {
          const other = await ctx.newUser();
          owners.push(other.user.id);
          await db.updateTable('asset').set({ ownerId: other.user.id }).where('id', '=', asset.id).execute();
          break;
        }
        case 'epoch': {
          plan.manifest.referenceOriginals![asset.id].sourceEpoch.epoch = '1';
          break;
        }
        case 'resource': {
          await db
            .updateTable('photo_source_resource')
            .set({ version: 'e'.repeat(64) })
            .where('id', '=', resource.id)
            .execute();
          break;
        }
        case 'bytes': {
          await writeFile(file.path, 'wrong');
          break;
        }
        case 'closure': {
          plan.files = [];
          break;
        }
        case 'duplicate': {
          await ctx.newAsset({
            ownerId: user.id,
            checksum: Buffer.from(file.sha256, 'hex'),
            checksumAlgorithm: ChecksumAlgorithm.sha256File,
          });
          break;
        }
        case 'physical': {
          await db
            .insertInto('physical_file')
            .values({
              path: file.path,
              checksum: Buffer.from(file.sha256, 'hex'),
              sizeInBytes: 5,
              type: PhysicalFileType.Original,
              canonicalAssetId: null,
            })
            .execute();
          break;
        }
        case 'session': {
          await db
            .insertInto('session')
            .values({ userId: user.id, token: randomBytes(32) })
            .execute();
          break;
        }
      }
      await expect(restore(plan)).rejects.toThrow(/Reference recovery/);
      expect(
        (await db.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirstOrThrow())
          .originalPath,
      ).toBe(asset.originalPath);
      expect(
        await db.selectFrom('source_original').select('assetId').where('assetId', '=', asset.id).executeTakeFirst(),
      ).toEqual({ assetId: asset.id });
    },
  );

  it('rolls conversion and quota back if recovery authority is lost before commit', async () => {
    const { user, asset, plan, file } = await fixture();
    await expect(
      db.transaction().execute((trx) =>
        recoverBuddyReferenceOriginals(trx, plan, async () => {
          const current = await trx
            .selectFrom('asset')
            .select('originalPath')
            .where('id', '=', asset.id)
            .executeTakeFirstOrThrow();
          if (current.originalPath === file.path) throw new Error('recovery authority lost');
        }),
      ),
    ).rejects.toThrow('recovery authority lost');
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirstOrThrow())
        .originalPath,
    ).toBe(asset.originalPath);
    expect(await db.selectFrom('physical_file').select('id').where('path', '=', file.path).execute()).toEqual([]);
    expect(
      Number(
        (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', user.id).executeTakeFirstOrThrow())
          .quotaUsageInBytes,
      ),
    ).toBe(100);
  });
});
