import { type Kysely, sql } from 'kysely';
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

it('returns only the unchanged native render attempt and preserves cancellations or replacement attempts', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const repo = new AssetDevelopRepository(db);
  for (const change of ['unchanged', 'cancelled', 'new-attempt', 'new-progress'] as const) {
    const revision = await repo.create({
      assetId: asset.id,
      ownerId: user.id,
      recipe: defaultDevelopRecipe(),
      recipeVersion: 1,
      label: null,
      status: AssetDevelopRevisionStatus.Queued,
    });
    const attempt = (await repo.beginAttempt(revision.id, 'native-test', 600))!;
    switch (change) {
      case 'cancelled': {
        await repo.requestCancel(revision.id);
        break;
      }
      case 'new-attempt': {
        await repo.update(revision.id, { attempts: attempt.attempts + 1 });
        break;
      }
      case 'new-progress': {
        await sql`UPDATE asset_develop_revision SET "updatedAt" = "updatedAt" + interval '1 second' WHERE id = ${revision.id}::uuid`.execute(
          db,
        );
        break;
      }
      case 'unchanged': {
        break;
      }
    }
    const before = await repo.get(revision.id);
    expect(await repo.deferAttempt(attempt)).toBe(['unchanged', 'new-progress'].includes(change));
    if (['unchanged', 'new-progress'].includes(change))
      expect(await repo.get(revision.id)).toMatchObject({ status: 'queued', attempts: 0 });
    else expect(await repo.get(revision.id)).toEqual(before);
    expect(await repo.deferAttempt(attempt)).toBe(false);
  }
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
