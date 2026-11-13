import { type Kysely } from 'kysely';
import { AssetType, AssetVisibility, UserMetadataKey } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkflowRepository } from 'src/repositories/photography-workflow.repository.js';
import type { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

it('makes each shoot only once and never adds photos owned by someone else or Locked', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user: owner } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const { asset: own } = await ctx.newAsset({ ownerId: owner.id, type: AssetType.Image });
  const { asset: foreign } = await ctx.newAsset({ ownerId: other.id, type: AssetType.Image });
  const { asset: locked } = await ctx.newAsset({
    ownerId: owner.id,
    type: AssetType.Image,
    visibility: AssetVisibility.Locked,
  });
  const repository = new PhotographyWorkflowRepository(db);
  const input = { title: 'Portraits', clientName: 'Morgan', clientEmail: 'morgan@example.test' };
  const id = newUuid();
  const create = (ids: string[], shootId = id) =>
    repository
      .mutateStudio(owner.id, undefined, (_record, tx) =>
        repository.createBulkShoot(tx, owner.id, shootId, { ...input, assetIds: ids }),
      )
      .then(({ result }) => result);

  await expect(create([own.id, foreign.id], newUuid())).resolves.toBeUndefined();
  await expect(create([own.id, locked.id], newUuid())).resolves.toBeUndefined();
  const [first, second] = await Promise.all([create([own.id]), create([own.id])]);
  expect(first).toBeDefined();
  expect(second).toBe(first);
  expect(await db.selectFrom('album_asset').select('assetId').where('albumId', '=', first!).execute()).toEqual([
    { assetId: own.id },
  ]);
  const workspace = await db
    .selectFrom('user_metadata')
    .select('value')
    .where('userId', '=', owner.id)
    .where('key', '=', UserMetadataKey.PhotographyWorkspace)
    .executeTakeFirstOrThrow();
  expect(workspace.value).toMatchObject({ shoots: [{ id, albumId: first }] });
  await db.deleteFrom('album').where('id', '=', first!).execute();
  await db.deleteFrom('user').where('id', 'in', [owner.id, other.id]).execute();
});
