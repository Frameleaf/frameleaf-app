import { Kysely } from 'kysely';
import { AssetMetadataKey, AssetType, AssetVisibility } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { MapService } from 'src/services/map.service.js';
import { upsertTags } from 'src/utils/tag.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(MapService, {
    database: db || defaultDatabase,
    real: [AlbumRepository, AssetRepository, MapRepository, PartnerRepository, TagRepository],
    mock: [LoggingRepository],
  });
};

const nsfwMetadata = (isNsfw: boolean, review?: { action: string; isNsfw: boolean }) => ({
  nsfwDetection: {
    status: 'success',
    result: { isNsfw, score: isNsfw ? 0.95 : 0.05, labels: { explicit: isNsfw ? 0.95 : 0.05 } },
    ...(review && { review }),
  },
});

const addExif = async (
  ctx: ReturnType<typeof setup>['ctx'],
  assets: Array<{ id: string }>,
  baseLatitude = 42,
  baseLongitude = 69,
) => {
  for (const [index, asset] of assets.entries()) {
    await ctx.newExif({
      assetId: asset.id,
      latitude: baseLatitude + index / 100,
      longitude: baseLongitude + index / 100,
      city: `city-${index}`,
      state: 'state',
      country: 'country',
    });
  }
};

describe(MapService.name, () => {
  beforeEach(async () => {
    defaultDatabase = await getKyselyDB();
  });

  describe('nsfw privacy', () => {
    it('filters owner map markers using private metadata only', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unreviewedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: markedSafe } = await ctx.newAsset({ ownerId: user.id });
      const { asset: markedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: tagOnly } = await ctx.newAsset({ ownerId: user.id });

      await addExif(ctx, [visible, unreviewedNsfw, markedSafe, markedNsfw, tagOnly]);
      await Promise.all([
        ctx.newMetadata({
          assetId: unreviewedNsfw.id,
          key: AssetMetadataKey.MlEnrichment,
          value: nsfwMetadata(true),
        }),
        ctx.newMetadata({
          assetId: markedSafe.id,
          key: AssetMetadataKey.MlEnrichment,
          value: nsfwMetadata(true, { action: 'marked-safe', isNsfw: false }),
        }),
        ctx.newMetadata({
          assetId: markedNsfw.id,
          key: AssetMetadataKey.MlEnrichment,
          value: nsfwMetadata(false, { action: 'marked-nsfw', isNsfw: true }),
        }),
      ]);

      const [visibleNsfwTag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['nsfw'] });
      await ctx.newTagAsset({ tagIds: [visibleNsfwTag.id], assetIds: [tagOnly.id] });

      const hiddenMarkers = await sut.getMapMarkers({ ...auth, hideNsfwAssets: true }, {});
      expect(hiddenMarkers.map(({ id }) => id)).toEqual(
        expect.arrayContaining([visible.id, markedSafe.id, tagOnly.id]),
      );
      expect(hiddenMarkers.map(({ id }) => id)).not.toContain(unreviewedNsfw.id);
      expect(hiddenMarkers.map(({ id }) => id)).not.toContain(markedNsfw.id);

      const elevatedMarkers = await sut.getMapMarkers(auth, {});
      expect(elevatedMarkers.map(({ id }) => id)).toEqual(
        expect.arrayContaining([visible.id, unreviewedNsfw.id, markedSafe.id, markedNsfw.id, tagOnly.id]),
      );
    });

    it('filters shared-album map markers using private metadata, and never maps a partner (FL-326)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partnerOwner } = await ctx.newUser();
      const { user: albumOwner } = await ctx.newUser();
      const auth = factory.auth({ user });

      await ctx.newPartner({ sharedById: partnerOwner.id, sharedWithId: user.id });

      const { asset: partnerVisible } = await ctx.newAsset({ ownerId: partnerOwner.id });
      const { asset: partnerNsfw } = await ctx.newAsset({ ownerId: partnerOwner.id });
      const { asset: albumVisible } = await ctx.newAsset({ ownerId: albumOwner.id });
      const { asset: albumNsfw } = await ctx.newAsset({ ownerId: albumOwner.id });
      const { album } = await ctx.newAlbum({ ownerId: albumOwner.id }, [albumVisible.id, albumNsfw.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: user.id });

      await addExif(ctx, [partnerVisible, partnerNsfw, albumVisible, albumNsfw]);
      await Promise.all([
        ctx.newMetadata({
          assetId: partnerNsfw.id,
          key: AssetMetadataKey.MlEnrichment,
          value: nsfwMetadata(true),
        }),
        ctx.newMetadata({
          assetId: albumNsfw.id,
          key: AssetMetadataKey.MlEnrichment,
          value: nsfwMetadata(true),
        }),
      ]);

      const options = { withSharedAlbums: true };
      const hiddenMarkers = (await sut.getMapMarkers({ ...auth, hideNsfwAssets: true }, options)).map(({ id }) => id);
      expect(hiddenMarkers).toEqual([albumVisible.id]);

      // FL-326: a partner's own rows are never mapped; the viewer's copies are
      const elevatedMarkers = (await sut.getMapMarkers(auth, options)).map(({ id }) => id);
      expect(elevatedMarkers.toSorted()).toEqual([albumVisible.id, albumNsfw.id].toSorted());
      expect(elevatedMarkers).not.toContain(partnerVisible.id);
    });
  });

  it('returns the file name, capture dates and media type on each marker (FL-51)', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalFileName: 'IMG_0042.HEIC',
      type: AssetType.Video,
      fileCreatedAt: new Date('2024-05-06T07:08:09.123Z'),
      localDateTime: new Date('2024-05-06T09:08:09.123Z'),
    });
    await addExif(ctx, [asset]);

    const markers = await sut.getMapMarkers(factory.auth({ user }), {});
    expect(markers).toEqual([
      expect.objectContaining({
        id: asset.id,
        originalFileName: 'IMG_0042.HEIC',
        type: AssetType.Video,
        fileCreatedAt: '2024-05-06T07:08:09.123Z',
        localDateTime: '2024-05-06T09:08:09.123Z',
      }),
    ]);
  });

  describe('one view of a large library (FL-1214)', () => {
    const located = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string, points: Array<[number, number]>) => {
      const assets = [];
      for (const [index, [latitude, longitude]] of points.entries()) {
        const { asset } = await ctx.newAsset({
          ownerId,
          type: index === 0 ? AssetType.Video : AssetType.Image,
          fileCreatedAt: new Date(Date.UTC(2024, 0, 1 + index)),
        });
        await ctx.newExif({ assetId: asset.id, latitude, longitude, city: `city-${index}`, state: null, country: 'C' });
        assets.push(asset);
      }
      return assets;
    };

    it('groups close items into one cell and sends a lone item with its details', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const assets = await located(ctx, user.id, [
        [48.85, 2.35],
        [48.851, 2.351],
        [48.852, 2.352],
        [-33.86, 151.2],
      ]);

      const result = await ctx.get(MapRepository).getMapClusters(user.id, [user.id], [], 4, 0);

      expect(result.total).toBe(4);
      expect(result.bounds).toEqual({ west: 2.35, south: -33.86, east: 151.2, north: 48.852 });
      expect(result.clusters).toEqual([
        expect.objectContaining({ count: 3, videos: 1, country: 'C', lat: expect.closeTo(48.851, 3) }),
      ]);
      expect(assets.slice(0, 3).map(({ id }) => id)).toContain(result.clusters[0].id);
      expect(result.markers).toEqual([expect.objectContaining({ id: assets[3].id, city: 'city-3', country: 'C' })]);
    });

    it('keeps to the area asked for, across the date line too', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const assets = await located(ctx, user.id, [
        [10, 179.5],
        [10, -179.5],
        [10, 0],
      ]);
      const area = { west: 170, south: 0, east: -170, north: 20 };

      const result = await ctx.get(MapRepository).getMapClusters(user.id, [user.id], [], 12, 2000, { area });

      expect(result.total).toBe(2);
      expect(result.clusters).toEqual([]);
      expect(result.markers.map(({ id }) => id).toSorted()).toEqual([assets[0].id, assets[1].id].toSorted());
    });

    it('sends a small library whole, and the In view rows a page at a time, newest first', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const assets = await located(ctx, user.id, [
        [1, 1],
        [1.5, 1.5],
        [2, 2],
        [50, 50],
      ]);

      await expect(sut.getMapClusters(auth, { zoom: 2 })).resolves.toEqual(
        expect.objectContaining({ complete: true, total: 4, clusters: [], markers: expect.any(Array) }),
      );

      const page = { west: 0, south: 0, east: 3, north: 3, take: 2 };
      await expect(sut.getMapMarkers(auth, { ...page, skip: 0 })).resolves.toEqual([
        expect.objectContaining({ id: assets[2].id }),
        expect.objectContaining({ id: assets[1].id }),
      ]);
      await expect(sut.getMapMarkers(auth, { ...page, skip: 2 })).resolves.toEqual([
        expect.objectContaining({ id: assets[0].id }),
      ]);
    });
  });

  describe('revocation and hidden content (FL-51)', () => {
    it("never maps a partner's rows: what they share arrives as the viewer's own copies (FL-326)", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      const auth = factory.auth({ user });
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
      const { asset: theirs } = await ctx.newAsset({ ownerId: partner.id });
      await addExif(ctx, [theirs]);

      await expect(sut.getMapMarkers(auth, {})).resolves.toEqual([]);
      await expect(sut.getMapStatistics(auth, {})).resolves.toEqual(expect.objectContaining({ partner: 0 }));
    });

    it("drops a shared album's markers once the viewer leaves the album", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: albumOwner } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: shared } = await ctx.newAsset({ ownerId: albumOwner.id });
      await addExif(ctx, [shared]);
      const { album } = await ctx.newAlbum({ ownerId: albumOwner.id }, [shared.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: user.id });

      await expect(sut.getMapMarkers(auth, { withSharedAlbums: true })).resolves.toEqual([
        expect.objectContaining({ id: shared.id }),
      ]);
      // without the switch, a shared album's items never reach the viewer's map
      await expect(sut.getMapMarkers(auth, {})).resolves.toEqual([]);

      await defaultDatabase
        .deleteFrom('album_user')
        .where('albumId', '=', album.id)
        .where('userId', '=', user.id)
        .execute();

      await expect(sut.getMapMarkers(auth, { withSharedAlbums: true })).resolves.toEqual([]);
    });

    it('leaves trashed, Locked and hidden items out of the markers and the settings counts', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      const auth = factory.auth({ user });
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      const { asset: located } = await ctx.newAsset({ ownerId: user.id });
      const { asset: archived } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: trashed } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      const { asset: nsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unlocated } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      const { asset: partnerLocated } = await ctx.newAsset({ ownerId: partner.id });
      const { asset: partnerLocked } = await ctx.newAsset({ ownerId: partner.id, visibility: AssetVisibility.Locked });
      const { asset: partnerArchived } = await ctx.newAsset({
        ownerId: partner.id,
        visibility: AssetVisibility.Archive,
      });
      await addExif(ctx, [located, archived, locked, trashed, nsfw, partnerLocated, partnerLocked, partnerArchived]);
      await ctx.newExif({ assetId: unlocated.id, latitude: null, longitude: null });
      await ctx.newMetadata({ assetId: nsfw.id, key: AssetMetadataKey.MlEnrichment, value: nsfwMetadata(true) });

      const ids = async (options: Parameters<MapService['getMapMarkers']>[1], hide = false) =>
        (await sut.getMapMarkers(hide ? { ...auth, hideNsfwAssets: true } : auth, options))
          .map(({ id }) => id)
          .toSorted();

      // FL-326: a partner's own rows are never mapped
      const all = { withSharedAlbums: true, isArchived: true };
      await expect(ids(all)).resolves.toEqual([located.id, archived.id, nsfw.id].toSorted());
      await expect(ids(all, true)).resolves.toEqual([located.id, archived.id].toSorted());
      await expect(ids({})).resolves.toEqual([located.id, nsfw.id].toSorted());

      await expect(sut.getMapStatistics(auth, {})).resolves.toEqual({ archived: 1, partner: 0, unlocated: 1 });
      // the counts follow the session's hidden content like the markers
      await ctx
        .newAsset({ ownerId: user.id })
        .then(({ asset }) =>
          ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MlEnrichment, value: nsfwMetadata(true) }),
        );
      await expect(sut.getMapStatistics(auth, {})).resolves.toEqual({ archived: 1, partner: 0, unlocated: 2 });
      await expect(sut.getMapStatistics({ ...auth, hideNsfwAssets: true }, {})).resolves.toEqual({
        archived: 1,
        partner: 0,
        unlocated: 1,
      });
    });
  });
});
