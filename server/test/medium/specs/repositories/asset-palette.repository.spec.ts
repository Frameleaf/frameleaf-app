import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetPaletteDto } from 'src/dtos/asset-palette.dto.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetFileType } from 'src/enum.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetPaletteRepository } from 'src/repositories/asset-palette.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { rgbToOklab } from 'src/utils/asset-palette.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const setup = async () => {
  const ctx = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }).ctx;
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const repo = new AssetPaletteRepository(db);
  const source = await repo.source(asset.id);
  if (!source) throw new Error('Missing source');
  const ready: AssetPaletteDto = {
    version: 1,
    sourceRevision: source.sourceRevision,
    status: 'ready',
    representative: 'image',
    hasTransparency: true,
    swatches: [{ hex: '#ff0000', weight: 1, oklab: rgbToOklab(1, 0, 0) }],
  };
  return { repo, asset, ready, source };
};

describe('current palette SQL persistence', () => {
  it('invalidates old palette reads and publication when edits or generated files change', async () => {
    const { repo, asset, ready, source } = await setup();
    expect(await repo.publish(asset.id, source.sourceRevision, ready)).toBe(true);
    expect(await repo.get(asset.id)).toEqual(ready);
    await db
      .insertInto('asset_edit')
      .values({
        assetId: asset.id,
        action: AssetEditAction.Crop,
        parameters: { x: 0, y: 0, width: 1, height: 1 },
        sequence: 0,
      })
      .execute();
    const edited = await repo.source(asset.id);
    expect(edited?.sourceRevision).not.toBe(source.sourceRevision);
    expect(await repo.get(asset.id)).toEqual(expect.objectContaining({ status: 'pending', swatches: [] }));
    expect(await repo.publish(asset.id, source.sourceRevision, ready)).toBe(false);
    await db
      .insertInto('asset_file')
      .values({
        assetId: asset.id,
        path: `/synthetic/${randomUUID()}.png`,
        type: AssetFileType.Preview,
        isEdited: true,
      })
      .execute();
    expect((await repo.source(asset.id))?.sourceRevision).not.toBe(edited?.sourceRevision);
  });
  it('invalidates source selection when an image filename changes representative-frame handling', async () => {
    const { repo, asset, source } = await setup();
    await db.updateTable('asset').set({ originalFileName: 'reference.gif' }).where('id', '=', asset.id).execute();
    expect((await repo.source(asset.id))?.sourceRevision).not.toBe(source.sourceRevision);
  });
  it('rejects trashed/deleted sources and cascades only derived palette rows when an asset is deleted', async () => {
    const { repo, asset, ready, source } = await setup();
    await repo.publish(asset.id, source.sourceRevision, ready);
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();
    expect(await repo.source(asset.id)).toBeUndefined();
    expect(await repo.get(asset.id)).toBeUndefined();
    expect(await repo.publish(asset.id, source.sourceRevision, ready)).toBe(false);
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    expect(await db.selectFrom('asset_palette').selectAll().where('assetId', '=', asset.id).execute()).toEqual([]);
    expect(await db.selectFrom('asset_palette_swatch').selectAll().where('assetId', '=', asset.id).execute()).toEqual(
      [],
    );
  });
  it('rolls state and coordinate writes back together when a swatch write fails', async () => {
    const { repo, asset, ready, source } = await setup();
    await repo.publish(asset.id, source.sourceRevision, { ...ready, status: 'pending', swatches: [] });
    await expect(
      db.transaction().execute(async (tx) => {
        await sql`CREATE FUNCTION pg_temp.reject_palette_swatch() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''swatch write failed''; END;'`.execute(
          tx,
        );
        await sql`CREATE TRIGGER palette_test_reject BEFORE INSERT ON asset_palette_swatch FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_palette_swatch()`.execute(
          tx,
        );
        await repo.publish(asset.id, source.sourceRevision, ready, tx);
      }),
    ).rejects.toThrow('swatch write failed');
    expect(await repo.get(asset.id)).toEqual(expect.objectContaining({ status: 'pending', swatches: [] }));
    expect(await db.selectFrom('asset_palette_swatch').selectAll().where('assetId', '=', asset.id).execute()).toEqual(
      [],
    );
  });
});

it('resolves only the currently selected develop revision for palette refresh', async () => {
  const { repo, asset } = await setup();
  const revisions = new AssetDevelopRepository(db);
  const create = () =>
    revisions.create({
      assetId: asset.id,
      ownerId: asset.ownerId,
      recipe: defaultDevelopRecipe(),
      recipeVersion: 1,
      label: null,
      status: AssetDevelopRevisionStatus.Rendered,
    });
  const first = await create();
  const second = await create();
  expect(await repo.currentDevelopAssetId(first.id)).toBeUndefined();
  await revisions.setCurrent(asset.id, first.id);
  expect(await repo.currentDevelopAssetId(first.id)).toBe(asset.id);
  expect(await repo.currentDevelopAssetId(second.id)).toBeUndefined();
  await revisions.setCurrent(asset.id, second.id);
  expect(await repo.currentDevelopAssetId(first.id)).toBeUndefined();
  expect(await repo.currentDevelopAssetId(second.id)).toBe(asset.id);
});
