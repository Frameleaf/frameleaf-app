import { Kysely } from 'kysely';
import type { HiddenContentFilter } from 'src/utils/hidden-content.js';
import { SearchSuggestionType } from 'src/dtos/search.dto.js';
import {
  AlbumUserRole,
  AssetLockReason,
  AssetMetadataKey,
  AssetOrder,
  AssetType,
  AssetVisibility,
  ImageEnrichmentFilter,
  SearchOrderField,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { SearchService } from 'src/services/search.service.js';
import { upsertTags } from 'src/utils/tag.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(SearchService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AssetRepository,
      ConfigRepository,
      DatabaseRepository,
      SearchRepository,
      PartnerRepository,
      PersonRepository,
      SystemMetadataRepository,
      TagRepository,
    ],
    mock: [LoggingRepository],
  });
};

const idsForFilter = async (sut: SearchService, userId: string, imageEnrichment: ImageEnrichmentFilter) => {
  const response = await sut.searchMetadata(factory.auth({ user: { id: userId } }), { imageEnrichment });
  return response.assets.items.map(({ id }) => id);
};

const nsfwMetadata = (isNsfw: boolean, review?: { action: string; isNsfw: boolean }) => ({
  nsfwDetection: {
    status: 'success',
    result: { isNsfw, score: isNsfw ? 0.95 : 0.05, labels: { explicit: isNsfw ? 0.95 : 0.05 } },
    ...(review && { review }),
  },
});

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SearchService.name, () => {
  it('should work', () => {
    const { sut } = setup();
    expect(sut).toBeDefined();
  });

  describe('landmarks (FL-353)', () => {
    const park = { id: 'Q181185', name: 'Disneyland', kind: 'theme_park', latitude: 33.8121, longitude: -117.919 };
    const tower = { id: 'Q243', name: 'Eiffel Tower', kind: 'tower', latitude: 48.8584, longitude: 2.2945 };
    const inPark = { latitude: 33.8121, longitude: -117.919, city: 'Anaheim', state: 'California', country: 'USA' };
    const atTower = { latitude: 48.8584, longitude: 2.2945, city: 'Paris', state: null, country: 'France' };

    beforeEach(async () => {
      await defaultDatabase.deleteFrom('landmark').execute();
      await defaultDatabase
        .insertInto('landmark')
        .values([park, tower].map((place) => ({ ...place, radiusM: 500, rank: 50 })))
        .execute();
    });

    it('lists the places the viewer has media at, and only their own visible media', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const at = async (ownerId: string, exif: object, asset: object = {}) => {
        const { asset: created } = await ctx.newAsset({ ownerId, ...asset });
        await ctx.newExif({ assetId: created.id, ...exif });
        return created;
      };
      await at(user.id, inPark, { localDateTime: new Date('2024-06-03T10:00:00Z') });
      const latest = await at(user.id, inPark, { localDateTime: new Date('2024-06-05T10:00:00Z') });
      const paris = await at(user.id, atTower, { localDateTime: new Date('2023-01-01T10:00:00Z') });
      await at(user.id, inPark, { deletedAt: new Date() });
      await at(user.id, inPark, { visibility: AssetVisibility.Locked });
      await at(user.id, inPark, { visibility: AssetVisibility.Archive });
      await at(stranger.id, inPark);
      await at(user.id, { latitude: 40, longitude: -100 });

      await expect(sut.getVisitedLandmarks(factory.auth({ user }))).resolves.toEqual([
        {
          ...park,
          assetCount: 2,
          firstTakenAt: '2024-06-03T10:00:00.000Z',
          lastTakenAt: '2024-06-05T10:00:00.000Z',
          coverAssetId: latest.id,
          city: 'Anaheim',
          state: 'California',
          country: 'USA',
        },
        {
          ...tower,
          assetCount: 1,
          firstTakenAt: '2023-01-01T10:00:00.000Z',
          lastTakenAt: '2023-01-01T10:00:00.000Z',
          coverAssetId: paris.id,
          city: 'Paris',
          state: null,
          country: 'France',
        },
      ]);
    });

    it('filters a search to, or away from, landmarks', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: disney } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: disney.id, ...inPark });
      const { asset: paris } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: paris.id, ...atTower });
      const { asset: elsewhere } = await ctx.newAsset({ ownerId: user.id });
      const auth = factory.auth({ user });
      const ids = async (filter: object) =>
        (await sut.searchMetadata(auth, { filter })).assets.items.map(({ id }) => id).sort();

      await expect(ids({ landmarkIds: { any: ['Q181185'] } })).resolves.toEqual([disney.id]);
      await expect(ids({ landmarkIds: { any: ['Q181185', 'Q243'] } })).resolves.toEqual([disney.id, paris.id].sort());
      await expect(ids({ landmarkIds: { none: ['Q243'] } })).resolves.toEqual([disney.id, elsewhere.id].sort());
    });
  });

  it.each(['another owner', 'Locked', 'hidden', 'archived', 'trashed', 'video'] as const)(
    'does not let %s media satisfy the Explore city threshold (FL-137)',
    async (excluded) => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const visibleIds = [];
      for (let i = 0; i < 4; i++) {
        const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
        await ctx.newExif({ assetId: asset.id, city: 'Private threshold' });
        visibleIds.push(asset.id);
      }
      const { asset: privateAsset } = await ctx.newAsset({
        ownerId: excluded === 'another owner' ? stranger.id : user.id,
        type: excluded === 'video' ? AssetType.Video : AssetType.Image,
        visibility:
          excluded === 'Locked'
            ? AssetVisibility.Locked
            : excluded === 'archived'
              ? AssetVisibility.Archive
              : AssetVisibility.Timeline,
      });
      await ctx.newExif({ assetId: privateAsset.id, city: 'Private threshold' });
      if (excluded === 'trashed') await ctx.softDeleteAsset(privateAsset.id);
      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['Private'] });
      if (excluded === 'hidden') await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [privateAsset.id] });
      const auth = {
        ...factory.auth({ user }),
        hiddenContent: {
          userId: user.id,
          includeNsfw: true,
          tagIds: [tag.id],
          personIds: [],
          petIds: [],
          scope: 'owned' as const,
        },
      };
      const cities = async () =>
        (await sut.getExploreData(auth)).find(({ fieldName }) => fieldName === 'exifInfo.city');
      await expect(cities()).resolves.toEqual({ fieldName: 'exifInfo.city', items: [] });

      const { asset: fifth } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await ctx.newExif({ assetId: fifth.id, city: 'Private threshold' });
      visibleIds.push(fifth.id);
      const qualifying = await cities();
      expect(qualifying?.items).toHaveLength(1);
      expect(qualifying?.items[0].value).toBe('Private threshold');
      expect(visibleIds).toContain(qualifying?.items[0].data.id);

      await ctx.newMetadata({ assetId: fifth.id, key: AssetMetadataKey.MlEnrichment, value: nsfwMetadata(true) });
      await expect(cities()).resolves.toEqual({ fieldName: 'exifInfo.city', items: [] });
    },
  );

  it.each([
    ['exifInfo.city', 'Locked'],
    ['exifInfo.city', 'suppressed'],
    ['createdAt', 'Locked'],
    ['createdAt', 'suppressed'],
  ] as const)('omits a %s cover made %s between selection and hydration (FL-137)', async (fieldName, privacy) => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    for (let i = 0; i < 5; i++) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await ctx.newExif({ assetId: asset.id, city: 'Hydration privacy' });
    }
    const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['Private'] });
    const auth = {
      ...factory.auth({ user }),
      hiddenContent: {
        userId: user.id,
        includeNsfw: true,
        tagIds: [tag.id],
        personIds: [],
        petIds: [],
        scope: 'owned' as const,
      },
    };
    const before = await sut.getExploreData(auth);
    expect(before.find((field) => field.fieldName === 'exifInfo.city')?.items).toHaveLength(1);
    expect(before.find((field) => field.fieldName === 'createdAt')?.items).toHaveLength(5);

    const repository = ctx.get(AssetRepository);
    const hydrate = repository.getByIdsWithAllRelationsButStacks.bind(repository);
    let hydration = 0;
    let protectedId = '';
    const intercept = vi.spyOn(repository, 'getByIdsWithAllRelationsButStacks').mockImplementation(async (...args) => {
      if (++hydration === (fieldName === 'exifInfo.city' ? 1 : 2)) {
        protectedId = args[0][0];
        expect(protectedId).toBeDefined();
        if (privacy === 'Locked') {
          await repository.lock([protectedId], AssetLockReason.Marked, user.id);
        } else {
          await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [protectedId] });
        }
      }
      return hydrate(...args);
    });
    const response = await sut.getExploreData(auth);
    intercept.mockRestore();
    expect(protectedId).not.toBe('');
    expect(response.find((field) => field.fieldName === fieldName)?.items).toHaveLength(
      fieldName === 'exifInfo.city' ? 0 : 4,
    );
    expect(response.find((field) => field.fieldName === fieldName)?.items.map(({ data }) => data.id)).not.toContain(
      protectedId,
    );
    // The owner's unlocked read still reveals the same item under the ordinary Explore policy.
    const unlocked = await sut.getExploreData(factory.auth({ user, session: { hasElevatedPermission: true } }));
    expect(unlocked.find((field) => field.fieldName === 'createdAt')?.items.map(({ data }) => data.id)).toContain(
      protectedId,
    );
  });

  it('should return assets', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();

    const assets = [];
    const sizes = [12_334, 599, 123_456];

    for (let i = 0; i < sizes.length; i++) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: sizes[i] });
      assets.push(asset);
    }

    const auth = factory.auth({ user: { id: user.id } });

    await expect(sut.searchLargeAssets(auth, {})).resolves.toEqual([
      expect.objectContaining({ id: assets[2].id }),
      expect.objectContaining({ id: assets[0].id }),
      expect.objectContaining({ id: assets[1].id }),
    ]);
  });

  it('paginates structured search and applies fork privacy and enrichment to every structured query', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: stranger } = await ctx.newUser();
    const { asset: first } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
    const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
    await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
    await ctx.newAsset({ ownerId: user.id, type: AssetType.Image, visibility: AssetVisibility.Locked });
    await ctx.newAsset({ ownerId: stranger.id, type: AssetType.Image });
    await ctx.newExif({ assetId: first.id, fileSizeInByte: 1 });
    await ctx.newExif({ assetId: second.id, fileSizeInByte: 2 });
    await ctx.newMetadata({ assetId: hidden.id, key: AssetMetadataKey.MlEnrichment, value: nsfwMetadata(true) });
    const auth = { ...factory.auth({ user }), hideNsfwAssets: true };
    const filter = { type: { eq: AssetType.Image } };
    const orderBy = { field: SearchOrderField.FileSizeInBytes, direction: AssetOrder.Asc };
    const page1 = await sut.searchMetadata(auth, { filter, orderBy, size: 1 });
    expect(page1.assets.items.map(({ id }) => id)).toEqual([first.id]);
    expect(page1.assets.nextCursor).toEqual(expect.any(String));
    const page2 = await sut.searchMetadata(auth, { filter, orderBy, size: 1, cursor: page1.assets.nextCursor! });
    expect(page2.assets.items.map(({ id }) => id)).toEqual([second.id]);
    expect(page2.assets.nextCursor).toBeNull();
    await expect(sut.searchStatistics(auth, { filter })).resolves.toEqual({ total: 2 });
    const random = await sut.searchRandom(auth, { filter });
    expect(random.map(({ id }) => id).sort()).toEqual([first.id, second.id].sort());
    const enriched = await sut.searchMetadata(factory.auth({ user }), {
      filter,
      imageEnrichment: ImageEnrichmentFilter.Nsfw,
    });
    expect(enriched.assets.items.map(({ id }) => id)).toEqual([hidden.id]);
  });

  describe('searchStatistics', () => {
    it('should return statistics when filtering by personIds', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      const auth = factory.auth({ user: { id: user.id } });

      const result = await sut.searchStatistics(auth, { personIds: [person.personGroupId] });

      expect(result).toEqual({ total: 1 });
    });

    it('should return zero when no assets match the personIds filter', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });

      const auth = factory.auth({ user: { id: user.id } });

      const result = await sut.searchStatistics(auth, { personIds: [person.personGroupId] });

      expect(result).toEqual({ total: 0 });
    });

    it('should not return locked assets of partner in elevated session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();

      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      await ctx.newAsset({ ownerId: partner.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

      const result = await sut.searchStatistics(auth, { visibility: AssetVisibility.Locked });

      expect(result).toEqual({ total: 0 });
    });
  });

  describe("a partner's Locked media", () => {
    const partnerLibrary = async (ctx: ReturnType<typeof setup>['ctx']) => {
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      const { asset: ownLocked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: partnerTimeline } = await ctx.newAsset({ ownerId: partner.id });
      const { asset: partnerLocked } = await ctx.newAsset({ ownerId: partner.id, visibility: AssetVisibility.Locked });
      for (const { id } of [ownLocked, partnerTimeline, partnerLocked]) {
        await ctx.newExif({ assetId: id, fileSizeInByte: 1000 });
      }

      const elevated = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
      return { user, partner, ownLocked, partnerTimeline, partnerLocked, elevated };
    };

    it('never comes back from an elevated metadata search, while the viewer keeps their own', async () => {
      const { sut, ctx } = setup();
      const { elevated, ownLocked, partnerTimeline, partnerLocked } = await partnerLibrary(ctx);

      const response = await sut.searchMetadata(elevated, {});
      const ids = response.assets.items.map(({ id }) => id);

      // FL-326: a partner's own rows are never searched, Locked or not; their items arrive as copies
      expect(ids).toEqual([ownLocked.id]);
      expect(ids).not.toContain(partnerTimeline.id);
      expect(ids).not.toContain(partnerLocked.id);
    });

    it('is not counted, sampled or listed by size in an elevated session', async () => {
      const { sut, ctx } = setup();
      const { elevated, partnerLocked } = await partnerLibrary(ctx);

      await expect(sut.searchStatistics(elevated, {})).resolves.toEqual({ total: 1 });

      const random = await sut.searchRandom(elevated, { size: 50 });
      expect(random.map(({ id }) => id)).not.toContain(partnerLocked.id);

      const large = await sut.searchLargeAssets(elevated, { size: 50 });
      expect(large.map(({ id }) => id)).not.toContain(partnerLocked.id);
    });

    it('does not come back even when the partner shares the album it sits in', async () => {
      const { sut, ctx } = setup();
      const { user, partner, elevated, partnerTimeline, partnerLocked } = await partnerLibrary(ctx);
      const { album } = await ctx.newAlbum({ ownerId: partner.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: partnerTimeline.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: partnerLocked.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: user.id, role: AlbumUserRole.Editor });

      const everything = await sut.searchMetadata(elevated, { albumIds: [album.id] });
      expect(everything.assets.items.map(({ id }) => id)).toEqual([partnerTimeline.id]);

      const lockedOnly = await sut.searchMetadata(elevated, {
        albumIds: [album.id],
        visibility: AssetVisibility.Locked,
      });
      expect(lockedOnly.assets.items).toEqual([]);
    });
  });

  describe('withStacked option', () => {
    it('should exclude stacked assets when withStacked is false', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const { asset: primaryAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: stackedAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unstackedAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newStack({ ownerId: user.id }, [primaryAsset.id, stackedAsset.id]);

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchMetadata(auth, { withStacked: false });

      expect(response.assets.items.length).toBe(1);
      expect(response.assets.items[0].id).toBe(unstackedAsset.id);
    });

    describe('visibility', () => {
      it('should filter out locked assets in a default session', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();

        await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

        const auth = factory.auth({ user: { id: user.id } });

        const response = await sut.searchMetadata(auth, { withStacked: false });

        expect(response.assets.items.length).toBe(0);
      });

      it('should return locked assets in an elevated session', async () => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();

        await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

        const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

        const response = await sut.searchMetadata(auth, { withStacked: false });

        expect(response.assets.items.length).toBe(1);
      });
    });
  });

  describe('albumIds option', () => {
    it('should return assets from shared album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: user.id, role: AlbumUserRole.Editor });

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchMetadata(auth, { albumIds: [album.id] });

      expect(response.assets.items.length).toBe(1);
    });

    it('should not return assets for album, a user is not in, when partner sharing is enabled', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      await ctx.newPartner({ sharedById: otherUser.id, sharedWithId: user.id });

      const { asset } = await ctx.newAsset({ ownerId: otherUser.id });
      const { album } = await ctx.newAlbum({ ownerId: otherUser.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });

      await expect(sut.searchMetadata(auth, { albumIds: [album.id] })).rejects.toThrow(
        'Not found or no album.read access',
      );
    });
  });

  describe('NSFW privacy hiding', () => {
    it('should use private review state, not visible tags, when hiding search results', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();

      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unreviewedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: markedSafe } = await ctx.newAsset({ ownerId: user.id });
      const { asset: markedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: tagOnly } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newMetadata({
        assetId: unreviewedNsfw.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true),
      });
      await ctx.newMetadata({
        assetId: markedSafe.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true, { action: 'marked-safe', isNsfw: false }),
      });
      await ctx.newMetadata({
        assetId: markedNsfw.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(false, { action: 'marked-nsfw', isNsfw: true }),
      });

      const [visibleNsfwTag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['nsfw'] });
      await ctx.newTagAsset({ tagIds: [visibleNsfwTag.id], assetIds: [tagOnly.id] });

      const hiddenAuth = { ...factory.auth({ user: { id: user.id } }), hideNsfwAssets: true };
      const hiddenResponse = await sut.searchMetadata(hiddenAuth, {});
      const hiddenIds = hiddenResponse.assets.items.map(({ id }) => id);

      expect(hiddenIds).toEqual(expect.arrayContaining([visible.id, markedSafe.id, tagOnly.id]));
      expect(hiddenIds).not.toEqual(expect.arrayContaining([unreviewedNsfw.id, markedNsfw.id]));

      const unlockedResponse = await sut.searchMetadata(factory.auth({ user: { id: user.id } }), {});
      expect(unlockedResponse.assets.items.map(({ id }) => id)).toEqual(
        expect.arrayContaining([unreviewedNsfw.id, markedNsfw.id]),
      );
    });

    it('should return only configured tag, person, and NSFW assets when suppressedOnly is requested', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();

      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      const { asset: tagSuppressed } = await ctx.newAsset({ ownerId: user.id });
      const { asset: faceSuppressed } = await ctx.newAsset({ ownerId: user.id });
      const { asset: nsfwSuppressed } = await ctx.newAsset({ ownerId: user.id });

      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['medical'] });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [tagSuppressed.id] });

      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Private Person' });
      await ctx.newAssetFace({ assetId: faceSuppressed.id, personGroupId: person.personGroupId });

      await ctx.newMetadata({
        assetId: nsfwSuppressed.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true),
      });

      const suppressedContent: HiddenContentFilter = {
        userId: user.id,
        includeNsfw: true,
        tagIds: [tag.id],
        personIds: [person.personGroupId],
        petIds: [],
        scope: 'owned',
      };
      const hiddenAuth = {
        ...factory.auth({ user: { id: user.id } }),
        hideNsfwAssets: true,
        hiddenContent: suppressedContent,
      };
      const elevatedAuth = {
        ...factory.auth({ user: { id: user.id } }),
        session: { id: factory.uuid(), hasElevatedPermission: true },
        suppressedContent,
      };

      for (const shape of [{}, { filter: {} }]) {
        const hiddenResponse = await sut.searchMetadata(hiddenAuth, shape);
        expect(hiddenResponse.assets.items.map(({ id }) => id)).toEqual([visible.id]);

        const suppressedResponse = await sut.searchMetadata(elevatedAuth, { ...shape, suppressedOnly: true });
        expect(suppressedResponse.assets.items.map(({ id }) => id)).toEqual(
          expect.arrayContaining([tagSuppressed.id, faceSuppressed.id, nsfwSuppressed.id]),
        );
        expect(suppressedResponse.assets.items.map(({ id }) => id)).not.toEqual(expect.arrayContaining([visible.id]));

        await expect(sut.searchStatistics(elevatedAuth, { ...shape, suppressedOnly: true })).resolves.toEqual({
          total: 3,
        });
      }
    });
  });

  describe('imageEnrichment option', () => {
    it('should filter NSFW review states and enrichment failures', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();

      const { asset: unreviewedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: acceptedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: overriddenSafe } = await ctx.newAsset({ ownerId: user.id });
      const { asset: reviewTagged } = await ctx.newAsset({ ownerId: user.id });
      const { asset: descriptionFailed } = await ctx.newAsset({ ownerId: user.id });
      const { asset: nsfwFailed } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newMetadata({
        assetId: unreviewedNsfw.id,
        key: AssetMetadataKey.MlEnrichment,
        value: {
          nsfwDetection: {
            status: 'success',
            result: { isNsfw: true, score: 0.95, labels: { explicit: 0.95 } },
          },
        },
      });
      await ctx.newMetadata({
        assetId: acceptedNsfw.id,
        key: AssetMetadataKey.MlEnrichment,
        value: {
          nsfwDetection: {
            status: 'success',
            result: { isNsfw: true, score: 0.95, labels: { explicit: 0.95 } },
            review: { action: 'accepted', isNsfw: true },
          },
        },
      });
      await ctx.newMetadata({
        assetId: overriddenSafe.id,
        key: AssetMetadataKey.MlEnrichment,
        value: {
          nsfwDetection: {
            status: 'success',
            result: { isNsfw: true, score: 0.95, labels: { explicit: 0.95 } },
            review: { action: 'marked-safe', isNsfw: false },
          },
        },
      });
      await ctx.newMetadata({
        assetId: descriptionFailed.id,
        key: AssetMetadataKey.MlEnrichment,
        value: {
          description: { status: 'failed', error: 'model unavailable' },
        },
      });
      await ctx.newMetadata({
        assetId: nsfwFailed.id,
        key: AssetMetadataKey.MlEnrichment,
        value: {
          nsfwDetection: { status: 'failed', error: 'classifier unavailable' },
        },
      });

      const [reviewTag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['nsfw_review'] });
      await ctx.newTagAsset({ tagIds: [reviewTag.id], assetIds: [reviewTagged.id] });

      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.Nsfw)).resolves.toEqual(
        expect.arrayContaining([unreviewedNsfw.id, acceptedNsfw.id]),
      );
      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.Nsfw)).resolves.not.toEqual(
        expect.arrayContaining([overriddenSafe.id]),
      );
      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.NsfwReview)).resolves.toEqual(
        expect.arrayContaining([unreviewedNsfw.id, reviewTagged.id]),
      );
      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.NsfwReviewed)).resolves.toEqual(
        expect.arrayContaining([acceptedNsfw.id, overriddenSafe.id]),
      );
      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.NsfwOverridden)).resolves.toEqual(
        expect.arrayContaining([overriddenSafe.id]),
      );
      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.NsfwOverridden)).resolves.not.toEqual(
        expect.arrayContaining([acceptedNsfw.id, unreviewedNsfw.id]),
      );
      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.ImageDescriptionFailed)).resolves.toEqual(
        expect.arrayContaining([descriptionFailed.id]),
      );
      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.NsfwDetectionFailed)).resolves.toEqual(
        expect.arrayContaining([nsfwFailed.id]),
      );
    });

    it('should filter image assets missing successful enrichment results', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();

      const { asset: missingBoth } = await ctx.newAsset({ ownerId: user.id });
      const { asset: descriptionDone } = await ctx.newAsset({ ownerId: user.id });
      const { asset: nsfwDone } = await ctx.newAsset({ ownerId: user.id });
      const { asset: video } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });

      await ctx.newMetadata({
        assetId: descriptionDone.id,
        key: AssetMetadataKey.MlEnrichment,
        value: { description: { status: 'success' } },
      });
      await ctx.newMetadata({
        assetId: nsfwDone.id,
        key: AssetMetadataKey.MlEnrichment,
        value: { nsfwDetection: { status: 'success' } },
      });

      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.MissingImageDescription)).resolves.toEqual(
        expect.arrayContaining([missingBoth.id, nsfwDone.id]),
      );
      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.MissingImageDescription)).resolves.not.toEqual(
        expect.arrayContaining([descriptionDone.id, video.id]),
      );
      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.MissingNsfwDetection)).resolves.toEqual(
        expect.arrayContaining([missingBoth.id, descriptionDone.id]),
      );
      await expect(idsForFilter(sut, user.id, ImageEnrichmentFilter.MissingNsfwDetection)).resolves.not.toEqual(
        expect.arrayContaining([nsfwDone.id, video.id]),
      );
    });
  });

  describe('FL-49 search palette conditions', () => {
    it('matches cameras and lenses by "contains", included or excluded', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: sony } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: sony.id, make: 'SONY', model: 'ILCE-7M4', lensModel: 'FE 24-70mm F2.8 GM II' });
      const { asset: canon } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: canon.id, make: 'Canon', model: 'EOS R5', lensModel: 'RF 15-35mm' });
      const auth = factory.auth({ user });
      const ids = async (filter: object) =>
        (await sut.searchMetadata(auth, { filter })).assets.items.map(({ id }) => id).sort();

      await expect(ids({ make: { like: 'son' } })).resolves.toEqual([sony.id]);
      await expect(ids({ model: { like: 'r5' } })).resolves.toEqual([canon.id]);
      await expect(ids({ lensModel: { like: '24-70' } })).resolves.toEqual([sony.id]);
      const { asset: noExif } = await ctx.newAsset({ ownerId: user.id });
      // A photo with no lens does not contain "24-70", so an exclusion keeps it
      await expect(ids({ lensModel: { notLike: '24-70' } })).resolves.toEqual([canon.id, noExif.id].sort());
      await expect(ids({ make: { notLike: 'son' } })).resolves.toEqual([canon.id, noExif.id].sort());
      await expect(sut.searchStatistics(auth, { filter: { make: { like: 'o' } } })).resolves.toEqual({ total: 2 });
    });

    it('finds panoramas by projection and screenshots by name or a camera-less PNG (FL-349)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const still = async (
        originalFileName: string,
        exif: { projectionType?: string; make?: string; model?: string },
      ) => {
        const { asset } = await ctx.newAsset({ ownerId: user.id, originalFileName });
        await ctx.newExif({ assetId: asset.id, make: null, ...exif });
        return asset.id;
      };
      const sphere = await still('PANO_0001.jpg', { projectionType: 'EQUIRECTANGULAR' });
      const sweep = await still('PANO_0002.jpg', { projectionType: 'CYLINDRICAL' });
      const insta = await still('IMG_0003.insp', {});
      const android = await still('Screenshot_20260101-101010_Maps.jpg', {});
      const mac = await still('Screen Shot 2026-01-01 at 10.10.10.png', { make: 'Apple' });
      const ios = await still('IMG_0004.PNG', {});
      const photo = await still('IMG_0005.HEIC', { make: 'Apple', model: 'iPhone 17 Pro' });
      const cameraPng = await still('DSC_0006.png', { make: 'NIKON', model: 'Z 8' });
      const { asset: video } = await ctx.newAsset({
        ownerId: user.id,
        originalFileName: 'Screen Recording 2026.mov',
        type: AssetType.Video,
      });
      await ctx.newExif({ assetId: video.id, projectionType: 'EQUIRECTANGULAR' });
      const auth = factory.auth({ user });
      const ids = async (filter: object) =>
        (await sut.searchMetadata(auth, { filter })).assets.items.map(({ id }) => id).sort();

      await expect(ids({ isPanorama: { eq: true } })).resolves.toEqual([sphere, sweep, insta].sort());
      await expect(ids({ isScreenshot: { eq: true } })).resolves.toEqual([android, mac, ios].sort());
      await expect(ids({ isScreenshot: { eq: false } })).resolves.toEqual(
        [sphere, sweep, insta, photo, cameraPng, video.id].sort(),
      );
      await expect(ids({ isPanorama: { eq: false }, isScreenshot: { eq: false } })).resolves.toEqual(
        [photo, cameraPng, video.id].sort(),
      );
      await expect(ids({ or: [{ isPanorama: { eq: true } }, { isScreenshot: { eq: true } }] })).resolves.toEqual(
        [sphere, sweep, insta, android, mac, ios].sort(),
      );
    });

    it('narrows by the local capture date, which is what the histogram buckets by', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      // 23:30 on July 31 where it was taken, already August 1 in UTC
      const { asset: lateJuly } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('2026-08-01T05:30:00.000Z'),
        localDateTime: new Date('2026-07-31T23:30:00.000Z'),
      });
      const { asset: august } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('2026-08-12T10:00:00.000Z'),
        localDateTime: new Date('2026-08-12T12:00:00.000Z'),
      });
      const auth = factory.auth({ user });
      const localDateTime = { gte: new Date('2026-08-01T00:00:00.000Z'), lt: new Date('2026-09-01T00:00:00.000Z') };

      const result = await sut.searchMetadata(auth, { filter: { localDateTime } });
      expect(result.assets.items.map(({ id }) => id)).toEqual([august.id]);
      const histogram = await sut.searchHistogram(auth, { filter: { localDateTime }, granularity: 'month' as never });
      expect(histogram.total).toBe(1);
      const byUtc = await sut.searchMetadata(auth, { filter: { takenAt: localDateTime } });
      expect(byUtc.assets.items.map(({ id }) => id).sort()).toEqual([lateJuly.id, august.id].sort());
    });
  });

  describe('getSearchSuggestions', () => {
    it('should filter out empty search suggestions', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const { asset: assetWithEmptyMake } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: assetWithEmptyMake.id, make: '' });

      const auth = factory.auth({ user: { id: user.id } });
      const suggestions = await sut.getSearchSuggestions(auth, {
        type: SearchSuggestionType.CAMERA_MAKE,
        includeNull: true,
      });

      expect(suggestions).toEqual(['Canon', null]);
    });
  });

  describe('searchRandom', () => {
    it('should filter out locked assets in a default session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id } });

      const response = await sut.searchRandom(auth, {});

      expect(response.length).toBe(0);
    });
  });

  describe('getCityAssetCounts (FL-51)', () => {
    it("counts timeline photos and videos per city and never Locked, trashed or other users' media", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const inCity = async (city: string, dto: Parameters<typeof ctx.newAsset>[0]) => {
        const { asset } = await ctx.newAsset(dto);
        await ctx.newExif({ assetId: asset.id, city, latitude: 48.85, longitude: 2.35 });
        return asset;
      };

      await inCity('Paris', { ownerId: user.id, type: AssetType.Image });
      await inCity('Paris', { ownerId: user.id, type: AssetType.Video });
      await inCity('Paris', { ownerId: user.id, visibility: AssetVisibility.Locked });
      await inCity('Rome', { ownerId: user.id });
      await inCity('Rome', { ownerId: user.id, deletedAt: new Date() });
      await inCity('Rome', { ownerId: user.id, visibility: AssetVisibility.Archive });
      await inCity('Secret', { ownerId: user.id, visibility: AssetVisibility.Locked });
      await inCity('Lisbon', { ownerId: user.id, type: AssetType.Video });
      await inCity('Paris', { ownerId: stranger.id });

      const counts = await sut.getCityAssetCounts(factory.auth({ user: { id: user.id } }));
      expect(counts).toEqual([
        { city: 'Lisbon', count: 1 },
        { city: 'Paris', count: 2 },
        { city: 'Rome', count: 1 },
      ]);
      // the places list itself shows photo cities only, so the video-only city is counted but not listed
      const listed = await sut.getAssetsByCity(factory.auth({ user: { id: user.id } }));
      expect(listed.map((asset) => asset.exifInfo?.city)).toEqual(['Paris', 'Rome']);
    });
  });
});
