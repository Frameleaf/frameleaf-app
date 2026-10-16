import { Kysely } from 'kysely';
import { AssetVisibility, JobName, QueueName } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe('Matched import metadata fills', () => {
  let db: Kysely<DB>;
  beforeEach(async () => {
    db = await getKyselyDB();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.destroy();
  });

  const setup = async (visibility = AssetVisibility.Timeline) => {
    const { sut, ctx } = newMediumService(AssetService, {
      database: db,
      real: [AssetRepository, AccessRepository],
      mock: [JobRepository, LoggingRepository, PartnerOriginRepository, WebsocketRepository],
    });
    const { auth, user } = await ctx.newSyncAuthUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility });
    const assets = ctx.get(AssetRepository);
    const jobs = ctx.getMock(JobRepository);
    ctx.getMock(PartnerOriginRepository).getIdsWithFollowers.mockResolvedValue([]);
    // Exercise real transactional job persistence; worker dispatch is a separate qualification gate.
    jobs.queueInTransaction.mockImplementation(async (tx, item) => {
      await new SqlQueueStore(tx).enqueue([
        {
          name: item.name,
          data: { ...item.data },
          queue: item.name === JobName.SidecarWrite ? QueueName.Sidecar : QueueName.BackgroundTask,
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 60_000,
        },
      ]);
    });
    return { sut, ctx, auth, user, asset, assets, jobs };
  };

  it('fills an absent EXIF row and commits metadata locks with its sidecar job', async () => {
    const { sut, auth, asset, assets } = await setup();
    await sut.fillMissingMetadata(auth, asset.id, {
      description: 'From Google',
      latitude: 0,
      longitude: 2,
      isFavorite: true,
    });
    expect(await assets.getById(asset.id, { exifInfo: true })).toMatchObject({
      isFavorite: true,
      exifInfo: {
        description: 'From Google',
        latitude: 0,
        longitude: 2,
        lockedProperties: expect.arrayContaining(['description', 'latitude', 'longitude']),
      },
    });
    const jobs = await db.selectFrom('job').select(['name', 'data']).execute();
    expect(jobs).toContainEqual({ name: JobName.SidecarWrite, data: { id: asset.id } });
  });

  it('preserves description and coordinates committed after the earlier missing-field snapshot', async () => {
    const { sut, auth, asset, assets, jobs } = await setup();
    expect((await assets.getById(asset.id, { exifInfo: true }))?.exifInfo).toBeNull();
    await assets.upsertExif({
      lockedPropertiesBehavior: 'override',
      exif: { assetId: asset.id, description: 'Mine', latitude: 5, longitude: 6 },
    });
    await sut.fillMissingMetadata(auth, asset.id, { description: 'From Google', latitude: 1, longitude: 2 });
    expect((await assets.getById(asset.id, { exifInfo: true }))?.exifInfo).toMatchObject({
      description: 'Mine',
      latitude: 5,
      longitude: 6,
    });
    expect(jobs.queueInTransaction).not.toHaveBeenCalled();
  });

  it('rolls back metadata and favorite when durable sidecar admission fails, then fills on retry', async () => {
    const { sut, auth, asset, assets, jobs } = await setup();
    jobs.queueInTransaction.mockRejectedValueOnce(new Error('queue admission failed'));
    await expect(
      sut.fillMissingMetadata(auth, asset.id, {
        description: 'From Google',
        isFavorite: true,
      }),
    ).rejects.toThrow('queue admission failed');
    expect(await assets.getById(asset.id, { exifInfo: true })).toMatchObject({ isFavorite: false, exifInfo: null });
    expect(await db.selectFrom('job').select('id').execute()).toEqual([]);
    await sut.fillMissingMetadata(auth, asset.id, { description: 'From Google', isFavorite: true });
    expect((await assets.getById(asset.id, { exifInfo: true }))?.exifInfo?.description).toBe('From Google');
    expect(await db.selectFrom('job').select('id').execute()).toHaveLength(1);
  });

  it.each(['Locked', 'deleted', 'foreign'])('does not mutate freshly %s media', async (state) => {
    const { sut, auth, asset, assets, jobs } = await setup(
      state === 'Locked' ? AssetVisibility.Locked : AssetVisibility.Timeline,
    );
    if (state === 'deleted') await assets.update({ id: asset.id, deletedAt: new Date() });
    else if (state === 'foreign') auth.user.id = (await setup()).user.id;
    if (state === 'Locked')
      expect(await sut.fillMissingMetadata(auth, asset.id, { description: 'From Google' })).toBe(false);
    else
      await expect(sut.fillMissingMetadata(auth, asset.id, { description: 'From Google' })).rejects.toThrow(
        'Asset not found',
      );
    expect((await assets.getById(asset.id, { exifInfo: true }))?.exifInfo).toBeNull();
    expect(jobs.queueInTransaction).not.toHaveBeenCalled();
  });

  it('refuses an ordinary writer holding an existing EXIF row, then preserves its committed edit', async () => {
    const { sut, auth, asset, assets } = await setup();
    await assets.upsertExif({ lockedPropertiesBehavior: 'override', exif: { assetId: asset.id, description: '' } });
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('asset_exif').set({ description: 'Mine' }).where('assetId', '=', asset.id).execute();
      await expect(sut.fillMissingMetadata(auth, asset.id, { description: 'From Google' })).rejects.toThrow(
        'retry the update',
      );
    });
    await sut.fillMissingMetadata(auth, asset.id, { description: 'From Google' });
    expect((await assets.getById(asset.id, { exifInfo: true }))?.exifInfo?.description).toBe('Mine');
  });

  it('refuses a concurrent first EXIF insert through its parent FK lock', async () => {
    const { sut, auth, asset, assets } = await setup();
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('asset_exif').values({ assetId: asset.id, description: 'Mine' }).execute();
      await expect(sut.fillMissingMetadata(auth, asset.id, { description: 'From Google' })).rejects.toThrow(
        'retry the update',
      );
    });
    await sut.fillMissingMetadata(auth, asset.id, { description: 'From Google' });
    expect((await assets.getById(asset.id, { exifInfo: true }))?.exifInfo?.description).toBe('Mine');
  });

  it('keeps first-insert contention retryable without overwriting a committed manual edit', async () => {
    const { sut, auth, asset, assets } = await setup();
    const started = Promise.withResolvers<void>();
    let writer!: Promise<PromiseSettledResult<void>>;
    const manual = () =>
      db.transaction().execute(async (tx) => {
        started.resolve();
        await new AssetRepository(tx).upsertExif({
          lockedPropertiesBehavior: 'override',
          exif: { assetId: asset.id, description: 'Mine' },
        });
      });
    const result = await Promise.allSettled([
      assets.withMetadataUpdate(asset.id, async (bound) => {
        writer = manual()
          .then(() => ({ status: 'fulfilled' as const, value: undefined }))
          .catch((error) => ({ status: 'rejected' as const, reason: error }));
        await started.promise;
        await bound.upsertExif({
          lockedPropertiesBehavior: 'override',
          exif: { assetId: asset.id, description: 'From Google' },
        });
      }),
    ]);
    const written = await writer;
    expect(result[0].status === 'fulfilled' || written.status === 'fulfilled').toBe(true);
    if (result[0].status === 'rejected') expect(result[0].reason.message).toContain('retry the update');
    if (written.status === 'rejected') {
      expect(written.reason.code).toBe('40P01');
      await manual();
    }
    await sut.fillMissingMetadata(auth, asset.id, { description: 'From Google' });
    expect((await assets.getById(asset.id, { exifInfo: true }))?.exifInfo?.description).toBe('Mine');
  });
});
