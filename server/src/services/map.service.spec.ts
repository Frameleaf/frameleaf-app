import { MapService } from 'src/services/map.service.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { userStub } from 'test/fixtures/user.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(MapService.name, () => {
  let sut: MapService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MapService));
    mocks.partner.getAll.mockResolvedValue([]);
  });

  describe('getMapMarkers', () => {
    it('should get geo information of assets', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.from()
        .exif({ latitude: 42, longitude: 69, city: 'city', state: 'state', country: 'country' })
        .build();
      const marker = {
        id: asset.id,
        lat: asset.exifInfo.latitude!,
        lon: asset.exifInfo.longitude!,
        city: asset.exifInfo.city,
        state: asset.exifInfo.state,
        country: asset.exifInfo.country,
        originalFileName: asset.originalFileName,
        type: asset.type,
        fileCreatedAt: asset.fileCreatedAt.toISOString(),
        localDateTime: asset.localDateTime.toISOString(),
      };
      mocks.partner.getAll.mockResolvedValue([]);
      mocks.map.getMapMarkers.mockResolvedValue([marker]);

      const markers = await sut.getMapMarkers(auth, {});

      expect(markers).toHaveLength(1);
      expect(markers[0]).toEqual(marker);
    });

    it('should exclude NSFW assets when privacy hiding is active', async () => {
      const auth = { ...AuthFactory.create(), hideNsfwAssets: true };
      mocks.partner.getAll.mockResolvedValue([]);
      mocks.map.getMapMarkers.mockResolvedValue([]);

      await sut.getMapMarkers(auth, {});

      expect(mocks.map.getMapMarkers).toHaveBeenCalledWith(auth.user.id, [auth.user.id], [], { excludeNsfw: true });
    });

    it('should include assets from shared albums', async () => {
      const auth = AuthFactory.create(userStub.user1);
      const asset = AssetFactory.from()
        .exif({ latitude: 42, longitude: 69, city: 'city', state: 'state', country: 'country' })
        .build();
      const marker = {
        id: asset.id,
        lat: asset.exifInfo.latitude!,
        lon: asset.exifInfo.longitude!,
        city: asset.exifInfo.city,
        state: asset.exifInfo.state,
        country: asset.exifInfo.country,
        originalFileName: asset.originalFileName,
        type: asset.type,
        fileCreatedAt: asset.fileCreatedAt.toISOString(),
        localDateTime: asset.localDateTime.toISOString(),
      };
      mocks.partner.getAll.mockResolvedValue([]);
      mocks.map.getMapMarkers.mockResolvedValue([marker]);
      const album1 = AlbumFactory.create();
      const album2 = AlbumFactory.from().albumUser({ userId: userStub.user1.id }).build();
      mocks.album.getAllIds.mockResolvedValue([album1.id, album2.id]);

      const markers = await sut.getMapMarkers(auth, { withSharedAlbums: true });

      expect(markers).toHaveLength(1);
      expect(markers[0]).toEqual(marker);
      expect(mocks.album.getAllIds).toHaveBeenCalledWith(auth.user.id);
    });
  });

  describe('getMapStatistics (FL-51)', () => {
    it("counts no partner items: partners' items are the viewer's own copies (FL-326)", async () => {
      const auth = AuthFactory.create();
      mocks.map.getMapStatistics.mockResolvedValue({ archived: 2, partner: 0, unlocated: 4 });

      await expect(sut.getMapStatistics(auth, { isFavorite: true })).resolves.toEqual({
        archived: 2,
        partner: 0,
        unlocated: 4,
      });
      expect(mocks.map.getMapStatistics).toHaveBeenCalledWith(
        auth.user.id,
        [],
        expect.objectContaining({ isFavorite: true }),
      );
      expect(mocks.partner.getAll).not.toHaveBeenCalled();
    });
  });

  describe('reverseGeocode', () => {
    it('should reverse geocode a location', async () => {
      mocks.map.reverseGeocode.mockResolvedValue({ city: 'foo', state: 'bar', country: 'baz' });

      await expect(sut.reverseGeocode({ lat: 42, lon: 69 })).resolves.toEqual([
        { city: 'foo', state: 'bar', country: 'baz' },
      ]);

      expect(mocks.map.reverseGeocode).toHaveBeenCalledWith({ latitude: 42, longitude: 69 });
    });
  });
});
