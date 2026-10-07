import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { TimeBucketDto } from 'src/dtos/time-bucket.dto.js';
import { AlbumUserRole, AssetLockReason, AssetType, AssetVisibility, SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { DB } from 'src/schema/index.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(TimelineService, {
    database: db || defaultDatabase,
    real: [AssetRepository, AccessRepository, PartnerRepository],
    mock: [LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(TimelineService.name, () => {
  it('keeps media-type filters consistent across album counts, buckets, highlights and flat layouts (FL-40)', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const date = new Date('1970-02-12');
    const { asset: photo } = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Image,
      localDateTime: date,
      fileCreatedAt: date,
    });
    const { asset: video } = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Video,
      localDateTime: date,
      fileCreatedAt: date,
    });
    const { album } = await ctx.newAlbum({ ownerId: user.id }, [photo.id, video.id]);
    await ctx.newExif({ assetId: photo.id, make: 'Canon' });
    await ctx.newExif({ assetId: video.id, make: 'Canon' });

    for (const asset of [photo, video]) {
      // Exercise the request schema too: an undeclared parameter would otherwise be stripped.
      const options = TimeBucketDto.schema.parse({ albumId: album.id, assetType: asset.type });
      expect(options.assetType).toBe(asset.type);
      await expect(sut.getTimeBuckets(auth, options)).resolves.toEqual([{ timeBucket: '1970-02-01', count: 1 }]);
      expect(JSON.parse(await sut.getTimeBucket(auth, { ...options, timeBucket: '1970-02-01' })).id).toEqual([
        asset.id,
      ]);
      expect(
        JSON.parse(await sut.getTimelineOrdered(auth, { ...options, sort: 'filename', skip: 0, take: 10 })).id,
      ).toEqual([asset.id]);
      await expect(sut.getTimelineHighlights(auth, { ...options, grouping: 'month' })).resolves.toEqual([
        expect.objectContaining({ timeBucket: '1970-02-01', count: 1, keyAssetId: asset.id }),
      ]);
    }
    expect(TimeBucketDto.schema.safeParse({ assetType: 'invalid' }).success).toBe(false);
  });

  describe('getTimeBuckets', () => {
    it('should get time buckets by month', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const dates = [new Date('1970-01-01'), new Date('1970-02-10'), new Date('1970-02-11'), new Date('1970-02-11')];
      for (const localDateTime of dates) {
        const { asset } = await ctx.newAsset({ ownerId: user.id, localDateTime });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      }

      const response = sut.getTimeBuckets(auth, {});
      await expect(response).resolves.toEqual([
        { count: 3, timeBucket: '1970-02-01' },
        { count: 1, timeBucket: '1970-01-01' },
      ]);
    });

    it('should return error if time bucket is requested with locked visibility for partner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      const auth = factory.auth({ user, session: { hasElevatedPermission: true } });

      const response = sut.getTimeBuckets(auth, { userId: partner.id, visibility: AssetVisibility.Locked });
      await expect(response).rejects.toThrow("You may not access another user's locked timeline");
    });

    it('should not allow access for unrelated shared links', async () => {
      const { sut } = setup();
      const auth = factory.auth({ sharedLink: {} });
      const response = sut.getTimeBuckets(auth, {});
      await expect(response).rejects.toBeInstanceOf(BadRequestException);
      await expect(response).rejects.toThrow('Not found or no timeline.read access');
    });
  });

  describe('getTimeBucket', () => {
    it('should return time bucket', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        localDateTime: new Date('1970-02-12'),
        deletedAt: new Date(),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      const auth = factory.auth({ user: { id: user.id } });
      const rawResponse = await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', isTrashed: true });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ isTrashed: [true] }));
    });

    it('should handle a bucket without any assets', async () => {
      const { sut } = setup();
      const rawResponse = await sut.getTimeBucket(factory.auth(), { timeBucket: '1970-02-01' });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual({
        city: [],
        country: [],
        createdAt: [],
        duration: [],
        fileSizeInByte: [],
        height: [],
        id: [],
        visibility: [],
        isFavorite: [],
        isImage: [],
        isOffline: [],
        isTrashed: [],
        livePhotoVideoId: [],
        fileCreatedAt: [],
        localOffsetHours: [],
        originalFileName: [],
        ownerId: [],
        projectionType: [],
        rating: [],
        ratio: [],
        status: [],
        thumbhash: [],
        width: [],
      });
    });

    it('should say which assets are offline (FL-33)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: offline } = await ctx.newAsset({
        ownerId: user.id,
        isOffline: true,
        fileCreatedAt: new Date('1970-02-13'),
        localDateTime: new Date('1970-02-13'),
      });
      const { asset: online } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('1970-02-12'),
        localDateTime: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: offline.id, make: 'Canon' });
      await ctx.newExif({ assetId: online.id, make: 'Canon' });
      const auth = factory.auth({ user: { id: user.id } });
      const response = JSON.parse(await sut.getTimeBucket(auth, { timeBucket: '1970-02-01' }));
      expect(response).toEqual(expect.objectContaining({ id: [offline.id, online.id], isOffline: [true, false] }));
    });

    it('should return the exif rating for each asset (FL-33)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: rated } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('1970-02-13'),
        localDateTime: new Date('1970-02-13'),
      });
      const { asset: unrated } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('1970-02-12'),
        localDateTime: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: rated.id, rating: 4 });
      await ctx.newExif({ assetId: unrated.id, make: 'Canon' });
      const auth = factory.auth({ user: { id: user.id } });
      const response = JSON.parse(await sut.getTimeBucket(auth, { timeBucket: '1970-02-01' }));
      expect(response).toEqual(expect.objectContaining({ id: [rated.id, unrated.id], rating: [4, null] }));
    });

    it('should return each asset file name for the Work layout (FL-33)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalFileName: 'IMG_0042.HEIC',
        fileCreatedAt: new Date('1970-02-13'),
        localDateTime: new Date('1970-02-13'),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      const auth = factory.auth({ user: { id: user.id } });
      const response = JSON.parse(await sut.getTimeBucket(auth, { timeBucket: '1970-02-01' }));
      expect(response).toEqual(expect.objectContaining({ id: [asset.id], originalFileName: ['IMG_0042.HEIC'] }));
    });

    it('should handle 5 digit years', async () => {
      const { sut } = setup();
      const rawResponse = await sut.getTimeBucket(factory.auth(), { timeBucket: '012345-01-01' });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ id: [] }));
    });

    it('should return time bucket in trash', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        localDateTime: new Date('1970-02-12'),
        deletedAt: new Date(),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      const auth = factory.auth({ user: { id: user.id } });
      const rawResponse = await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', isTrashed: true });
      const response = JSON.parse(rawResponse);
      expect(response).toEqual(expect.objectContaining({ isTrashed: [true] }));
    });

    it("shows a partner's item once, as the viewer's own copy, never the partner's row (FL-326)", async () => {
      const { sut, ctx } = setup();
      const { user: alice } = await ctx.newUser();
      const { user: bob } = await ctx.newUser();
      await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
      const { asset: theirs } = await ctx.newAsset({ ownerId: alice.id, localDateTime: new Date('1970-02-12') });
      await ctx.newExif({ assetId: theirs.id, make: 'Canon' });
      // bob's copy of it (the copy engine's row)
      const { asset: copy } = await ctx.newAsset({
        ownerId: bob.id,
        checksum: theirs.checksum,
        localDateTime: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: copy.id, make: 'Canon' });

      const auth = factory.auth({ user: { id: bob.id } });
      const response = JSON.parse(
        await sut.getTimeBucket(auth, {
          timeBucket: '1970-02-01',
          userId: bob.id,
          visibility: AssetVisibility.Timeline,
        }),
      );
      expect(response.id).toEqual([copy.id]);
      // and the partner's own timeline is not readable
      await expect(sut.getTimeBuckets(auth, { userId: alice.id })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('should strip geodata metadata if shared link without exif', async () => {
    const { sut, ctx } = setup();
    const sharedLinkRepo = ctx.get(SharedLinkRepository);

    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      localDateTime: new Date('1970-02-12'),
      deletedAt: new Date(),
    });
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

    const { id: sharedLinkId } = await sharedLinkRepo.create({
      allowUpload: false,
      key: Buffer.from('123'),
      type: SharedLinkType.Album,
      userId: user.id,
      albumId: album.id,
    });

    await ctx.newExif({ assetId: asset.id, city: 'Austin', country: 'USA' });
    const auth = factory.auth({ sharedLink: { id: sharedLinkId, showExif: false } });
    const rawResponse = await sut.getTimeBucket(auth, { albumId: album.id, timeBucket: '1970-02-01', isTrashed: true });
    const response = JSON.parse(rawResponse);
    expect(response).not.toEqual(expect.objectContaining({ city: expect.any(Array), country: expect.any(Array) }));
    expect(response).not.toHaveProperty('rating');
    expect(response).not.toHaveProperty('originalFileName');
  });

  describe('Locked media in album timelines (FL-32)', () => {
    it('counts an album owner’s Locked members only for their elevated session', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const localDateTime = new Date('1970-02-10');
      const { asset: plain } = await ctx.newAsset({ ownerId: owner.id, localDateTime });
      const { asset: locked } = await ctx.newAsset({
        ownerId: owner.id,
        localDateTime,
        visibility: AssetVisibility.Locked,
      });
      for (const asset of [plain, locked]) {
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      }
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [plain.id, locked.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Editor });

      const elevatedOwner = factory.auth({ user: { id: owner.id }, session: { hasElevatedPermission: true } });
      const ordinaryOwner = factory.auth({ user: { id: owner.id } });
      const elevatedMember = factory.auth({ user: { id: member.id }, session: { hasElevatedPermission: true } });

      await expect(sut.getTimeBuckets(elevatedOwner, { albumId: album.id })).resolves.toEqual([
        { count: 2, timeBucket: '1970-02-01' },
      ]);
      await expect(sut.getTimeBuckets(ordinaryOwner, { albumId: album.id })).resolves.toEqual([
        { count: 1, timeBucket: '1970-02-01' },
      ]);
      await expect(sut.getTimeBuckets(elevatedMember, { albumId: album.id })).resolves.toEqual([
        { count: 1, timeBucket: '1970-02-01' },
      ]);

      // an explicit Locked request on the album is the caller's own Locked items, nobody else's
      await expect(
        sut.getTimeBuckets(elevatedOwner, { albumId: album.id, visibility: AssetVisibility.Locked }),
      ).resolves.toEqual([{ count: 1, timeBucket: '1970-02-01' }]);
      await expect(
        sut.getTimeBuckets(elevatedMember, { albumId: album.id, visibility: AssetVisibility.Locked }),
      ).resolves.toEqual([]);

      const bucket = JSON.parse(
        await sut.getTimeBucket(elevatedMember, { albumId: album.id, timeBucket: '1970-02-01' }),
      );
      expect(bucket.id).toEqual([plain.id]);
    });
  });

  describe('the Locked view (FL-34)', () => {
    it('lists the owner’s Locked-rule matches alongside their locks, and only in the Locked view', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const localDateTime = new Date('1970-02-10');
      const newItem = async (ownerId: string, visibility = AssetVisibility.Timeline) => {
        const { asset } = await ctx.newAsset({ ownerId, localDateTime, visibility });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
        return asset;
      };
      const plain = await newItem(owner.id);
      const locked = await newItem(owner.id, AssetVisibility.Locked);
      const ruleMatch = await newItem(owner.id);
      const archivedRuleMatch = await newItem(owner.id, AssetVisibility.Archive);
      const hiddenRuleMatch = await newItem(owner.id, AssetVisibility.Hidden);
      const othersRuleMatch = await newItem(other.id);
      const { tag } = await ctx.newTag({ userId: owner.id, value: 'Private' });
      await ctx.newTagAsset({
        tagIds: [tag.id],
        assetIds: [ruleMatch.id, archivedRuleMatch.id, hiddenRuleMatch.id, othersRuleMatch.id],
      });
      const rules = { userId: owner.id, includeNsfw: false, tagIds: [tag.id], personIds: [], petIds: [] };

      const elevated = factory.auth({ user: { id: owner.id }, session: { hasElevatedPermission: true } });
      elevated.suppressedContent = { ...rules, scope: 'visible' };
      const ordinary = factory.auth({ user: { id: owner.id } });
      ordinary.suppressedContent = { ...rules, scope: 'visible' };
      ordinary.hiddenContent = ordinary.suppressedContent;

      // the prototype's Locked view (`classifyLocked`): every lock plus every rule match, never hidden parts
      const lockedView = JSON.parse(
        await sut.getTimeBucket(elevated, { timeBucket: '1970-02-01', visibility: AssetVisibility.Locked }),
      );
      expect(new Set(lockedView.id)).toEqual(new Set([locked.id, ruleMatch.id, archivedRuleMatch.id]));
      expect(lockedView.visibility[lockedView.id.indexOf(ruleMatch.id)]).toBe(AssetVisibility.Timeline);
      expect(lockedView.lockReason[lockedView.id.indexOf(ruleMatch.id)]).toBeNull();
      await expect(sut.getTimeBuckets(elevated, { visibility: AssetVisibility.Locked })).resolves.toEqual([
        { count: 3, timeBucket: '1970-02-01' },
      ]);
      const ordered = JSON.parse(
        await sut.getTimelineOrdered(elevated, {
          sort: 'filename',
          skip: 0,
          take: 10,
          visibility: AssetVisibility.Locked,
        }),
      );
      expect(new Set(ordered.id)).toEqual(new Set(lockedView.id));

      // a lock reason narrows to locks, so rule matches (which have none) drop out
      const marked = JSON.parse(
        await sut.getTimeBucket(elevated, {
          timeBucket: '1970-02-01',
          visibility: AssetVisibility.Locked,
          lockReason: AssetLockReason.Marked,
        }),
      );
      expect(marked.id).toEqual([locked.id]);

      // an ordinary session keeps rule matches out of the timeline and cannot open the Locked view
      const timeline = JSON.parse(
        await sut.getTimeBucket(ordinary, { timeBucket: '1970-02-01', visibility: AssetVisibility.Timeline }),
      );
      expect(timeline.id).toEqual([plain.id]);
      await expect(
        sut.getTimeBucket(ordinary, { timeBucket: '1970-02-01', visibility: AssetVisibility.Locked }),
      ).rejects.toBeInstanceOf(Error);
    });
  });

  describe('items moved from the old Locked folder (FL-195 follow-up)', () => {
    it("reveals them in every ordinary view of their owner's unlocked session, like any other item", async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const localDateTime = new Date('1970-02-12');
      const newItem = async (visibility = AssetVisibility.Timeline) => {
        const { asset } = await ctx.newAsset({ ownerId: owner.id, localDateTime, visibility });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
        return asset;
      };
      const plain = await newItem();
      const moved = await newItem();
      const movedArchived = await newItem(AssetVisibility.Archive);
      await ctx.database
        .insertInto('asset_lock')
        .values(
          [moved.id, movedArchived.id].map((assetId) => ({
            assetId,
            reason: AssetLockReason.ImmichLockedFolder,
            previousVisibility: AssetVisibility.Locked,
          })),
        )
        .execute();
      const ordinary = factory.auth({ user: { id: owner.id } });
      const elevated = factory.auth({ user: { id: owner.id }, session: { hasElevatedPermission: true } });
      const { user: other } = await ctx.newUser();
      const otherElevated = factory.auth({ user: { id: other.id }, session: { hasElevatedPermission: true } });
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: other.id });

      const bucket = async (auth: typeof ordinary, dto: Record<string, unknown>) =>
        JSON.parse(await sut.getTimeBucket(auth, { timeBucket: '1970-02-01', ...dto }));

      expect((await bucket(ordinary, { visibility: AssetVisibility.Timeline })).id).toEqual([plain.id]);
      const timeline = await bucket(elevated, { visibility: AssetVisibility.Timeline });
      expect(new Set(timeline.id)).toEqual(new Set([plain.id, moved.id]));
      expect(timeline.lockReason[timeline.id.indexOf(moved.id)]).toBe(AssetLockReason.ImmichLockedFolder);
      expect((await bucket(elevated, { visibility: AssetVisibility.Archive })).id).toEqual([movedArchived.id]);
      await expect(sut.getTimeBuckets(elevated, { visibility: AssetVisibility.Timeline })).resolves.toEqual([
        { count: 2, timeBucket: '1970-02-01' },
      ]);
      // never to anybody else, whatever their own session (FL-326: nor is the timeline readable at all)
      await expect(bucket(otherElevated, { userId: owner.id, visibility: AssetVisibility.Timeline })).rejects.toThrow(
        'Not found or no timeline.read access',
      );
    });
  });

  describe('getTimelineOrdered (FL-30, S-15)', () => {
    const newItem = async (
      ctx: ReturnType<typeof setup>['ctx'],
      ownerId: string,
      originalFileName: string,
      day: number,
      exif: { rating?: number | null; city?: string } = {},
      extra: { visibility?: AssetVisibility } = {},
    ) => {
      const date = new Date(`1970-02-${String(day).padStart(2, '0')}`);
      const { asset } = await ctx.newAsset({
        ownerId,
        originalFileName,
        fileCreatedAt: date,
        localDateTime: date,
        ...extra,
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon', ...exif });
      return asset;
    };

    it('orders by file name, locale-aware, across every bucket, and pages without overlap', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const b = await newItem(ctx, user.id, 'beach.jpg', 1);
      const a = await newItem(ctx, user.id, 'Alps.jpg', 20);
      const c = await newItem(ctx, user.id, 'canyon.jpg', 10);
      const auth = factory.auth({ user: { id: user.id } });

      const all = JSON.parse(await sut.getTimelineOrdered(auth, { sort: 'filename', skip: 0, take: 10 }));
      expect(all.id).toEqual([a.id, b.id, c.id]);
      expect(all.originalFileName).toEqual(['Alps.jpg', 'beach.jpg', 'canyon.jpg']);

      const first = JSON.parse(await sut.getTimelineOrdered(auth, { sort: 'filename', skip: 0, take: 2 }));
      const second = JSON.parse(await sut.getTimelineOrdered(auth, { sort: 'filename', skip: 2, take: 2 }));
      expect([...first.id, ...second.id]).toEqual([a.id, b.id, c.id]);
    });

    it('orders by rating, highest first, unrated as 0 and rejected last, then newest', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const rejected = await newItem(ctx, user.id, 'r.jpg', 5, { rating: -1 });
      const unratedOld = await newItem(ctx, user.id, 'u1.jpg', 1, { rating: null });
      const unratedNew = await newItem(ctx, user.id, 'u2.jpg', 9, { rating: null });
      const five = await newItem(ctx, user.id, 'f.jpg', 3, { rating: 5 });
      const two = await newItem(ctx, user.id, 't.jpg', 4, { rating: 2 });
      const auth = factory.auth({ user: { id: user.id } });

      const page = JSON.parse(await sut.getTimelineOrdered(auth, { sort: 'rating', skip: 0, take: 10 }));
      expect(page.id).toEqual([five.id, two.id, unratedNew.id, unratedOld.id, rejected.id]);
      expect(page.rating).toEqual([5, 2, null, null, -1]);
    });

    it.each(['filename', 'rating'] as const)(
      'seeks %s in both directions across ties, with the same owner and privacy filters',
      async (sort) => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();
        const { user: other } = await ctx.newUser();
        const auth = factory.auth({ user: { id: user.id } });
        const ids: string[] = [];
        for (const [name, day, rating] of [
          ['same.jpg', 5, 5],
          ['same.jpg', 5, 5],
          ['same.jpg', 4, 5],
          ['z.jpg', 3, 0],
          ['z.jpg', 3, null],
          ['z.jpg', 1, -1],
        ] as const) {
          ids.push((await newItem(ctx, user.id, name, day, { rating })).id);
        }
        // Missing EXIF stays excluded, exactly as the existing bucket query requires.
        const { asset: missingExif } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'same.jpg' });
        await newItem(ctx, other.id, 'same.jpg', 5, { rating: 5 });
        await newItem(ctx, user.id, 'same.jpg', 5, { rating: 5 }, { visibility: AssetVisibility.Locked });
        await newItem(ctx, user.id, 'same.jpg', 5, { rating: 5 }, { visibility: AssetVisibility.Archive });
        const options = { sort, visibility: AssetVisibility.Timeline, skip: 0, take: 2 };
        const all = JSON.parse(await sut.getTimelineOrdered(auth, { ...options, take: 100 }));
        expect(new Set(all.id)).toEqual(new Set(ids));
        expect(all.id).not.toContain(missingExif.id);
        const pages = [JSON.parse(await sut.getTimelineOrdered(auth, options))];
        while (pages.at(-1).id.length > 0) {
          pages.push(
            JSON.parse(await sut.getTimelineOrdered(auth, { ...options, skip: 999, after: pages.at(-1).endCursor })),
          );
        }
        expect(pages.flatMap((page) => page.id)).toEqual(all.id);
        const random = JSON.parse(await sut.getTimelineOrdered(auth, { ...options, skip: 4 }));
        expect(random.id).toEqual(all.id.slice(4, 6));
        const previous = JSON.parse(await sut.getTimelineOrdered(auth, { ...options, before: random.startCursor }));
        expect(previous.id).toEqual(all.id.slice(2, 4));
        const first = JSON.parse(await sut.getTimelineOrdered(auth, { ...options, before: previous.startCursor }));
        expect(first.id).toEqual(all.id.slice(0, 2));
        // Cursor is a position, not authorization to read the referenced owner's rows.
        const otherPage = JSON.parse(
          await sut.getTimelineOrdered(factory.auth({ user: { id: other.id } }), {
            ...options,
            after: first.endCursor,
          }),
        );
        expect(otherPage.ownerId.every((id: string) => id === other.id)).toBe(true);
      },
    );

    it('shows exactly what the time buckets show: Locked only in the Locked view of an elevated owner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const plain = await newItem(ctx, user.id, 'a.jpg', 1);
      const locked = await newItem(ctx, user.id, 'b.jpg', 2, {}, { visibility: AssetVisibility.Locked });
      const ordinary = factory.auth({ user: { id: user.id } });
      const elevated = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

      const timeline = JSON.parse(
        await sut.getTimelineOrdered(ordinary, {
          sort: 'filename',
          skip: 0,
          take: 10,
          visibility: AssetVisibility.Timeline,
        }),
      );
      expect(timeline.id).toEqual([plain.id]);

      await expect(
        sut.getTimelineOrdered(ordinary, { sort: 'filename', skip: 0, take: 10, visibility: AssetVisibility.Locked }),
      ).rejects.toBeInstanceOf(Error);
      const lockedView = JSON.parse(
        await sut.getTimelineOrdered(elevated, {
          sort: 'filename',
          skip: 0,
          take: 10,
          visibility: AssetVisibility.Locked,
        }),
      );
      expect(lockedView.id).toEqual([locked.id]);
      const bucket = JSON.parse(
        await sut.getTimeBucket(elevated, { timeBucket: '1970-02-01', visibility: AssetVisibility.Locked }),
      );
      expect(lockedView.id).toEqual(bucket.id);
    });

    it('returns dimensions and size for the list view; a shared link without EXIF hides them and may not sort', async () => {
      const { sut, ctx } = setup();
      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalFileName: 'a.jpg',
        width: 4000,
        height: 3000,
        localDateTime: new Date('1970-02-12'),
        fileCreatedAt: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1_234_567 });
      const auth = factory.auth({ user: { id: user.id } });
      const page = JSON.parse(await sut.getTimelineOrdered(auth, { sort: 'filename', skip: 0, take: 10 }));
      expect(page).toEqual(expect.objectContaining({ width: [4000], height: [3000], fileSizeInByte: [1_234_567] }));

      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      const { id: sharedLinkId } = await sharedLinkRepo.create({
        allowUpload: false,
        key: Buffer.from('456'),
        type: SharedLinkType.Album,
        userId: user.id,
        albumId: album.id,
      });
      const linkAuth = factory.auth({ sharedLink: { id: sharedLinkId, showExif: false } });
      // Its buckets hide the columns, and it may not sort: the order would reveal them.
      const bucket = JSON.parse(await sut.getTimeBucket(linkAuth, { albumId: album.id, timeBucket: '1970-02-01' }));
      expect(bucket.id).toEqual([asset.id]);
      for (const field of ['width', 'height', 'fileSizeInByte', 'originalFileName', 'rating']) {
        expect(bucket).not.toHaveProperty(field);
      }
      await expect(
        sut.getTimelineOrdered(linkAuth, { albumId: album.id, sort: 'filename', skip: 0, take: 10 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
