import { Kysely, sql } from 'kysely';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PrintBackRepository } from 'src/repositories/print-back.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { isPrintBack } from 'src/utils/database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-967: what only the database can prove: the release trigger, in every way a pair can end. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = async (backVisibility = AssetVisibility.Timeline) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset: front } = await ctx.newAsset({ ownerId: user.id });
  const { asset: back } = await ctx.newAsset({ ownerId: user.id, visibility: backVisibility });
  const repository = new PrintBackRepository(db);
  await repository.pair(front.id, back.id, () => {});
  return { front, back, repository };
};

const visibilityOf = async (id: string) =>
  (await db.selectFrom('asset').select('visibility').where('id', '=', id).executeTakeFirstOrThrow()).visibility;
const lockOf = (id: string) =>
  db.selectFrom('asset_lock').select('reason').where('assetId', '=', id).executeTakeFirst();

describe('asset_print_back', () => {
  it('hides the back while paired', async () => {
    const { back } = await setup();

    await expect(visibilityOf(back.id)).resolves.toBe(AssetVisibility.Hidden);
    const row = await db
      .selectFrom('asset')
      .select(isPrintBack('asset').as('isPrintBack'))
      .where('id', '=', back.id)
      .executeTakeFirstOrThrow();
    expect(row.isPrintBack).toBe(true);
  });

  it.each([AssetVisibility.Timeline, AssetVisibility.Archive])('unpair restores %s', async (visibility) => {
    const { front, back, repository } = await setup(visibility);

    await repository.unpair(front.id);

    await expect(visibilityOf(back.id)).resolves.toBe(visibility);
  });

  it('restores the back when the front is deleted', async () => {
    const { front, back } = await setup(AssetVisibility.Archive);

    await db.deleteFrom('asset').where('id', '=', front.id).execute();

    await expect(visibilityOf(back.id)).resolves.toBe(AssetVisibility.Archive);
  });

  it('keeps the back private when a Locked front is deleted', async () => {
    const { front, back } = await setup();
    await db.insertInto('asset_lock').values({ assetId: front.id, reason: AssetLockReason.Marked }).execute();

    await db.deleteFrom('asset').where('id', '=', front.id).execute();

    await expect(lockOf(back.id)).resolves.toEqual({ reason: AssetLockReason.Marked });
  });

  it('keeps the back private when unpaired from a Locked front', async () => {
    const { front, back, repository } = await setup();
    await db.insertInto('asset_lock').values({ assetId: front.id, reason: AssetLockReason.Marked }).execute();

    await repository.unpair(front.id);

    await expect(lockOf(back.id)).resolves.toEqual({ reason: AssetLockReason.Marked });
  });

  it('survives one statement deleting front and back together', async () => {
    const { front, back } = await setup();

    await expect(db.deleteFrom('asset').where('id', 'in', [front.id, back.id]).execute()).resolves.toBeDefined();

    const { rows } = await sql`select 1 from asset_print_back where "frontAssetId" = ${front.id}`.execute(db);
    expect(rows).toHaveLength(0);
  });

  it('removes the pair and leaves the front when the back is deleted', async () => {
    const { front, back } = await setup();

    await db.deleteFrom('asset').where('id', '=', back.id).execute();

    await expect(visibilityOf(front.id)).resolves.toBe(AssetVisibility.Timeline);
  });
});
