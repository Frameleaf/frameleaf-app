import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetLockReason, AssetStatus, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { DB } from 'src/schema/index.js';
import { TrashService } from 'src/services/trash.service.js';
import { TrashReviewAction } from 'src/utils/trash-review.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Reviewed trash changes against a real database (FL-47): the set a review shows is the set an
 * apply changes, or nothing changes.
 */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(TrashService, {
    database: db || defaultDatabase,
    real: [AccessRepository, TrashRepository],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  return { sut, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/** Every medium asset shares one default path; give each its own original unless a test shares one. */
const own = () => `/data/library/${randomUUID()}.jpg`;

const statusOf = async (db: Kysely<DB>, id: string) => {
  const row = await db.selectFrom('asset').select(['status', 'deletedAt']).where('id', '=', id).executeTakeFirst();
  return row?.status;
};

describe(TrashService.name, () => {
  describe('review and apply', () => {
    it('should permanently delete exactly the reviewed items', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: first } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const { asset: second } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });

      const review = await sut.review(auth, { action: TrashReviewAction.Empty });
      expect(review).toMatchObject({ action: TrashReviewAction.Empty, count: 2, retainedOriginals: 0 });

      await expect(sut.apply(auth, { action: TrashReviewAction.Empty, token: review.token })).resolves.toEqual({
        count: 2,
      });
      await expect(statusOf(ctx.database, first.id)).resolves.toBe(AssetStatus.Deleted);
      await expect(statusOf(ctx.database, second.id)).resolves.toBe(AssetStatus.Deleted);
    });

    it('should refuse to empty the trash when an item arrived after the review', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: reviewed } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });

      const review = await sut.review(auth, { action: TrashReviewAction.Empty });
      const { asset: late } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });

      await expect(sut.apply(auth, { action: TrashReviewAction.Empty, token: review.token })).rejects.toThrow(
        'Trash changed since this review',
      );
      await expect(statusOf(ctx.database, reviewed.id)).resolves.toBe(AssetStatus.Trashed);
      await expect(statusOf(ctx.database, late.id)).resolves.toBe(AssetStatus.Trashed);
    });

    it('should refuse a delete when a reviewed item was restored elsewhere', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });

      const review = await sut.review(auth, { action: TrashReviewAction.Delete, ids: [asset.id] });
      await sut.restoreAssets(auth, { ids: [asset.id] });

      await expect(
        sut.apply(auth, { action: TrashReviewAction.Delete, ids: [asset.id], token: review.token }),
      ).rejects.toThrow();
      await expect(statusOf(ctx.database, asset.id)).resolves.toBe(AssetStatus.Active);
    });

    it('should refuse when an item was locked between review and apply', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: open } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const { asset: laterLocked } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });

      const review = await sut.review(auth, { action: TrashReviewAction.Empty });
      expect(review.count).toBe(2);

      // a detection or another tab locks it: an ordinary session no longer sees it
      await ctx.database
        .insertInto('asset_lock')
        .values({ assetId: laterLocked.id, reason: AssetLockReason.Detected, lockedBy: null })
        .execute();

      await expect(sut.apply(auth, { action: TrashReviewAction.Empty, token: review.token })).rejects.toThrow(
        'Trash changed since this review',
      );
      await expect(statusOf(ctx.database, open.id)).resolves.toBe(AssetStatus.Trashed);
      await expect(statusOf(ctx.database, laterLocked.id)).resolves.toBe(AssetStatus.Trashed);
    });

    it('should report shared originals as retained', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const shared = own();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: shared,
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 5000 });
      // another account's copy points at the same original
      const { user: other } = await ctx.newUser();
      await ctx.newAsset({ ownerId: other.id, originalPath: shared });

      await expect(sut.review(auth, { action: TrashReviewAction.Delete, ids: [asset.id] })).resolves.toMatchObject({
        count: 1,
        bytes: 5000,
        retainedOriginals: 1,
        retainedBytes: 5000,
      });
    });
  });

  describe('hidden items', () => {
    it('should keep Locked media out of an ordinary session and include it when unlocked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: open } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const { asset: locked } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        visibility: AssetVisibility.Locked,
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const ordinary = factory.auth({ user });
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

      await expect(sut.getSummary(ordinary)).resolves.toMatchObject({ count: 1 });
      const { items } = await sut.getItems(ordinary, {});
      expect(items.map(({ id }) => id)).toEqual([open.id]);

      await expect(sut.getSummary(elevated)).resolves.toMatchObject({ count: 2 });
      const unlocked = await sut.getItems(elevated, {});
      expect(unlocked.items.find(({ id }) => id === locked.id)).toMatchObject({ isLocked: true });

      // a chosen Locked item cannot be reviewed from an ordinary session
      await expect(sut.review(ordinary, { action: TrashReviewAction.Delete, ids: [locked.id] })).rejects.toThrow();

      // emptying from an ordinary session leaves Locked media in the trash
      const review = await sut.review(ordinary, { action: TrashReviewAction.Empty });
      expect(review.count).toBe(1);
      await sut.apply(ordinary, { action: TrashReviewAction.Empty, token: review.token });
      await expect(statusOf(ctx.database, open.id)).resolves.toBe(AssetStatus.Deleted);
      await expect(statusOf(ctx.database, locked.id)).resolves.toBe(AssetStatus.Trashed);
    });

    it("should never list the hidden part of a live photo or another account's trash", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        visibility: AssetVisibility.Hidden,
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      await ctx.newAsset({
        ownerId: other.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });

      await expect(sut.getSummary(factory.auth({ user }))).resolves.toEqual({
        count: 0,
        offline: 0,
        bytes: 0,
        pendingDeletion: 0,
      });
      await expect(sut.review(factory.auth({ user }), { action: TrashReviewAction.Empty })).rejects.toThrow(
        'Your trash is already empty',
      );
    });
  });

  describe('missing external originals', () => {
    it('should list them without restoring or emptying them', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      // what a library scan does to a file that disappeared: a deletion date, still active
      const { asset: offline } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        isExternal: true,
        isOffline: true,
        deletedAt: new Date(),
      });
      const { asset: trashed } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });

      await expect(sut.getSummary(auth)).resolves.toMatchObject({ count: 2, offline: 1 });
      const { items } = await sut.getItems(auth, {});
      expect(items.find(({ id }) => id === offline.id)).toMatchObject({ isOffline: true });

      const review = await sut.review(auth, { action: TrashReviewAction.Empty });
      expect(review.count).toBe(1);
      await sut.apply(auth, { action: TrashReviewAction.Empty, token: review.token });

      await expect(statusOf(ctx.database, offline.id)).resolves.toBe(AssetStatus.Active);
      await expect(statusOf(ctx.database, trashed.id)).resolves.toBe(AssetStatus.Deleted);
    });
  });

  describe('restore', () => {
    it('should keep albums, favourites and the archive when restoring', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        isFavorite: true,
        visibility: AssetVisibility.Archive,
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);

      const review = await sut.review(auth, { action: TrashReviewAction.Restore, ids: [asset.id] });
      await expect(
        sut.apply(auth, { action: TrashReviewAction.Restore, ids: [asset.id], token: review.token }),
      ).resolves.toEqual({ count: 1 });

      const restored = await ctx.database
        .selectFrom('asset')
        .select(['status', 'deletedAt', 'isFavorite', 'visibility'])
        .where('id', '=', asset.id)
        .executeTakeFirstOrThrow();
      expect(restored).toEqual({
        status: AssetStatus.Active,
        deletedAt: null,
        isFavorite: true,
        visibility: AssetVisibility.Archive,
      });
      await expect(
        ctx.database.selectFrom('album_asset').select('assetId').where('albumId', '=', album.id).execute(),
      ).resolves.toEqual([{ assetId: asset.id }]);
    });

    it('should not report a stale restore', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: own() });

      await expect(sut.restoreAssets(auth, { ids: [asset.id] })).resolves.toEqual({ count: 0 });
      expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalled();
    });
  });

  describe('move to trash', () => {
    it('should move reviewed library items to the trash and refuse ones already there', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: own() });

      const review = await sut.review(auth, { action: TrashReviewAction.Trash, ids: [asset.id] });
      await expect(
        sut.apply(auth, { action: TrashReviewAction.Trash, ids: [asset.id], token: review.token }),
      ).resolves.toEqual({ count: 1 });
      await expect(statusOf(ctx.database, asset.id)).resolves.toBe(AssetStatus.Trashed);

      // the same review again: the item is no longer in the library
      await expect(
        sut.apply(auth, { action: TrashReviewAction.Trash, ids: [asset.id], token: review.token }),
      ).rejects.toThrow('Trash changed since this review');
    });
  });
});
