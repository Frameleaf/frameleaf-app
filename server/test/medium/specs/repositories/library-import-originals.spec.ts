import { Kysely, sql } from 'kysely';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobStatus, PhysicalFileType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/2100000003044-AssetAdditionalOriginals.js';
import { BaseService } from 'src/services/base.service.js';
import { StorageService } from 'src/services/storage.service.js';
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

it('captures additional originals atomically with removal and retains them when queuing fails', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [AssetRepository], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const path = `/data/upload/${asset.id}/extra.raw`;
  const physical = await ctx.get(PhysicalFileRepository).upsertPhysicalFile({
    canonicalAssetId: asset.id,
    checksum: Buffer.alloc(20, 7),
    sizeInBytes: 42,
    path,
    type: PhysicalFileType.Original,
  });
  await db
    .insertInto('asset_original')
    .values({ assetId: asset.id, physicalFileId: physical.id, originalFileName: 'extra.raw' })
    .execute();
  const assets = ctx.get(AssetRepository);
  const files = (removed: { originalPath: string; additionalOriginals?: { path: string }[] }) => [
    removed.originalPath,
    ...(removed.additionalOriginals ?? []).map((original) => original.path),
  ];
  await expect(
    assets.remove(asset, { files, queue: () => Promise.reject(new Error('queue unavailable')) }),
  ).rejects.toThrow('queue unavailable');
  expect(
    await db.selectFrom('asset_original').select('physicalFileId').where('assetId', '=', asset.id).execute(),
  ).toHaveLength(1);
  const queue = vi.fn().mockResolvedValue(undefined);
  const removed = await assets.remove(asset, { files, queue });
  expect(queue).toHaveBeenCalledWith(expect.arrayContaining([asset.originalPath, path]));
  expect(removed).toMatchObject({
    additionalOriginals: [{ path, checksum: Buffer.alloc(20, 7), sizeInBytes: 42, originalFileName: 'extra.raw' }],
  });
  expect(
    await db.selectFrom('asset_original').select('physicalFileId').where('assetId', '=', asset.id).execute(),
  ).toEqual([]);
});

it('moves released additional-original bytes to file trash with owner provenance and survives job replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-import-original-trash-'));
  StorageCore.setMediaLocation(directory);
  try {
    const path = join(directory, 'extra.raw');
    const bytes = Buffer.from('synthetic additional original with owner provenance');
    const checksum = createHash('sha256').update(bytes).digest();
    await writeFile(path, bytes);
    const { sut, ctx } = newMediumService(StorageService, {
      database: db,
      real: [AssetRepository, PhysicalFileRepository, StorageRepository],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: join(directory, 'primary.jpg') });
    const physical = await ctx.get(PhysicalFileRepository).upsertPhysicalFile({
      canonicalAssetId: asset.id,
      checksum,
      path,
      sizeInBytes: bytes.length,
      type: PhysicalFileType.Original,
    });
    await db
      .insertInto('asset_original')
      .values({ assetId: asset.id, physicalFileId: physical.id, originalFileName: 'camera-original.raw' })
      .execute();
    const removed = await ctx.get(AssetRepository).remove(asset);
    expect(removed).toBeDefined();
    const job = {
      files: [path],
      removedAssetId: asset.id,
      additionalOriginals: removed!.additionalOriginals.map((original) => ({
        ...original,
        checksum: original.checksum.toString('hex'),
        ownerId: user.id,
        assetId: asset.id,
      })),
    };
    await expect(sut.handleDeleteFiles(job)).resolves.toBe(JobStatus.Success);
    await expect(sut.handleDeleteFiles(job)).resolves.toBe(JobStatus.Success);
    const { rows: entries } = await sql<{
      path: string;
      lastOwnerId: string;
      lastAssetId: string;
      originalFileName: string;
      checksum: Buffer;
      sizeInBytes: number;
    }>`SELECT path,"lastOwnerId","lastAssetId","originalFileName",checksum,"sizeInBytes"
      FROM public.physical_file_trash WHERE "lastAssetId"=${asset.id}::uuid`.execute(db);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      lastOwnerId: user.id,
      lastAssetId: asset.id,
      originalFileName: 'camera-original.raw',
      checksum,
      sizeInBytes: bytes.length,
    });
    expect(await readFile(entries[0].path)).toEqual(bytes);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    StorageCore.reset();
    await rm(directory, { recursive: true, force: true });
  }
});
