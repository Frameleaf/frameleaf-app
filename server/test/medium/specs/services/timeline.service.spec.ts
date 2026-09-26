import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AlbumUserRole, AssetVisibility, SharedLinkType } from 'src/enum.js';
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

    it('should return error if time bucket is requested with partners asset and archived', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response1 = sut.getTimeBuckets(auth, { withPartners: true, visibility: AssetVisibility.Archive });
      await expect(response1).rejects.toBeInstanceOf(BadRequestException);
      await expect(response1).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );

      const response2 = sut.getTimeBuckets(auth, { withPartners: true });
      await expect(response2).rejects.toBeInstanceOf(BadRequestException);
      await expect(response2).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
    });

    it('should return error if time bucket is requested with partners asset and favorite', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response1 = sut.getTimeBuckets(auth, { withPartners: true, isFavorite: false });
      await expect(response1).rejects.toBeInstanceOf(BadRequestException);
      await expect(response1).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );

      const response2 = sut.getTimeBuckets(auth, { withPartners: true, isFavorite: true });
      await expect(response2).rejects.toBeInstanceOf(BadRequestException);
      await expect(response2).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
    });

    it('should return error if time bucket is requested with partners asset and trash', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const response = sut.getTimeBuckets(auth, { withPartners: true, isTrashed: true });
      await expect(response).rejects.toBeInstanceOf(BadRequestException);
      await expect(response).rejects.toThrow(
        'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets',
      );
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

    it('should return false for favorite status unless asset owner', async () => {
      const { sut, ctx } = setup();
      const [{ asset: asset1 }, { asset: asset2 }] = await Promise.all([
        ctx.newUser().then(async ({ user }) => {
          const result = await ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('1970-02-12'),
            localDateTime: new Date('1970-02-12'),
            isFavorite: true,
          });
          await ctx.newExif({ assetId: result.asset.id, make: 'Canon' });
          return result;
        }),

        ctx.newUser().then(async ({ user }) => {
          const result = await ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('1970-02-13'),
            localDateTime: new Date('1970-02-13'),
            isFavorite: true,
          });
          await ctx.newExif({ assetId: result.asset.id, make: 'Canon' });
          return result;
        }),
      ]);

      await Promise.all([
        ctx.newPartner({ sharedById: asset1.ownerId, sharedWithId: asset2.ownerId }),
        ctx.newPartner({ sharedById: asset2.ownerId, sharedWithId: asset1.ownerId }),
      ]);

      const auth1 = factory.auth({ user: { id: asset1.ownerId } });
      const rawResponse1 = await sut.getTimeBucket(auth1, {
        timeBucket: '1970-02-01',
        withPartners: true,
        visibility: AssetVisibility.Timeline,
      });
      const response1 = JSON.parse(rawResponse1);
      expect(response1).toEqual(expect.objectContaining({ id: [asset2.id, asset1.id], isFavorite: [false, true] }));

      const auth2 = factory.auth({ user: { id: asset2.ownerId } });
      const rawResponse2 = await sut.getTimeBucket(auth2, {
        timeBucket: '1970-02-01',
        withPartners: true,
        visibility: AssetVisibility.Timeline,
      });
      const response2 = JSON.parse(rawResponse2);
      expect(response2).toEqual(expect.objectContaining({ id: [asset2.id, asset1.id], isFavorite: [true, false] }));
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

    it('includes partners like the buckets and hides the locations a partner keeps private', async () => {
      const { sut, ctx } = setup();
      const { user: me } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.get(PartnerRepository).create({
        sharedById: partner.id,
        sharedWithId: me.id,
        inTimeline: true,
        shareLocation: false,
      });
      const mine = await newItem(ctx, me.id, 'a.jpg', 1, { city: 'Halifax' });
      const theirs = await newItem(ctx, partner.id, 'b.jpg', 2, { city: 'Oslo' });
      const auth = factory.auth({ user: { id: me.id } });

      const page = JSON.parse(
        await sut.getTimelineOrdered(auth, {
          sort: 'filename',
          skip: 0,
          take: 10,
          withPartners: true,
          visibility: AssetVisibility.Timeline,
        }),
      );
      expect(page.id).toEqual([mine.id, theirs.id]);
      expect(page.city).toEqual(['Halifax', null]);

      const bucket = JSON.parse(
        await sut.getTimeBucket(auth, {
          timeBucket: '1970-02-01',
          withPartners: true,
          visibility: AssetVisibility.Timeline,
        }),
      );
      expect(bucket.id.toSorted()).toEqual(page.id.toSorted());
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
