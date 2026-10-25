import { sql } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { down, up } from 'src/schema/migrations/2100000003014-DevelopSourceBindings.js';
import { BaseService } from 'src/services/base.service.js';
import { sourceOriginalPath } from 'src/utils/source-original.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

it('marks historical parent and motion references unbound without guessing their current bytes', async () => {
  const db = await getKyselyDB();
  try {
    await db.transaction().execute(down);
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { asset: managed } = await ctx.newAsset({ ownerId: user.id });
    const { asset: reference } = await ctx.newAsset({
      ownerId: user.id,
      originalPath: sourceOriginalPath({ sourceId: newUuid(), resourceKey: 'b'.repeat(64) }),
    });
    const rows = [
      { id: newUuid(), assetId: reference.id, sourceAssetId: null },
      { id: newUuid(), assetId: managed.id, sourceAssetId: reference.id },
      { id: newUuid(), assetId: managed.id, sourceAssetId: managed.id },
    ];
    for (const [index, row] of rows.entries())
      await sql`INSERT INTO asset_develop_revision (id,"assetId","ownerId",revision,recipe,"sourceAssetId")
        VALUES (${row.id}::uuid,${row.assetId}::uuid,${user.id}::uuid,${index + 1},'{"version":1}'::jsonb,
          ${row.sourceAssetId}::uuid)`.execute(db);
    await db.transaction().execute(up);
    const result = await sql<{ id: string; sourceBinding: unknown }>`SELECT id,"sourceBinding"
      FROM asset_develop_revision ORDER BY revision`.execute(db);
    expect(result.rows).toEqual([
      { id: rows[0].id, sourceBinding: { kind: 'unbound-reference' } },
      { id: rows[1].id, sourceBinding: { kind: 'unbound-reference' } },
      { id: rows[2].id, sourceBinding: null },
    ]);
    await expect(db.transaction().execute(down)).rejects.toThrow('Cannot discard retained develop source bindings');
    expect((await sql`SELECT "sourceBinding" FROM asset_develop_revision`.execute(db)).rows).toHaveLength(3);
  } finally {
    await db.destroy();
  }
});

it.each(['renderAttemptId', 'renderGenerationId'])(
  'refuses rollback while %s retains render ownership',
  async (field) => {
    const db = await getKyselyDB();
    try {
      const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const fence = newUuid();
      await sql`INSERT INTO asset_develop_revision ("assetId","ownerId",revision,recipe,${sql.ref(field)})
      VALUES (${asset.id}::uuid,${user.id}::uuid,1,'{"version":1}'::jsonb,${fence}::uuid)`.execute(db);
      await expect(db.transaction().execute(down)).rejects.toThrow('Cannot discard retained develop source bindings');
      expect((await sql`SELECT ${sql.ref(field)} AS fence FROM asset_develop_revision`.execute(db)).rows).toEqual([
        { fence },
      ]);
    } finally {
      await db.destroy();
    }
  },
);

it('permits an empty rollback and reapply without losing the nullable binding and fence columns', async () => {
  const db = await getKyselyDB();
  try {
    await db.transaction().execute(down);
    await db.transaction().execute(up);
    const { rows } = await sql<{ column_name: string; is_nullable: string }>`SELECT column_name,is_nullable
      FROM information_schema.columns WHERE table_schema='public' AND table_name='asset_develop_revision'
        AND column_name IN ('sourceBinding','renderAttemptId','renderGenerationId') ORDER BY column_name`.execute(db);
    expect(rows).toEqual(
      ['renderAttemptId', 'renderGenerationId', 'sourceBinding'].map((column_name) => ({
        column_name,
        is_nullable: 'YES',
      })),
    );
  } finally {
    await db.destroy();
  }
});
