import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import type { CloudBackupRestoreSnapshot } from 'src/services/cloud-backup-restore.js';
import {
  AssetStatus,
  ChecksumAlgorithm,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  SystemMetadataKey,
} from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});

afterAll(async () => {
  await database?.destroy();
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  const index = new CloudBackupIndexRepository(database);
  const operations = new MediaOperationRepository(database);
  const metadata = new SystemMetadataRepository(database);
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const { session } = await ctx.newSession({ userId: user.id, pinExpiresAt: new Date(Date.now() + 60_000) });
  const owner = { ownerId: user.id, sessionId: session.id };
  const identity = {
    bucketRef: 'https://s3.example.test/owned',
    keyFingerprint: 'a'.repeat(64),
    manifestKey: `m/${randomUUID()}.json.gz`,
  };
  await metadata.set(SystemMetadataKey.FrameleafCloudBackup, { ...identity, target: 'byo-s3' } as never);
  const config = {
    frameleafCloud: {
      cloudBackup: {
        enabled: true,
        target: 'byo-s3' as const,
        s3: { endpoint: 'https://s3.example.test', bucket: 'owned' },
      },
    },
  };
  await metadata.withConfigTransaction((bound) => bound.set(SystemMetadataKey.SystemConfig, config));
  const manifest = await index.createManifest({
    bucket: identity.bucketRef,
    key: identity.manifestKey,
    operationId: randomUUID(),
  });
  await index.finishManifest(manifest.id, { status: 'complete' });
  const operation = await operations.create({
    ownerId: user.id,
    kind: MediaOperationKind.CloudRestore,
    destination: MediaOperationDestination.Local,
    label: 'owner restore fixture',
    snapshot: {},
    settings: {},
  });
  const claimed = (await operations.claimNext({
    kinds: [MediaOperationKind.CloudRestore],
    workerId: 'owner-restore-fixture',
    leaseMs: 60_000,
  }))!;
  expect(claimed.operation.id).toBe(operation.id);
  await operations.reportProgress(operation.id, claimed.claimToken, {
    status: MediaOperationStatus.Rendering,
    processedUnits: 0,
    totalUnits: null,
    progress: 0,
  });
  const lease = { operationId: operation.id, claimToken: claimed.claimToken };
  const run = (callback = (_trx: Kysely<DB>) => Promise.resolve('published')) =>
    index.withOwnerRestore(owner, identity, asset.id, lease, callback);
  return { ctx, index, metadata, config, asset, user, session, manifest, operation, owner, identity, lease, run };
};

afterEach(async () => {
  await database.deleteFrom('media_operation').execute();
});

describe('owner restore current publication authority (FL-234)', () => {
  it('uses real session/kept/config/lease authority and rolls back local metadata on failure', async () => {
    const { run, asset } = await setup();
    await expect(
      run(async (trx) => {
        await trx.updateTable('asset').set({ isFavorite: true }).where('id', '=', asset.id).execute();
        throw new Error('publication fixture failed');
      }),
    ).rejects.toThrow('publication fixture failed');
    expect(
      await database.selectFrom('asset').select('isFavorite').where('id', '=', asset.id).executeTakeFirst(),
    ).toEqual({ isFavorite: false });
    await expect(run()).resolves.toBe('published');
  });

  it.each([
    'wrong-kind',
    'cancelled',
    'stale-claim',
    'expired-claim',
    'relocked',
    'revoked-session',
    'pruned',
    'disabled',
    'changed-target',
    'changed-bucket',
    'changed-key',
  ] as const)('refuses %s before publication', async (failure) => {
    const fixture = await setup();
    const { operation, lease, session, manifest, metadata, config, identity, run } = fixture;
    switch (failure) {
      case 'wrong-kind': {
        await database
          .updateTable('media_operation')
          .set({ kind: MediaOperationKind.CloudBackup })
          .where('id', '=', operation.id)
          .execute();
        break;
      }
      case 'cancelled': {
        await database
          .updateTable('media_operation')
          .set({ cancelRequestedAt: new Date() })
          .where('id', '=', operation.id)
          .execute();
        break;
      }
      case 'stale-claim': {
        lease.claimToken = randomUUID();
        break;
      }
      case 'expired-claim': {
        await database
          .updateTable('media_operation')
          .set({ claimExpiresAt: new Date(0) })
          .where('id', '=', operation.id)
          .execute();
        break;
      }
      case 'relocked': {
        await database.updateTable('session').set({ pinExpiresAt: null }).where('id', '=', session.id).execute();
        break;
      }
      case 'revoked-session': {
        await database.deleteFrom('session').where('id', '=', session.id).execute();
        break;
      }
      case 'pruned': {
        await database.deleteFrom('cloud_backup_manifest').where('id', '=', manifest.id).execute();
        break;
      }
      case 'disabled': {
        await metadata.withConfigTransaction((bound) =>
          bound.set(SystemMetadataKey.SystemConfig, {
            frameleafCloud: { cloudBackup: { ...config.frameleafCloud.cloudBackup, enabled: false } },
          }),
        );
        break;
      }
      case 'changed-target': {
        await metadata.withConfigTransaction((bound) =>
          bound.set(SystemMetadataKey.SystemConfig, {
            frameleafCloud: { cloudBackup: { ...config.frameleafCloud.cloudBackup, target: 'off' } },
          }),
        );
        break;
      }
      case 'changed-bucket': {
        await metadata.withConfigTransaction((bound) =>
          bound.set(SystemMetadataKey.SystemConfig, {
            frameleafCloud: {
              cloudBackup: {
                ...config.frameleafCloud.cloudBackup,
                s3: { ...config.frameleafCloud.cloudBackup.s3, bucket: 'replacement' },
              },
            },
          }),
        );
        break;
      }
      case 'changed-key': {
        await metadata.set(SystemMetadataKey.FrameleafCloudBackup, {
          ...identity,
          target: 'byo-s3',
          keyFingerprint: 'b'.repeat(64),
        } as never);
        break;
      }
    }
    const publish = vi.fn().mockResolvedValue('published');
    await expect(run(publish)).rejects.toThrow('Owner restore');
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['changed-owner', 'foreign-library', 'deleted-library'] as const)(
    'refuses %s before publication',
    async (failure) => {
      const { ctx, asset, user, run } = await setup();
      const { user: foreign } = await ctx.newUser();
      if (failure === 'changed-owner') {
        await database.updateTable('asset').set({ ownerId: foreign.id }).where('id', '=', asset.id).execute();
      } else {
        const library = await database
          .insertInto('library')
          .values({
            name: 'authority fixture',
            ownerId: failure === 'foreign-library' ? foreign.id : user.id,
            importPaths: [],
            exclusionPatterns: [],
            deletedAt: failure === 'deleted-library' ? new Date() : null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await database.updateTable('asset').set({ libraryId: library.id }).where('id', '=', asset.id).execute();
      }
      const publish = vi.fn().mockResolvedValue('published');
      await expect(run(publish)).rejects.toThrow('Owner restore');
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it('keeps current config stable against its existing UPDATE path for the local publication only', async () => {
    const { run } = await setup();
    await run(async () => {
      await expect(
        database.transaction().execute(async (trx) => {
          await sql`SET LOCAL lock_timeout = '50ms'`.execute(trx);
          await new SystemMetadataRepository(trx).withConfigTransaction((bound) =>
            bound.set(SystemMetadataKey.SystemConfig, {}),
          );
        }),
      ).rejects.toThrow(/lock timeout/);
      return 'published';
    });
  });

  it('refuses another owner original at the destination before invoking the filesystem publisher', async () => {
    const { ctx, user, asset } = await setup();
    const { user: foreign } = await ctx.newUser();
    await ctx.newAsset({ ownerId: foreign.id, originalPath: asset.originalPath });
    const publish = vi.fn().mockResolvedValue('written');
    await expect(
      new PhysicalFileRepository(database).withOwnerRestorePath(asset.originalPath, asset.id, user.id, publish),
    ).rejects.toThrow('destination unavailable');
    expect(publish).not.toHaveBeenCalled();
  });
});

it('refuses a contended Buddy publication and rechecks authority after the contender releases its row', async () => {
  const { index, asset, operation, owner, identity, lease } = await setup();
  await database
    .updateTable('media_operation')
    .set({ kind: MediaOperationKind.BuddyRestore })
    .where('id', '=', operation.id)
    .execute();
  const publish = vi.fn().mockResolvedValue('published');
  const run = () => index.withOwnerRestore(owner, identity, asset.id, lease, publish, { authorize: async () => {} });
  const { promise: held, resolve: locked } = Promise.withResolvers<void>();
  const { promise: done, resolve: release } = Promise.withResolvers<void>();
  const contender = database.transaction().execute(async (trx) => {
    await trx.updateTable('asset').set({ isFavorite: false }).where('id', '=', asset.id).execute();
    locked();
    await done;
  });
  try {
    await held;
    await expect(run()).rejects.toMatchObject({ code: '55P03' });
    expect(publish).not.toHaveBeenCalled();
  } finally {
    release();
    await contender;
  }
  await expect(run()).resolves.toBe('published');
  expect(publish).toHaveBeenCalledTimes(1);
  await database.updateTable('session').set({ pinExpiresAt: null }).where('id', '=', owner.sessionId).execute();
  await expect(run()).rejects.toThrow('Owner restore authorization unavailable');
  expect(publish).toHaveBeenCalledTimes(1);
});

describe('current owner restore source identity', () => {
  const changeLifecycle = (f: Awaited<ReturnType<typeof setup>>) =>
    database.transaction().execute(async (tx) => {
      for (const status of [AssetStatus.Trashed, AssetStatus.Active] as const) {
        await tx
          .updateTable('asset')
          .set({ status, deletedAt: status === AssetStatus.Trashed ? new Date() : null })
          .where('id', '=', f.asset.id)
          .execute();
        await new AssetLocalEffectRepository(tx).append(tx, f.user.id, randomUUID(), {
          origin: { kind: status === AssetStatus.Trashed ? 'trash' : 'restore' },
          assets: [{ assetId: f.asset.id, status, revoke: status === AssetStatus.Trashed }],
          stacks: [],
        });
      }
    });
  const reference = async () => {
    const f = await setup();
    const device = (await new DesktopDeviceRepository(database).enroll({
      userId: f.user.id,
      installationId: randomUUID(),
      publicKey: Buffer.alloc(32, 7).toString('base64'),
      name: 'Offline desktop',
      platform: 'linux',
      architecture: 'x86_64',
      mode: 'client-worker',
      state: 'revoked',
    }))!;
    const { session: photo } = await f.ctx.newSession({ userId: f.user.id });
    const source = await database
      .insertInto('photo_source')
      .values({
        ownerId: f.user.id,
        deviceId: device.id,
        photoSessionId: photo.id,
        kind: 'folder',
        mode: 'copy',
        name: 'Snapshot provenance',
        scopeFingerprint: 'a'.repeat(64),
        revokedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await sql`UPDATE photo_source SET mode='reference' WHERE id=${source.id}::uuid`.execute(database);
    const run = await database
      .insertInto('photo_source_run')
      .values({ sourceId: source.id, maxBytes: 10, maxItems: 1 })
      .returningAll()
      .executeTakeFirstOrThrow();
    const resource = await database
      .insertInto('photo_source_resource')
      .values({
        runId: run.id,
        resourceKey: 'b'.repeat(64),
        version: 'c'.repeat(64),
        checksum: Buffer.alloc(32, 8),
        bytes: 5,
        state: 'verified',
        verifiedAt: new Date(),
        assetId: f.asset.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const library = await new LibraryRepository(database).create({
      ownerId: f.user.id,
      name: 'Reference metadata',
      readOnly: true,
      importPaths: [],
      exclusionPatterns: [],
    });
    const path = `frameleaf-source://${source.id}/${resource.resourceKey}`;
    await database
      .updateTable('asset')
      .set({
        originalPath: path,
        checksum: createHash('sha1').update(path).digest(),
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
        isExternal: true,
        libraryId: library.id,
      })
      .where('id', '=', f.asset.id)
      .execute();
    await database
      .insertInto('source_original')
      .values({
        assetId: f.asset.id,
        resourceId: resource.id,
        scopeFingerprint: source.scopeFingerprint,
        authorizationEpoch: device.authorizationEpoch,
      })
      .execute();
    const current = await f.index.getOwnerRestoreIdentities([f.asset.id]);
    const owner: NonNullable<CloudBackupRestoreSnapshot['owner']> = { ...f.owner, current, assetHashes: {} };
    const identity = { ...f.identity, owner };
    const publish = vi.fn().mockResolvedValue('published');
    const restore = () => f.index.withOwnerRestore(f.owner, identity, f.asset.id, f.lease, publish);
    return { ...f, source, resource, photo, identity, publish, restore };
  };

  it('freezes recorded identity without borrowing permission from an offline or revoked source', async () => {
    const f = await reference();
    await database.deleteFrom('session').where('id', '=', f.photo.id).execute();
    expect(f.identity.owner.current[f.asset.id]).toMatchObject({
      sourceEpoch: '0',
      sourceReference: {
        resourceId: f.resource.id,
        version: f.resource.version,
        sha256: f.resource.checksum.toString('hex'),
      },
    });
    await expect(f.restore()).resolves.toBe('published');
  });

  it.each(['version', 'sha256', 'lifecycle', 'binding'] as const)(
    'refuses a changed %s before the owner callback',
    async (change) => {
      const f = await reference();
      const before = f.identity.owner.current[f.asset.id];
      switch (change) {
        case 'version': {
          await database
            .updateTable('photo_source_resource')
            .set({ version: 'd'.repeat(64) })
            .where('id', '=', f.resource.id)
            .execute();
          break;
        }
        case 'sha256': {
          await database
            .updateTable('photo_source_resource')
            .set({ checksum: Buffer.alloc(32, 9) })
            .where('id', '=', f.resource.id)
            .execute();
          break;
        }
        case 'lifecycle': {
          await changeLifecycle(f);
          break;
        }
        case 'binding': {
          await database.deleteFrom('source_original').where('assetId', '=', f.asset.id).execute();
          break;
        }
      }
      const current = (await f.index.getOwnerRestoreIdentities([f.asset.id]))[f.asset.id];
      expect(current.originalPath).toBe(before.originalPath);
      expect(current.checksum).toBe(before.checksum);
      await expect(f.restore()).rejects.toThrow('Owner restore source changed');
      expect(f.publish).not.toHaveBeenCalled();
    },
  );

  it('holds source provenance before asset publication and refuses contention without waiting', async () => {
    const f = await reference();
    await f.index.withOwnerRestore(f.owner, f.identity, f.asset.id, f.lease, async () => {
      await expect(
        database
          .transaction()
          .execute((tx) =>
            tx.selectFrom('photo_source').select('id').where('id', '=', f.source.id).forUpdate().noWait().execute(),
          ),
      ).rejects.toMatchObject({ code: '55P03' });
      await expect(
        database.transaction().execute((tx) => {
          return tx
            .selectFrom('photo_source_resource')
            .select('id')
            .where('id', '=', f.resource.id)
            .forUpdate()
            .noWait()
            .execute();
        }),
      ).rejects.toMatchObject({ code: '55P03' });
    });
    const { promise: held, resolve: locked } = Promise.withResolvers<void>();
    const { promise: done, resolve: release } = Promise.withResolvers<void>();
    const contender = database.transaction().execute(async (tx) => {
      await tx.selectFrom('photo_source').select('id').where('id', '=', f.source.id).forUpdate().execute();
      locked();
      await done;
    });
    try {
      await held;
      await expect(f.restore()).rejects.toMatchObject({ code: '55P03' });
      expect(f.publish).not.toHaveBeenCalled();
    } finally {
      release();
      await contender;
    }
    await expect(f.restore()).resolves.toBe('published');
  });

  it('permits legacy managed snapshots only while their lifecycle remains unchanged', async () => {
    const f = await setup();
    const current: NonNullable<CloudBackupRestoreSnapshot['owner']>['current'] =
      await f.index.getOwnerRestoreIdentities([f.asset.id]);
    delete current[f.asset.id].sourceEpoch;
    delete current[f.asset.id].sourceReference;
    const identity = { ...f.identity, owner: { ...f.owner, current, assetHashes: {} } };
    await expect(
      f.index.withOwnerRestore(f.owner, identity, f.asset.id, f.lease, () => Promise.resolve('published')),
    ).resolves.toBe('published');
    await changeLifecycle(f);
    const publish = vi.fn();
    await expect(f.index.withOwnerRestore(f.owner, identity, f.asset.id, f.lease, publish)).rejects.toThrow(
      'Owner restore source changed',
    );
    expect(publish).not.toHaveBeenCalled();
  });
});
