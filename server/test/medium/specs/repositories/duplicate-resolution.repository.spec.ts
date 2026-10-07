import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetType, JobName, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { QueueExecution } from 'src/queue/types.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DuplicateDecisionRepository } from 'src/repositories/duplicate-decision.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const duplicateId = randomUUID();
  const assets = new AssetRepository(db);
  await assets.updateAll([asset.id], { duplicateId });
  return {
    ctx,
    user,
    asset,
    duplicateId,
    assets,
    duplicates: new DuplicateRepository(db),
    develop: new AssetDevelopRepository(db),
  };
};

it('proves motion by owner and content identifier, then undoes only its own still link', async () => {
  const { ctx, user, asset: keeper, duplicateId, assets, duplicates } = await setup();
  await assets.update({ id: keeper.id, originalFileName: 'capture.HEIC' });
  const { asset: motion } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
  const { asset: jpeg } = await ctx.newAsset({ ownerId: user.id, duplicateId, livePhotoVideoId: motion.id });
  for (const id of [keeper.id, motion.id, jpeg.id]) {
    await db.insertInto('asset_exif').values({ assetId: id, livePhotoCID: 'consented-test-pair' }).execute();
  }
  expect(await duplicates.findMotionTransfer(user.id, keeper.id, [jpeg.id])).toBe(motion.id);
  await db.updateTable('asset_exif').set({ livePhotoCID: 'different-pair' }).where('assetId', '=', jpeg.id).execute();
  expect(await duplicates.findMotionTransfer(user.id, keeper.id, [jpeg.id])).toBeUndefined();
  await db
    .updateTable('asset_exif')
    .set({ livePhotoCID: 'consented-test-pair' })
    .where('assetId', '=', jpeg.id)
    .execute();
  await assets.update({ id: keeper.id, livePhotoVideoId: motion.id });
  const decisions = new DuplicateDecisionRepository(db);
  expect(await decisions.restoreKeeperMotion(user.id, keeper.id, motion.id)).toBe(true);
  expect(await assets.getById(keeper.id)).toMatchObject({ livePhotoVideoId: null });
  expect(await assets.getById(jpeg.id)).toMatchObject({ livePhotoVideoId: motion.id });
  expect(await decisions.restoreKeeperMotion(user.id, keeper.id, motion.id)).toBe(false);
});

it('undo cannot clear the surviving motion reference while the protecting still is permanently deleted', async () => {
  const { ctx, user, asset: keeper, assets } = await setup();
  const { asset: motion } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
  const { asset: original } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: motion.id });
  await assets.update({ id: keeper.id, livePhotoVideoId: motion.id });
  const { promise: locked, resolve: entered } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const deletion = db.transaction().execute(async (tx) => {
    await tx.deleteFrom('asset').where('id', '=', original.id).execute();
    entered();
    await gate;
  });
  await locked;
  const undo = new DuplicateDecisionRepository(db)
    .restoreKeeperMotion(user.id, keeper.id, motion.id)
    .then((restored) => (restored ? 'cleared' : 'refused'))
    .catch(() => 'refused');
  try {
    await expect
      .poll(async () => {
        const { rows } = await sql<{
          waiting: boolean;
        }>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"asset"%for update%') AS waiting`.execute(
          db,
        );
        return rows[0].waiting;
      })
      .toBe(true);
  } finally {
    release();
  }
  await deletion;
  expect(await undo).toBe('refused');
  expect(await assets.getById(keeper.id)).toMatchObject({ livePhotoVideoId: motion.id });
  expect(await assets.getById(motion.id)).toBeDefined();
});

it.each(['foreign-owner', 'missing-video-cid', 'deleted-video', 'multiple-clips'])(
  'requires review for incomplete motion proof (%s)',
  async (fault) => {
    const { ctx, user, asset: keeper, duplicateId, assets, duplicates } = await setup();
    await assets.update({ id: keeper.id, originalFileName: 'capture.HIF' });
    const { asset: motion } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
    const { asset: jpeg } = await ctx.newAsset({ ownerId: user.id, duplicateId, livePhotoVideoId: motion.id });
    for (const id of [keeper.id, motion.id, jpeg.id]) {
      await db.insertInto('asset_exif').values({ assetId: id, livePhotoCID: 'test-pair' }).execute();
    }
    const trashIds = [jpeg.id];
    switch (fault) {
      case 'foreign-owner': {
        const { user: other } = await ctx.newUser();
        await assets.update({ id: motion.id, ownerId: other.id });

        break;
      }
      case 'missing-video-cid': {
        await db.updateTable('asset_exif').set({ livePhotoCID: null }).where('assetId', '=', motion.id).execute();

        break;
      }
      case 'deleted-video': {
        await assets.update({ id: motion.id, deletedAt: new Date() });

        break;
      }
      default: {
        const { asset: otherMotion } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
        const { asset: otherCopy } = await ctx.newAsset({
          ownerId: user.id,
          duplicateId,
          livePhotoVideoId: otherMotion.id,
        });
        trashIds.push(otherCopy.id);
      }
    }
    expect(await duplicates.findMotionTransfer(user.id, keeper.id, trashIds)).toBeUndefined();
    expect(await assets.getById(keeper.id)).toMatchObject({ livePhotoVideoId: null });
  },
);

it('rolls metadata and disposal back together across participating repositories', async () => {
  const { asset, duplicateId, assets, duplicates } = await setup();
  await expect(
    duplicates.withResolutionLock(duplicateId, async () => {
      await assets.updateAll([asset.id], { isFavorite: true, deletedAt: new Date(), duplicateId: null });
      throw new Error('abort decision');
    }),
  ).rejects.toThrow('abort decision');
  expect(await assets.getById(asset.id)).toMatchObject({ isFavorite: false, deletedAt: null, duplicateId });
});

it('a save racing with disposal cannot create an edit after its asset is trashed', async () => {
  const { user, asset, duplicateId, assets, duplicates, develop } = await setup();
  const { promise: locked, resolve: entered } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const disposal = duplicates.withResolutionLock(duplicateId, async () => {
    entered();
    await gate;
    await assets.updateAll([asset.id], { deletedAt: new Date(), duplicateId: null });
  });
  await locked;
  const save = develop.create({
    assetId: asset.id,
    ownerId: user.id,
    recipe: defaultDevelopRecipe(),
    recipeVersion: 1,
    label: null,
    status: AssetDevelopRevisionStatus.Saved,
  });
  const outcome = save.then(() => 'saved').catch(() => 'refused');
  try {
    await expect
      .poll(async () => {
        const { rows } = await sql<{
          waiting: boolean;
        }>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%') AS waiting`.execute(
          db,
        );
        return rows[0].waiting;
      })
      .toBe(true);
  } finally {
    release();
  }
  await disposal;
  expect(await outcome).toBe('refused');
  expect(await develop.getAssetIdsWithHistory([asset.id])).toEqual(new Set());
});

it.each([AssetType.Image, AssetType.Video])('refuses a legacy %s save admitted before disposal', async (type) => {
  const { asset, duplicateId, assets, duplicates } = await setup();
  await assets.updateAll([asset.id], { type });
  const { promise: locked, resolve: entered } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const disposal = duplicates.withResolutionLock(duplicateId, async () => {
    entered();
    await gate;
    await assets.updateAll([asset.id], { deletedAt: new Date(), duplicateId: null });
  });
  await locked;
  const edits = new AssetEditRepository(db);
  const outcome = edits
    .replaceAll(asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }])
    .then(() => 'saved')
    .catch(() => 'refused');
  try {
    await expect
      .poll(async () => {
        const { rows } = await sql<{
          waiting: boolean;
        }>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"asset"%for update%') AS waiting`.execute(
          db,
        );
        return rows[0].waiting;
      })
      .toBe(true);
  } finally {
    release();
  }
  await disposal;
  expect(await outcome).toBe('refused');
  expect(await db.selectFrom('asset_edit').select('id').where('assetId', '=', asset.id).execute()).toEqual([]);
  expect(await new AssetDevelopRepository(db).getAssetIdsWithHistory([asset.id])).toEqual(new Set());
});

it('commits lifecycle work with disposal and rolls it back with a failed decision', async () => {
  const { user, asset, duplicateId, assets, duplicates } = await setup();
  const jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
  jobs['handlers'][JobName.DuplicateResolutionLifecycle] = { queueName: QueueName.BackgroundTask } as never;
  await jobs['store'].initialize([QueueName.BackgroundTask]);
  const data = { id: randomUUID(), userId: user.id, sidecarIds: [], lockedIds: [], trashIds: [asset.id], force: false };
  await expect(
    duplicates.withResolutionLock(duplicateId, async (tx) => {
      await assets.updateAll([asset.id], { deletedAt: new Date() });
      await jobs.queueInTransaction(tx, { name: JobName.DuplicateResolutionLifecycle, data });
      throw new Error('abort decision');
    }),
  ).rejects.toThrow('abort decision');
  const queued = () =>
    sql<{
      id: string;
    }>`SELECT id FROM job WHERE name=${JobName.DuplicateResolutionLifecycle} AND data->>'id'=${data.id}`.execute(db);
  expect((await queued()).rows).toEqual([]);
  await duplicates.withResolutionLock(duplicateId, async (tx) => {
    await assets.updateAll([asset.id], { deletedAt: new Date(), duplicateId: null });
    await jobs.queueInTransaction(tx, { name: JobName.DuplicateResolutionLifecycle, data });
  });
  expect((await queued()).rows).toHaveLength(1);
  expect(await assets.getById(asset.id)).toMatchObject({ deletedAt: expect.any(Date) });
});

it.each([false, true])(
  'fences a queue-owned decision before commit and retains cleanup afterward (expired=%s)',
  async (expired) => {
    const { user, asset, duplicateId, assets, duplicates } = await setup();
    const jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    const queue = `duplicate-owner-${randomUUID()}`;
    const workerId = randomUUID();
    jobs['handlers'][JobName.ImageDescriptionQueueAll] = { queueName: queue } as never;
    jobs['handlers'][JobName.DuplicateResolutionLifecycle] = { queueName: QueueName.BackgroundTask } as never;
    await jobs['store'].initialize([queue, QueueName.BackgroundTask], workerId);
    await jobs.queue({ name: JobName.ImageDescriptionQueueAll, data: {} });
    const [claim] = await jobs['store'].claim(queue, workerId);
    if (expired) {
      await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${claim.id}::uuid`.execute(db);
    }
    const context: QueueExecution = {
      claim,
      signal: new AbortController().signal,
      progress: () => {},
      progressUnits: 0,
      followups: [],
      adoptions: [],
      buffering: true,
    };
    const data = {
      id: randomUUID(),
      userId: user.id,
      sidecarIds: [],
      lockedIds: [],
      trashIds: [asset.id],
      force: false,
    };
    const decision = queueExecution.run(context, () =>
      duplicates.withResolutionLock(duplicateId, async (tx) => {
        await assets.updateAll([asset.id], { deletedAt: new Date(), duplicateId: null });
        await jobs.queueInTransaction(tx, { name: JobName.DuplicateResolutionLifecycle, data });
      }),
    );
    const receipt = () =>
      sql<{
        parentId: string | null;
        runId: string | null;
        state: string;
      }>`select "parentId", "runId", state from job where name = ${JobName.DuplicateResolutionLifecycle} and data->>'id' = ${data.id}`.execute(
        db,
      );
    if (expired) {
      await expect(decision).rejects.toThrow('Duplicate decision lost its claim');
      expect((await receipt()).rows).toEqual([]);
      expect(await assets.getById(asset.id)).toMatchObject({ deletedAt: null, duplicateId });
    } else {
      await decision;
      await sql`update job set "cancelRequestedAt" = now(), "cancelReason" = 'request' where id = ${claim.id}::uuid`.execute(
        db,
      );
      expect(context.followups).toEqual([]);
      expect((await receipt()).rows).toEqual([{ parentId: null, runId: null, state: 'pending' }]);
      expect(await assets.getById(asset.id)).toMatchObject({ deletedAt: expect.any(Date) });
    }
  },
);
