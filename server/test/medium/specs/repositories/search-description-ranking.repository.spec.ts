import { Kysely } from 'kysely';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import {
  DESCRIPTION_MATCH_MAX_BONUS,
  DESCRIPTION_MATCH_MAX_DISTANCE,
  SearchRepository,
} from 'src/repositories/search.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { SearchService } from 'src/services/search.service.js';
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

// Unit vector at the given cosine distance from the query (axis 0), bending
// toward `axis` so different assets stay distinct.
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

describe('smart search ranking with description embeddings (FL-656)', () => {
  const rank = async (items: Array<{ name: string; visual: number; description?: number }>): Promise<string[]> => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const repository = ctx.get(SearchRepository);
    const names = new Map<string, string>();
    for (const [index, item] of items.entries()) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await repository.upsert(asset.id, atDistance(item.visual, index + 1));
      if (item.description !== undefined) {
        await repository.upsertDescriptionEmbedding(asset.id, atDistance(item.description, index + 100));
      }
      names.set(asset.id, item.name);
    }
    const { items: results } = await repository.searchSmart(
      { page: 1, size: 10 },
      { userIds: [user.id], embedding: query },
    );
    return results.map(({ id }) => names.get(id)!);
  };

  it('keeps a clearly better visual match ahead of a photo with an unrelated description', async () => {
    // Measured on a real library: a matching photo is ~0.85 from the query,
    // an unrelated photo ~1.1, and an unrelated description ~0.58.
    await expect(
      rank([
        { name: 'licence', visual: 1.1, description: 0.58 },
        { name: 'dog', visual: 0.85 },
        { name: 'beach', visual: 1.05, description: 0.6 },
      ]),
    ).resolves.toEqual(['dog', 'beach', 'licence']);
  });

  it('caps the boost so even an exact description cannot beat a clearly better visual match', async () => {
    await expect(
      rank([
        // 0.15 behind: a bonus above the 0.1 cap would move it ahead.
        { name: 'described', visual: 1, description: 0 },
        { name: 'dog', visual: 0.85 },
      ]),
    ).resolves.toEqual(['dog', 'described']);
  });

  it('lets a strong description match lift a photo past a close visual rival', async () => {
    await expect(
      rank([
        { name: 'visual-only', visual: 0.86 },
        { name: 'described', visual: 0.9, description: 0.15 },
      ]),
    ).resolves.toEqual(['described', 'visual-only']);
  });

  it('gives no boost to descriptions at or beyond the match threshold', async () => {
    await expect(
      rank([
        { name: 'visual-only', visual: 0.86 },
        {
          name: 'described',
          visual: 0.85 + DESCRIPTION_MATCH_MAX_BONUS / 2,
          description: DESCRIPTION_MATCH_MAX_DISTANCE,
        },
      ]),
    ).resolves.toEqual(['visual-only', 'described']);
  });

  it('never pushes a photo down for a description beyond the threshold', async () => {
    // Without the floor at zero, the 0.05 overshoot would add ~0.011 and drop it behind the rival.
    await expect(
      rank([
        { name: 'visual-only', visual: 0.86 },
        { name: 'described', visual: 0.855, description: DESCRIPTION_MATCH_MAX_DISTANCE + 0.05 },
      ]),
    ).resolves.toEqual(['described', 'visual-only']);
  });
});
