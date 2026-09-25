import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { UtilityActivityAction, UtilityActivityTool } from 'src/dtos/trash.dto.js';
import { AssetLockReason, AssetStatus, AssetVisibility, PhysicalFileType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
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

  describe('Large files activity (FL-47, FL-146)', () => {
    const moveFromLargeFiles = async (sut: TrashService, auth: ReturnType<typeof factory.auth>, ids: string[]) => {
      const review = await sut.review(auth, { action: TrashReviewAction.Trash, ids });
      await sut.apply(auth, {
        action: TrashReviewAction.Trash,
        ids,
        token: review.token,
        source: UtilityActivityTool.LargeFiles,
      });
    };

    it('keeps each move and undo with its items, sizes and time, newest first', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: own(), originalFileName: 'Lake.mov' });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 4_800_000_000 });

      await moveFromLargeFiles(sut, auth, [asset.id]);
      const review = await sut.review(auth, { action: TrashReviewAction.Restore, ids: [asset.id] });
      await sut.apply(auth, {
        action: TrashReviewAction.Restore,
        ids: [asset.id],
        token: review.token,
        source: UtilityActivityTool.LargeFiles,
      });

      const { entries } = await sut.getUtilityActivity(auth, { tool: UtilityActivityTool.LargeFiles });
      expect(entries.map(({ action }) => action)).toEqual([UtilityActivityAction.Restore, UtilityActivityAction.Trash]);
      expect(entries[1]).toMatchObject({
        itemCount: 1,
        bytes: 4_800_000_000,
        items: [{ assetId: asset.id, fileName: 'Lake.mov', bytes: 4_800_000_000 }],
        unavailableCount: 0,
      });
      expect(Date.parse(entries[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(entries[1].createdAt));

      // another account never sees it
      const { user: other } = await ctx.newUser();
      await expect(
        sut.getUtilityActivity(factory.auth({ user: other }), { tool: UtilityActivityTool.LargeFiles }),
      ).resolves.toEqual({ entries: [] });
    });

    it('does not record a change made outside Large files', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: own() });

      const review = await sut.review(auth, { action: TrashReviewAction.Trash, ids: [asset.id] });
      await sut.apply(auth, { action: TrashReviewAction.Trash, ids: [asset.id], token: review.token });

      await expect(sut.getUtilityActivity(auth, { tool: UtilityActivityTool.LargeFiles })).resolves.toEqual({
        entries: [],
      });
    });

    it('stops naming an item that was Locked afterwards, except in the unlocked session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: own(), originalFileName: 'Private.mov' });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 9000 });
      await moveFromLargeFiles(sut, auth, [asset.id]);

      await ctx.database
        .insertInto('asset_lock')
        .values({ assetId: asset.id, reason: AssetLockReason.Detected, lockedBy: null })
        .execute();

      const ordinary = await sut.getUtilityActivity(auth, { tool: UtilityActivityTool.LargeFiles });
      expect(ordinary.entries[0]).toMatchObject({ itemCount: 0, bytes: 0, items: [], unavailableCount: 1 });
      expect(JSON.stringify(ordinary)).not.toContain('Private.mov');

      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
      const unlocked = await sut.getUtilityActivity(elevated, { tool: UtilityActivityTool.LargeFiles });
      expect(unlocked.entries[0]).toMatchObject({ itemCount: 1, items: [{ fileName: 'Private.mov' }] });
    });

    it("gives another owner none of it, even their unlocked session, and keeps each owner's own apart", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: own(), originalFileName: 'Mine.mov' });
      const { asset: theirs } = await ctx.newAsset({
        ownerId: other.id,
        originalPath: own(),
        originalFileName: 'Theirs.mov',
      });
      await moveFromLargeFiles(sut, auth, [asset.id]);
      await moveFromLargeFiles(sut, factory.auth({ user: other }), [theirs.id]);

      for (const reader of [
        factory.auth({ user: other }),
        factory.auth({ user: other, session: { hasElevatedPermission: true } }),
      ]) {
        const { entries } = await sut.getUtilityActivity(reader, { tool: UtilityActivityTool.LargeFiles });
        expect(entries).toHaveLength(1);
        expect(JSON.stringify(entries)).not.toContain('Mine.mov');
        expect(JSON.stringify(entries)).not.toContain(asset.id);
        expect(entries[0].items).toEqual([expect.objectContaining({ assetId: theirs.id, fileName: 'Theirs.mov' })]);
      }
      const mine = await sut.getUtilityActivity(auth, { tool: UtilityActivityTool.LargeFiles });
      expect(mine.entries).toHaveLength(1);
      expect(mine.entries[0].items).toEqual([expect.objectContaining({ assetId: asset.id })]);
    });

    it('counts but never names an item a privacy mark hides from the session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { tag } = await ctx.newTag({ userId: user.id, value: 'private-mark' });
      const auth = factory.auth({ user });
      const { asset: open } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        originalFileName: 'Open.mov',
      });
      const { asset: marked } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        originalFileName: 'Marked.mov',
      });
      await ctx.newExif({ assetId: open.id, fileSizeInByte: 3000 });
      await ctx.newExif({ assetId: marked.id, fileSizeInByte: 7000 });
      await moveFromLargeFiles(sut, auth, [open.id, marked.id]);
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [marked.id] });

      const hidden = await sut.getUtilityActivity(markedAuth(user, [tag.id]), { tool: UtilityActivityTool.LargeFiles });
      expect(hidden.entries[0]).toMatchObject({
        itemCount: 1,
        bytes: 3000,
        items: [{ assetId: open.id, fileName: 'Open.mov', bytes: 3000 }],
        unavailableCount: 1,
      });
      expect(JSON.stringify(hidden)).not.toContain('Marked.mov');

      // without the filter both are named
      const all = await sut.getUtilityActivity(auth, { tool: UtilityActivityTool.LargeFiles });
      expect(all.entries[0]).toMatchObject({ itemCount: 2, bytes: 10_000, unavailableCount: 0 });
    });

    it('counts but no longer names permanently deleted items', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: kept } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        originalFileName: 'Kept.mov',
      });
      const { asset: deleted } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        originalFileName: 'Deleted.mov',
      });
      const { asset: removed } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: own(),
        originalFileName: 'Removed.mov',
      });
      await moveFromLargeFiles(sut, auth, [kept.id, deleted.id, removed.id]);

      // one permanently deleted and still being removed from storage, one already gone entirely
      const review = await sut.review(auth, { action: TrashReviewAction.Delete, ids: [deleted.id] });
      await sut.apply(auth, { action: TrashReviewAction.Delete, ids: [deleted.id], token: review.token });
      await ctx.database.deleteFrom('asset').where('id', '=', removed.id).execute();

      const { entries } = await sut.getUtilityActivity(auth, { tool: UtilityActivityTool.LargeFiles });
      expect(entries[0]).toMatchObject({
        itemCount: 1,
        items: [expect.objectContaining({ assetId: kept.id, fileName: 'Kept.mov' })],
        unavailableCount: 2,
      });
      expect(JSON.stringify(entries)).not.toContain('Deleted.mov');
      expect(JSON.stringify(entries)).not.toContain('Removed.mov');
    });

    it('keeps a year and at most 500 entries per owner', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const repository = new TrashRepository(ctx.database);
      const item = { assetId: randomUUID(), fileName: 'a.mov', bytes: 1 };
      await sql`
        INSERT INTO immich_fork.utility_activity ("userId", tool, action, "itemCount", bytes, items, "createdAt")
        VALUES (${user.id}::uuid, 'large-files', 'trash', 1, 1, ${JSON.stringify([item])}::text::jsonb,
          clock_timestamp() - interval '400 days')
      `.execute(ctx.database);
      for (let index = 0; index < 501; index++) {
        await repository.addUtilityActivity({
          userId: user.id,
          tool: UtilityActivityTool.LargeFiles,
          action: UtilityActivityAction.Trash,
          items: [item],
        });
      }

      const count = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM immich_fork.utility_activity WHERE "userId" = ${user.id}::uuid
      `.execute(ctx.database);
      expect(count.rows[0].count).toBe('500');
    });

    it('goes with the account, and the removed-account sweep clears what a handoff left behind', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: kept } = await ctx.newUser();
      const repository = new TrashRepository(ctx.database);
      const users = new UserRepository(ctx.database);
      const item = { assetId: randomUUID(), fileName: 'a.mov', bytes: 1 };
      const removed = randomUUID();
      for (const userId of [user.id, kept.id, removed]) {
        await repository.addUtilityActivity({
          userId,
          tool: UtilityActivityTool.LargeFiles,
          action: UtilityActivityAction.Trash,
          items: [item],
        });
      }
      // an expired entry of the kept account
      await sql`
        INSERT INTO immich_fork.utility_activity ("userId", tool, action, "itemCount", bytes, items, "createdAt")
        VALUES (${kept.id}::uuid, 'large-files', 'trash', 1, 1, ${JSON.stringify([item])}::text::jsonb,
          clock_timestamp() - interval '400 days')
      `.execute(ctx.database);

      await users.deletePreferenceHistory(user.id);
      const swept = await users.sweepRemovedAccountForkRows();
      expect(swept?.utilityActivity).toBeGreaterThanOrEqual(2);

      const rows = await sql<{ userId: string }>`
        SELECT "userId"::text AS "userId" FROM immich_fork.utility_activity
        WHERE "userId" IN (${user.id}::uuid, ${kept.id}::uuid, ${removed}::uuid)
      `.execute(ctx.database);
      expect(rows.rows).toEqual([{ userId: kept.id }]);
    });
  });
});
