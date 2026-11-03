import { Kysely } from 'kysely';
import { JobName, JobStatus, PhysicalFileType } from 'src/enum.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());

it.each(['fallback', 'develop'] as const)(
  'recounts and releases the same original bytes through %s accounting',
  async (mode) => {
    const { sut, ctx } = newMediumService(AssetService, {
      database: db,
      real: [AssetRepository, AssetJobRepository, PhysicalFileRepository, UserRepository],
      mock: [JobRepository, EventRepository, LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const { user: unrelated } = await ctx.newUser({ quotaUsageInBytes: 77 });
    const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
    await ctx.newExif({ assetId: asset.id, fileSizeInByte: 5000 });
    const physical = await ctx.get(PhysicalFileRepository).upsertPhysicalFile({
      canonicalAssetId: asset.id,
      checksum: Buffer.alloc(20, 7),
      sizeInBytes: 42,
      path: `/fixture/${asset.id}/extra.raw`,
      type: PhysicalFileType.Original,
    });
    await db
      .insertInto('asset_original')
      .values({ assetId: asset.id, physicalFileId: physical.id, originalFileName: 'extra.raw' })
      .execute();
    const users = ctx.get(UserRepository);
    const accounting = mode === 'fallback' ? users : new AssetDevelopRepository(db);
    await accounting.syncUsage(user.id);
    expect.soft(await users.get(user.id, {})).toMatchObject({ quotaUsageInBytes: 5042 });
    ctx.getMock(JobRepository).queue.mockResolvedValue();
    ctx.getMock(EventRepository).emit.mockResolvedValue();

    await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);
    expect.soft(await users.get(user.id, {})).toMatchObject({ quotaUsageInBytes: 0 });
    expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
      name: JobName.FileDelete,
      data: expect.objectContaining({
        additionalOriginals: [expect.objectContaining({ ownerId: user.id, assetId: asset.id, sizeInBytes: 42 })],
      }),
    });
    await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Skipped);
    await accounting.syncUsage(user.id);
    await expect(users.get(user.id, {})).resolves.toMatchObject({ quotaUsageInBytes: 0 });
    await expect(users.get(unrelated.id, {})).resolves.toMatchObject({ quotaUsageInBytes: 77 });
  },
);
