import { Kysely } from 'kysely';
import { AssetMetadataKey, JobName, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { DescriptionTagCleanupService } from 'src/services/description-tag-cleanup.service.js';
import { upsertTags } from 'src/utils/tag.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const service = newMediumService(DescriptionTagCleanupService, {
    database: db || defaultDatabase,
    real: [AssetRepository, TagRepository, SystemMetadataRepository],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  service.ctx.getMock(EventRepository).emit.mockResolvedValue();
  service.ctx.getMock(JobRepository).queue.mockResolvedValue();
  return service;
};

type Context = ReturnType<typeof setup>['ctx'];

/** Tags these values on an asset, as the description step or a person does. */
const tag = async (ctx: Context, ownerId: string, assetId: string, values: string[]) => {
  const tags = await upsertTags(ctx.get(TagRepository), { userId: ownerId, tags: values });
  await ctx.get(TagRepository).upsertAssetIds(tags.map(({ id }) => ({ tagId: id, assetId })));
};

/** The record the description step leaves after applying `applied` (pre-FL-659, so filler included). */
const recordDescription = async (ctx: Context, assetId: string, applied: string[], resultTags = applied) => {
  await ctx.get(AssetRepository).upsertMetadata(assetId, [
    {
      key: AssetMetadataKey.MlEnrichment,
      value: {
        description: {
          status: 'success',
          modelName: 'florence-2',
          updatedAt: new Date().toISOString(),
          result: { description: 'A dog behind her, four balls.', tags: resultTags },
          appliedTagHash: 'abcd1234',
          appliedTagValues: applied,
        },
      },
    },
  ]);
};

const assetTags = async (ctx: Context, assetId: string) => {
  const rows = await ctx.database
    .selectFrom('tag_asset')
    .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
    .select('tag.value')
    .where('tag_asset.assetId', '=', assetId)
    .execute();
  return rows.map(({ value }) => value).toSorted();
};

const ownerTags = async (ctx: Context, ownerId: string) => {
  const rows = await ctx.database.selectFrom('tag').select('value').where('userId', '=', ownerId).execute();
  return rows.map(({ value }) => value).toSorted();
};

const enrichment = async (ctx: Context, assetId: string) => {
  const row = await ctx.get(AssetRepository).getMetadataByKey(assetId, AssetMetadataKey.MlEnrichment);
  return (row?.value as { description: { appliedTagValues: string[]; result: { tags: string[] } } }).description;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

beforeEach(async () => {
  // each case is a fresh upgrade
  await new SystemMetadataRepository(defaultDatabase).delete(SystemMetadataKey.DescriptionFillerTagCleanup);
});

describe(DescriptionTagCleanupService.name, () => {
  it('removes the filler tags a description applied and keeps its real tags', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await tag(ctx, user.id, asset.id, ['dog', 'her', 'behind', 'four']);
    await recordDescription(ctx, asset.id, ['dog', 'her', 'behind', 'four']);

    await expect(sut.handleDescriptionFillerTagCleanup()).resolves.toBe(JobStatus.Success);

    expect(await assetTags(ctx, asset.id)).toEqual(['dog']);
    const description = await enrichment(ctx, asset.id);
    expect(description.appliedTagValues).toEqual(['dog']);
    expect(description.result.tags).toEqual(['dog']);
    const exif = await ctx.database
      .selectFrom('asset_exif')
      .select('tags')
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(exif.tags).toEqual(['dog']);
    expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetUntag', { assetId: asset.id });
  });

  it('keeps a tag a person added, even with a filler value', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset: described } = await ctx.newAsset({ ownerId: user.id });
    const { asset: personTagged } = await ctx.newAsset({ ownerId: user.id });
    const { asset: both } = await ctx.newAsset({ ownerId: user.id });
    await tag(ctx, user.id, described.id, ['behind']);
    await recordDescription(ctx, described.id, ['behind']);
    // a person tagged this one "behind"; its description left no record of applying it
    await tag(ctx, user.id, personTagged.id, ['behind']);
    // the person tagged this one before it was described, so the description recorded only "dog"
    await tag(ctx, user.id, both.id, ['behind', 'dog']);
    await recordDescription(ctx, both.id, ['dog'], ['dog', 'behind']);

    await sut.handleDescriptionFillerTagCleanup();

    expect(await assetTags(ctx, described.id)).toEqual([]);
    expect(await assetTags(ctx, personTagged.id)).toEqual(['behind']);
    expect(await assetTags(ctx, both.id)).toEqual(['behind', 'dog']);
    // still in use, so the tag stays
    expect(await ownerTags(ctx, user.id)).toEqual(['behind', 'dog']);
  });

  it('deletes a filler tag once no asset uses it, and only that owner’s', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { asset: first } = await ctx.newAsset({ ownerId: user.id });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id });
    await tag(ctx, user.id, first.id, ['dog', 'her', 'four']);
    await recordDescription(ctx, first.id, ['dog', 'her', 'four']);
    await tag(ctx, user.id, second.id, ['her']);
    await recordDescription(ctx, second.id, ['her']);
    // an empty "four" another account made by hand is not this clean-up's to delete
    await upsertTags(ctx.get(TagRepository), { userId: other.id, tags: ['four'] });

    await sut.handleDescriptionFillerTagCleanup();

    expect(await ownerTags(ctx, user.id)).toEqual(['dog']);
    expect(await ownerTags(ctx, other.id)).toEqual(['four']);
  });

  it('runs once: the bootstrap queues it until it has finished, and a second run changes nothing', async () => {
    const { sut, ctx } = setup();
    const metadata = ctx.get(SystemMetadataRepository);
    const jobs = ctx.getMock(JobRepository);

    await sut.onBootstrap();
    expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.DescriptionFillerTagCleanup, data: {} });

    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await tag(ctx, user.id, asset.id, ['dog', 'her']);
    await recordDescription(ctx, asset.id, ['dog', 'her']);
    await expect(sut.handleDescriptionFillerTagCleanup()).resolves.toBe(JobStatus.Success);
    expect(await metadata.get(SystemMetadataKey.DescriptionFillerTagCleanup)).toEqual(
      expect.objectContaining({ completedAt: expect.any(String) }),
    );

    // filler applied after the run (it could not be, with FL-659; this proves the run never repeats)
    await tag(ctx, user.id, asset.id, ['her']);
    await recordDescription(ctx, asset.id, ['dog', 'her']);
    jobs.queue.mockClear();
    await sut.onBootstrap();
    expect(jobs.queue).not.toHaveBeenCalled();
    await expect(sut.handleDescriptionFillerTagCleanup()).resolves.toBe(JobStatus.Skipped);
    expect(await assetTags(ctx, asset.id)).toEqual(['dog', 'her']);
  });
});
