import { Kysely, sql } from 'kysely';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhysicalFileType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/2100000003044-AssetAdditionalOriginals.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());

it('can roll back an empty original-reference table and reinstall it', async () => {
  await down(db);
  try {
    const result = await sql<{
      table: string | null;
    }>`SELECT to_regclass('public.asset_original')::text AS table`.execute(db);
    expect(result.rows[0].table).toBeNull();
  } finally {
    await up(db);
  }
});

it('retains an additional original after its primary asset is removed, until its last asset releases it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-import-original-'));
  try {
    const path = join(directory, 'original.raw');
    const bytes = Buffer.from('independently verified synthetic original');
    await writeFile(path, bytes);
    const { ctx } = newMediumService(BaseService, { database: db, real: [AssetRepository], mock: [LoggingRepository] });
    const physical = ctx.get(PhysicalFileRepository);
    const { user } = await ctx.newUser();
    const { asset: primary } = await ctx.newAsset({ ownerId: user.id, originalPath: path });
    const { asset: keepsOriginal } = await ctx.newAsset({
      ownerId: user.id,
      originalPath: join(directory, 'other-primary.jpg'),
    });
    const original = await physical.upsertPhysicalFile({
      canonicalAssetId: primary.id,
      checksum: createHash('sha1').update(bytes).digest(),
      sizeInBytes: bytes.length,
      path,
      type: PhysicalFileType.Original,
    });
    await sql`INSERT INTO public.asset_original ("assetId", "physicalFileId", "originalFileName")
      VALUES (${keepsOriginal.id}::uuid, ${original.id}::uuid, 'original.raw')`.execute(db);
    await db.deleteFrom('asset').where('id', '=', primary.id).execute();

    await expect(physical.deleteUnreferencedPath(path, () => unlink(path))).resolves.toMatchObject({
      deleted: false,
      references: 1,
    });
    expect(await readFile(path)).toEqual(bytes);
    await expect(db.deleteFrom('physical_file').where('id', '=', original.id).execute()).rejects.toThrow();
    await expect(down(db)).rejects.toThrow('Additional originals must be preserved before downgrading');

    await db.deleteFrom('asset').where('id', '=', keepsOriginal.id).execute();
    await expect(physical.deleteUnreferencedPath(path, () => unlink(path))).resolves.toMatchObject({
      deleted: true,
      references: 0,
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
