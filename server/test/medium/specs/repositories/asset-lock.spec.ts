import { Kysely, sql } from 'kysely';
import { AssetLockReason, AssetMetadataKey, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { up as addAssetLock } from 'src/schema/migrations/2100000000320-AddAssetLock.js';
import { BaseService } from 'src/services/base.service.js';
import { effectiveVisibility } from 'src/utils/locked.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * One Locked state (owner decision, September 22, 2026, FL-34): a lock record per asset, metadata that
 * never relocates it. The upgrade moves the upstream Locked folder and the sensitive marks into lock
 * records, stacks and live photos lock and unlock as a whole, and every read decides Locked from the
 * record alone.
 */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  // before the fork schema cutover: `asset.is_nsfw` and `asset_metadata` carry the sensitive marks
  await sql`UPDATE immich_fork.state SET phase = 'legacy' WHERE id = 1`.execute(defaultDatabase);
});

const locksOf = async (db: Kysely<DB>, assetIds: string[]) => {
  const rows = await db
    .selectFrom('asset_lock')
    .select(['assetId', 'reason'])
    .where('assetId', 'in', assetIds)
    .execute();
  return Object.fromEntries(rows.map((row) => [row.assetId, row.reason]));
};

const storedVisibilityOf = async (db: Kysely<DB>, assetIds: string[]) => {
  const rows = await db.selectFrom('asset').select(['id', 'visibility']).where('id', 'in', assetIds).execute();
  return Object.fromEntries(rows.map((row) => [row.id, row.visibility]));
};

const effectiveVisibilityOf = async (db: Kysely<DB>, assetIds: string[]) => {
  const rows = await db
    .selectFrom('asset')
    .select(['id', effectiveVisibility('asset').as('visibility')])
    .where('id', 'in', assetIds)
    .execute();
  return Object.fromEntries(rows.map((row) => [row.id, row.visibility]));
};

/** The saved "hide sensitive detections" switch, restored after the test that sets it. */
const setDetectionHiding = async (db: Kysely<DB>, enabled: boolean | undefined) => {
  await db
    .deleteFrom('system_metadata')
    .where('key', '=', 'system-config' as never)
    .execute();
  if (enabled !== undefined) {
    await sql`INSERT INTO system_metadata (key, value) VALUES ('system-config', ${JSON.stringify({
      machineLearning: { nsfwDetection: { hideFromLibrary: enabled } },
    })}::text::jsonb)`.execute(db);
  }
};

describe('asset lock (FL-34)', () => {
  describe('migration 2100000000320-AddAssetLock', () => {
    afterEach(async () => {
      await setDetectionHiding(defaultDatabase, undefined);
    });

    it('moves the old Locked folder into lock records, and nothing stays stored as locked', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: motion } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Hidden });
      const { asset: still } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: motion.id });
      const { asset: archived } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });
      const { asset: open } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumThumbnailAssetId: still.id }, [still.id, open.id]);
      // an Immich library: the still and its video part in the Locked folder
      await ctx.database
        .updateTable('asset')
        .set({ visibility: AssetVisibility.Locked })
        .where('id', 'in', [still.id, motion.id])
        .execute();

      await addAssetLock(ctx.database);

      await expect(locksOf(ctx.database, [still.id, motion.id, archived.id, open.id])).resolves.toEqual({
        [still.id]: AssetLockReason.ImmichLockedFolder,
        [motion.id]: AssetLockReason.ImmichLockedFolder,
      });
      // the video part goes back to hidden, never onto the timeline
      await expect(storedVisibilityOf(ctx.database, [still.id, motion.id, archived.id])).resolves.toEqual({
        [still.id]: AssetVisibility.Timeline,
        [motion.id]: AssetVisibility.Hidden,
        [archived.id]: AssetVisibility.Archive,
      });
      await expect(effectiveVisibilityOf(ctx.database, [still.id])).resolves.toEqual({
        [still.id]: AssetVisibility.Locked,
      });
      // memberships stay; the cover does not
      await expect(
        ctx.database.selectFrom('album_asset').select('assetId').where('albumId', '=', album.id).execute(),
      ).resolves.toHaveLength(2);
      await expect(
        ctx.database.selectFrom('album').select('albumThumbnailAssetId').where('id', '=', album.id).executeTakeFirst(),
      ).resolves.toEqual({ albumThumbnailAssetId: open.id });

      // running it again changes nothing
      await addAssetLock(ctx.database);
      await expect(locksOf(ctx.database, [still.id, motion.id])).resolves.toEqual({
        [still.id]: AssetLockReason.ImmichLockedFolder,
        [motion.id]: AssetLockReason.ImmichLockedFolder,
      });
    });

    it('turns sensitive marks into locks, and detections only while hiding them is on', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: marked } = await ctx.newAsset({ ownerId: user.id });
      const { asset: detected } = await ctx.newAsset({ ownerId: user.id });
      const { asset: reviewedSafe } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({
        assetId: marked.id,
        key: AssetMetadataKey.MlEnrichment,
        value: { nsfwDetection: { review: { action: 'marked-nsfw', isNsfw: true } } },
      });
      await ctx.newMetadata({
        assetId: detected.id,
        key: AssetMetadataKey.MlEnrichment,
        value: { nsfwDetection: { status: 'success', result: { isNsfw: true, score: 0.97, labels: {} } } },
      });
      await ctx.newMetadata({
        assetId: reviewedSafe.id,
        key: AssetMetadataKey.MlEnrichment,
        value: {
          nsfwDetection: {
            status: 'success',
            result: { isNsfw: true, score: 0.97, labels: {} },
            review: { action: 'marked-safe', isNsfw: false },
          },
        },
      });

      await addAssetLock(ctx.database);
      await expect(locksOf(ctx.database, [marked.id, detected.id, reviewedSafe.id])).resolves.toEqual({
        [marked.id]: AssetLockReason.Marked,
      });

      await setDetectionHiding(ctx.database, true);
      await addAssetLock(ctx.database);
      await expect(locksOf(ctx.database, [marked.id, detected.id, reviewedSafe.id])).resolves.toEqual({
        [marked.id]: AssetLockReason.Marked,
        [detected.id]: AssetLockReason.Detected,
      });
    });

    it('locks stacks saved half locked as a whole, with the reason of their locked photo', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: primary } = await ctx.newAsset({ ownerId: user.id });
      const { asset: member } = await ctx.newAsset({ ownerId: user.id });
      const { asset: outside } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newStack({ ownerId: user.id }, [primary.id, member.id]);
      await ctx.database
        .updateTable('asset')
        .set({ visibility: AssetVisibility.Locked })
        .where('id', '=', primary.id)
        .execute();

      await addAssetLock(ctx.database);

      await expect(locksOf(ctx.database, [primary.id, member.id, outside.id])).resolves.toEqual({
        [primary.id]: AssetLockReason.ImmichLockedFolder,
        [member.id]: AssetLockReason.ImmichLockedFolder,
      });
    });
  });

  describe(AssetRepository.prototype.lock.name, () => {
    it('locks a stack and a live photo as a whole and leaves the stored visibility alone', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset: motion } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Hidden });
      const { asset: primary } = await ctx.newAsset({
        ownerId: user.id,
        livePhotoVideoId: motion.id,
        visibility: AssetVisibility.Archive,
      });
      const { asset: member } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newStack({ ownerId: user.id }, [primary.id, member.id]);

      const locked = await sut.lock([member.id], AssetLockReason.Marked, user.id);

      expect([...locked].sort()).toEqual([motion.id, primary.id, member.id].sort());
      await expect(storedVisibilityOf(ctx.database, [motion.id, primary.id, member.id])).resolves.toEqual({
        [motion.id]: AssetVisibility.Hidden,
        [primary.id]: AssetVisibility.Archive,
        [member.id]: AssetVisibility.Timeline,
      });
      // the video part locks with its photo but never lists on its own
      await expect(effectiveVisibilityOf(ctx.database, [motion.id, primary.id, member.id])).resolves.toEqual({
        [motion.id]: AssetVisibility.Hidden,
        [primary.id]: AssetVisibility.Locked,
        [member.id]: AssetVisibility.Locked,
      });

      // locking again keeps the lock and its reason
      await expect(sut.lock([member.id], AssetLockReason.Detected, null)).resolves.toEqual([]);
      await expect(locksOf(ctx.database, [member.id])).resolves.toEqual({ [member.id]: AssetLockReason.Marked });
    });

    it('creates an asset already locked, together with the video part of its live photo', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset: motion } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Hidden });

      const created = await sut.create(mediumFactory.assetInsert({ ownerId: user.id, livePhotoVideoId: motion.id }), {
        reason: AssetLockReason.Marked,
        lockedBy: user.id,
      });

      await expect(locksOf(ctx.database, [created.id, motion.id])).resolves.toEqual({
        [created.id]: AssetLockReason.Marked,
        [motion.id]: AssetLockReason.Marked,
      });
      await expect(storedVisibilityOf(ctx.database, [created.id])).resolves.toEqual({
        [created.id]: AssetVisibility.Timeline,
      });
    });

    it("locks a photo joining a locked stack, and its video part, with the stack's own reason", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset: primary } = await ctx.newAsset({ ownerId: user.id });
      const { stack } = await ctx.newStack({ ownerId: user.id }, [primary.id]);
      await sut.lock([primary.id], AssetLockReason.Detected, null);
      const { asset: motion } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Hidden });
      const { asset: joining } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: motion.id });

      await sut.update({ id: joining.id, stackId: stack.id });

      await expect(locksOf(ctx.database, [primary.id, joining.id, motion.id])).resolves.toEqual({
        [primary.id]: AssetLockReason.Detected,
        [joining.id]: AssetLockReason.Detected,
        [motion.id]: AssetLockReason.Detected,
      });
    });

    it('never stores visibility locked, whoever asks for it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.updateAll([asset.id], { visibility: AssetVisibility.Locked });
      await sut.update({ id: asset.id, visibility: AssetVisibility.Locked });

      await expect(storedVisibilityOf(ctx.database, [asset.id])).resolves.toEqual({
        [asset.id]: AssetVisibility.Timeline,
      });
      await expect(locksOf(ctx.database, [asset.id])).resolves.toEqual({ [asset.id]: AssetLockReason.Marked });
    });
  });

  describe(AssetRepository.prototype.getTimeBuckets.name, () => {
    it('lists the Locked view for its owner, by reason, and reveals only marks in the timeline', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
      const { asset: folder } = await ctx.newAsset({ ownerId: user.id });
      const { asset: marked } = await ctx.newAsset({ ownerId: user.id });
      // an ordinary photo: the one Timeline item
      await ctx.newAsset({ ownerId: user.id });
      await ctx.database
        .insertInto('asset_lock')
        .values([
          { assetId: folder.id, reason: AssetLockReason.ImmichLockedFolder, lockedBy: null },
          { assetId: marked.id, reason: AssetLockReason.Marked, lockedBy: user.id },
        ])
        .execute();
      const count = async (options: Parameters<AssetRepository['getTimeBuckets']>[0]) =>
        (await sut.getTimeBuckets({ userIds: [user.id], ...options }, auth)).reduce(
          (total, { count }) => total + Number(count),
          0,
        );

      await expect(count({ visibility: AssetVisibility.Locked })).resolves.toBe(2);
      await expect(
        count({ visibility: AssetVisibility.Locked, lockReasons: [AssetLockReason.ImmichLockedFolder] }),
      ).resolves.toBe(1);
      await expect(count({ visibility: AssetVisibility.Timeline })).resolves.toBe(1);
      // "Revealed for this session": the mark, never the item from the old Locked folder
      await expect(count({ visibility: AssetVisibility.Timeline, revealLockedOwnerId: user.id })).resolves.toBe(2);
    });
  });
});
