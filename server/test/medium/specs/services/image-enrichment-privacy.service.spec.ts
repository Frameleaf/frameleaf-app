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
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
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
      EventRepository,
      JobRepository,
      LoggingRepository,
      AssetJobRepository,
      MachineLearningRepository,
      MlDestinationRepository,
      SystemMetadataRepository,
      WebsocketRepository,
    ],
  });
  Object.assign(sut, { db: database });
  // FL-90: marking an asset sensitive moves it to Locked, which announces AssetLocked.
  ctx.getMock(EventRepository).emit.mockResolvedValue();
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

// FL-34: "hiding policy remains independent of detector enablement". An owner's mark hides and a safe
// review shows again with machine learning, or only the detector, switched off.
it.each([
  ['machine learning off', { machineLearning: { enabled: false, nsfwDetection: { enabled: true } } }],
  ['the detector off', { machineLearning: { enabled: true, nsfwDetection: { enabled: false } } }],
])('marks and reviews as safe with %s', async (_label, config) => {
  const { ctx, asset, mark, visible, lockRow } = await setup();
  ctx.getMock(SystemMetadataRepository).get.mockResolvedValue(config);
  await mark(AssetImageEnrichmentAction.MarkNsfw);
  await expect(visible()).resolves.toEqual([]);
  await expect(lockRow()).resolves.toMatchObject({ assetId: asset.id, reason: AssetLockReason.Marked });
  await mark(AssetImageEnrichmentAction.MarkSafe);
  await expect(visible()).resolves.toEqual([{ id: asset.id }]);
  await expect(lockRow()).resolves.toBeUndefined();
});

// FL-34: "retain legacy visibility-locked compatibility separately". Mark Safe answers a sensitive
// verdict; an item its owner kept in the upstream Locked folder stays Locked until they unlock it.
it('keeps an item from the upstream Locked folder Locked when it is marked safe', async () => {
  const { asset, mark, lockRow } = await setup();
  await database
    .insertInto('asset_lock')
    .values({ assetId: asset.id, reason: AssetLockReason.ImmichLockedFolder, lockedBy: null })
    .execute();
  await expect(mark(AssetImageEnrichmentAction.MarkSafe)).resolves.toMatchObject({
    nsfwDetection: { effectiveIsNsfw: false },
  });
  await expect(lockRow()).resolves.toMatchObject({ assetId: asset.id, reason: AssetLockReason.ImmichLockedFolder });
});

// FL-34: after the cutover a missing privacy row is "no classification yet" (not sensitive, no review);
// reading it returns the defaults and every enrichment write creates it
describe('an asset without a privacy row after the cutover', () => {
  const privacyRow = (assetId: string) => new ForkPrivacyRepository(database).get(assetId);
  const withoutRow = async () => {
    const context = await setup();
    await new ForkPrivacyRepository(database).delete([context.asset.id]);
    await expect(privacyRow(context.asset.id)).resolves.toBeUndefined();
    return context;
  };

  it('reads as unclassified without writing a row', async () => {
    const { sut, auth, asset } = await withoutRow();
    const response = await sut.getAssetEnrichment(auth, asset.id);
    expect(response.nsfwDetection?.effectiveIsNsfw ?? false).toBe(false);
    await expect(privacyRow(asset.id)).resolves.toBeUndefined();
  });

  it('creates the row, unclassified, when a description is saved', async () => {
    const { sut, asset } = await withoutRow();
    const service = sut as unknown as {
      saveEnrichmentMetadata(id: string, value: object, kysely: Kysely<DB>): Promise<void>;
    };
    await database.transaction().execute((trx) =>
      service.saveEnrichmentMetadata(
        asset.id,
        {
          description: {
            status: 'success',
            modelName: 'vlm',
            updatedAt: '2026-09-24T00:00:00.000Z',
            result: { description: 'A beach', tags: ['beach'] },
          },
        },
        trx,
      ),
    );
    await expect(privacyRow(asset.id)).resolves.toMatchObject({ isNsfw: false, suppression: null });
  });

  it.each([true, false])('creates the row with the detection verdict (%s)', async (isNsfw) => {
    const { sut, ctx, asset, user } = await withoutRow();
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
    ctx.getMock(MachineLearningRepository).detectNsfw.mockResolvedValue({ isNsfw, score: 0.99, labels: {} });

    await expect(sut.handleNsfwDetection({ id: asset.id })).resolves.toBe(JobStatus.Success);

    await expect(privacyRow(asset.id)).resolves.toMatchObject({ isNsfw, suppression: null });
  });

  it.each([
    [AssetImageEnrichmentAction.MarkNsfw, true, true],
    [AssetImageEnrichmentAction.MarkSafe, false, false],
    [AssetImageEnrichmentAction.AcceptNsfwResult, false, false],
  ])('creates the row when %s is chosen, with its lock', async (action, isNsfw, locked) => {
    const { asset, mark, lockRow } = await withoutRow();
    await mark(action);
    await expect(privacyRow(asset.id)).resolves.toMatchObject({ isNsfw });
    await (locked
      ? expect(lockRow()).resolves.toMatchObject({ assetId: asset.id })
      : expect(lockRow()).resolves.toBeUndefined());
  });
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
        WebsocketRepository,
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

// FL-34 (ported from aj/fl34-server-privacy-recovery 16427197ac, 4e03a93516 and 2e4170eb5e, adapted to the
// row-locked `asset_lock` design): Mark Safe unlocks a whole stack or live photo, so it reviews every member
describe('Mark Safe on a stack', () => {
  const setupStack = async () => {
    const context = await setup();
    const { asset: sibling } = await context.ctx.newAsset({ ownerId: context.user.id });
    await context.ctx.newStack({ ownerId: context.user.id }, [context.asset.id, sibling.id]);
    const lockRows = () =>
      database
        .selectFrom('asset_lock')
        .select('assetId')
        .where('assetId', 'in', [context.asset.id, sibling.id])
        .execute();
    return { ...context, sibling, lockRows };
  };

  it('reviews every member safe, so neither a later detection nor the sweep relocks the stack', async () => {
    const { sut, ctx, asset, sibling, user, mark, lockRows } = await setupStack();
    await mark(AssetImageEnrichmentAction.MarkNsfw);
    await expect(lockRows()).resolves.toHaveLength(2);

    await mark(AssetImageEnrichmentAction.MarkSafe);

    await expect(lockRows()).resolves.toEqual([]);
    for (const id of [asset.id, sibling.id]) {
      await expect(new ForkPrivacyRepository(database).get(id)).resolves.toMatchObject({
        isNsfw: false,
        suppression: { action: 'marked-safe', reviewedBy: user.id },
      });
    }

    ctx.getMock(SystemMetadataRepository).get.mockResolvedValue({
      machineLearning: { enabled: true, nsfwDetection: { enabled: true, hideFromLibrary: true } },
    });
    ctx.getMock(AssetJobRepository).getForImageEnrichment.mockResolvedValue({
      id: sibling.id,
      ownerId: user.id,
      type: AssetType.Image,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      description: '',
      previewFile: '/synthetic/sibling.webp',
    } as never);
    ctx.getMock(MachineLearningRepository).detectNsfw.mockResolvedValue({ isNsfw: true, score: 0.99, labels: {} });
    await expect(sut.handleNsfwDetection({ id: sibling.id })).resolves.toBe(JobStatus.Success);

    await expect(lockRows()).resolves.toEqual([]);
    await expect(new ForkPrivacyRepository(database).get(sibling.id)).resolves.toMatchObject({
      isNsfw: false,
      suppression: { action: 'marked-safe' },
    });
    const unreviewed = await ctx.get(AssetRepository).getUnlockedDetectionIds();
    expect(unreviewed).not.toContain(asset.id);
    expect(unreviewed).not.toContain(sibling.id);
  });

  it('checks elevation against the group, even when only a sibling is locked', async () => {
    const { sut, asset, sibling, user, lockRows } = await setupStack();
    // a lock record on the sibling only, as an interrupted legacy writer could leave
    await database.insertInto('asset_lock').values({ assetId: sibling.id, reason: AssetLockReason.Marked }).execute();
    const ordinary = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: false } });

    await expect(
      sut.updateAssetEnrichment(ordinary, asset.id, { action: AssetImageEnrichmentAction.MarkSafe }),
    ).rejects.toThrow('Elevated permission is required');

    await expect(lockRows()).resolves.toEqual([{ assetId: sibling.id }]);
    await expect(new ForkPrivacyRepository(database).get(asset.id)).resolves.toMatchObject({ suppression: null });
  });

  it('rolls back the unlock and every review when a sibling review cannot be saved', async () => {
    const { asset, sibling, mark, lockRows } = await setupStack();
    await mark(AssetImageEnrichmentAction.MarkNsfw);
    const original = ForkPrivacyRepository.prototype.saveClassification;
    const save = vi.spyOn(ForkPrivacyRepository.prototype, 'saveClassification').mockImplementation(function (
      this: ForkPrivacyRepository,
      ...args
    ) {
      return args[0] === sibling.id ? Promise.reject(new Error('sibling review failed')) : original.apply(this, args);
    });
    try {
      await expect(mark(AssetImageEnrichmentAction.MarkSafe)).rejects.toThrow('sibling review failed');
    } finally {
      save.mockRestore();
    }

    await expect(lockRows()).resolves.toHaveLength(2);
    await expect(new ForkPrivacyRepository(database).get(asset.id)).resolves.toMatchObject({
      isNsfw: true,
      suppression: { action: 'marked-nsfw' },
    });
  });

  it('repairs a missing projection of an asset already reviewed safe, keeping its review', async () => {
    const { asset, sibling, mark } = await setupStack();
    await mark(AssetImageEnrichmentAction.MarkNsfw);
    await mark(AssetImageEnrichmentAction.MarkSafe);
    const privacy = new ForkPrivacyRepository(database);
    const safe = await privacy.get(asset.id);
    await privacy.delete([asset.id]);

    await expect(mark(AssetImageEnrichmentAction.MarkSafe)).resolves.toMatchObject({
      nsfwDetection: { effectiveIsNsfw: false },
    });

    await expect(privacy.get(asset.id)).resolves.toEqual(
      expect.objectContaining({ isNsfw: false, suppression: safe!.suppression }),
    );
    await expect(privacy.get(sibling.id)).resolves.toMatchObject({ isNsfw: false });
  });

  it('leaves a detected but unlocked sibling with its detector verdict', async () => {
    const { sut, ctx, asset, sibling, user, mark, lockRows } = await setupStack();
    // hiding is off, so the detection flags the sibling without locking it
    ctx.getMock(SystemMetadataRepository).get.mockResolvedValue({
      machineLearning: { enabled: true, nsfwDetection: { enabled: true, hideFromLibrary: false } },
    });
    ctx.getMock(AssetJobRepository).getForImageEnrichment.mockResolvedValue({
      id: sibling.id,
      ownerId: user.id,
      type: AssetType.Image,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      description: '',
      previewFile: '/synthetic/sibling.webp',
    } as never);
    ctx.getMock(MachineLearningRepository).detectNsfw.mockResolvedValue({ isNsfw: true, score: 0.99, labels: {} });
    await expect(sut.handleNsfwDetection({ id: sibling.id })).resolves.toBe(JobStatus.Success);
    await expect(lockRows()).resolves.toEqual([]);

    await mark(AssetImageEnrichmentAction.MarkSafe);

    await expect(new ForkPrivacyRepository(database).get(asset.id)).resolves.toMatchObject({
      isNsfw: false,
      suppression: { action: 'marked-safe', reviewedBy: user.id },
    });
    await expect(new ForkPrivacyRepository(database).get(sibling.id)).resolves.toMatchObject({
      isNsfw: true,
      suppression: null,
    });
    // viewers who hide sensitive content still do not see it
    await expect(
      database.selectFrom('asset').select('id').where('id', '=', sibling.id).$call(withoutNsfwAssets).execute(),
    ).resolves.toEqual([]);
  });

  it('marks two members of one stack safe in parallel without a deadlock', async () => {
    const { sut, auth, asset, sibling, mark, lockRows } = await setupStack();
    for (let attempt = 0; attempt < 3; attempt++) {
      await mark(AssetImageEnrichmentAction.MarkNsfw);
      await Promise.all(
        [asset.id, sibling.id].map((id) =>
          sut.updateAssetEnrichment(auth, id, { action: AssetImageEnrichmentAction.MarkSafe }),
        ),
      );
      await expect(lockRows()).resolves.toEqual([]);
    }
  });
});

// FL-34: an owner unlock and the reviews it implies commit together, in one transaction
describe('unlocking assets', () => {
  it('keeps every asset locked when an owner-unlock review cannot be saved', async () => {
    const { sut, ctx, auth, user, asset, mark, lockRow } = await setup();
    await mark(AssetImageEnrichmentAction.MarkNsfw);
    const { asset: other } = await ctx.newAsset({ ownerId: user.id });
    await sut.updateAssetEnrichment(auth, other.id, { action: AssetImageEnrichmentAction.MarkNsfw });
    const original = ForkPrivacyRepository.prototype.saveClassification;
    const save = vi.spyOn(ForkPrivacyRepository.prototype, 'saveClassification').mockImplementation(function (
      this: ForkPrivacyRepository,
      ...args
    ) {
      return args[0] === other.id ? Promise.reject(new Error('review failed')) : original.apply(this, args);
    });
    try {
      await expect(sut.unlockAssets(auth, { ids: [asset.id, other.id] })).rejects.toThrow('review failed');
    } finally {
      save.mockRestore();
    }

    await expect(lockRow()).resolves.toMatchObject({ assetId: asset.id });
    await expect(
      database.selectFrom('asset_lock').select('assetId').where('assetId', '=', other.id).execute(),
    ).resolves.toHaveLength(1);
    await expect(new ForkPrivacyRepository(database).get(asset.id)).resolves.toMatchObject({ isNsfw: true });
  });

  it('accepts repeated unlocks of overlapping stack members and reviews each once', async () => {
    const { sut, ctx, auth, user, asset, mark } = await setup();
    const { asset: sibling } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newStack({ ownerId: user.id }, [asset.id, sibling.id]);
    await mark(AssetImageEnrichmentAction.MarkNsfw);

    await expect(sut.unlockAssets(auth, { ids: [asset.id, sibling.id] })).resolves.toBeUndefined();
    const reviewed = await new ForkPrivacyRepository(database).get(sibling.id);
    await expect(sut.unlockAssets(auth, { ids: [asset.id, sibling.id] })).resolves.toBeUndefined();

    await expect(
      database.selectFrom('asset_lock').select('assetId').where('assetId', 'in', [asset.id, sibling.id]).execute(),
    ).resolves.toEqual([]);
    expect(reviewed).toMatchObject({ isNsfw: false, suppression: { action: 'marked-safe', reviewedBy: user.id } });
    await expect(new ForkPrivacyRepository(database).get(sibling.id)).resolves.toEqual(reviewed);
  });
});

// FL-36: the description confidence round-trips through the stored enrichment record, owner only
describe('description confidence', () => {
  const save = async (sut: ImageEnrichmentService, assetId: string, result: Record<string, unknown>) => {
    const service = sut as unknown as {
      saveEnrichmentMetadata(id: string, value: object, kysely: Kysely<DB>): Promise<void>;
    };
    await database.transaction().execute((trx) =>
      service.saveEnrichmentMetadata(
        assetId,
        {
          description: {
            status: 'success',
            modelName: 'vlm',
            updatedAt: '2026-09-24T00:00:00.000Z',
            result: { description: 'A beach', tags: [], ...result },
          },
        },
        trx,
      ),
    );
  };

  it('returns a stored confidence and null when none was reported', async () => {
    const { sut, ctx, asset, auth } = await setup();
    await save(sut, asset.id, { confidence: 0.91 });
    await expect(sut.getAssetEnrichment(auth, asset.id)).resolves.toMatchObject({
      description: { status: 'success', description: 'A beach', confidence: 0.91 },
    });

    await save(sut, asset.id, {});
    const response = await sut.getAssetEnrichment(auth, asset.id);
    expect(response.description.confidence).toBeNull();

    const { user: stranger } = await ctx.newUser();
    await expect(sut.getAssetEnrichment(factory.auth({ user: { id: stranger.id } }), asset.id)).rejects.toThrow();
  });
});
