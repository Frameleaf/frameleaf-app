import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { AssetType, AssetVisibility, PhysicalFileType } from 'src/enum.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());

it.each(['fallback', 'develop'] as const)('includes additional originals in the %s quota recount', async (mode) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [AssetRepository], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  await ctx.newExif({ assetId: asset.id, fileSizeInByte: 100 });
  const file = await ctx.get(PhysicalFileRepository).upsertPhysicalFile({
    canonicalAssetId: asset.id,
    checksum: createHash('sha1').update(asset.id).digest(),
    path: `/fixture/${asset.id}/additional.raw`,
    sizeInBytes: 125,
    type: PhysicalFileType.Original,
  });
  await db
    .insertInto('asset_original')
    .values({ assetId: asset.id, physicalFileId: file.id, originalFileName: 'additional.raw' })
    .execute();
  const users = new UserRepository(db);
  const develop = new AssetDevelopRepository(db);
  if (mode === 'develop') {
    await develop.addArtifact({
      assetId: asset.id,
      ownerId: user.id,
      id: 'a'.repeat(64),
      kind: 'mask',
      path: `/fixture/${asset.id}/mask.png`,
      bytes: 50,
      width: 10,
      height: 10,
    });
  }
  const repository = mode === 'fallback' ? users : develop;
  await repository.syncUsage(user.id);
  await expect(users.get(user.id, {})).resolves.toMatchObject({ quotaUsageInBytes: mode === 'develop' ? 275 : 225 });
});

it('counts every original without multiplying logical counts or changing owner, privacy and library boundaries', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [AssetRepository], mock: [LoggingRepository] });
  const users = new UserRepository(db);
  const develop = new AssetDevelopRepository(db);
  const physical = ctx.get(PhysicalFileRepository);
  const { user: owner } = await ctx.newUser();
  const { user: other } = await ctx.newUser({ quotaUsageInBytes: 77 });
  const { user: empty } = await ctx.newUser();
  const library = await db
    .insertInto('library')
    .values({ ownerId: owner.id, name: 'Synthetic external library', importPaths: ['/fixture'], exclusionPatterns: [] })
    .returning('id')
    .executeTakeFirstOrThrow();
  const add = async (
    primaryBytes: number | null,
    additionalBytes: number[],
    options: Parameters<typeof ctx.newAsset>[0] = {},
  ) => {
    const { asset } = await ctx.newAsset({ ownerId: owner.id, ...options });
    if (primaryBytes !== null) {
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: primaryBytes });
    }
    for (const [index, sizeInBytes] of additionalBytes.entries()) {
      const path = `/fixture/${asset.id}/${index}.raw`;
      const file = await physical.upsertPhysicalFile({
        canonicalAssetId: asset.id,
        checksum: createHash('sha1').update(path).digest(),
        path,
        sizeInBytes,
        type: PhysicalFileType.Original,
      });
      await db
        .insertInto('asset_original')
        .values({ assetId: asset.id, physicalFileId: file.id, originalFileName: `${index}.raw` })
        .execute();
    }
  };
  await add(100, [30, 40]);
  await add(200, [60], { type: AssetType.Video });
  await add(20, [5], { visibility: AssetVisibility.Hidden });
  await add(50, [15], { visibility: AssetVisibility.Locked });
  await add(80, [25], { deletedAt: new Date() });
  await add(500, [900], { libraryId: library.id, isExternal: true });
  await add(null, [9]);
  await add(300, [600], { ownerId: other.id });

  const stats = await users.getUserStats();
  expect(stats.find(({ userId }) => userId === owner.id)).toMatchObject({
    photos: 3,
    videos: 1,
    usage: 529,
    usagePhotos: 269,
    usageVideos: 260,
  });
  expect(stats.find(({ userId }) => userId === other.id)).toMatchObject({ photos: 1, usage: 900 });
  expect(stats.find(({ userId }) => userId === empty.id)).toMatchObject({ photos: 0, videos: 0, usage: 0 });

  // Quota keeps counting trashed originals until permanent deletion releases them.
  await users.syncUsage(owner.id);
  await expect(users.get(owner.id, {})).resolves.toMatchObject({ quotaUsageInBytes: 634 });
  await expect(users.get(other.id, {})).resolves.toMatchObject({ quotaUsageInBytes: 77 });
  await users.syncUsage();
  await expect(users.get(other.id, {})).resolves.toMatchObject({ quotaUsageInBytes: 900 });
  await users.updateUsage(owner.id, -634);
  await expect(develop.syncUsage(owner.id)).resolves.toBe(true);
  await expect(users.get(owner.id, {})).resolves.toMatchObject({ quotaUsageInBytes: 634 });
  await users.updateUsage(other.id, -900);
  await expect(develop.syncUsage()).resolves.toBe(true);
  await expect(users.get(other.id, {})).resolves.toMatchObject({ quotaUsageInBytes: 900 });
});
