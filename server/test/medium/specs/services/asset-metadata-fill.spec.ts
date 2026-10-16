import { Kysely, sql } from 'kysely';
import { AssetLockReason, AssetType, AssetVisibility, JobName, QueueName } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
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
      real: [AssetRepository, AccessRepository, PartnerOriginRepository, DatabaseRepository],
      mock: [JobRepository, LoggingRepository, WebsocketRepository],
    });
    const { auth, user } = await ctx.newSyncAuthUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility });
    const assets = ctx.get(AssetRepository);
    const jobs = ctx.getMock(JobRepository);
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

  it.each([
    { action: 'single', failing: 'lock' },
    { action: 'single', failing: 'override' },
    { action: 'bulk', failing: 'lock' },
    { action: 'bulk', failing: 'override' },
  ] as const)('rolls back $action sensitive metadata on $failing failure', async ({ action, failing }) => {
    const { sut, ctx, auth, user, asset, assets, jobs } = await setup();
    const { asset: sibling } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newStack({ ownerId: user.id }, [asset.id, sibling.id]);
    const { user: sharer } = await ctx.newUser();
    const origins = ctx.get(PartnerOriginRepository);
    const ids = [asset.id, sibling.id];
    for (const id of ids) {
      const { asset: source } = await ctx.newAsset({ ownerId: sharer.id });
      await origins.createAssetOrigin({
        id,
        sourceId: source.id,
        ownerId: user.id,
        rootOwnerId: sharer.id,
        partnerSharedById: sharer.id,
      });
    }
    const original = origins.markOverridden.bind(origins);
    const failure =
      failing === 'lock'
        ? vi.spyOn(assets, 'lock').mockRejectedValueOnce(new Error('metadata phase failed'))
        : vi.spyOn(origins, 'markOverridden').mockImplementationOnce(async (...args) => {
            await original(...args);
            throw new Error('metadata phase failed');
          });
    const item = { key: 'ml-enrichment', value: { nsfwDetection: { review: { isNsfw: true } } } };
    try {
      const write =
        action === 'single'
          ? sut.upsertMetadata(auth, asset.id, { items: [item] })
          : sut.upsertBulkMetadata(auth, { items: [{ assetId: asset.id, ...item }] });
      await expect(write).rejects.toThrow('metadata phase failed');
    } finally {
      failure.mockRestore();
    }
    expect(await assets.getMetadataByKey(asset.id, item.key)).toBeUndefined();
    expect(
      (await db.selectFrom('asset').select('is_nsfw').where('id', '=', asset.id).executeTakeFirstOrThrow()).is_nsfw,
    ).toBe(false);
    expect(await db.selectFrom('asset_lock').select('assetId').where('assetId', 'in', ids).execute()).toEqual([]);
    for (const id of ids) expect((await origins.getOrigin('asset', id))?.overriddenFields).toEqual([]);
    expect(jobs.queue).not.toHaveBeenCalled();
    expect(jobs.queueAll).not.toHaveBeenCalled();
  });

  it.each(['ordinary', 'unlink', 'replace'] as const)(
    'rolls back %s pairing, metadata, locks and group overrides when recording fails',
    async (action) => {
      const { sut, ctx, auth, user, asset, assets, jobs } = await setup();
      const { asset: sibling } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newStack({ ownerId: user.id }, [asset.id, sibling.id]);
      const oldMotion =
        action === 'ordinary'
          ? undefined
          : (await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, visibility: AssetVisibility.Hidden })).asset;
      const newMotion =
        action === 'replace' ? (await ctx.newAsset({ ownerId: user.id, type: AssetType.Video })).asset : undefined;
      if (oldMotion) await assets.update({ id: asset.id, livePhotoVideoId: oldMotion.id });
      const ids = [asset.id, sibling.id, ...(oldMotion ? [oldMotion.id] : []), ...(newMotion ? [newMotion.id] : [])];
      const { user: sharer } = await ctx.newUser();
      const origins = ctx.get(PartnerOriginRepository);
      for (const id of ids) {
        const { asset: source } = await ctx.newAsset({ ownerId: sharer.id });
        await origins.createAssetOrigin({
          id,
          sourceId: source.id,
          ownerId: user.id,
          rootOwnerId: sharer.id,
          partnerSharedById: sharer.id,
        });
      }
      const read = () =>
        db
          .selectFrom('asset')
          .select(['id', 'visibility', 'livePhotoVideoId'])
          .where('id', 'in', ids)
          .orderBy('id')
          .execute();
      const before = await read();
      const original = origins.markOverridden.bind(origins);
      const recording = vi.spyOn(origins, 'markOverridden').mockImplementation(async (...args) => {
        await original(...args);
        if (args[1].length > 1 && args[2].includes('visibility')) throw new Error('group override failed');
      });
      try {
        await expect(
          sut.update(auth, asset.id, {
            visibility: AssetVisibility.Locked,
            description: 'Mine',
            ...(action === 'ordinary' ? {} : { livePhotoVideoId: action === 'unlink' ? null : newMotion!.id }),
          }),
        ).rejects.toThrow('group override failed');
      } finally {
        recording.mockRestore();
      }
      expect(await read()).toEqual(before);
      expect((await assets.getById(asset.id, { exifInfo: true }))?.exifInfo).toBeNull();
      expect(await db.selectFrom('asset_lock').select('assetId').where('assetId', 'in', ids).execute()).toEqual([]);
      for (const id of ids) expect((await origins.getOrigin('asset', id))?.overriddenFields).toEqual([]);
      expect(jobs.queue).not.toHaveBeenCalled();
      expect(jobs.queueAll).not.toHaveBeenCalled();
    },
  );

  it.each(['direct', 'bulk'] as const)(
    'pins every already-locked %s group member without pinning unrelated fields',
    async (action) => {
      const { sut, ctx, auth, user, asset, assets } = await setup();
      const { asset: sibling } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newStack({ ownerId: user.id }, [asset.id, sibling.id]);
      const ids = [asset.id, sibling.id];
      await assets.lock([asset.id], AssetLockReason.Marked, user.id);
      auth.session!.hasElevatedPermission = true;
      const { user: sharer } = await ctx.newUser();
      const origins = ctx.get(PartnerOriginRepository);
      for (const id of ids) {
        const { asset: source } = await ctx.newAsset({ ownerId: sharer.id });
        await origins.createAssetOrigin({
          id,
          sourceId: source.id,
          ownerId: user.id,
          rootOwnerId: sharer.id,
          partnerSharedById: sharer.id,
        });
      }
      if (action === 'direct') await sut.lock(auth, { ids: [asset.id] });
      else await sut.updateAll(auth, { ids: [asset.id], visibility: AssetVisibility.Locked, description: 'Mine' });
      for (const id of ids) expect((await origins.getOrigin('asset', id))?.overriddenFields).toContain('visibility');
      expect((await origins.getOrigin('asset', sibling.id))?.overriddenFields).toEqual(['visibility']);
      expect((await assets.getById(sibling.id, { exifInfo: true }))?.exifInfo).toBeNull();
      if (action === 'bulk') {
        expect((await origins.getOrigin('asset', asset.id))?.overriddenFields).toContain('description');
        expect((await assets.getById(asset.id, { exifInfo: true }))?.exifInfo?.description).toBe('Mine');
      }
    },
  );

  it('waits for origin admission before entering metadata write locks', async () => {
    const { sut, ctx, auth, user, asset, assets } = await setup();
    const { user: sharer } = await ctx.newUser();
    const { asset: source } = await ctx.newAsset({ ownerId: sharer.id });
    const origins = ctx.get(PartnerOriginRepository);
    await origins.createAssetOrigin({
      id: asset.id,
      sourceId: source.id,
      ownerId: user.id,
      rootOwnerId: sharer.id,
      partnerSharedById: sharer.id,
    });
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const editing = db.transaction().execute(async (tx) => {
      // asset_origin is outside the Kysely schema; PartnerOriginRepository reads it with raw SQL too
      await sql`SELECT 1 FROM public.asset_origin WHERE "assetId" = ${asset.id}::uuid FOR UPDATE`.execute(tx);
      entered.resolve();
      await held.promise;
    });
    await entered.promise;
    const metadata = vi.spyOn(assets, 'withMetadataUpdate');
    const filling = sut.fillMissingMetadata(auth, asset.id, { description: 'Imported' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(metadata).not.toHaveBeenCalled();
    } finally {
      held.resolve();
      await Promise.allSettled([editing, filling]);
    }
    await expect(filling).resolves.toBe(true);
    expect((await assets.getById(asset.id, { exifInfo: true }))?.exifInfo?.description).toBe('Imported');
    expect((await origins.getOrigin('asset', asset.id))?.overriddenFields).toContain('description');
  });

  it.each([false, true])(
    'rolls back an ordinary edit and its Live Photo change %s when override recording fails',
    async (livePhoto) => {
      const { sut, ctx, auth, asset, assets, jobs } = await setup();
      const motion = livePhoto
        ? (await ctx.newAsset({ ownerId: auth.user.id, type: AssetType.Video, visibility: AssetVisibility.Hidden }))
            .asset
        : undefined;
      if (motion) await assets.update({ id: asset.id, livePhotoVideoId: motion.id });
      vi.spyOn(ctx.get(PartnerOriginRepository), 'markOverridden').mockRejectedValueOnce(new Error('marker failed'));
      await expect(
        sut.update(auth, asset.id, {
          description: 'Mine',
          isFavorite: true,
          ...(livePhoto && { livePhotoVideoId: null }),
        }),
      ).rejects.toThrow('marker failed');
      expect(await assets.getById(asset.id, { exifInfo: true })).toMatchObject({
        isFavorite: false,
        exifInfo: null,
        livePhotoVideoId: motion?.id ?? null,
      });
      if (motion) expect((await assets.getById(motion.id))?.visibility).toBe(AssetVisibility.Hidden);
      expect(jobs.queue).not.toHaveBeenCalled();
    },
  );

  it('rolls back a direct lock when override recording fails without publishing effects', async () => {
    const { sut, ctx, auth, asset, jobs } = await setup();
    vi.spyOn(ctx.get(PartnerOriginRepository), 'markOverridden').mockRejectedValueOnce(new Error('marker failed'));
    await expect(sut.lock(auth, { ids: [asset.id] })).rejects.toThrow('marker failed');
    expect(await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', asset.id).execute()).toEqual([]);
    expect(jobs.queueAll).not.toHaveBeenCalled();
    expect(jobs.queue).not.toHaveBeenCalled();
  });

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

  it.each([AssetVisibility.Archive, AssetVisibility.Locked])(
    'rolls back bulk metadata and %s when override recording fails',
    async (visibility) => {
      const { sut, ctx, auth, asset, assets, jobs } = await setup();
      const { asset: second } = await ctx.newAsset({ ownerId: auth.user.id });
      const ids = [asset.id, second.id];
      vi.spyOn(ctx.get(PartnerOriginRepository), 'markOverridden').mockRejectedValueOnce(new Error('marker failed'));
      await expect(sut.updateAll(auth, { ids, description: 'Mine', isFavorite: true, visibility })).rejects.toThrow(
        'marker failed',
      );
      for (const id of ids) {
        expect(await assets.getById(id, { exifInfo: true })).toMatchObject({
          isFavorite: false,
          visibility: AssetVisibility.Timeline,
          exifInfo: null,
        });
      }
      expect(await db.selectFrom('asset_lock').select('assetId').where('assetId', 'in', ids).execute()).toEqual([]);
      expect(jobs.queueAll).not.toHaveBeenCalled();
    },
  );

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
