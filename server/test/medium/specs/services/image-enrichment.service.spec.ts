import { Kysely, sql } from 'kysely';
import { AssetImageEnrichmentAction } from 'src/dtos/asset.dto.js';
import { AssetStatus, AssetType, AssetVisibility, JobStatus } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { ImageEnrichmentService } from 'src/services/image-enrichment.service.js';
import { withoutHiddenContent, withoutNsfwAssets } from 'src/utils/database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getActiveForkKyselyDB();
});
afterAll(async () => database?.destroy());

const setup = async (visibility = AssetVisibility.Timeline) => {
  const { sut, ctx } = newMediumService(ImageEnrichmentService, {
    database,
    real: [AccessRepository, AssetRepository, DatabaseRepository, ConfigRepository],
    mock: [JobRepository, LoggingRepository, AssetJobRepository, MachineLearningRepository, SystemMetadataRepository],
  });
  Object.assign(sut, { db: database });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, visibility });
  const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
  const mark = (action: AssetImageEnrichmentAction) => sut.updateAssetEnrichment(auth, asset.id, { action });
  const visible = () =>
    database.selectFrom('asset').select('id').where('id', '=', asset.id).$call(withoutNsfwAssets).execute();
  return { sut, ctx, user, asset, auth, mark, visible };
};

it.each([AssetVisibility.Timeline, AssetVisibility.Archive, AssetVisibility.Locked])(
  'projects mark/safe immediately while preserving %s visibility, albums and original paths',
  async (visibility) => {
    const { ctx, user, asset, mark, visible } = await setup(visibility);
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
    await expect(visible()).resolves.toEqual([{ id: asset.id }]);
    await expect(mark(AssetImageEnrichmentAction.MarkNsfw)).resolves.toMatchObject({
      nsfwDetection: { effectiveIsNsfw: true },
    });
    await expect(visible()).resolves.toEqual([]);
    await mark(AssetImageEnrichmentAction.MarkNsfw); // retry
    await expect(visible()).resolves.toEqual([]);
    await expect(mark(AssetImageEnrichmentAction.MarkSafe)).resolves.toMatchObject({
      nsfwDetection: { effectiveIsNsfw: false },
    });
    await expect(visible()).resolves.toEqual([{ id: asset.id }]);
    await expect(
      database
        .selectFrom('asset')
        .select(['visibility', 'originalPath', 'is_nsfw'])
        .where('id', '=', asset.id)
        .executeTakeFirst(),
    ).resolves.toEqual({ visibility, originalPath: asset.originalPath, is_nsfw: false });
    await expect(
      database.selectFrom('album_asset').select('albumId').where('assetId', '=', asset.id).execute(),
    ).resolves.toEqual([{ albumId: album.id }]);
  },
);

it('fails closed on missing privacy rows except an explicit owner mark or safe repair', async () => {
  const { sut, auth, asset, mark, visible } = await setup();
  const enrichment = new ForkEnrichmentRepository(database);
  const before = await enrichment.get(asset.id);
  await new ForkPrivacyRepository(database).delete([asset.id]);
  await expect(visible()).resolves.toEqual([]);
  await expect(sut.getAssetEnrichment(auth, asset.id)).rejects.toThrow('Missing fork privacy sidecar');
  await expect(mark(AssetImageEnrichmentAction.AcceptNsfwResult)).rejects.toThrow('Missing fork privacy sidecar');
  await expect(enrichment.get(asset.id)).resolves.toEqual(before);
  await expect(visible()).resolves.toEqual([]);
  await mark(AssetImageEnrichmentAction.MarkNsfw);
  await expect(visible()).resolves.toEqual([]);
  await new ForkPrivacyRepository(database).delete([asset.id]);
  await mark(AssetImageEnrichmentAction.MarkSafe);
  await expect(visible()).resolves.toEqual([{ id: asset.id }]);
});

it('rolls back enrichment when its privacy projection fails', async () => {
  const { asset, mark } = await setup();
  const enrichment = new ForkEnrichmentRepository(database);
  const before = await enrichment.get(asset.id);
  const save = vi
    .spyOn(ForkPrivacyRepository.prototype, 'saveClassification')
    .mockRejectedValueOnce(new Error('projection unavailable'));
  try {
    await expect(mark(AssetImageEnrichmentAction.MarkNsfw)).rejects.toThrow('projection unavailable');
    await expect(enrichment.get(asset.id)).resolves.toEqual(before);
    await expect(new ForkPrivacyRepository(database).get(asset.id)).resolves.toMatchObject({
      isNsfw: false,
      suppression: null,
    });
  } finally {
    save.mockRestore();
  }
});

it.each([true, false])(
  'preserves a manual %s review against an in-flight detector and its retry/failure',
  async (isNsfw) => {
    const { sut, ctx, asset, user, mark, visible } = await setup();
    ctx
      .getMock(SystemMetadataRepository)
      .get.mockResolvedValue({ machineLearning: { enabled: true, nsfwDetection: { enabled: true } } });
    ctx.getMock(AssetJobRepository).getForImageEnrichment.mockResolvedValue({
      id: asset.id,
      ownerId: user.id,
      type: AssetType.Image,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      description: '',
      previewFile: '/synthetic/preview.webp',
    });
    const started = Promise.withResolvers<void>();
    const inference = Promise.withResolvers<{ isNsfw: boolean; score: number; labels: Record<string, number> }>();
    const detector = ctx.getMock(MachineLearningRepository).detectNsfw;
    detector.mockImplementationOnce(() => {
      started.resolve();
      return inference.promise;
    });
    const pending = sut.handleNsfwDetection({ id: asset.id });
    await started.promise;
    await mark(isNsfw ? AssetImageEnrichmentAction.MarkNsfw : AssetImageEnrichmentAction.MarkSafe);
    inference.resolve({ isNsfw: !isNsfw, score: 0.99, labels: {} });
    await expect(pending).resolves.toBe(JobStatus.Success);
    detector.mockRejectedValueOnce(new Error('model unavailable'));
    await expect(sut.handleNsfwDetection({ id: asset.id })).resolves.toBe(JobStatus.Failed);
    await expect(new ForkPrivacyRepository(database).get(asset.id)).resolves.toMatchObject({
      isNsfw,
      suppression: { isNsfw, reviewedBy: user.id },
    });
    await expect(visible()).resolves.toEqual(isNsfw ? [] : [{ id: asset.id }]);
  },
);

it('does not grant another owner review or asset access to an elevated administrator', async () => {
  const { sut, ctx, asset, mark } = await setup();
  await mark(AssetImageEnrichmentAction.MarkNsfw);
  const { user: administrator } = await ctx.newUser({ isAdmin: true });
  const auth = factory.auth({
    user: { id: administrator.id, isAdmin: true },
    session: { hasElevatedPermission: true },
  });
  await expect(
    sut.updateAssetEnrichment(auth, asset.id, { action: AssetImageEnrichmentAction.MarkSafe }),
  ).rejects.toThrow('Not found or no asset.update access');
  await expect(
    ctx.get(AccessRepository).asset.checkOwnerAccess(administrator.id, new Set([asset.id]), true),
  ).resolves.toEqual(new Set());
});

it('retains independent tag and person hiding after marking safe', async () => {
  const { ctx, user, asset, mark } = await setup();
  const { tag } = await ctx.newTag({ userId: user.id, value: 'private-tag' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
  const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Private person' });
  await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
  await mark(AssetImageEnrichmentAction.MarkNsfw);
  await mark(AssetImageEnrichmentAction.MarkSafe);
  const filter = { userId: user.id, includeNsfw: true, tagIds: [tag.id], personIds: [], scope: 'owned' as const };
  await expect(
    database
      .selectFrom('asset')
      .select('id')
      .where('id', '=', asset.id)
      .$call((qb) => withoutHiddenContent(qb, filter))
      .execute(),
  ).resolves.toEqual([]);
  await expect(
    database
      .selectFrom('asset')
      .select('id')
      .where('id', '=', asset.id)
      .$call((qb) => withoutHiddenContent(qb, { ...filter, tagIds: [], personIds: [person.personGroupId!] }))
      .execute(),
  ).resolves.toEqual([]);
  await expect(
    database.selectFrom('tag_asset').select('tagId').where('assetId', '=', asset.id).execute(),
  ).resolves.toContainEqual({ tagId: tag.id });
  await expect(
    sql`SELECT suppression FROM immich_fork.asset_privacy WHERE "assetId" = ${asset.id}::uuid`.execute(database),
  ).resolves.toMatchObject({ rows: [{ suppression: { action: 'marked-safe' } }] });
});
