import type { Kysely } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

it('retries a sidecar import atomically and creates a separate version when its settings change', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const repo = new AssetDevelopRepository(db);
  const input = (checksum: string) => ({
    assetId: asset.id,
    ownerId: user.id,
    recipe: { ...defaultDevelopRecipe(), imported: { checksum, lightroom: { CameraProfile: 'test profile' } } },
    recipeVersion: 1,
    importChecksum: checksum,
    requireRenderable: true,
    label: 'From Lightroom',
    software: 'Lightroom',
    status: AssetDevelopRevisionStatus.Saved,
  });
  const versions = await Promise.all([repo.create(input('a'.repeat(64))), repo.create(input('a'.repeat(64)))]);
  expect(versions[0].id).toBe(versions[1].id);
  const changed = await repo.create(input('b'.repeat(64)));
  expect(changed.id).not.toBe(versions[0].id);
  expect(await repo.getCurrent(asset.id)).toBeUndefined();
  expect(changed.recipe.imported).toMatchObject({ lightroom: { CameraProfile: 'test profile' } });
});
