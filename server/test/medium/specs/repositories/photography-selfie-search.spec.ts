import type { Kysely } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

it('scopes exact face distance to visible faces on the specified assets owned by the studio', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user: studio } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const vector = (x: number, y: number) => JSON.stringify([x, y, ...Array.from({ length: 510 }, () => 0)]);
  const query = vector(1, 0);
  async function photo(ownerId: string, embedding: string, isVisible = true) {
    const { asset } = await ctx.newAsset({ ownerId });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, isVisible });
    await db.insertInto('face_search').values({ faceId: assetFace.id, embedding }).execute();
    return asset.id;
  }
  try {
    const best = await photo(studio.id, query);
    const otherVisible = await photo(studio.id, vector(0.8, 0.6));
    const foreign = await photo(other.id, query);
    const unpublished = await photo(studio.id, query);
    const hidden = await photo(studio.id, query, false);
    const far = await photo(studio.id, vector(0, 1));

    expect(unpublished).not.toBe(best);
    const repository = new SearchRepository(db);
    await expect(
      repository.findGalleryFaces(studio.id, [otherVisible, foreign, hidden, far, best], query, 0.4),
    ).resolves.toEqual([best, otherVisible]);
  } finally {
    await db.deleteFrom('user').where('id', 'in', [studio.id, other.id]).execute();
  }
});
