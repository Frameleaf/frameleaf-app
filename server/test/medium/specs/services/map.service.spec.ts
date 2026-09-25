import { Kysely } from 'kysely';
import { AssetMetadataKey, AssetType } from 'src/enum.js';
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
      expect(hiddenMarkers.map(({ id }) => id)).not.toEqual(expect.arrayContaining([unreviewedNsfw.id, markedNsfw.id]));

      const elevatedMarkers = await sut.getMapMarkers(auth, {});
      expect(elevatedMarkers.map(({ id }) => id)).toEqual(
        expect.arrayContaining([visible.id, unreviewedNsfw.id, markedSafe.id, markedNsfw.id, tagOnly.id]),
      );
    });

    it('filters partner and shared-album map markers using private metadata', async () => {
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

      const options = { withPartners: true, withSharedAlbums: true };
      const hiddenMarkers = await sut.getMapMarkers({ ...auth, hideNsfwAssets: true }, options);
      expect(hiddenMarkers.map(({ id }) => id)).toEqual(expect.arrayContaining([partnerVisible.id, albumVisible.id]));
      expect(hiddenMarkers.map(({ id }) => id)).not.toEqual(expect.arrayContaining([partnerNsfw.id, albumNsfw.id]));

      const elevatedMarkers = await sut.getMapMarkers(auth, options);
      expect(elevatedMarkers.map(({ id }) => id)).toEqual(
        expect.arrayContaining([partnerVisible.id, partnerNsfw.id, albumVisible.id, albumNsfw.id]),
      );
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

  describe('partner location (FL-54)', () => {
    it("keeps a hiding owner's shared-album items off the viewer's map and the album map", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: hiding } = await ctx.newUser();
      const auth = factory.auth({ user });
      await ctx.newPartner({ sharedById: hiding.id, sharedWithId: user.id });
      await defaultDatabase
        .updateTable('partner')
        .set({ shareLocation: false })
        .where('sharedById', '=', hiding.id)
        .where('sharedWithId', '=', user.id)
        .execute();

      const { asset: mine } = await ctx.newAsset({ ownerId: user.id });
      const { asset: theirs } = await ctx.newAsset({ ownerId: hiding.id });
      await addExif(ctx, [mine, theirs]);
      const { album } = await ctx.newAlbum({ ownerId: hiding.id }, [mine.id, theirs.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: user.id });

      const markers = await sut.getMapMarkers(auth, { withSharedAlbums: true });
      expect(markers.map(({ id }) => id)).toEqual([mine.id]);

      const albumMarkers = await ctx
        .get(MapRepository)
        .getAlbumMapMarkers(album.id, { locationHiddenOwnerIds: [hiding.id] });
      expect(albumMarkers.map(({ id }) => id)).toEqual([mine.id]);
    });
  });
});
