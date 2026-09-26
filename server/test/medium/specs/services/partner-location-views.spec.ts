import { Kysely } from 'kysely';
import { SearchFacetField } from 'src/dtos/search.dto.js';
import { AlbumUserRole } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { MapService } from 'src/services/map.service.js';
import { SearchService } from 'src/services/search.service.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

/**
 * FL-54: place matching and album resharing. A hides locations from P; P puts A's photo in P's album and
 * shares it with C, who is not A's partner. Owner default (privacy first): everyone looking through P's
 * album sees A's item without its location, so no place filter or map may match it either.
 */

let database: Kysely<DB>;

const real = [
  AccessRepository,
  AlbumRepository,
  AssetRepository,
  DatabaseRepository,
  MapRepository,
  PartnerRepository,
  PersonRepository,
  SearchRepository,
  TagRepository,
];

const newTimeline = () => newMediumService(TimelineService, { database, real, mock: [LoggingRepository] });
const newSearch = () => newMediumService(SearchService, { database, real, mock: [LoggingRepository] });
const newMap = () => newMediumService(MapService, { database, real, mock: [LoggingRepository] });

const inOslo = { latitude: 59.91, longitude: 10.75, city: 'Oslo', state: 'Oslo', country: 'Norway' };
const osloBox = { west: 10, south: 59, east: 11, north: 60 };

type AnyContext = Pick<
  ReturnType<typeof newTimeline>['ctx'],
  'newUser' | 'newPartner' | 'newAsset' | 'newExif' | 'newAlbum' | 'newAlbumUser'
>;

const setupReshare = async (ctx: AnyContext) => {
  const { user: hiding } = await ctx.newUser();
  const { user: albumOwner } = await ctx.newUser();
  const { user: member } = await ctx.newUser();
  await ctx.newPartner({ sharedById: hiding.id, sharedWithId: albumOwner.id });
  await database
    .updateTable('partner')
    .set({ shareLocation: false })
    .where('sharedById', '=', hiding.id)
    .where('sharedWithId', '=', albumOwner.id)
    .execute();

  const { asset: theirs } = await ctx.newAsset({ ownerId: hiding.id });
  const { asset: ownersOwn } = await ctx.newAsset({ ownerId: albumOwner.id });
  for (const asset of [theirs, ownersOwn]) {
    await ctx.newExif({ assetId: asset.id, ...inOslo });
  }
  const { album } = await ctx.newAlbum({ ownerId: albumOwner.id }, [theirs.id, ownersOwn.id]);
  await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });

  return { hiding, albumOwner, member, album, theirs, ownersOwn };
};

beforeAll(async () => {
  database = await getKyselyDB();
});

describe('partner location through albums and place filters (FL-54)', () => {
  it("finds the items a member reaches only through a hidden album owner's album", async () => {
    const { ctx } = newTimeline();
    const { hiding, member, album, theirs, ownersOwn } = await setupReshare(ctx);
    const partners = ctx.get(PartnerRepository);

    await expect(partners.getLocationHiddenOwnerIdsForAlbums([album.id], member.id)).resolves.toEqual([hiding.id]);
    await expect(partners.getLocationHiddenThroughAlbums(member.id, [theirs.id, ownersOwn.id])).resolves.toEqual(
      new Set([theirs.id]),
    );
    // the owner is never hidden from themselves
    await expect(partners.getLocationHiddenThroughAlbums(hiding.id, [theirs.id])).resolves.toEqual(new Set());
  });

  it('leaves a partner the owner shares locations with alone', async () => {
    const { ctx } = newTimeline();
    const { hiding, member, album, theirs } = await setupReshare(ctx);
    await ctx.newPartner({ sharedById: hiding.id, sharedWithId: member.id });
    const partners = ctx.get(PartnerRepository);

    await expect(partners.getLocationHiddenThroughAlbums(member.id, [theirs.id])).resolves.toEqual(new Set());
    // album views, maps, searches and facets exempt a direct location-sharing partner the same way
    await expect(partners.getLocationHiddenOwnerIdsForAlbums([album.id], member.id)).resolves.toEqual([]);
  });

  it("never matches a hidden owner's items with a bounding box in an album timeline", async () => {
    const { sut, ctx } = newTimeline();
    const { member, album } = await setupReshare(ctx);
    const auth = factory.auth({ user: member });

    const withoutBox = await sut.getTimeBuckets(auth, { albumId: album.id });
    const withBox = await sut.getTimeBuckets(auth, { albumId: album.id, bbox: osloBox });

    const total = (buckets: Array<{ count: number }>) => buckets.reduce((sum, { count }) => sum + count, 0);
    expect(total(withoutBox)).toBe(2);
    // only the album owner's own item matches the place
    expect(total(withBox)).toBe(1);
  });

  it("never matches a hidden owner's items by place in an album search", async () => {
    const { sut, ctx } = newSearch();
    const { member, album, ownersOwn } = await setupReshare(ctx);
    const auth = factory.auth({ user: member });

    const legacy = await sut.searchMetadata(auth, { albumIds: [album.id], city: 'Oslo' });
    expect(legacy.assets.items.map(({ id }) => id)).toEqual([ownersOwn.id]);

    const v3 = await sut.searchMetadata(auth, { filter: { albumIds: { any: [album.id] }, city: { eq: 'Oslo' } } });
    expect(v3.assets.items.map(({ id }) => id)).toEqual([ownersOwn.id]);

    // without a place filter the album shows both
    const all = await sut.searchMetadata(auth, { albumIds: [album.id] });
    expect(all.assets.items).toHaveLength(2);
  });

  it("returns a hidden owner's album item from search without its location (withExif)", async () => {
    const { sut, ctx } = newSearch();
    const { member, album, theirs, ownersOwn } = await setupReshare(ctx);
    const auth = factory.auth({ user: member });

    const response = await sut.searchMetadata(auth, { albumIds: [album.id], withExif: true });
    const byId = new Map(response.assets.items.map((asset) => [asset.id, asset]));

    expect(byId.get(theirs.id)?.exifInfo).toMatchObject({
      latitude: null,
      longitude: null,
      city: null,
      state: null,
      country: null,
    });
    expect(byId.get(ownersOwn.id)?.exifInfo).toMatchObject({ city: 'Oslo', latitude: inOslo.latitude });
  });

  it("never counts a hidden owner's places in an album search's facets", async () => {
    const { sut, ctx } = newSearch();
    const { member, album } = await setupReshare(ctx);
    const auth = factory.auth({ user: member });
    const placeCounts = (response: Awaited<ReturnType<typeof sut.searchFacets>>, field: SearchFacetField) =>
      response.facets.find(({ fieldName }) => fieldName === field)?.counts;

    const v3 = await sut.searchFacets(auth, {
      filter: { albumIds: { any: [album.id] } },
      facets: [SearchFacetField.City, SearchFacetField.Country],
    });
    // both items are in the album, but only the album owner's own item names its place
    expect(v3.total).toBe(2);
    expect(placeCounts(v3, SearchFacetField.City)).toEqual([{ value: 'Oslo', count: 1 }]);
    expect(placeCounts(v3, SearchFacetField.Country)).toEqual([{ value: 'Norway', count: 1 }]);

    // the legacy flat body only ever searches the viewer's own and partner libraries, so a member reaches
    // no album item there at all
    const legacy = await sut.searchFacets(auth, { albumIds: [album.id], facets: [SearchFacetField.City] });
    expect(legacy.total).toBe(0);
  });

  it("keeps a hidden owner's items off a member's map through the album", async () => {
    const { sut, ctx } = newMap();
    const { member, ownersOwn } = await setupReshare(ctx);

    const markers = await sut.getMapMarkers(factory.auth({ user: member }), { withSharedAlbums: true });

    expect(markers.map(({ id }) => id)).toEqual([ownersOwn.id]);
  });
});
