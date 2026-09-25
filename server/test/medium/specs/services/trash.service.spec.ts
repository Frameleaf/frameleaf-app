import { Kysely } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { AssetLockReason, AssetStatus, AssetVisibility, PhysicalFileType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
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
    real: [AccessRepository, ConfigRepository, SystemMetadataRepository, TrashRepository],
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

/** Point several items at one physical original, as deduplicated uploads do. */
const sharePhysicalOriginal = async (db: Kysely<DB>, assetIds: string[], sizeInBytes: number) => {
  const file = await db
    .insertInto('physical_file')
    .values({
      type: PhysicalFileType.Original,
      checksum: randomBytes(32),
      sizeInBytes,
      path: `/data/physical/${randomUUID()}`,
      canonicalAssetId: assetIds[0],
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db.updateTable('asset').set({ physicalOriginalFileId: file.id }).where('id', 'in', assetIds).execute();
};

/** An ordinary session whose privacy marks hide items carrying one of `tagIds`. */
const markedAuth = (user: { id: string }, tagIds: string[], elevated = false) => ({
  ...factory.auth({ user, ...(elevated && { session: { hasElevatedPermission: true } }) }),
  hiddenContent: { userId: user.id, includeNsfw: false, tagIds, personIds: [], petIds: [], scope: 'owned' as const },
});

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

    it('should report an original shared through the physical file as retained', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      // different paths, one deduplicated original on disk
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 7000 });
      const { user: other } = await ctx.newUser();
      const { asset: copy } = await ctx.newAsset({ ownerId: other.id, originalPath: own() });
      await sharePhysicalOriginal(ctx.database, [asset.id, copy.id], 7000);

      await expect(sut.review(auth, { action: TrashReviewAction.Delete, ids: [asset.id] })).resolves.toMatchObject({
        count: 1,
        bytes: 7000,
        retainedOriginals: 1,
        retainedBytes: 7000,
      });
    });

    it('should not count copies deleted together as keeping their shared original', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const shared = own();
      const { asset: first } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: shared,
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const { asset: second } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: shared,
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });

      await expect(
        sut.review(auth, { action: TrashReviewAction.Delete, ids: [first.id, second.id] }),
      ).resolves.toMatchObject({ count: 2, retainedOriginals: 0 });
      await expect(sut.review(auth, { action: TrashReviewAction.Delete, ids: [first.id] })).resolves.toMatchObject({
        count: 1,
        retainedOriginals: 1,
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

  describe('privacy marks', () => {
    it('should keep items a privacy mark hides out of the list, the counts and every review', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { tag } = await ctx.newTag({ userId: user.id, value: 'private-mark' });
      const { asset: open } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const { asset: marked } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [marked.id] });
      const auth = markedAuth(user, [tag.id]);

      await expect(sut.getSummary(auth)).resolves.toMatchObject({ count: 1 });
      const { items } = await sut.getItems(auth, {});
      expect(items.map(({ id }) => id)).toEqual([open.id]);

      // a chosen hidden item is refused, alone or with a visible one (access or availability, never a review)
      await expect(sut.review(auth, { action: TrashReviewAction.Delete, ids: [marked.id] })).rejects.toThrow();
      await expect(
        sut.review(auth, { action: TrashReviewAction.Restore, ids: [open.id, marked.id] }),
      ).rejects.toThrow();

      // emptying covers only what the session sees
      const review = await sut.review(auth, { action: TrashReviewAction.Empty });
      expect(review.count).toBe(1);
      await sut.apply(auth, { action: TrashReviewAction.Empty, token: review.token });
      await expect(statusOf(ctx.database, open.id)).resolves.toBe(AssetStatus.Deleted);
      await expect(statusOf(ctx.database, marked.id)).resolves.toBe(AssetStatus.Trashed);
    });

    it('should refuse an apply when a privacy mark was added after the review', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { tag } = await ctx.newTag({ userId: user.id, value: 'private-mark' });
      const { asset: open } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const { asset: laterMarked } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const auth = markedAuth(user, [tag.id]);

      const review = await sut.review(auth, { action: TrashReviewAction.Empty });
      expect(review.count).toBe(2);

      // another tab marks it: this session no longer sees it
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [laterMarked.id] });

      await expect(sut.apply(auth, { action: TrashReviewAction.Empty, token: review.token })).rejects.toThrow(
        'Trash changed since this review',
      );
      await expect(statusOf(ctx.database, open.id)).resolves.toBe(AssetStatus.Trashed);
      await expect(statusOf(ctx.database, laterMarked.id)).resolves.toBe(AssetStatus.Trashed);
    });

    it('should refuse an unlocked apply when an item was locked after the review', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

      const review = await sut.review(elevated, { action: TrashReviewAction.Restore, ids: [asset.id] });

      // still visible to the unlocked session, but it is now Locked media: the reviewed set changed
      await ctx.database
        .insertInto('asset_lock')
        .values({ assetId: asset.id, reason: AssetLockReason.Detected, lockedBy: null })
        .execute();

      await expect(
        sut.apply(elevated, { action: TrashReviewAction.Restore, ids: [asset.id], token: review.token }),
      ).rejects.toThrow('Trash changed since this review');
      await expect(statusOf(ctx.database, asset.id)).resolves.toBe(AssetStatus.Trashed);
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
      // one the owner trashed whose file went missing afterwards is an ordinary trash item
      const { asset: trashedThenMissing } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        isExternal: true,
        isOffline: true,
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });

      await expect(sut.getSummary(auth)).resolves.toMatchObject({ count: 3, offline: 1 });
      const { items } = await sut.getItems(auth, {});
      expect(items.find(({ id }) => id === offline.id)).toMatchObject({ isOffline: true });
      expect(items.find(({ id }) => id === trashedThenMissing.id)).toMatchObject({ isOffline: false });

      const review = await sut.review(auth, { action: TrashReviewAction.Empty });
      expect(review.count).toBe(2);
      await sut.apply(auth, { action: TrashReviewAction.Empty, token: review.token });

      await expect(statusOf(ctx.database, offline.id)).resolves.toBe(AssetStatus.Active);
      await expect(statusOf(ctx.database, trashed.id)).resolves.toBe(AssetStatus.Deleted);
      await expect(statusOf(ctx.database, trashedThenMissing.id)).resolves.toBe(AssetStatus.Deleted);

      // nor can it be moved to the trash as if it were in the library
      await expect(sut.review(auth, { action: TrashReviewAction.Trash, ids: [offline.id] })).rejects.toThrow(
        'A chosen item changed or is no longer available',
      );
    });
  });

  describe('restore', () => {
    it('should keep albums, favourites, the archive, tags and source provenance when restoring', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const originalPath = own();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath,
        originalFileName: 'IMG_0001.HEIC',
        isFavorite: true,
        visibility: AssetVisibility.Archive,
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
      const { tag } = await ctx.newTag({ userId: user.id, value: 'kept' });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
      const before = await ctx.database
        .selectFrom('asset')
        .select(['originalPath', 'originalFileName', 'checksum', 'libraryId', 'fileCreatedAt'])
        .where('id', '=', asset.id)
        .executeTakeFirstOrThrow();

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
      await expect(
        ctx.database.selectFrom('tag_asset').select('tagId').where('assetId', '=', asset.id).execute(),
      ).resolves.toEqual([{ tagId: tag.id }]);
      // where it came from is untouched: the same original, name, checksum, library and capture date
      await expect(
        ctx.database
          .selectFrom('asset')
          .select(['originalPath', 'originalFileName', 'checksum', 'libraryId', 'fileCreatedAt'])
          .where('id', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual(before);
      expect(before.originalPath).toBe(originalPath);
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
