import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus, SystemMetadataKey } from 'src/enum.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
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
