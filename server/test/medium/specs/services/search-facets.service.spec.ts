import { Kysely } from 'kysely';
import { SearchFacetField, SearchFacetsResponseDto, SearchHistogramGranularity } from 'src/dtos/search.dto.js';
import { AssetMetadataKey, AssetType, AssetVisibility } from 'src/enum.js';
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
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { factory, newEmbedding } from 'test/small.factory.js';
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
      SystemMetadataRepository,
      SearchRepository,
      PartnerRepository,
      PersonRepository,
      TagRepository,
    ],
    mock: [LoggingRepository],
  });
};

type Ctx = MediumTestContext<typeof SearchService>;

const nsfw = {
  nsfwDetection: { status: 'success', result: { isNsfw: true, score: 0.95, labels: { explicit: 0.95 } } },
};

const counts = (response: SearchFacetsResponseDto, field: SearchFacetField) =>
  response.facets.find(({ fieldName }) => fieldName === field)?.counts ?? [];

const sum = (response: SearchFacetsResponseDto, field: SearchFacetField) =>
  counts(response, field).reduce((total, { count }) => total + count, 0);

const newItem = async (
  ctx: Ctx,
  ownerId: string,
  exif: { city?: string; country?: string; make?: string; model?: string; lensModel?: string; rating?: number } = {},
  asset: {
    type?: AssetType;
    isFavorite?: boolean;
    visibility?: AssetVisibility;
    localDateTime?: Date;
    fileCreatedAt?: Date;
  } = {},
) => {
  const { asset: created } = await ctx.newAsset({ ownerId, ...asset });
  await ctx.newExif({ assetId: created.id, make: exif.make ?? 'Canon', ...exif });
  return created;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('SearchService facets, histogram and smart counts (FL-49)', () => {
  it('counts every facet over exactly the assets the statistics count, and reconciles', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });

    const lisbon = await newItem(
      ctx,
      user.id,
      { city: 'Lisbon', country: 'Portugal', model: 'EOS R5', lensModel: 'RF 35mm', rating: 5 },
      { isFavorite: true, localDateTime: new Date('2024-03-02T10:00:00Z') },
    );
    const porto = await newItem(
      ctx,
      user.id,
      { city: 'Porto', country: 'Portugal', model: 'EOS R5', rating: 3 },
      { localDateTime: new Date('2024-03-20T10:00:00Z') },
    );
    await newItem(
      ctx,
      user.id,
      { make: 'Apple' },
      { type: AssetType.Video, localDateTime: new Date('2023-07-01T10:00:00Z') },
    );

    const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Emma' });
    await ctx.newAssetFace({ assetId: lisbon.id, personGroupId: person.personGroupId });
    await ctx.newAssetFace({ assetId: porto.id, personGroupId: person.personGroupId });
    const [family, trips] = await upsertTags(ctx.get(TagRepository), {
      userId: user.id,
      tags: ['Family', 'Trips/Portugal'],
    });
    await ctx.newTagAsset({ tagIds: [family.id], assetIds: [lisbon.id] });
    await ctx.newTagAsset({ tagIds: [trips.id], assetIds: [lisbon.id, porto.id] });

    const statistics = await sut.searchStatistics(auth, {});
    const facets = await sut.searchFacets(auth, {});
    expect(facets.total).toBe(3);
    expect(statistics.total).toBe(3);

    // partitions add up to the total
    expect(sum(facets, SearchFacetField.Type)).toBe(3);
    expect(sum(facets, SearchFacetField.Rating)).toBe(3);
    expect(sum(facets, SearchFacetField.IsFavorite)).toBe(3);
    expect(counts(facets, SearchFacetField.Type)).toEqual([
      { value: 'IMAGE', count: 2 },
      { value: 'VIDEO', count: 1 },
    ]);
    expect(counts(facets, SearchFacetField.Rating)).toEqual([
      { value: '3', count: 1 },
      { value: '5', count: 1 },
      { value: 'unrated', count: 1 },
    ]);
    expect(counts(facets, SearchFacetField.IsFavorite)).toEqual([
      { value: 'false', count: 2 },
      { value: 'true', count: 1 },
    ]);
    expect(counts(facets, SearchFacetField.City)).toEqual([
      { value: 'Lisbon', count: 1 },
      { value: 'Porto', count: 1 },
    ]);
    expect(counts(facets, SearchFacetField.Country)).toEqual([{ value: 'Portugal', count: 2 }]);
    expect(counts(facets, SearchFacetField.Make)).toEqual([
      { value: 'Canon', count: 2 },
      { value: 'Apple', count: 1 },
    ]);
    expect(counts(facets, SearchFacetField.Model)).toEqual([{ value: 'EOS R5', count: 2 }]);
    expect(counts(facets, SearchFacetField.LensModel)).toEqual([{ value: 'RF 35mm', count: 1 }]);
    expect(counts(facets, SearchFacetField.People)).toEqual([{ value: person.personGroupId, label: 'Emma', count: 2 }]);
    // a parent tag counts what its children hold, as the tag filter matches
    expect(counts(facets, SearchFacetField.Tags)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Family', count: 1 }),
        expect.objectContaining({ label: 'Trips', count: 2 }),
        expect.objectContaining({ label: 'Trips/Portugal', count: 2 }),
      ]),
    );

    // narrowing the body narrows every facet; a structured body agrees with the flat one
    const narrowed = await sut.searchFacets(auth, {
      filter: { city: { eq: 'Lisbon' } },
      facets: [SearchFacetField.People],
    });
    expect(narrowed).toEqual({
      total: 1,
      facets: [{ fieldName: 'people', counts: [{ value: person.personGroupId, label: 'Emma', count: 1 }] }],
    });

    const limited = await sut.searchFacets(auth, { facets: [SearchFacetField.City], facetLimit: 1 });
    expect(counts(limited, SearchFacetField.City)).toEqual([{ value: 'Lisbon', count: 1 }]);

    // the histogram adds up to the same total, by local capture date
    const months = await sut.searchHistogram(auth, { granularity: SearchHistogramGranularity.Month });
    expect(months).toEqual({
      granularity: 'month',
      total: 3,
      buckets: [
        { date: '2023-07-01', count: 1 },
        { date: '2024-03-01', count: 2 },
      ],
    });
    const years = await sut.searchHistogram(auth, {
      filter: { type: { eq: AssetType.Image } },
      granularity: SearchHistogramGranularity.Year,
    });
    expect(years).toEqual({ granularity: 'year', total: 2, buckets: [{ date: '2024-01-01', count: 2 }] });
    const days = await sut.searchHistogram(auth, { granularity: SearchHistogramGranularity.Day });
    expect(days.buckets.map(({ date }) => date)).toEqual(['2023-07-01', '2024-03-02', '2024-03-20']);
  });

  it('never counts Locked or hidden media outside an unlocked session', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    await newItem(ctx, user.id, { city: 'Visible' });
    await newItem(ctx, user.id, { city: 'LockedCity' }, { visibility: AssetVisibility.Locked });
    const hidden = await newItem(ctx, user.id, { city: 'HiddenCity' });
    await ctx.newMetadata({ assetId: hidden.id, key: AssetMetadataKey.MlEnrichment, value: nsfw });

    const auth = { ...factory.auth({ user }), hideNsfwAssets: true };
    const facets = await sut.searchFacets(auth, {});
    expect(facets.total).toBe(1);
    expect(counts(facets, SearchFacetField.City)).toEqual([{ value: 'Visible', count: 1 }]);
    const histogram = await sut.searchHistogram(auth, { granularity: SearchHistogramGranularity.Year });
    expect(histogram.total).toBe(1);

    // a Locked request needs an elevated session; the elevated owner sees only their Locked item
    await expect(sut.searchFacets(auth, { visibility: AssetVisibility.Locked })).rejects.toThrow();
    const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
    const locked = await sut.searchFacets(elevated, {
      visibility: AssetVisibility.Locked,
      facets: [SearchFacetField.City],
    });
    expect(locked).toEqual({ total: 1, facets: [{ fieldName: 'city', counts: [{ value: 'LockedCity', count: 1 }] }] });
  });

  it("counts partners' shared media without naming their people or tags, their Locked media or hidden places", async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    await ctx.get(PartnerRepository).create({
      sharedById: partner.id,
      sharedWithId: user.id,
      inTimeline: true,
      shareLocation: false,
    });

    await newItem(ctx, user.id, { city: 'Lisbon' });
    const shared = await newItem(ctx, partner.id, { city: 'PartnerHome', country: 'PartnerLand' });
    await newItem(ctx, partner.id, { city: 'PartnerLocked' }, { visibility: AssetVisibility.Locked });

    const { person: partnerPerson } = await ctx.newPerson({ ownerId: partner.id, name: 'Partner Friend' });
    await ctx.newAssetFace({ assetId: shared.id, personGroupId: partnerPerson.personGroupId });
    const [partnerTag] = await upsertTags(ctx.get(TagRepository), { userId: partner.id, tags: ['Partner Secret'] });
    await ctx.newTagAsset({ tagIds: [partnerTag.id], assetIds: [shared.id] });

    const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
    const facets = await sut.searchFacets(elevated, {});
    expect(facets.total).toBe(2);
    expect(sum(facets, SearchFacetField.Type)).toBe(2);
    expect(counts(facets, SearchFacetField.City)).toEqual([{ value: 'Lisbon', count: 1 }]);
    expect(counts(facets, SearchFacetField.Country)).toEqual([]);
    expect(counts(facets, SearchFacetField.People)).toEqual([]);
    expect(counts(facets, SearchFacetField.Tags)).toEqual([]);
    expect(JSON.stringify(facets)).not.toContain('Partner');
  });

  it('names no person or tag the owner keeps Locked while the session is locked', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

    // the Locked rules are scoped to owned media, so a partner's photo of the same person stays visible
    const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Kept Private' });
    const partnerAsset = await newItem(ctx, partner.id);
    await ctx.newAssetFace({ assetId: partnerAsset.id, personGroupId: person.personGroupId });
    const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['Private'] });
    const ownAsset = await newItem(ctx, user.id);
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [ownAsset.id] });

    const hiddenContent = {
      userId: user.id,
      includeNsfw: false,
      personIds: [person.personGroupId],
      tagIds: [tag.id],
      petIds: [],
      scope: 'owned' as const,
    };
    const locked = await sut.searchFacets({ ...factory.auth({ user }), hiddenContent }, {});
    expect(counts(locked, SearchFacetField.People)).toEqual([]);
    expect(counts(locked, SearchFacetField.Tags)).toEqual([]);
    expect(JSON.stringify(locked)).not.toContain('Kept Private');

    const unlocked = await sut.searchFacets(factory.auth({ user }), {});
    expect(counts(unlocked, SearchFacetField.People)).toEqual([
      { value: person.personGroupId, label: 'Kept Private', count: 1 },
    ]);
  });

  it('counts smart search results up to the cap, with the same privacy rules', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const searchRepository = ctx.get(SearchRepository);
    for (const visibility of [undefined, undefined, AssetVisibility.Locked]) {
      const asset = await newItem(ctx, user.id, {}, { visibility });
      await searchRepository.upsert(asset.id, newEmbedding());
    }
    await newItem(ctx, user.id); // no embedding yet, so smart search cannot rank it

    const counted = await sut.searchSmartStatistics(factory.auth({ user }), { query: 'beach' });
    expect(counted).toEqual({ total: 2, capped: false });
    const structured = await sut.searchSmartStatistics(factory.auth({ user }), {
      query: 'beach',
      filter: { type: { eq: AssetType.Video } },
    });
    expect(structured).toEqual({ total: 0, capped: false });
  });

  it("covers each value with its newest match in the count's own scope, never an archived or Locked item (FL-50)", async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });

    const older = await newItem(ctx, user.id, { city: 'Lisbon' }, { fileCreatedAt: new Date('2024-01-01T10:00:00Z') });
    const newer = await newItem(ctx, user.id, { city: 'Lisbon' }, { fileCreatedAt: new Date('2024-06-01T10:00:00Z') });
    const archived = await newItem(
      ctx,
      user.id,
      { city: 'Lisbon' },
      { visibility: AssetVisibility.Archive, fileCreatedAt: new Date('2025-01-01T10:00:00Z') },
    );
    const locked = await newItem(
      ctx,
      user.id,
      { city: 'Lisbon' },
      { visibility: AssetVisibility.Locked, fileCreatedAt: new Date('2025-02-01T10:00:00Z') },
    );
    const [beach] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['beach'] });
    await ctx.newTagAsset({ tagIds: [beach.id], assetIds: [older.id, archived.id, locked.id] });
    const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Emma' });
    await ctx.newAssetFace({ assetId: older.id, personGroupId: person.personGroupId });
    await ctx.newAssetFace({ assetId: archived.id, personGroupId: person.personGroupId });

    const facets = await sut.searchFacets(auth, {
      visibility: AssetVisibility.Timeline,
      facets: [SearchFacetField.People, SearchFacetField.City, SearchFacetField.Tags],
      facetCovers: true,
    });
    expect(facets.total).toBe(2);
    expect(counts(facets, SearchFacetField.City)).toEqual([{ value: 'Lisbon', count: 2, coverAssetId: newer.id }]);
    expect(counts(facets, SearchFacetField.Tags)).toEqual([
      { value: beach.id, label: 'beach', count: 1, coverAssetId: older.id },
    ]);
    expect(counts(facets, SearchFacetField.People)).toEqual([
      { value: person.personGroupId, label: 'Emma', count: 1, coverAssetId: older.id },
    ]);
    // the count is the number of results the same body finds
    expect(await sut.searchStatistics(auth, { visibility: AssetVisibility.Timeline, city: 'Lisbon' })).toEqual({
      total: 2,
    });

    // covers are only returned when asked for
    const plain = await sut.searchFacets(auth, {
      visibility: AssetVisibility.Timeline,
      facets: [SearchFacetField.City],
    });
    expect(counts(plain, SearchFacetField.City)).toEqual([{ value: 'Lisbon', count: 2 }]);
  });
});
