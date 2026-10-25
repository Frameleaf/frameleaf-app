import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetType } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { down, up } from 'src/schema/migrations/2100000003013-SavedEditSourceReferences.js';
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

it('marks historical reference recipes unbound, preserves managed edits and guards provenance on rollback', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset: reference } = await ctx.newAsset({
    ownerId: user.id,
    type: AssetType.Image,
    originalPath: 'frameleaf-source://018e50c9-910e-4ef7-b38e-2ca6e8801667/' + 'a'.repeat(64),
  });
  const { asset: managed } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
  await db.transaction().execute(down);
  for (const asset of [reference, managed]) {
    await db
      .insertInto('asset_edit')
      .values({ assetId: asset.id, action: AssetEditAction.Rotate, parameters: { angle: 90 }, sequence: 1 })
      .execute();
  }
  await db.transaction().execute(up);
  const rows = await db.selectFrom('asset_edit').select(['assetId', 'sourceReference', 'parameters']).execute();
  expect(rows.find((row) => row.assetId === reference.id)).toMatchObject({
    sourceReference: { kind: 'unbound-reference' },
    parameters: { angle: 90 },
  });
  expect(rows.find((row) => row.assetId === managed.id)?.sourceReference).toBeNull();
  await expect(db.transaction().execute(down)).rejects.toThrow('Cannot discard saved edit source references');
  expect(
    (
      await db
        .selectFrom('asset_edit')
        .select('sourceReference')
        .where('assetId', '=', reference.id)
        .executeTakeFirstOrThrow()
    ).sourceReference,
  ).toEqual({ kind: 'unbound-reference' });
  await db.updateTable('asset_edit').set({ sourceReference: null }).where('assetId', '=', reference.id).execute();
  await db.transaction().execute(down);
  await db.transaction().execute(up);
  expect(
    (
      await db
        .selectFrom('asset_edit')
        .select('sourceReference')
        .where('assetId', '=', reference.id)
        .executeTakeFirstOrThrow()
    ).sourceReference,
  ).toEqual({ kind: 'unbound-reference' });
});

it('refuses rollback while a video version retains its exact source snapshot', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
  const id = randomUUID();
  const snapshot = { resourceId: randomUUID(), version: 'a'.repeat(64), sha256: 'b'.repeat(64) };
  await db.updateTable('asset_edit').set({ sourceReference: null }).execute();
  await sql`INSERT INTO video_edit_version (id,"assetId","ownerId","sourcePath","sourceChecksum","sourceReference",recipe,purpose)
    VALUES (${id}::uuid,${asset.id}::uuid,${user.id}::uuid,${asset.originalPath},${asset.checksum},${JSON.stringify(snapshot)}::text::jsonb,'[]'::jsonb,'save')`.execute(
    db,
  );
  await expect(db.transaction().execute(down)).rejects.toThrow('Cannot discard saved edit source references');
  const { rows } = await sql<{
    sourceReference: unknown;
  }>`SELECT "sourceReference" FROM video_edit_version WHERE id=${id}::uuid`.execute(db);
  expect(rows[0].sourceReference).toEqual(snapshot);
  await sql`DELETE FROM video_edit_version WHERE id=${id}::uuid`.execute(db);
  await db.deleteFrom('asset_edit').execute();
  await db.transaction().execute(down);
  await db.transaction().execute(up);
});
