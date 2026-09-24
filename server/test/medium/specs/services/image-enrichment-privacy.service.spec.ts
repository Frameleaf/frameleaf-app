import { Kysely, sql } from 'kysely';
import { AssetImageEnrichmentAction } from 'src/dtos/asset.dto.js';
import { AssetLockReason, AssetStatus, AssetType, AssetVisibility, JobStatus } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { ImageEnrichmentService } from 'src/services/image-enrichment.service.js';
import { withoutHiddenContent, withoutNsfwAssets } from 'src/utils/database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB, getKyselyDB } from 'test/utils.js';

/**
 * FL-34 (ported from PR127 f77249be16, adapted to per-asset `asset_lock`): a sensitive review, its
 * privacy projection and the lock it implies commit together inside the enrichment metadata
 * transaction, and an explicit owner mark or safe decision repairs a missing projection row.
 */
let database: Kysely<DB>;
beforeAll(async () => {
  database = await getActiveForkKyselyDB();
});
afterAll(async () => database?.destroy());

const setup = async (visibility = AssetVisibility.Timeline) => {
  const { sut, ctx } = newMediumService(ImageEnrichmentService, {
    database,
    real: [AccessRepository, AssetRepository, DatabaseRepository, ConfigRepository, PersonRepository, UserRepository],
    // detection is routed to an ML destination (FL-110, after PR127); the mock routes it to a healthy local one
    mock: [
      JobRepository,
      LoggingRepository,
      AssetJobRepository,
      MachineLearningRepository,
      MlDestinationRepository,
      SystemMetadataRepository,
    ],
  });
  Object.assign(sut, { db: database });
  const { user } = await ctx.newUser();
  // `Locked` seeds a timeline asset with an `asset_lock` record (the stored visibility is never locked)
  const { asset } = await ctx.newAsset({ ownerId: user.id, visibility });
  const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
  const mark = (action: AssetImageEnrichmentAction) => sut.updateAssetEnrichment(auth, asset.id, { action });
  const visible = () =>
    database.selectFrom('asset').select('id').where('id', '=', asset.id).$call(withoutNsfwAssets).execute();
  const lockRow = () =>
    database.selectFrom('asset_lock').select(['assetId', 'reason']).where('assetId', '=', asset.id).executeTakeFirst();
  return { sut, ctx, user, asset, auth, mark, visible, lockRow };
};

it.each([AssetVisibility.Timeline, AssetVisibility.Archive, AssetVisibility.Locked])(
  'projects mark/safe and its lock immediately while preserving %s visibility, albums and original paths',
  async (visibility) => {
    const { ctx, user, asset, mark, visible, lockRow } = await setup(visibility);
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
    await expect(visible()).resolves.toEqual([{ id: asset.id }]);
    await expect(mark(AssetImageEnrichmentAction.MarkNsfw)).resolves.toMatchObject({
      nsfwDetection: { effectiveIsNsfw: true },
    });
    await expect(visible()).resolves.toEqual([]);
    await expect(lockRow()).resolves.toMatchObject({ assetId: asset.id });
    await mark(AssetImageEnrichmentAction.MarkNsfw); // retry
    await expect(visible()).resolves.toEqual([]);
    await expect(mark(AssetImageEnrichmentAction.MarkSafe)).resolves.toMatchObject({
      nsfwDetection: { effectiveIsNsfw: false },
    });
    await expect(visible()).resolves.toEqual([{ id: asset.id }]);
    await expect(lockRow()).resolves.toBeUndefined();
    const expectedVisibility = visibility === AssetVisibility.Locked ? AssetVisibility.Timeline : visibility;
    await expect(
      database.selectFrom('asset').select(['visibility', 'originalPath']).where('id', '=', asset.id).executeTakeFirst(),
    ).resolves.toEqual({ visibility: expectedVisibility, originalPath: asset.originalPath });
    await expect(
      database.selectFrom('album_asset').select('albumId').where('assetId', '=', asset.id).execute(),
    ).resolves.toEqual([{ albumId: album.id }]);
  },
);

it('fails closed on missing privacy rows except an explicit owner mark or safe repair', async () => {
  const { sut, auth, asset, mark, visible, lockRow } = await setup();
  const enrichment = new ForkEnrichmentRepository(database);
  const before = await enrichment.get(asset.id);
  await new ForkPrivacyRepository(database).delete([asset.id]);
  await expect(visible()).resolves.toEqual([]);
  await expect(sut.getAssetEnrichment(auth, asset.id)).rejects.toThrow('Missing fork privacy sidecar');
  await expect(mark(AssetImageEnrichmentAction.AcceptNsfwResult)).rejects.toThrow('Missing fork privacy sidecar');
  await expect(enrichment.get(asset.id)).resolves.toEqual(before);
  await expect(visible()).resolves.toEqual([]);
  await expect(lockRow()).resolves.toBeUndefined();
  await mark(AssetImageEnrichmentAction.MarkNsfw);
  await expect(visible()).resolves.toEqual([]);
  await expect(lockRow()).resolves.toMatchObject({ assetId: asset.id });
  await new ForkPrivacyRepository(database).delete([asset.id]);
  await mark(AssetImageEnrichmentAction.MarkSafe);
  await expect(visible()).resolves.toEqual([{ id: asset.id }]);
  await expect(lockRow()).resolves.toBeUndefined();
});

it('rolls back the review and its lock when the privacy projection fails', async () => {
  const { asset, mark, lockRow } = await setup();
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
    await expect(lockRow()).resolves.toBeUndefined();
  } finally {
    save.mockRestore();
  }
});

it('rolls back the review and its projection when the lock fails', async () => {
  const { asset, mark, lockRow } = await setup();
  const enrichment = new ForkEnrichmentRepository(database);
  const before = await enrichment.get(asset.id);
  const lock = vi.spyOn(AssetRepository.prototype, 'lock').mockRejectedValueOnce(new Error('lock unavailable'));
  try {
    await expect(mark(AssetImageEnrichmentAction.MarkNsfw)).rejects.toThrow('lock unavailable');
    await expect(enrichment.get(asset.id)).resolves.toEqual(before);
    await expect(new ForkPrivacyRepository(database).get(asset.id)).resolves.toMatchObject({
      isNsfw: false,
      suppression: null,
    });
    await expect(lockRow()).resolves.toBeUndefined();
  } finally {
    lock.mockRestore();
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
    } as never);
    const started = Promise.withResolvers<void>();
    const inference = Promise.withResolvers<{ isNsfw: boolean; score: number; labels: Record<string, number> }>();
    const detector = ctx.getMock(MachineLearningRepository).detectNsfw;
    detector.mockImplementationOnce(() => {
      started.resolve();
      return inference.promise;
    });
    const pending = sut.handleNsfwDetection({ id: asset.id });
    // fail fast, with the job's result, if the job ends without ever reaching the detector
    await Promise.race([
      started.promise,
      pending.then((status) => {
        throw new Error(`detection finished (${status}) without reaching the detector`);
      }),
    ]);
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
  ).rejects.toThrow();
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
  const filter = {
    userId: user.id,
    includeNsfw: true,
    tagIds: [tag.id],
    personIds: [],
    petIds: [],
    scope: 'owned' as const,
  };
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

it('marks two members of one stack in parallel before the cutover without a deadlock', async () => {
  const legacy = await getKyselyDB();
  try {
    const { sut, ctx } = newMediumService(ImageEnrichmentService, {
      database: legacy,
      // before the cutover the review also writes its tags
      real: [
        AccessRepository,
        AssetRepository,
        DatabaseRepository,
        ConfigRepository,
        PersonRepository,
        TagRepository,
        UserRepository,
      ],
      mock: [
        EventRepository,
        JobRepository,
        LoggingRepository,
        AssetJobRepository,
        MachineLearningRepository,
        SystemMetadataRepository,
      ],
    });
    Object.assign(sut, { db: legacy });
    ctx.getMock(EventRepository).emit.mockResolvedValue();
    ctx.getMock(JobRepository).queue.mockResolvedValue();
    ctx.getMock(JobRepository).queueAll.mockResolvedValue();
    const { user } = await ctx.newUser();
    const { asset: first } = await ctx.newAsset({ ownerId: user.id });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newStack({ ownerId: user.id }, [first.id, second.id]);
    const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
    const action = AssetImageEnrichmentAction.MarkNsfw;

    // each writes its own is_nsfw, then locks the whole stack: without a fixed row order they deadlock
    for (let attempt = 0; attempt < 5; attempt++) {
      await Promise.all([
        sut.updateAssetEnrichment(auth, first.id, { action }),
        sut.updateAssetEnrichment(auth, second.id, { action }),
      ]);
      await Promise.all([
        sut.updateAssetEnrichment(auth, first.id, { action: AssetImageEnrichmentAction.MarkSafe }),
        sut.updateAssetEnrichment(auth, second.id, { action: AssetImageEnrichmentAction.MarkSafe }),
      ]);
    }

    await Promise.all([
      sut.updateAssetEnrichment(auth, first.id, { action }),
      sut.updateAssetEnrichment(auth, second.id, { action }),
    ]);
    await expect(
      legacy
        .selectFrom('asset_lock')
        .select('assetId')
        .where('assetId', 'in', [first.id, second.id])
        .orderBy('assetId')
        .execute(),
    ).resolves.toHaveLength(2);
  } finally {
    await legacy.destroy();
  }
});

it('marks one stack member while another is moved to Locked in parallel without a deadlock', async () => {
  const { sut, ctx, user, asset: first, auth } = await setup();
  const { asset: second } = await ctx.newAsset({ ownerId: user.id });
  await ctx.newStack({ ownerId: user.id }, [first.id, second.id]);
  const assets = ctx.get(AssetRepository);

  // The review holds the stack's rows from the start of its transaction and writes its lock records
  // later. Move to Locked (`AssetService.lock` → `AssetRepository.lock`) starts in that window: were it
  // to write its lock records before taking the rows, each would wait on the other.
  let moved: Promise<string[]> | undefined;
  const takeRows = assets.lockGroupRows.bind(assets);
  const spy = vi.spyOn(AssetRepository.prototype, 'lockGroupRows').mockImplementation(async (ids, trx) => {
    await takeRows(ids, trx);
    moved = assets.lock([second.id], AssetLockReason.Marked, user.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  try {
    await sut.updateAssetEnrichment(auth, first.id, { action: AssetImageEnrichmentAction.MarkNsfw });
    await moved;
  } finally {
    spy.mockRestore();
  }

  await expect(
    database
      .selectFrom('asset_lock')
      .select('assetId')
      .where('assetId', 'in', [first.id, second.id])
      .orderBy('assetId')
      .execute(),
  ).resolves.toHaveLength(2);
});
