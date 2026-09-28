import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, vitest } from 'vitest';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { SearchFacetField, SearchHistogramGranularity, SearchSuggestionType } from 'src/dtos/search.dto.js';
import { AssetVisibility, Permission } from 'src/enum.js';
import { SearchService } from 'src/services/search.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { PartnerFactory } from 'test/factories/partner.factory.js';
import { PersonFactory } from 'test/factories/person.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForAsset, getForPartner } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

vitest.useFakeTimers();

describe(SearchService.name, () => {
  let sut: SearchService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SearchService));
    mocks.partner.getAll.mockResolvedValue([]);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('searchPerson', () => {
    it('should pass options to search', async () => {
      const auth = AuthFactory.create();
      const name = 'foo';

      mocks.person.getByName.mockResolvedValue([]);

      await sut.searchPerson(auth, { name, withHidden: false });

      expect(mocks.person.getByName).toHaveBeenCalledWith(auth.user.id, name, { withHidden: false });

      await sut.searchPerson(auth, { name, withHidden: true });

      expect(mocks.person.getByName).toHaveBeenCalledWith(auth.user.id, name, { withHidden: true });
    });
  });

  describe('searchPlaces', () => {
    it('should search places', async () => {
      mocks.search.searchPlaces.mockResolvedValue([
        {
          id: 42,
          name: 'my place',
          latitude: 420,
          longitude: 69,
          admin1Code: null,
          admin1Name: null,
          admin2Code: null,
          admin2Name: null,
          alternateNames: null,
          countryCode: 'US',
          modificationDate: new Date(),
        },
      ]);

      await sut.searchPlaces({ name: 'place' });
      expect(mocks.search.searchPlaces).toHaveBeenCalledWith('place');
    });
  });

  describe('getExploreData', () => {
    it('should get recent assets and assets by city and tag', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.from()
        .exif({ latitude: 42, longitude: 69, city: 'city', state: 'state', country: 'country' })
        .build();
      mocks.asset.getAssetIdByCity.mockResolvedValue({
        fieldName: 'exifInfo.city',
        items: [{ value: 'city', data: asset.id }],
      });
      mocks.asset.getRecentlyCreatedAssetIds.mockResolvedValue({
        fieldName: 'createdAt',
        items: [{ value: asset.createdAt, data: asset.id }],
      });
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([asset as never]);
      const expectedResponse = [
        { fieldName: 'exifInfo.city', items: [{ value: 'city', data: mapAsset(getForAsset(asset)) }] },
        {
          fieldName: 'createdAt',
          items: [{ value: asset.createdAt.toISOString(), data: mapAsset(getForAsset(asset)) }],
        },
      ];

      const result = await sut.getExploreData(auth);

      expect(result).toEqual(expectedResponse);
    });

    it('should exclude NSFW assets when privacy hiding is active', async () => {
      const auth = { ...AuthFactory.create(), hideNsfwAssets: true };
      mocks.asset.getAssetIdByCity.mockResolvedValue({
        fieldName: 'exifInfo.city',
        items: [],
      });
      mocks.asset.getRecentlyCreatedAssetIds.mockResolvedValue({
        fieldName: 'createdAt',
        items: [],
      });
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([]);

      await sut.getExploreData(auth);

      expect(mocks.asset.getAssetIdByCity).toHaveBeenCalledWith(auth.user.id, {
        maxFields: 12,
        minAssetsPerField: 5,
        excludeNsfw: true,
      });
    });
  });

  describe('getSearchSuggestions', () => {
    it('should return search suggestions for country', async () => {
      mocks.search.getCountries.mockResolvedValue(['USA']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: false, type: SearchSuggestionType.COUNTRY }),
      ).resolves.toEqual(['USA']);
      expect(mocks.search.getCountries).toHaveBeenCalledWith([authStub.user1.user.id], {});
    });

    it('should leave partners who hide their locations out of place suggestions only', async () => {
      const me = authStub.user1.user.id;
      const hiding = PartnerFactory.create({ sharedWithId: me, inTimeline: true, shareLocation: false });
      const sharing = PartnerFactory.create({ sharedWithId: me, inTimeline: true, shareLocation: true });
      mocks.partner.getAll.mockResolvedValue([getForPartner(hiding), getForPartner(sharing)]);
      mocks.search.getCities.mockResolvedValue(['Calgary']);
      mocks.search.getCameraMakes.mockResolvedValue(['Canon']);

      await sut.getSearchSuggestions(authStub.user1, { includeNull: false, type: SearchSuggestionType.CITY });
      expect(mocks.search.getCities).toHaveBeenCalledWith([me, sharing.sharedById], expect.anything());

      await sut.getSearchSuggestions(authStub.user1, { includeNull: false, type: SearchSuggestionType.CAMERA_MAKE });
      expect(mocks.search.getCameraMakes).toHaveBeenCalledWith(
        [me, hiding.sharedById, sharing.sharedById],
        expect.anything(),
      );
    });

    it('should exclude NSFW assets from suggestions when privacy hiding is active', async () => {
      const auth = { ...authStub.user1, hideNsfwAssets: true };
      mocks.search.getCountries.mockResolvedValue(['USA']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(auth, { includeNull: false, type: SearchSuggestionType.COUNTRY }),
      ).resolves.toEqual(['USA']);

      expect(mocks.search.getCountries).toHaveBeenCalledWith([auth.user.id], { excludeNsfw: true });
    });

    it('should return search suggestions for country (including null)', async () => {
      mocks.search.getCountries.mockResolvedValue(['USA']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: true, type: SearchSuggestionType.COUNTRY }),
      ).resolves.toEqual(['USA', null]);
      expect(mocks.search.getCountries).toHaveBeenCalledWith([authStub.user1.user.id], {});
    });

    it('should return search suggestions for state', async () => {
      mocks.search.getStates.mockResolvedValue(['California']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: false, type: SearchSuggestionType.STATE }),
      ).resolves.toEqual(['California']);
      expect(mocks.search.getStates).toHaveBeenCalledWith([authStub.user1.user.id], expect.anything());
    });

    it('should return search suggestions for state (including null)', async () => {
      mocks.search.getStates.mockResolvedValue(['California']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: true, type: SearchSuggestionType.STATE }),
      ).resolves.toEqual(['California', null]);
      expect(mocks.search.getStates).toHaveBeenCalledWith([authStub.user1.user.id], expect.anything());
    });

    it('should return search suggestions for city', async () => {
      mocks.search.getCities.mockResolvedValue(['Denver']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: false, type: SearchSuggestionType.CITY }),
      ).resolves.toEqual(['Denver']);
      expect(mocks.search.getCities).toHaveBeenCalledWith([authStub.user1.user.id], expect.anything());
    });

    it('should return search suggestions for city (including null)', async () => {
      mocks.search.getCities.mockResolvedValue(['Denver']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: true, type: SearchSuggestionType.CITY }),
      ).resolves.toEqual(['Denver', null]);
      expect(mocks.search.getCities).toHaveBeenCalledWith([authStub.user1.user.id], expect.anything());
    });

    it('should return search suggestions for camera make', async () => {
      mocks.search.getCameraMakes.mockResolvedValue(['Nikon']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: false, type: SearchSuggestionType.CAMERA_MAKE }),
      ).resolves.toEqual(['Nikon']);
      expect(mocks.search.getCameraMakes).toHaveBeenCalledWith([authStub.user1.user.id], expect.anything());
    });

    it('should return search suggestions for camera make (including null)', async () => {
      mocks.search.getCameraMakes.mockResolvedValue(['Nikon']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: true, type: SearchSuggestionType.CAMERA_MAKE }),
      ).resolves.toEqual(['Nikon', null]);
      expect(mocks.search.getCameraMakes).toHaveBeenCalledWith([authStub.user1.user.id], expect.anything());
    });

    it('should return search suggestions for camera model', async () => {
      mocks.search.getCameraModels.mockResolvedValue(['Fujifilm X100VI']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: false, type: SearchSuggestionType.CAMERA_MODEL }),
      ).resolves.toEqual(['Fujifilm X100VI']);
      expect(mocks.search.getCameraModels).toHaveBeenCalledWith([authStub.user1.user.id], expect.anything());
    });

    it('should return search suggestions for camera model (including null)', async () => {
      mocks.search.getCameraModels.mockResolvedValue(['Fujifilm X100VI']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: true, type: SearchSuggestionType.CAMERA_MODEL }),
      ).resolves.toEqual(['Fujifilm X100VI', null]);
      expect(mocks.search.getCameraModels).toHaveBeenCalledWith([authStub.user1.user.id], expect.anything());
    });

    it('should return search suggestions for camera lens model', async () => {
      mocks.search.getCameraLensModels.mockResolvedValue(['10-24mm']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: false, type: SearchSuggestionType.CAMERA_LENS_MODEL }),
      ).resolves.toEqual(['10-24mm']);
      expect(mocks.search.getCameraLensModels).toHaveBeenCalledWith([authStub.user1.user.id], expect.anything());
    });

    it('should return search suggestions for camera lens model (including null)', async () => {
      mocks.search.getCameraLensModels.mockResolvedValue(['10-24mm']);
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getSearchSuggestions(authStub.user1, { includeNull: true, type: SearchSuggestionType.CAMERA_LENS_MODEL }),
      ).resolves.toEqual(['10-24mm', null]);
      expect(mocks.search.getCameraLensModels).toHaveBeenCalledWith([authStub.user1.user.id], expect.anything());
    });
  });

  describe('new shape routing', () => {
    it('should route a filter request to the V3 search and a flat request to the legacy search', async () => {
      const auth = AuthFactory.create();

      mocks.search.searchMetadataV3.mockResolvedValue({ hasNextPage: false, items: [] });
      await sut.searchMetadata(auth, { size: 250, filter: {} });
      expect(mocks.search.searchMetadataV3).toHaveBeenCalled();
      expect(mocks.search.searchMetadata).not.toHaveBeenCalled();

      mocks.search.searchMetadata.mockResolvedValue({ hasNextPage: false, items: [] });
      await sut.searchMetadata(auth, { size: 250, city: 'Oslo' });
      expect(mocks.search.searchMetadata).toHaveBeenCalled();
    });

    it('should route statistics, random, and smart filter requests to their V3 search', async () => {
      const auth = AuthFactory.create();

      mocks.search.searchStatisticsV3.mockResolvedValue({ total: 0 });
      await expect(sut.searchStatistics(auth, { filter: {} })).resolves.toEqual({ total: 0 });

      mocks.search.searchRandomV3.mockResolvedValue([]);
      await expect(sut.searchRandom(auth, { size: 250, filter: {} })).resolves.toEqual([]);

      mocks.search.searchSmartV3.mockResolvedValue({ hasNextPage: false, items: [] });
      mocks.machineLearning.encodeText.mockResolvedValue('[1, 2, 3]');
      await sut.searchSmart(auth, { size: 100, filter: {}, query: 'test' });
      expect(mocks.search.searchSmartV3).toHaveBeenCalledWith(
        { take: 100 },
        expect.objectContaining({ embedding: '[1, 2, 3]' }),
        expect.objectContaining({ lockedOwnerId: expect.any(String) }),
      );
    });

    it('passes suppression to smart search and rejects suppressed-only requests without elevation', async () => {
      const auth = { ...AuthFactory.create(), hideNsfwAssets: true };
      mocks.search.searchSmartV3.mockResolvedValue({ hasNextPage: false, items: [] });
      mocks.machineLearning.encodeText.mockResolvedValue('[1, 2, 3]');
      await sut.searchSmart(auth, { filter: {}, query: 'private photo' });
      expect(mocks.search.searchSmartV3).toHaveBeenCalledWith(
        { take: 100 },
        expect.objectContaining({ excludeNsfw: true, query: 'private photo' }),
        expect.anything(),
      );
      await expect(sut.searchMetadata(auth, { filter: {}, suppressedOnly: true })).rejects.toThrow(
        'suppressedOnly requires an elevated session',
      );
    });

    it('should reject an invalid cursor', async () => {
      await expect(sut.searchMetadata(AuthFactory.create(), { size: 250, cursor: '???' })).rejects.toThrowError(
        new BadRequestException('Invalid cursor'),
      );
    });

    it('should reject an unelevated session whose filter could match locked assets', async () => {
      const filter = { visibility: { in: [AssetVisibility.Locked, AssetVisibility.Timeline] } };
      await expect(sut.searchMetadata(AuthFactory.create(), { size: 250, filter })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('should reject a shared link whose filter is not confined to albums everywhere', async () => {
      const auth = AuthFactory.from().sharedLink().build();
      const albumId = newUuid();

      await expect(sut.searchMetadata(auth, { size: 250, filter: {} })).rejects.toThrowError(
        new BadRequestException('Shared link access is only allowed in combination with an albumIds filter'),
      );

      await expect(
        sut.searchMetadata(auth, {
          size: 250,
          filter: { or: [{ albumIds: { any: [albumId] } }, { city: { eq: 'Oslo' } }] },
        }),
      ).rejects.toThrowError(
        new BadRequestException('Shared link access is only allowed in combination with an albumIds filter'),
      );
    });

    it('should allow a shared link when every branch is confined to a covered album', async () => {
      const auth = AuthFactory.from().sharedLink().build();
      const albumId = newUuid();

      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set([albumId]));
      mocks.search.searchMetadataV3.mockResolvedValue({ hasNextPage: false, items: [] });

      await expect(
        sut.searchMetadata(auth, { size: 250, filter: { or: [{ albumIds: { any: [albumId] } }] } }),
      ).resolves.toBeDefined();
      expect(mocks.search.searchMetadataV3).toHaveBeenCalled();
    });

    it('should reject a pet filter through a shared link even inside a covered album', async () => {
      const auth = AuthFactory.from().sharedLink().build();
      const albumId = newUuid();
      const petId = newUuid();

      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set([albumId]));

      await expect(
        sut.searchMetadata(auth, { size: 250, filter: { albumIds: { any: [albumId] }, petIds: { any: [petId] } } }),
      ).rejects.toThrowError(new BadRequestException('Pet filters are not available through a shared link'));
      await expect(sut.searchMetadata(auth, { albumIds: [albumId], petIds: [petId] })).rejects.toThrowError(
        new BadRequestException('Pet filters are not available through a shared link'),
      );
      expect(mocks.search.searchMetadataV3).not.toHaveBeenCalled();
      expect(mocks.search.searchMetadata).not.toHaveBeenCalled();
    });

    it('should hand a pet filter to the repository with the caller as the viewer', async () => {
      const auth = AuthFactory.create();
      const petId = newUuid();
      mocks.search.searchMetadataV3.mockResolvedValue({ hasNextPage: false, items: [] });

      await sut.searchMetadata(auth, { size: 250, filter: { petIds: { all: [petId] } } });

      expect(mocks.search.searchMetadataV3).toHaveBeenCalledWith(
        { take: 250, skip: 0 },
        expect.objectContaining({ filter: expect.objectContaining({ petIds: { all: [petId] } }) }),
        expect.objectContaining({ lockedOwnerId: auth.user.id, viewingUserId: auth.user.id }),
      );
    });
  });

  describe('searchSmart', () => {
    beforeEach(() => {
      mocks.search.searchSmart.mockResolvedValue({ hasNextPage: false, items: [] });
      mocks.machineLearning.encodeText.mockResolvedValue('[1, 2, 3]');
    });

    it('should raise a BadRequestException if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { enabled: false },
      });

      await expect(sut.searchSmart(authStub.user1, { query: 'test' })).rejects.toThrowError(
        new BadRequestException('Smart search is not enabled'),
      );
    });

    it('should raise a BadRequestException if smart search is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { clip: { enabled: false } },
      });

      await expect(sut.searchSmart(authStub.user1, { query: 'test' })).rejects.toThrowError(
        new BadRequestException('Smart search is not enabled'),
      );
    });

    it('should work', async () => {
      await sut.searchSmart(authStub.user1, { query: 'test' });

      expect(mocks.machineLearning.encodeText).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        'test',
        expect.objectContaining({ modelName: expect.any(String) }),
      );
      expect(mocks.search.searchSmart).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        {
          query: 'test',
          embedding: '[1, 2, 3]',
          userIds: [authStub.user1.user.id],
          viewingUserId: authStub.user1.user.id,
          visibility: 'not-locked',
          hideLockedMotion: true,
        },
      );
    });

    it('should exclude NSFW assets when privacy hiding is active', async () => {
      const auth = { ...authStub.user1, hideNsfwAssets: true };

      await sut.searchSmart(auth, { query: 'test' });

      expect(mocks.search.searchSmart).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        {
          query: 'test',
          embedding: '[1, 2, 3]',
          userIds: [auth.user.id],
          viewingUserId: auth.user.id,
          excludeNsfw: true,
          visibility: 'not-locked',
          hideLockedMotion: true,
        },
      );
    });

    it('should consider page and size parameters', async () => {
      await sut.searchSmart(authStub.user1, { query: 'test', page: 2, size: 50 });

      expect(mocks.machineLearning.encodeText).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        'test',
        expect.objectContaining({ modelName: expect.any(String) }),
      );
      expect(mocks.search.searchSmart).toHaveBeenCalledWith(
        { page: 2, size: 50 },
        expect.objectContaining({ query: 'test', embedding: '[1, 2, 3]', userIds: [authStub.user1.user.id] }),
      );
    });

    it('should use clip model specified in config', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { clip: { modelName: 'ViT-B-16-SigLIP__webli' } },
      });

      await sut.searchSmart(authStub.user1, { query: 'test' });

      expect(mocks.machineLearning.encodeText).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        'test',
        expect.objectContaining({ modelName: 'ViT-B-16-SigLIP__webli' }),
      );
    });

    it('should use language specified in request', async () => {
      await sut.searchSmart(authStub.user1, { query: 'test', language: 'de' });

      expect(mocks.machineLearning.encodeText).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: expect.any(String), workload: expect.any(String) }),
        'test',
        expect.objectContaining({ language: 'de' }),
      );
    });
  });

  describe('Locked media in the flat (legacy) searches', () => {
    const partnerSetup = () => {
      const auth = AuthFactory.from().session({ hasElevatedPermission: true }).build();
      const partner = PartnerFactory.create({ sharedWithId: auth.user.id, inTimeline: true });
      mocks.partner.getAll.mockResolvedValue([getForPartner(partner)]);
      mocks.search.searchMetadata.mockResolvedValue({ hasNextPage: false, items: [] });
      mocks.search.searchStatistics.mockResolvedValue({ total: 0 });
      mocks.search.searchRandom.mockResolvedValue([]);
      mocks.search.searchLargeAssets.mockResolvedValue([]);
      mocks.search.searchSmart.mockResolvedValue({ hasNextPage: false, items: [] });
      mocks.machineLearning.encodeText.mockResolvedValue('[1, 2, 3]');
      return { auth, partnerId: partner.sharedById };
    };

    it("scopes an elevated session's Locked media to its own owner when partners are searched too", async () => {
      const { auth, partnerId } = partnerSetup();
      const scoped = expect.objectContaining({
        userIds: [auth.user.id, partnerId],
        lockedOwnerId: auth.user.id,
      });

      await sut.searchMetadata(auth, { size: 250 });
      expect(mocks.search.searchMetadata).toHaveBeenCalledWith({ page: 1, size: 250 }, scoped);

      await sut.searchStatistics(auth, {});
      expect(mocks.search.searchStatistics).toHaveBeenCalledWith(scoped);

      await sut.searchRandom(auth, { size: 10 });
      expect(mocks.search.searchRandom).toHaveBeenCalledWith(10, scoped);

      await sut.searchLargeAssets(auth, { size: 10 });
      expect(mocks.search.searchLargeAssets).toHaveBeenCalledWith(10, scoped);

      await sut.searchSmart(auth, { query: 'beach' });
      expect(mocks.search.searchSmart).toHaveBeenCalledWith({ page: 1, size: 100 }, scoped);
    });

    it('never names a Locked owner for a session that is not elevated', async () => {
      const auth = AuthFactory.create();
      mocks.search.searchMetadata.mockResolvedValue({ hasNextPage: false, items: [] });

      await sut.searchMetadata(auth, { size: 250 });

      const options = mocks.search.searchMetadata.mock.calls[0][1];
      expect(options.visibility).toBe('not-locked');
      expect(options.lockedOwnerId).toBeUndefined();
    });

    it('never names a Locked owner for a shared link, even inside its album', async () => {
      const auth = AuthFactory.from().sharedLink().build();
      const albumId = newUuid();
      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set([albumId]));
      mocks.search.searchMetadata.mockResolvedValue({ hasNextPage: false, items: [] });

      await sut.searchMetadata(auth, { size: 250, albumIds: [albumId] });

      expect(mocks.search.searchMetadata.mock.calls[0][1].lockedOwnerId).toBeUndefined();
    });

    it('keeps owners who hide their locations out of an album search by place (FL-54)', async () => {
      const auth = AuthFactory.create();
      const albumId = newUuid();
      const hidingFromAlbumOwner = newUuid();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      mocks.partner.getAll.mockResolvedValue([]);
      mocks.partner.getLocationHiddenOwnerIdsForAlbums.mockResolvedValue([hidingFromAlbumOwner]);
      mocks.search.searchMetadata.mockResolvedValue({ hasNextPage: false, items: [] });
      mocks.search.searchMetadataV3.mockResolvedValue({ hasNextPage: false, items: [] });

      await sut.searchMetadata(auth, { size: 250, albumIds: [albumId], city: 'Oslo' });
      expect(mocks.search.searchMetadata.mock.calls[0][1].locationHiddenOwnerIds).toEqual([hidingFromAlbumOwner]);
      expect(mocks.partner.getLocationHiddenOwnerIdsForAlbums).toHaveBeenCalledWith([albumId], auth.user.id);

      await sut.searchMetadata(auth, { size: 250, filter: { albumIds: { any: [albumId] }, city: { eq: 'Oslo' } } });
      expect(mocks.search.searchMetadataV3.mock.calls[0][2]).toMatchObject({
        locationHiddenOwnerIds: [hidingFromAlbumOwner],
      });
    });

    it('adds no owner exclusion to an album search without a place filter (FL-54)', async () => {
      const auth = AuthFactory.create();
      const albumId = newUuid();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      mocks.search.searchMetadata.mockResolvedValue({ hasNextPage: false, items: [] });

      await sut.searchMetadata(auth, { size: 250, albumIds: [albumId] });

      expect(mocks.search.searchMetadata.mock.calls[0][1].locationHiddenOwnerIds).toBeUndefined();
      expect(mocks.partner.getLocationHiddenOwnerIdsForAlbums).not.toHaveBeenCalled();
    });

    it('leaves the motion parts of Locked live photos out of every search (FL-34)', async () => {
      const { auth } = partnerSetup();
      mocks.search.searchMetadataV3.mockResolvedValue({ hasNextPage: false, items: [] });

      await sut.searchMetadata(auth, { size: 250 });
      expect(mocks.search.searchMetadata).toHaveBeenCalledWith(
        { page: 1, size: 250 },
        expect.objectContaining({ hideLockedMotion: true, lockedOwnerId: auth.user.id }),
      );

      await sut.searchMetadata(auth, { filter: {} });
      expect(mocks.search.searchMetadataV3).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ lockedMotion: { lockedOwnerId: auth.user.id } }),
      );
    });

    it('keeps an explicit Locked request to the caller alone', async () => {
      const { auth } = partnerSetup();

      await sut.searchMetadata(auth, { size: 250, visibility: AssetVisibility.Locked });

      expect(mocks.search.searchMetadata).toHaveBeenCalledWith(
        { page: 1, size: 250 },
        expect.objectContaining({
          userIds: [auth.user.id],
          visibility: AssetVisibility.Locked,
          lockedOwnerId: auth.user.id,
        }),
      );
    });
  });

  describe('askSearch', () => {
    beforeEach(() => {
      mocks.search.searchSmart.mockResolvedValue({ hasNextPage: false, items: [] });
      mocks.search.searchMetadata.mockResolvedValue({ hasNextPage: false, items: [] });
      mocks.machineLearning.encodeText.mockResolvedValue('[1, 2, 3]');
      mocks.person.getByName.mockResolvedValue([]);
      mocks.search.searchPetsByName.mockResolvedValue([]);
    });

    it('should answer natural language searches with smart search and structured filters', async () => {
      const result = await sut.askSearch(authStub.user1, { query: 'photos of Alice in Banff last summer' });

      expect(result.plan.mode).toBe('smart');
      expect(result.plan.filters).toEqual(
        expect.objectContaining({
          city: 'Banff',
          type: 'IMAGE',
          withExif: true,
        }),
      );
      expect(result.warnings).toEqual([
        'People names are searched semantically until Ask Search can resolve names to person IDs.',
      ]);
      expect(mocks.search.searchSmart).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        expect.objectContaining({
          city: 'Banff',
          embedding: '[1, 2, 3]',
          query: 'photos of Alice in Banff last summer',
          userIds: [authStub.user1.user.id],
        }),
      );
    });

    it('caps the whole answer at Most answers shown, across pages (FL-31)', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ localFeatures: { askSearch: { enabled: true, maxResults: 20 } } });
      // only the number of items matters here
      const assets = (count: number) => Array.from({ length: count }, () => AssetFactory.create()) as never[];
      mocks.search.searchSmart.mockResolvedValueOnce({ hasNextPage: true, items: assets(20) });

      const first = await sut.askSearch(authStub.user1, { query: 'beach' });

      expect(mocks.search.searchSmart).toHaveBeenCalledWith({ page: 1, size: 20 }, expect.anything());
      expect(first.results.assets.items).toHaveLength(20);
      expect(first.results.assets.nextPage).toBeNull();

      // a smaller page size: the page that reaches the limit is trimmed and ends the answer
      mocks.search.searchSmart.mockResolvedValueOnce({ hasNextPage: true, items: assets(15) });
      const last = await sut.askSearch(authStub.user1, { query: 'beach', page: 2, size: 15 });
      expect(last.results.assets.items).toHaveLength(5);
      expect(last.results.assets.count).toBe(5);
      expect(last.results.assets.nextPage).toBeNull();

      mocks.search.searchSmart.mockResolvedValueOnce({ hasNextPage: true, items: assets(15) });
      const beyond = await sut.askSearch(authStub.user1, { query: 'beach', page: 3, size: 15 });
      expect(beyond.results.assets.items).toEqual([]);
      expect(beyond.results.assets.nextPage).toBeNull();

      mocks.search.searchSmart.mockResolvedValueOnce({ hasNextPage: true, items: assets(10) });
      const within = await sut.askSearch(authStub.user1, { query: 'beach', page: 1, size: 10 });
      expect(within.results.assets.nextPage).toBe('2');
    });

    it('should understand relative date phrases', async () => {
      vitest.setSystemTime(new Date('2026-05-15T12:00:00.000Z'));

      const result = await sut.askSearch(authStub.user1, { query: 'photos from last month' });

      expect(result.plan.filters).toEqual(
        expect.objectContaining({
          takenAfter: new Date('2026-04-01T00:00:00.000Z'),
          takenBefore: new Date('2026-04-30T23:59:59.999Z'),
        }),
      );
      expect(mocks.search.searchSmart).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        expect.objectContaining({
          takenAfter: new Date('2026-04-01T00:00:00.000Z'),
          takenBefore: new Date('2026-04-30T23:59:59.999Z'),
        }),
      );
    });

    it('should understand open-ended year phrases', async () => {
      const result = await sut.askSearch(authStub.user1, { query: 'videos since 2020' });

      expect(result.plan.filters).toEqual(
        expect.objectContaining({
          takenAfter: new Date('2020-01-01T00:00:00.000Z'),
          takenBefore: undefined,
          type: 'VIDEO',
        }),
      );
      expect(mocks.search.searchSmart).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        expect.objectContaining({
          takenAfter: new Date('2020-01-01T00:00:00.000Z'),
          takenBefore: undefined,
          type: 'VIDEO',
        }),
      );
    });

    it('should understand named month phrases', async () => {
      const result = await sut.askSearch(authStub.user1, { query: 'photos from April 2024' });

      expect(result.plan.filters).toEqual(
        expect.objectContaining({
          takenAfter: new Date('2024-04-01T00:00:00.000Z'),
          takenBefore: new Date('2024-04-30T23:59:59.999Z'),
        }),
      );
      expect(mocks.search.searchSmart).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        expect.objectContaining({
          takenAfter: new Date('2024-04-01T00:00:00.000Z'),
          takenBefore: new Date('2024-04-30T23:59:59.999Z'),
        }),
      );
    });

    it('should understand open-ended named month phrases', async () => {
      const beforeResult = await sut.askSearch(authStub.user1, { query: 'photos before April 2024' });

      expect(beforeResult.plan.filters).toEqual(
        expect.objectContaining({
          takenAfter: undefined,
          takenBefore: new Date('2024-04-01T00:00:00.000Z'),
        }),
      );
      expect(mocks.search.searchSmart).toHaveBeenLastCalledWith(
        { page: 1, size: 100 },
        expect.objectContaining({
          takenAfter: undefined,
          takenBefore: new Date('2024-04-01T00:00:00.000Z'),
        }),
      );

      const afterResult = await sut.askSearch(authStub.user1, { query: 'photos after April 2024' });

      expect(afterResult.plan.filters).toEqual(
        expect.objectContaining({
          takenAfter: new Date('2024-04-01T00:00:00.000Z'),
          takenBefore: undefined,
        }),
      );
      expect(mocks.search.searchSmart).toHaveBeenLastCalledWith(
        { page: 1, size: 100 },
        expect.objectContaining({
          takenAfter: new Date('2024-04-01T00:00:00.000Z'),
          takenBefore: undefined,
        }),
      );

      const sinceResult = await sut.askSearch(authStub.user1, { query: 'photos since April 2024' });

      expect(sinceResult.plan.filters).toEqual(
        expect.objectContaining({
          takenAfter: new Date('2024-04-01T00:00:00.000Z'),
          takenBefore: undefined,
        }),
      );
    });

    it('should resolve people names into person filters when possible', async () => {
      const person = PersonFactory.create({
        personGroupId: 'person-1',
        name: 'Alice',
        ownerId: authStub.user1.user.id,
      });
      mocks.person.getByName.mockResolvedValue([person]);

      const result = await sut.askSearch(authStub.user1, { query: 'photos of Alice in Banff' });

      expect(result.warnings).toEqual([]);
      expect(result.plan.filters).toEqual(expect.objectContaining({ personIds: ['person-1'], city: 'Banff' }));
      expect(mocks.person.getByName).toHaveBeenCalledWith(authStub.user1.user.id, 'Alice', { withHidden: false });
      expect(mocks.search.searchSmart).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        expect.objectContaining({
          personIds: ['person-1'],
          city: 'Banff',
        }),
      );
    });

    it('should not resolve people names for API keys without person read permission', async () => {
      const auth = AuthFactory.from(authStub.user1.user)
        .apiKey({ permissions: [Permission.AssetRead] })
        .build();

      const result = await sut.askSearch(auth, { query: 'photos of Alice in Banff' });

      expect(result.plan.filters).toEqual(expect.not.objectContaining({ personIds: expect.anything() }));
      expect(result.warnings).toEqual([
        'People names are searched semantically until Ask Search can resolve names to person IDs.',
      ]);
      expect(mocks.person.getByName).not.toHaveBeenCalled();
      expect(mocks.search.searchSmart).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        expect.not.objectContaining({
          personIds: expect.anything(),
        }),
      );
    });

    it('should resolve lowercase people names and warn when they cannot be resolved', async () => {
      const person = PersonFactory.create({
        personGroupId: 'person-1',
        name: 'Alice',
        ownerId: authStub.user1.user.id,
      });
      mocks.person.getByName.mockResolvedValueOnce([person]);

      const resolvedResult = await sut.askSearch(authStub.user1, { query: 'photos of alice in Banff' });

      expect(resolvedResult.warnings).toEqual([]);
      expect(resolvedResult.plan.filters).toEqual(expect.objectContaining({ personIds: ['person-1'] }));
      expect(mocks.person.getByName).toHaveBeenCalledWith(authStub.user1.user.id, 'alice', { withHidden: false });

      mocks.person.getByName.mockResolvedValueOnce([]);

      const fallbackResult = await sut.askSearch(authStub.user1, { query: 'photos of alice in Banff' });

      expect(fallbackResult.plan.filters).toEqual(expect.not.objectContaining({ personIds: expect.anything() }));
      expect(fallbackResult.warnings).toEqual([
        'People names are searched semantically until Ask Search can resolve names to person IDs.',
      ]);
    });

    it('should resolve a pet name into the caller’s own pet filter', async () => {
      const petId = newUuid();
      mocks.search.searchPetsByName.mockResolvedValue([{ id: petId, name: 'Biscuit' }]);

      const result = await sut.askSearch(authStub.user1, { query: 'photos of biscuit in Banff' });

      expect(result.warnings).toEqual([]);
      expect(result.plan.filters).toEqual(expect.objectContaining({ petIds: [petId], city: 'Banff' }));
      expect(result.plan.filters).toEqual(expect.not.objectContaining({ personIds: expect.anything() }));
      expect(mocks.search.searchPetsByName).toHaveBeenCalledWith(authStub.user1.user.id, 'biscuit', {});
      expect(mocks.search.searchSmart).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        expect.objectContaining({ petIds: [petId], viewingUserId: authStub.user1.user.id }),
      );
    });

    it('should resolve people and pets named together', async () => {
      const petId = newUuid();
      const person = PersonFactory.create({
        personGroupId: 'person-1',
        name: 'Alice',
        ownerId: authStub.user1.user.id,
      });
      mocks.person.getByName.mockImplementation((_userId, name) => Promise.resolve(name === 'Alice' ? [person] : []));
      mocks.search.searchPetsByName.mockImplementation((_ownerId, name) =>
        Promise.resolve(name === 'Rex' ? [{ id: petId, name: 'Rex' }] : []),
      );

      const result = await sut.askSearch(authStub.user1, { query: 'photos with Alice and Rex' });

      expect(result.plan.filters).toEqual(expect.objectContaining({ personIds: ['person-1'], petIds: [petId] }));
    });

    it('should prefer an exact name, a person before a pet, then the closest person', async () => {
      const petId = newUuid();
      const ownerId = authStub.user1.user.id;
      const alex = PersonFactory.create({ personGroupId: 'person-alex', name: 'Alexander', ownerId });
      const max = PersonFactory.create({ personGroupId: 'person-max', name: 'Max', ownerId });

      // an exact pet name beats a fuzzy person match
      mocks.person.getByName.mockResolvedValueOnce([alex]);
      mocks.search.searchPetsByName.mockResolvedValueOnce([{ id: petId, name: 'Alex' }]);
      const exactPet = await sut.askSearch(authStub.user1, { query: 'photos of alex' });
      expect(exactPet.plan.filters).toEqual(expect.objectContaining({ petIds: [petId] }));
      expect(exactPet.plan.filters).toEqual(expect.not.objectContaining({ personIds: expect.anything() }));

      // an exact person name beats an exact pet name
      mocks.person.getByName.mockResolvedValueOnce([max]);
      mocks.search.searchPetsByName.mockResolvedValueOnce([{ id: petId, name: 'Max' }]);
      const exactPerson = await sut.askSearch(authStub.user1, { query: 'photos of max' });
      expect(exactPerson.plan.filters).toEqual(expect.objectContaining({ personIds: ['person-max'] }));
      expect(exactPerson.plan.filters).toEqual(expect.not.objectContaining({ petIds: expect.anything() }));

      // with no exact name the closest person wins over the closest pet, as before pets existed
      mocks.person.getByName.mockResolvedValueOnce([alex]);
      mocks.search.searchPetsByName.mockResolvedValueOnce([{ id: petId, name: 'Alexa' }]);
      const fuzzy = await sut.askSearch(authStub.user1, { query: 'photos of alexandr' });
      expect(fuzzy.plan.filters).toEqual(expect.objectContaining({ personIds: ['person-alex'] }));
      expect(fuzzy.plan.filters).toEqual(expect.not.objectContaining({ petIds: expect.anything() }));
    });

    it('should resolve pets with the session privacy so suppressed pets stay unresolved', async () => {
      const hiddenContent = {
        userId: authStub.user1.user.id,
        includeNsfw: false,
        tagIds: [],
        personIds: [],
        petIds: [newUuid()],
        scope: 'owned' as const,
      };
      const auth = { ...authStub.user1, hiddenContent, hideNsfwAssets: true };

      const result = await sut.askSearch(auth, { query: 'photos of Biscuit' });

      expect(mocks.search.searchPetsByName).toHaveBeenCalledWith(auth.user.id, 'Biscuit', { hiddenContent });
      expect(mocks.person.getByName).toHaveBeenCalledWith(auth.user.id, 'Biscuit', {
        hiddenContent,
        withHidden: false,
      });
      expect(result.warnings).toEqual([
        'People names are searched semantically until Ask Search can resolve names to person IDs.',
      ]);
    });

    it('should still resolve pets for an API key without person read permission', async () => {
      const petId = newUuid();
      const auth = AuthFactory.from(authStub.user1.user)
        .apiKey({ permissions: [Permission.AssetRead] })
        .build();
      mocks.search.searchPetsByName.mockResolvedValue([{ id: petId, name: 'Biscuit' }]);

      const result = await sut.askSearch(auth, { query: 'photos of Biscuit' });

      expect(mocks.person.getByName).not.toHaveBeenCalled();
      expect(result.plan.filters).toEqual(expect.objectContaining({ petIds: [petId] }));
    });

    it('should use OCR-backed metadata search for document-like queries', async () => {
      const result = await sut.askSearch(authStub.user1, { query: 'receipts from 2024' });

      expect(result.plan.mode).toBe('metadata');
      expect(result.plan.filters).toEqual(
        expect.objectContaining({
          ocr: 'receipt invoice total tax',
          takenAfter: new Date('2024-01-01T00:00:00.000Z'),
          takenBefore: new Date('2024-12-31T23:59:59.999Z'),
        }),
      );
      expect(mocks.search.searchMetadata).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        expect.objectContaining({
          ocr: 'receipt invoice total tax',
          userIds: [authStub.user1.user.id],
        }),
      );
      expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
    });

    it('should use metadata filename search for screenshots', async () => {
      const result = await sut.askSearch(authStub.user1, { query: 'screenshots from last year' });

      expect(result.plan.mode).toBe('metadata');
      expect(result.plan.filters).toEqual(
        expect.objectContaining({
          originalFileName: 'Screenshot',
          takenAfter: new Date(`${new Date().getUTCFullYear() - 1}-01-01T00:00:00.000Z`),
          takenBefore: new Date(`${new Date().getUTCFullYear() - 1}-12-31T23:59:59.999Z`),
        }),
      );
      expect(mocks.search.searchMetadata).toHaveBeenCalledWith(
        { page: 1, size: 100 },
        expect.objectContaining({
          originalFileName: 'Screenshot',
          userIds: [authStub.user1.user.id],
        }),
      );
      expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
    });

    it('should reject when Ask Search is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ localFeatures: { askSearch: { enabled: false, maxResults: 100 } } });

      await expect(sut.askSearch(authStub.user1, { query: 'dogs' })).rejects.toThrowError(
        new BadRequestException('Ask Search is not enabled'),
      );
    });
  });

  describe('FL-49 facets, histogram and smart counts', () => {
    it('counts facets over the statistics scope and names nothing the session keeps Locked', async () => {
      const me = authStub.user1.user.id;
      const hiding = PartnerFactory.create({ sharedWithId: me, inTimeline: true, shareLocation: false });
      mocks.partner.getAll.mockResolvedValue([getForPartner(hiding)]);
      mocks.search.searchFacets.mockResolvedValue({
        total: 3,
        rows: [
          { field: SearchFacetField.Type, value: 'IMAGE', label: null, count: 3, coverAssetId: null },
          { field: SearchFacetField.People, value: 'person-1', label: 'Emma', count: 2, coverAssetId: null },
        ],
      });
      const hiddenContent = {
        userId: me,
        includeNsfw: false,
        tagIds: ['tag-locked'],
        personIds: ['person-locked'],
        petIds: [],
        scope: 'owned' as const,
      };
      const auth = { ...authStub.user1, hiddenContent };

      const result = await sut.searchFacets(auth, {
        city: 'Lisbon',
        // a repeated facet is counted once
        facets: [SearchFacetField.Type, SearchFacetField.People, SearchFacetField.Type],
      });

      expect(result).toEqual({
        total: 3,
        facets: [
          { fieldName: 'type', counts: [{ value: 'IMAGE', count: 3 }] },
          { fieldName: 'people', counts: [{ value: 'person-1', label: 'Emma', count: 2 }] },
        ],
      });
      const [options, facetOptions] = mocks.search.searchFacets.mock.calls[0];
      // a place filter leaves out partners who hide their locations, exactly as statistics does
      expect(options).toEqual(
        expect.objectContaining({ userIds: [me], visibility: 'not-locked', hiddenContent, hideLockedMotion: true }),
      );
      // the total comes from the facet statement, not a second statistics scan
      expect(mocks.search.searchStatistics).not.toHaveBeenCalled();
      expect(facetOptions).toEqual({
        viewerId: me,
        facets: [SearchFacetField.Type, SearchFacetField.People],
        limit: 10,
        locationHiddenOwnerIds: [hiding.sharedById],
        suppressedPersonIds: ['person-locked'],
        suppressedTagIds: ['tag-locked'],
        covers: false,
      });
    });

    it('returns a cover per value only when asked, in the same scope as the counts (Explore, FL-50)', async () => {
      mocks.search.searchFacets.mockResolvedValue({
        total: 2,
        rows: [
          { field: SearchFacetField.City, value: 'Lisbon', label: null, count: 2, coverAssetId: 'asset-new' },
          { field: SearchFacetField.Tags, value: 'tag-1', label: 'beach', count: 1, coverAssetId: 'asset-tag' },
        ],
      });

      const result = await sut.searchFacets(authStub.user1, {
        visibility: AssetVisibility.Timeline,
        facets: [SearchFacetField.City, SearchFacetField.Tags],
        facetCovers: true,
      });

      expect(result.facets).toEqual([
        { fieldName: 'city', counts: [{ value: 'Lisbon', count: 2, coverAssetId: 'asset-new' }] },
        { fieldName: 'tags', counts: [{ value: 'tag-1', label: 'beach', count: 1, coverAssetId: 'asset-tag' }] },
      ]);
      const [options, facetOptions] = mocks.search.searchFacets.mock.calls[0];
      expect(options).toEqual(expect.objectContaining({ visibility: AssetVisibility.Timeline }));
      expect(options).not.toHaveProperty('facetCovers');
      expect(facetOptions).toEqual(expect.objectContaining({ covers: true }));
    });

    it('uses the structured scope for a filter body', async () => {
      mocks.search.searchFacetsV3.mockResolvedValue({ total: 0, rows: [] });
      const result = await sut.searchFacets(authStub.user1, { filter: { isFavorite: { eq: true } } });
      expect(result.facets.map(({ fieldName }) => fieldName)).toEqual(Object.values(SearchFacetField));
      expect(mocks.search.searchFacetsV3).toHaveBeenCalledWith(
        expect.objectContaining({ filter: expect.objectContaining({ isFavorite: { eq: true } }) }),
        expect.objectContaining({ userIds: [authStub.user1.user.id], lockedOwnerId: authStub.user1.user.id }),
        expect.anything(),
      );
      expect(mocks.search.searchFacets).not.toHaveBeenCalled();
    });

    it('requires an elevated session for Locked facets and histograms', async () => {
      await expect(sut.searchFacets(authStub.user1, { visibility: AssetVisibility.Locked })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(
        sut.searchHistogram(authStub.user1, {
          visibility: AssetVisibility.Locked,
          granularity: SearchHistogramGranularity.Year,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('sums the histogram buckets into the total', async () => {
      mocks.search.searchHistogram.mockResolvedValue([
        { date: '2024-01-01', count: 2 },
        { date: '2024-02-01', count: 5 },
      ]);
      await expect(
        sut.searchHistogram(authStub.user1, { granularity: SearchHistogramGranularity.Month }),
      ).resolves.toEqual({
        granularity: 'month',
        total: 7,
        buckets: [
          { date: '2024-01-01', count: 2 },
          { date: '2024-02-01', count: 5 },
        ],
      });
    });

    it('counts smart search results without encoding the query', async () => {
      mocks.search.searchSmartCount.mockResolvedValue({ total: 1000, capped: true });
      await expect(sut.searchSmartStatistics(authStub.user1, { query: 'beach', size: 5 })).resolves.toEqual({
        total: 1000,
        capped: true,
      });
      expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
      const [options] = mocks.search.searchSmartCount.mock.calls[0];
      expect(options).not.toHaveProperty('query');
      expect(options).not.toHaveProperty('size');
      await expect(sut.searchSmartStatistics(authStub.user1, {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a smart count when smart search is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });
      await expect(sut.searchSmartStatistics(authStub.user1, { query: 'beach' })).rejects.toThrowError(
        new BadRequestException('Smart search is not enabled'),
      );
    });
  });
});
