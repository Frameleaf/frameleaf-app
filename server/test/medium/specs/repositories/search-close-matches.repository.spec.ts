import { Kysely } from 'kysely';
import { AssetVisibility, LibraryScope } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { SearchService } from 'src/services/search.service.js';
import { countCloseMatches } from 'src/utils/search-relevance.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () =>
  newMediumService(SearchService, {
    database: defaultDatabase,
    real: [
      AccessRepository,
      AssetRepository,
      ConfigRepository,
      DatabaseRepository,
      SystemMetadataRepository,
      SearchRepository,
      PartnerRepository,
    ],
    mock: [LoggingRepository],
  });

const DIMENSIONS = 768;

// Unit vector at the given cosine distance from the query (axis 0), bending toward `axis` so
// different assets stay distinct.
const atDistance = (distance: number, axis = 1) => {
  const cos = 1 - distance;
  const values = Array.from({ length: DIMENSIONS }, () => 0);
  values[0] = cos;
  values[axis] = Math.sqrt(1 - cos * cos);
  return `[${values.join(',')}]`;
};

const query = atDistance(0);

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('close matches of a search by meaning (FL-1393)', () => {
  /** A library with one embedded photo at each distance, and a Locked one at each of `hidden`. */
  const library = async (distances: number[], hidden: number[] = []) => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const repository = ctx.get(SearchRepository);
    let axis = 1;
    for (const distance of distances) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await repository.upsert(asset.id, atDistance(distance, axis++));
    }
    for (const distance of hidden) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      await repository.upsert(asset.id, atDistance(distance, axis++));
    }
    return { repository, userId: user.id, ctx };
  };

  // Four lakes around 0.9 and forty unrelated photos spread from 0.97 to 1.048.
  const lakes = [0.9, 0.91, 0.92, 0.925];
  const others = Array.from({ length: 40 }, (_, index) => 0.97 + index * 0.002);

  it('returns each result with the distance it was ranked by, closest first', async () => {
    const { repository, userId } = await library([...others, ...lakes]);

    const { items } = await repository.searchSmart({ page: 1, size: 10 }, { userIds: [userId], embedding: query });

    const distances = items.map(({ searchDistance }) => Number(searchDistance));
    expect(distances.slice(0, 4)).toEqual(lakes.map((distance) => expect.closeTo(distance, 4)));
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it('measures what an unrelated photo scores, and that splits the lakes from the rest', async () => {
    const { repository, userId } = await library([...others, ...lakes]);

    const unrelated = await repository.getUnrelatedSearchDistance(query, [userId]);
    // The 90th percentile of the 44 distances sits among the farthest of the unrelated photos.
    expect(unrelated).toBeGreaterThan(1.03);
    expect(unrelated).toBeLessThan(1.048);

    const { items } = await repository.searchSmart({ page: 1, size: 100 }, { userIds: [userId], embedding: query });
    expect(
      countCloseMatches(
        items.map(({ searchDistance, visualDistance }) => ({
          searchDistance: Number(searchDistance),
          visualDistance: Number(visualDistance),
        })),
        unrelated,
      ),
    ).toBe(lakes.length);
  });

  it('counts a photo whose description names the search without pushing the look-alikes out', async () => {
    const { repository, userId, ctx } = await library([...others, ...lakes]);
    // Looks only a little like the search (0.95) but its description names it, which ranks it first.
    const { asset: named } = await ctx.newAsset({ ownerId: userId });
    await ctx.newExif({ assetId: named.id, description: 'lake house' });
    await repository.upsert(named.id, atDistance(0.95, 700));

    const { items } = await repository.searchSmart(
      { page: 1, size: 100 },
      { userIds: [userId], embedding: query, query: 'lake house' },
    );
    expect(items[0].id).toBe(named.id);
    expect(Number(items[0].visualDistance)).toBeCloseTo(0.95, 4);
    expect(Number(items[0].searchDistance)).toBeLessThan(0.9);

    const unrelated = await repository.getUnrelatedSearchDistance(query, [userId]);
    expect(
      countCloseMatches(
        items.map(({ searchDistance, visualDistance }) => ({
          searchDistance: Number(searchDistance),
          visualDistance: Number(visualDistance),
        })),
        unrelated,
      ),
    ).toBe(lakes.length + 1);
  });

  it('measures the library the search looked in', async () => {
    // Thirty photos at 1.0 in the photo library; a design library far closer must not move the line.
    const { repository, userId, ctx } = await library(Array.from({ length: 30 }, () => 1));
    for (let index = 0; index < 30; index++) {
      const { asset } = await ctx.newAsset({ ownerId: userId, libraryScope: LibraryScope.Design });
      await repository.upsert(asset.id, atDistance(0.5, 400 + index));
    }

    await expect(repository.getUnrelatedSearchDistance(query, [userId])).resolves.toBeCloseTo(1, 4);
    await expect(repository.getUnrelatedSearchDistance(query, [userId], LibraryScope.Design)).resolves.toBeCloseTo(
      0.5,
      4,
    );
  });

  it('says nothing for a library with too few embedded photos to judge', async () => {
    const { repository, userId } = await library([...lakes, ...others.slice(0, 10)]);

    await expect(repository.getUnrelatedSearchDistance(query, [userId])).resolves.toBeNull();
  });

  it('measures only photos a plain search shows, and only the person’s own', async () => {
    // Thirty visible photos at 1.0; Locked photos and another person's photos far closer must not move it.
    const { repository, userId } = await library(
      Array.from({ length: 30 }, () => 1),
      Array.from({ length: 30 }, () => 0.5),
    );
    await library(Array.from({ length: 30 }, () => 0.5));

    await expect(repository.getUnrelatedSearchDistance(query, [userId])).resolves.toBeCloseTo(1, 4);
  });
});
