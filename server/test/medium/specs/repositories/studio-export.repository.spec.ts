import { Kysely, Transaction, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AssetLockReason,
  AssetType,
  AssetVisibility,
  JobName,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  PetObservationState,
  StudioExportRemoteReason,
  StudioExportScope,
  StudioExportVersionState,
  UserMetadataKey,
} from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import {
  StudioExportPublication,
  StudioExportRefusal,
  StudioExportRepository,
  StudioExportVersion,
} from 'src/repositories/studio-export.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { getOwnerHiddenShareIds } from 'src/utils/item-share.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const database = db || defaultDatabase;
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  const privacy = new DerivativePrivacyRepository(database);
  const sut = new StudioExportRepository(database, privacy);
  return { ctx, sut, privacy, projects: ctx.get(StudioProjectRepository), assets: ctx.get(AssetRepository) };
};

type Ctx = ReturnType<typeof setup>;
type Source = { id: string; ownerId: string; checksum: Buffer; access: 'owner' | 'shared' };

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

afterEach(async () => {
  await defaultDatabase.deleteFrom('studio_export_remote_reference').execute();
  await defaultDatabase.deleteFrom('studio_export_version').execute();
  await defaultDatabase.deleteFrom('media_operation').execute();
  await defaultDatabase.deleteFrom('studio_project').execute();
});

/** A project whose export rendered and staged, waiting for publication: the state FL-95 leaves it in. */
const stagedExport = async (
  { sut, projects }: Ctx,
  ownerId: string,
  sources: Source[],
  options: { destination?: MediaOperationDestination; projectId?: string } = {},
) => {
  const projectId = options.projectId ?? (await projects.create({ ownerId, name: 'Lake trip' })).id;
  const destination = options.destination ?? MediaOperationDestination.Local;
  const { operation } = await sut.createWithRender(
    {
      ownerId,
      kind: MediaOperationKind.StudioExport,
      destination,
      destinationDetail: null,
      label: 'Lake trip',
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId,
      revisionId: 'digest-1',
      snapshot: { kind: 'studio-export' },
      settings: {},
      estimate: null,
      maxAttempts: 3,
    },
    { ownerId, projectId, revision: 1, revisionDigest: 'digest-1', destination, settings: { format: 'mp4-h264' } },
  );
  await sut.recordRenderClaim(operation.id, {
    workerId: 'worker-1',
    engineDigest: 'engine-1',
    sources: sources.map((source) => ({
      key: `library-asset:${source.id}`,
      kind: 'library-asset',
      resourceId: source.id,
      assetId: source.id,
      ownerId: source.ownerId,
      checksum: source.checksum.toString('base64'),
      sourceAccess: source.access,
    })),
  });
  const checksum = randomBytes(32);
  const claimToken = randomUUID();
  await defaultDatabase
    .updateTable('media_operation')
    .set({
      claimToken,
      status: MediaOperationStatus.Validating,
      claimExpiresAt: sql<Date>`clock_timestamp() + interval '10 minutes'`,
    })
    .where('id', '=', operation.id)
    .execute();
  const staged = await sut.stage(
    operation.id,
    claimToken,
    {
      path: `/data/exports/${ownerId}/out.mp4`,
      checksum,
      sizeInBytes: 1024,
      contentType: 'video/mp4',
      remoteRef: null,
    },
    (version) => ({
      ownerId,
      kind: MediaOperationKind.StudioExportPublish,
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: 'Lake trip',
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId,
      revisionId: 'digest-1',
      snapshot: { kind: 'studio-export-publish', versionId: version.id },
      settings: {},
      estimate: null,
      maxAttempts: 1,
    }),
  );
  await defaultDatabase
    .updateTable('media_operation')
    .set({
      claimToken,
      status: MediaOperationStatus.Validating,
      claimExpiresAt: sql<Date>`clock_timestamp() + interval '10 minutes'`,
    })
    .where('id', '=', staged!.operation.id)
    .execute();
  return {
    projectId,
    render: operation,
    version: staged!.version,
    publishId: staged!.operation.id,
    claimToken,
    checksum,
  };
};

const publication = (
  staged: { version: StudioExportVersion; publishId: string; claimToken: string; checksum: Buffer },
  sources: Source[],
  overrides: Partial<StudioExportPublication> = {},
): StudioExportPublication => ({
  versionId: staged.version.id,
  operationId: staged.publishId,
  claimToken: staged.claimToken,
  ownerId: staged.version.ownerId,
  sources: sources.map((source) => ({
    key: `library-asset:${source.id}`,
    kind: 'library-asset',
    assetId: source.id,
    checksum: source.checksum.toString('base64'),
  })),
  expectedScope: sources.some((source) => source.access === 'shared')
    ? StudioExportScope.Project
    : StudioExportScope.Library,
  nsfwHiding: false,
  path: `/data/upload/${staged.version.ownerId}/${staged.version.id}.mp4`,
  checksum: staged.checksum,
  sizeInBytes: 1024,
  contentType: 'video/mp4',
  assetType: AssetType.Video,
  originalFileName: 'Lake trip.mp4',
  ...overrides,
});

const ownSource = async (ctx: Ctx['ctx'], ownerId: string, dto: Record<string, unknown> = {}): Promise<Source> => {
  const { asset } = await ctx.newAsset({ ownerId, ...dto });
  return { id: asset.id!, ownerId, checksum: asset.checksum as Buffer, access: 'owner' };
};

const lockOf = async (assetId: string) =>
  (
    await sql<{ reason: AssetLockReason }>`SELECT reason FROM asset_lock WHERE "assetId" = ${assetId}::uuid`.execute(
      defaultDatabase,
    )
  ).rows[0]?.reason ?? null;

const expectRefusal = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toBeInstanceOf(StudioExportRefusal);
  await expect(promise).rejects.toHaveProperty('code', code);
};

describe(StudioExportRepository.name, () => {
  describe('durable publication follow-ups', () => {
    const schedule = (name: JobName) => async (tx: Transaction<DB>, assetId: string) => {
      await new SqlQueueStore(defaultDatabase).enqueue(
        [
          {
            queue: 'studio-publication-test',
            name,
            data: { id: assetId },
            safeToRetry: name === JobName.AssetExtractMetadata,
            sensitive: false,
            deadlineMs: 60_000,
          },
        ],
        tx,
      );
    };
    const queued = async (assetId: string) =>
      (
        await sql<{ name: string }>`select name from job
      where data->>'id' = ${assetId} order by name`.execute(defaultDatabase)
      ).rows.map((row) => row.name);
    const state = async (id: string) =>
      defaultDatabase
        .selectFrom('media_operation')
        .select(['result', 'status', 'autoRetries'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    const metadata = schedule(JobName.AssetExtractMetadata);
    const notify = async (tx: Transaction<DB>, version: StudioExportVersion) =>
      schedule(JobName.PushDeliver)(tx, version.resultAssetId!);

    afterEach(async () => {
      await sql`delete from job where queue = 'studio-publication-test'`.execute(defaultDatabase);
    });

    it('rolls back the version, asset, quota and admitted metadata if notification admission fails', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const source = await ownSource(context.ctx, user.id);
      const staged = await stagedExport(context, user.id, [source]);
      const before = await defaultDatabase
        .selectFrom('user')
        .select('quotaUsageInBytes')
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow();
      let allocated = '';
      await expect(
        context.sut.publish(
          publication(staged, [source]),
          async (tx, id) => {
            allocated = id;
            await metadata(tx, id);
          },
          async (tx, version) => {
            await notify(tx, version);
            throw new Error('admission failed');
          },
        ),
      ).rejects.toThrow('admission failed');
      expect(await queued(allocated)).toEqual([]);
      expect(await context.sut.getById(staged.version.id)).toMatchObject({
        state: StudioExportVersionState.Staged,
        resultAssetId: null,
      });
      expect((await state(staged.publishId)).result).toBeNull();
      expect(
        await defaultDatabase.selectFrom('asset').select('id').where('id', '=', allocated).executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await defaultDatabase
          .selectFrom('user')
          .select('quotaUsageInBytes')
          .where('id', '=', user.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
    });

    it('rolls back admitted work if its claim expires while waiting on the queue', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const source = await ownSource(context.ctx, user.id);
      const staged = await stagedExport(context, user.id, [source]);
      let assetId = '';
      await expectRefusal(
        context.sut.publish(
          publication(staged, [source]),
          async (tx, id) => {
            assetId = id;
            await metadata(tx, id);
            await tx
              .updateTable('media_operation')
              .set({ claimExpiresAt: sql<Date>`clock_timestamp() - interval '1 second'` })
              .where('id', '=', staged.publishId)
              .execute();
          },
          notify,
        ),
        'claim-lost',
      );
      expect(await queued(assetId)).toHaveLength(0);
      expect((await context.sut.getById(staged.version.id))?.state).toBe(StudioExportVersionState.Staged);
      expect((await state(staged.publishId)).result).toBeNull();
    });

    it('stores the canonical still identity atomically without changing source or Live Photo pairing', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const motion = await ownSource(context.ctx, user.id, { type: AssetType.Video });
      const source = await ownSource(context.ctx, user.id, { livePhotoVideoId: motion.id });
      const staged = await stagedExport(context, user.id, [source]);
      const checksum = randomBytes(32);
      const outputPath = `/data/upload/${user.id}/${staged.version.id}-${randomUUID()}.jpg`;
      const accepted = await context.sut.publish(
        publication(staged, [source], {
          checksum,
          sizeInBytes: 2048,
          path: outputPath,
          contentType: 'image/jpeg',
          assetType: AssetType.Image,
          originalFileName: 'Lake trip_still.jpg',
        }),
      );
      const version = await context.sut.getById(staged.version.id);
      expect(Buffer.from(version!.outputChecksum!)).toEqual(checksum);
      expect(String(version!.outputSizeInBytes)).toBe('2048');
      expect(version!.outputPath).toBe(outputPath);
      const result = await defaultDatabase
        .selectFrom('asset')
        .select(['checksum', 'type', 'livePhotoVideoId'])
        .where('id', '=', accepted.createdAssetId!)
        .executeTakeFirstOrThrow();
      expect(Buffer.from(result.checksum)).toEqual(checksum);
      expect(result.type).toBe(AssetType.Image);
      expect(result.livePhotoVideoId).toBeNull();
      const original = await defaultDatabase
        .selectFrom('asset')
        .select(['checksum', 'livePhotoVideoId'])
        .where('id', '=', source.id)
        .executeTakeFirstOrThrow();
      expect(Buffer.from(original.checksum)).toEqual(source.checksum);
      expect(original.livePhotoVideoId).toBe(motion.id);
    });

    it('commits both queue entries with publication and never re-admits them after acknowledgement loss', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const source = await ownSource(context.ctx, user.id);
      const staged = await stagedExport(context, user.id, [source]);
      const accepted = await context.sut.publish(publication(staged, [source]), metadata, notify);
      const version = accepted.version.version;
      expect(await queued(accepted.createdAssetId!)).toEqual(
        [JobName.AssetExtractMetadata, JobName.PushDeliver].sort(),
      );
      expect((await state(staged.publishId)).result).toMatchObject({
        studioPublication: {
          revision: 1,
          metadataAccepted: true,
          notification: 'accepted',
          smoothMotion: 'accepted',
        },
      });
      const forbidden = vi.fn(() => Promise.reject(new Error('must not re-admit')));
      await context.sut.publish(publication(staged, [source]), forbidden, forbidden);
      await context.sut.publicationFollowups(staged.publishId, staged.claimToken, forbidden, forbidden);
      expect(forbidden).not.toHaveBeenCalled();
      expect((await context.sut.getById(staged.version.id))?.version).toBe(version);
      expect(await queued(accepted.createdAssetId!)).toHaveLength(2);
    });

    it('resumes unadmitted durable intents atomically, without reconstructing an already accepted notification', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const source = await ownSource(context.ctx, user.id);
      const staged = await stagedExport(context, user.id, [source]);
      const accepted = await context.sut.publish(publication(staged, [source]));
      const failing = async (tx: Transaction<DB>, version: StudioExportVersion) => {
        await notify(tx, version);
        throw new Error('recovery admission failed');
      };
      await expect(
        context.sut.publicationFollowups(staged.publishId, staged.claimToken, metadata, failing),
      ).rejects.toThrow('recovery admission failed');
      expect(await queued(accepted.createdAssetId!)).toHaveLength(0);
      expect((await state(staged.publishId)).result).toMatchObject({
        studioPublication: { metadataAccepted: false, notification: 'pending' },
      });
      await context.sut.publicationFollowups(staged.publishId, staged.claimToken, metadata, notify);
      await context.sut.publicationFollowups(staged.publishId, staged.claimToken, metadata, notify);
      expect(await queued(accepted.createdAssetId!)).toHaveLength(2);
    });

    it('uses one operation recovery budget and fences the expired external attempt after a crash', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const source = await ownSource(context.ctx, user.id);
      const staged = await stagedExport(context, user.id, [source]);
      const operations = context.ctx.get(MediaOperationRepository);
      const frozen = {
        kind: 'studio-export-publish',
        versionId: staged.version.id,
        smoothMotion: { factor: 4, destinationId: randomUUID() },
      };
      await defaultDatabase
        .updateTable('media_operation')
        .set({ snapshot: frozen })
        .where('id', '=', staged.publishId)
        .execute();
      await context.sut.publish(publication(staged, [source]), metadata, notify);
      const attempts = await Promise.all(
        [1, 2].map(() =>
          context.sut.transitionPublicationFollowup(
            staged.publishId,
            staged.claimToken,
            'smoothMotion',
            'pending',
            'dispatching',
          ),
        ),
      );
      expect(attempts.filter(Boolean)).toHaveLength(1);
      await defaultDatabase
        .updateTable('media_operation')
        .set({ claimExpiresAt: sql<Date>`clock_timestamp() - interval '1 second'` })
        .where('id', '=', staged.publishId)
        .execute();
      await operations.recoverExpiredClaims({ errorCode: 'test_crash', error: 'publication process stopped' });
      expect(await state(staged.publishId)).toMatchObject({
        status: MediaOperationStatus.Queued,
        autoRetries: 1,
        result: { studioPublication: { smoothMotion: 'dispatching' } },
      });
      await defaultDatabase
        .updateTable('media_operation')
        .set({ retryAt: null })
        .where('id', '=', staged.publishId)
        .execute();
      const replacement = await operations.claimNext({
        kinds: [MediaOperationKind.StudioExportPublish],
        workerId: 'recovery',
        leaseMs: 60_000,
      });
      expect(replacement?.operation.id).toBe(staged.publishId);
      expect(replacement?.operation.snapshot).toEqual(frozen);
      await operations.beginValidation(staged.publishId, replacement!.claimToken, true);
      expect(
        await context.sut.transitionPublicationFollowup(
          staged.publishId,
          staged.claimToken,
          'smoothMotion',
          'dispatching',
          'accepted',
        ),
      ).toBe(false);
      expect(
        await context.sut.publicationFollowups(staged.publishId, replacement!.claimToken, metadata, notify),
      ).toMatchObject({ smoothMotion: 'dispatching' });
      expect(
        await context.sut.transitionPublicationFollowup(
          staged.publishId,
          replacement!.claimToken,
          'smoothMotion',
          'dispatching',
          'needs_attention',
        ),
      ).toBe(true);
      // A second lost process consumes no new budget and cannot turn uncertainty into a new submission.
      await defaultDatabase
        .updateTable('media_operation')
        .set({ claimExpiresAt: sql<Date>`clock_timestamp() - interval '1 second'` })
        .where('id', '=', staged.publishId)
        .execute();
      await operations.recoverExpiredClaims({ errorCode: 'test_crash', error: 'replacement stopped' });
      expect(await state(staged.publishId)).toMatchObject({
        status: MediaOperationStatus.Failed,
        autoRetries: 1,
        result: { studioPublication: { smoothMotion: 'needs_attention' } },
      });
      expect((await context.sut.getById(staged.version.id))?.state).toBe(StudioExportVersionState.Published);
    });
  });

  describe('claim fencing', () => {
    it('refuses an expired publication token before recovery clears it', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const source = await ownSource(context.ctx, user.id);
      const staged = await stagedExport(context, user.id, [source]);
      const before = await defaultDatabase.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute();
      await defaultDatabase
        .updateTable('media_operation')
        .set({ claimExpiresAt: sql<Date>`clock_timestamp() - interval '1 second'` })
        .where('id', '=', staged.publishId)
        .execute();
      await expectRefusal(context.sut.publish(publication(staged, [source])), 'claim-lost');
      expect(await context.sut.getById(staged.version.id)).toMatchObject({
        state: StudioExportVersionState.Staged,
        resultAssetId: null,
      });
      expect(await defaultDatabase.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute()).toEqual(
        before,
      );
      // Negative control: same token/state works after an explicit new valid lease, proving expiry is the fence.
      await defaultDatabase
        .updateTable('media_operation')
        .set({ claimExpiresAt: sql<Date>`clock_timestamp() + interval '10 minutes'` })
        .where('id', '=', staged.publishId)
        .execute();
      await expect(context.sut.publish(publication(staged, [source]))).resolves.toMatchObject({ status: 'published' });
    });

    const claims = [
      { name: 'cancelled', status: MediaOperationStatus.Cancelled, stale: false },
      { name: 'cancelling', status: MediaOperationStatus.Cancelling, stale: false },
      { name: 'stale token', status: MediaOperationStatus.Validating, stale: true },
    ];
    it.each(claims)('does not stage a $name render', async ({ status, stale }) => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const staged = await stagedExport(context, user.id, []);
      await defaultDatabase
        .updateTable('studio_export_version')
        .set({ state: StudioExportVersionState.Rendering, publishOperationId: null })
        .where('id', '=', staged.version.id)
        .execute();
      await defaultDatabase.deleteFrom('media_operation').where('id', '=', staged.publishId).execute();
      await defaultDatabase
        .updateTable('media_operation')
        .set({ status, claimToken: stale ? randomUUID() : staged.claimToken })
        .where('id', '=', staged.render.id)
        .execute();
      const publish = vi.fn(() => {
        throw new Error('must not queue a publication');
      });
      await expect(
        context.sut.stage(
          staged.render.id,
          staged.claimToken,
          {
            path: '/out.mp4',
            checksum: staged.checksum,
            sizeInBytes: 1024,
            contentType: 'video/mp4',
            remoteRef: null,
          },
          publish,
        ),
      ).resolves.toBeUndefined();
      expect(publish).not.toHaveBeenCalled();
      expect(await context.sut.getById(staged.version.id)).toMatchObject({
        state: StudioExportVersionState.Rendering,
        publishOperationId: null,
      });
    });
    it.each(claims)('does not publish a $name operation', async ({ status, stale }) => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);
      await defaultDatabase
        .updateTable('media_operation')
        .set({ status, claimToken: stale ? randomUUID() : staged.claimToken })
        .where('id', '=', staged.publishId)
        .execute();
      await expectRefusal(context.sut.publish(publication(staged, sources)), 'claim-lost');
      expect(await context.sut.getById(staged.version.id)).toMatchObject({
        state: StudioExportVersionState.Staged,
        resultAssetId: null,
        version: null,
      });
      expect(
        await defaultDatabase
          .selectFrom('asset')
          .select('id')
          .where('ownerId', '=', user.id)
          .where('checksum', '=', staged.checksum)
          .execute(),
      ).toEqual([]);
    });
  });

  describe('publish: inherited privacy', () => {
    // FL-326: a partner no longer reaches the sharer's rows, so only the owner case remains
    it('rechecks a motion linked to an already Locked still before publication for its owner', async () => {
      const context = setup();
      const { user: owner } = await context.ctx.newUser();
      const source = {
        ...(await ownSource(context.ctx, owner.id, { type: AssetType.Video, visibility: AssetVisibility.Hidden })),
        access: 'owner' as const,
      };
      const access = new AccessRepository(defaultDatabase);
      const reachable = () => access.asset.checkOwnerAccess(owner.id, new Set([source.id]), false);
      await expect(reachable()).resolves.toEqual(new Set([source.id]));
      const staged = await stagedExport(context, owner.id, [source]);

      // Between source authorization and final publication, a previously Locked still is paired
      // with this motion. No lock is written on the motion by that association update.
      const still = await ownSource(context.ctx, owner.id, { visibility: AssetVisibility.Locked });
      await context.assets.update({ id: still.id, livePhotoVideoId: source.id });
      expect(await lockOf(source.id)).toBeNull();
      await expect(reachable()).resolves.toEqual(new Set());

      const published = await context.sut.publish(publication(staged, [source]));
      expect(published.privacy).toMatchObject({ lockReason: AssetLockReason.Marked, lockedSourceCount: 1 });
      expect(await lockOf(published.createdAssetId!)).toBe(AssetLockReason.Marked);
      await expect(context.sut.getForOwner(staged.version.id, owner.id, { revealed: false })).resolves.toBeUndefined();
    });

    it('locks the result when a later clip is Locked, as a lock record and never a stored visibility', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [
        await ownSource(context.ctx, user.id),
        await ownSource(context.ctx, user.id),
        await ownSource(context.ctx, user.id, { visibility: AssetVisibility.Locked }),
      ];
      const staged = await stagedExport(context, user.id, sources);

      const published = await context.sut.publish(publication(staged, sources));

      expect(published.privacy).toEqual(
        expect.objectContaining({
          lockReason: AssetLockReason.Marked,
          lockedSourceCount: 1,
          scope: StudioExportScope.Library,
        }),
      );
      const assetId = published.createdAssetId!;
      expect(await lockOf(assetId)).toBe(AssetLockReason.Marked);
      const row = await defaultDatabase
        .selectFrom('asset')
        .select(['visibility', 'ownerId'])
        .where('id', '=', assetId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ visibility: AssetVisibility.Timeline, ownerId: user.id });
      expect(published.version).toEqual(
        expect.objectContaining({ state: StudioExportVersionState.Published, version: 1 }),
      );

      const provenance = await context.sut.getSources(staged.version.id);
      expect(provenance.filter((source) => source.locked)).toHaveLength(1);
    });

    it('keeps the strongest reason and carries sensitivity from any source', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [
        await ownSource(context.ctx, user.id, { is_nsfw: true } as never),
        await ownSource(context.ctx, user.id),
      ];
      await context.assets.lock([sources[1].id], AssetLockReason.Detected, null);
      const staged = await stagedExport(context, user.id, sources);

      const published = await context.sut.publish(publication(staged, sources, { nsfwHiding: true }));

      expect(published.privacy).toEqual(
        expect.objectContaining({ lockReason: AssetLockReason.Detected, sensitive: true }),
      );
      expect(await context.privacy.get(published.createdAssetId!)).toEqual({
        lockReason: AssetLockReason.Detected,
        sensitive: true,
      });
    });

    it('never puts a result made with shared media in the owner’s library', async () => {
      const context = setup();
      const { user: owner } = await context.ctx.newUser();
      const { user: partner } = await context.ctx.newUser();
      const shared = { ...(await ownSource(context.ctx, partner.id)), access: 'shared' as const };
      // FL-326: a partnership grants nothing any more, so the media is shared through an album
      const { album } = await context.ctx.newAlbum({ ownerId: partner.id }, [shared.id]);
      await context.ctx.newAlbumUser({ albumId: album.id, userId: owner.id });
      const sources = [await ownSource(context.ctx, owner.id), shared];
      const staged = await stagedExport(context, owner.id, sources);

      const published = await context.sut.publish(publication(staged, sources));

      expect(published.createdAssetId).toBeNull();
      expect(published.version).toEqual(
        expect.objectContaining({ scope: StudioExportScope.Project, resultAssetId: null, version: 1 }),
      );
      const count = await defaultDatabase
        .selectFrom('asset')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('ownerId', '=', owner.id)
        .executeTakeFirstOrThrow();
      expect(Number(count.count)).toBe(1);
    });
  });

  describe('a result kept with its project, then saved to the library (FL-194)', () => {
    const kept = (staged: { version: StudioExportVersion }) =>
      `/data/exports/${staged.version.ownerId}/studio-exports/versions/${staged.version.id}.mp4`;

    it('keeps an all-own result out of the library until the owner saves it, with its privacy', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [
        await ownSource(context.ctx, user.id),
        await ownSource(context.ctx, user.id, { visibility: AssetVisibility.Locked }),
      ];
      const staged = await stagedExport(context, user.id, sources);

      const published = await context.sut.publish(
        publication(staged, sources, {
          expectedScope: StudioExportScope.Project,
          retainInProject: true,
          path: kept(staged),
        }),
      );
      expect(published.createdAssetId).toBeNull();
      expect(published.version).toEqual(
        expect.objectContaining({ scope: StudioExportScope.Project, resultAssetId: null, outputPath: kept(staged) }),
      );
      const before = await defaultDatabase
        .selectFrom('asset')
        .select('id')
        .where('ownerId', '=', user.id)
        .where('checksum', '=', staged.checksum)
        .execute();
      expect(before).toEqual([]);

      const library = `/data/upload/${user.id}/${staged.version.id}.mp4`;
      const saved = await context.sut.saveToLibrary({
        versionId: staged.version.id,
        ownerId: user.id,
        sources: publication(staged, sources).sources,
        nsfwHiding: false,
        path: library,
        checksum: staged.checksum,
        sizeInBytes: 1024,
        contentType: 'video/mp4',
        assetType: AssetType.Video,
        originalFileName: 'Lake trip.mp4',
      });
      expect(saved.version).toEqual(
        expect.objectContaining({
          scope: StudioExportScope.Library,
          resultAssetId: saved.createdAssetId,
          outputPath: library,
        }),
      );
      // the Locked source's lock is installed on the saved asset, as at publication
      expect(await lockOf(saved.createdAssetId!)).toBe(AssetLockReason.Marked);

      // saving again answers with the same result
      const again = await context.sut.saveToLibrary({
        versionId: staged.version.id,
        ownerId: user.id,
        sources: [],
        nsfwHiding: false,
        path: library,
        checksum: staged.checksum,
        sizeInBytes: 1024,
        contentType: 'video/mp4',
        assetType: AssetType.Video,
        originalFileName: 'Lake trip.mp4',
      });
      expect(again.createdAssetId).toBeNull();
      expect(again.version.resultAssetId).toBe(saved.createdAssetId);
    });

    it("refuses to save somebody else's result or one whose source was deleted", async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const { user: stranger } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);
      await context.sut.publish(
        publication(staged, sources, {
          expectedScope: StudioExportScope.Project,
          retainInProject: true,
          path: kept(staged),
        }),
      );
      const save = (ownerId: string) =>
        context.sut.saveToLibrary({
          versionId: staged.version.id,
          ownerId,
          sources: publication(staged, sources).sources,
          nsfwHiding: false,
          path: `/data/upload/${ownerId}/${staged.version.id}.mp4`,
          checksum: staged.checksum,
          sizeInBytes: 1024,
          contentType: 'video/mp4',
          assetType: AssetType.Video,
          originalFileName: 'Lake trip.mp4',
        });

      await expectRefusal(save(stranger.id), 'not-staged');
      await defaultDatabase
        .updateTable('asset')
        .set({ deletedAt: new Date() })
        .where('id', '=', sources[0].id)
        .execute();
      await expectRefusal(save(user.id), 'source-unavailable');
      expect(await context.sut.getById(staged.version.id)).toMatchObject({ scope: StudioExportScope.Project });
    });
  });

  describe('publish: direct item shares', () => {
    const sharedExport = async (motion = false) => {
      const context = setup();
      const { user: owner } = await context.ctx.newUser();
      const { user: recipient } = await context.ctx.newUser();
      const source = await ownSource(context.ctx, owner.id, motion ? { visibility: AssetVisibility.Hidden } : {});
      const shared = { ...source, access: 'shared' as const };
      const item = motion ? await ownSource(context.ctx, owner.id, { livePhotoVideoId: shared.id }) : shared;
      const shares = new ItemShareRepository(defaultDatabase);
      await shares.add(owner.id, [item.id], [recipient.id]);
      const staged = await stagedExport(context, recipient.id, [shared]);
      return { context, owner, recipient, shared, item, shares, staged };
    };

    it.each(['ordinary', 'archive', 'motion'] as const)(
      'publishes an accessible %s item only with its project',
      async (kind) => {
        const { context, shared, staged } = await sharedExport(kind === 'motion');
        if (kind === 'archive') {
          await defaultDatabase
            .updateTable('asset')
            .set({ visibility: AssetVisibility.Archive })
            .where('id', '=', shared.id)
            .execute();
        }

        const published = await context.sut.publish(publication(staged, [shared]));

        expect(published.createdAssetId).toBeNull();
        expect(published.version).toMatchObject({
          scope: StudioExportScope.Project,
          resultAssetId: null,
          state: StudioExportVersionState.Published,
        });
        expect(published.privacy).toMatchObject({ includesSharedSources: true, sourceCount: 1 });
      },
    );

    it.each([
      'hidden',
      'locked',
      'trashed',
      'deleted-owner',
      'changed-owner',
      'changed-motion-owner',
      'suppressed',
      'revoked',
    ] as const)('refuses an item share that became %s after rendering', async (change) => {
      const { context, owner, recipient, shared, shares, staged } = await sharedExport(
        change === 'changed-motion-owner',
      );
      switch (change) {
        case 'hidden': {
          await defaultDatabase
            .updateTable('asset')
            .set({ visibility: AssetVisibility.Hidden })
            .where('id', '=', shared.id)
            .execute();
          break;
        }
        case 'locked': {
          await context.assets.lock([shared.id], AssetLockReason.Marked, owner.id);
          break;
        }
        case 'trashed': {
          await defaultDatabase
            .updateTable('asset')
            .set({ deletedAt: new Date() })
            .where('id', '=', shared.id)
            .execute();
          break;
        }
        case 'deleted-owner': {
          await defaultDatabase.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', owner.id).execute();
          break;
        }
        case 'changed-owner':
        case 'changed-motion-owner': {
          const { user } = await context.ctx.newUser();
          await defaultDatabase.updateTable('asset').set({ ownerId: user.id }).where('id', '=', shared.id).execute();
          break;
        }
        case 'suppressed': {
          const { tag } = await context.ctx.newTag({ userId: owner.id, value: 'Private' });
          await context.ctx.newTagAsset({ tagIds: [tag.id], assetIds: [shared.id] });
          await defaultDatabase
            .insertInto('user_metadata')
            .values({
              userId: owner.id,
              key: UserMetadataKey.Preferences,
              value: { privacy: { suppression: { tagIds: [tag.id], scope: 'visible' } } },
            })
            .execute();
          break;
        }
        case 'revoked': {
          await shares.remove(owner.id, [shared.id], [recipient.id]);
          break;
        }
      }

      await expectRefusal(
        context.sut.publish(publication(staged, [shared])),
        change === 'trashed' ? 'source-unavailable' : 'source-access-lost',
      );
      expect((await context.sut.getById(staged.version.id))!.state).toBe(StudioExportVersionState.Staged);
    });

    it.each(['still', 'motion'] as const)('applies an owner suppression rule to the live photo %s', async (part) => {
      const { context, owner, shared, item, staged } = await sharedExport(true);
      const { tag } = await context.ctx.newTag({ userId: owner.id, value: 'Private' });
      await context.ctx.newTagAsset({ tagIds: [tag.id], assetIds: [part === 'still' ? item.id : shared.id] });
      await defaultDatabase
        .insertInto('user_metadata')
        .values({
          userId: owner.id,
          key: UserMetadataKey.Preferences,
          value: { privacy: { suppression: { tagIds: [tag.id], scope: 'visible' } } },
        })
        .execute();

      await expectRefusal(context.sut.publish(publication(staged, [shared])), 'source-access-lost');
    });

    it.each(['tag', 'inherited tag', 'face', 'pet observation', 'pet owner'] as const)(
      'holds %s membership steady after the suppression read until publication commits',
      async (kind) => {
        const { context, owner, recipient, shared, staged } = await sharedExport();
        const suppression = {
          tagIds: [] as string[],
          personIds: [] as string[],
          petIds: [] as string[],
          scope: 'visible' as const,
        };
        let write: () => Promise<unknown>;
        if (kind === 'tag' || kind === 'inherited tag') {
          const tags = context.ctx.get(TagRepository);
          const { tag } = await context.ctx.newTag({ userId: owner.id, value: 'Private' });
          suppression.tagIds = [tag.id];
          if (kind === 'tag') {
            write = () => tags.addAssetIds(tag.id, [shared.id]);
          } else {
            const { tag: child } = await context.ctx.newTag({ userId: owner.id, value: 'Child' });
            await tags.addAssetIds(child.id, [shared.id]);
            write = () => tags.update(child.id, { parentId: tag.id });
          }
        } else if (kind === 'face') {
          const people = context.ctx.get(PersonRepository);
          const { person } = await context.ctx.newPerson({ ownerId: owner.id });
          suppression.personIds = [person.personGroupId];
          const faceId = randomUUID();
          await people.createAssetFace({ id: faceId, assetId: shared.id, personGroupId: null });
          write = () => people.reassignFaces({ faceIds: [faceId], newPersonGroupId: person.personGroupId });
        } else {
          const pets = new PetRepository(defaultDatabase, LoggingRepository.create());
          const petOwner = kind === 'pet owner' ? (await context.ctx.newUser()).user.id : owner.id;
          const pet = await pets.create({ ownerId: petOwner, name: 'Private' });
          suppression.petIds = [pet.id];
          await pets.upsertObservation({
            petId: pet.id,
            assetId: shared.id,
            state: kind === 'pet owner' ? PetObservationState.Confirmed : PetObservationState.Rejected,
          });
          write =
            kind === 'pet owner'
              ? () => pets.update(petOwner, pet.id, { ownerId: owner.id })
              : () =>
                  pets.upsertObservation({ petId: pet.id, assetId: shared.id, state: PetObservationState.Confirmed });
        }
        await defaultDatabase
          .insertInto('user_metadata')
          .values({
            userId: owner.id,
            key: UserMetadataKey.Preferences,
            value: { privacy: { suppression } },
          })
          .execute();
        await expect(getOwnerHiddenShareIds(defaultDatabase, [shared])).resolves.toEqual(new Set());

        const release = deferred();
        const { promise: read, resolve: signalRead } = Promise.withResolvers<number>();
        const original = context.privacy.lockSharedAccess.bind(context.privacy);
        const pause = vi
          .spyOn(context.privacy, 'lockSharedAccess')
          .mockImplementationOnce(async (tx, userId, sources) => {
            const reachable = await original(tx, userId, sources);
            const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
            signalRead(rows[0].pid);
            await release.promise;
            return reachable;
          });
        const publishing = context.sut.publish(publication(staged, [shared]));
        let writing: Promise<unknown> | undefined;
        try {
          const blockerPid = await Promise.race([
            read,
            publishing.then(() => {
              throw new Error('Publication did not pause');
            }),
          ]);
          writing = write();
          void writing.catch(() => {});
          await vi.waitFor(
            async () => {
              const { rows } = await sql<{ waiting: boolean }>`
              SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
                AND pg_blocking_pids(pid) @> ARRAY[${blockerPid}]::integer[]) AS waiting
            `.execute(defaultDatabase);
              expect(rows[0].waiting).toBe(true);
            },
            { timeout: 5000 },
          );
        } finally {
          release.resolve();
          await Promise.allSettled([publishing, writing]);
          pause.mockRestore();
        }
        await expect(publishing).resolves.toMatchObject({ version: { state: StudioExportVersionState.Published } });
        expect(writing).toBeDefined();
        await writing;
        await expect(getOwnerHiddenShareIds(defaultDatabase, [shared])).resolves.toEqual(new Set([shared.id]));
        const next = await stagedExport(context, recipient.id, [shared], { projectId: staged.projectId });
        await expectRefusal(context.sut.publish(publication(next, [shared])), 'source-access-lost');
        expect((await context.sut.getById(staged.version.id))!.state).toBe(StudioExportVersionState.Published);
      },
      10_000,
    );

    it.each(['asset_face', 'pet', 'pet_observation', 'tag_asset', 'tag_closure'] as const)(
      'refuses busy %s membership without waiting or losing the staged version',
      async (table) => {
        const { context, shared, staged } = await sharedExport();
        const locked = deferred();
        const release = deferred();
        const writer = defaultDatabase.transaction().execute(async (tx) => {
          await sql`LOCK TABLE ${sql.table(table)} IN ROW EXCLUSIVE MODE`.execute(tx);
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        try {
          await expect(context.sut.publish(publication(staged, [shared]))).rejects.toMatchObject({
            status: 409,
            message: 'Shared-source privacy is changing; retry publication.',
          });
          expect((await context.sut.getById(staged.version.id))!.state).toBe(StudioExportVersionState.Staged);
        } finally {
          release.resolve();
          await writer;
        }
        await expect(context.sut.publish(publication(staged, [shared]))).resolves.toMatchObject({
          version: { state: StudioExportVersionState.Published },
        });
      },
    );

    // FL-326: a partnership is no grant any more; only the album grant remains
    it.each(['album'] as const)('keeps existing %s grants independent of item suppression locks', async () => {
      const { context, owner, recipient, shared, staged } = await sharedExport();
      const { album } = await context.ctx.newAlbum({ ownerId: owner.id }, [shared.id]);
      await context.ctx.newAlbumUser({ albumId: album.id, userId: recipient.id });
      const locked = deferred();
      const release = deferred();
      const writer = defaultDatabase.transaction().execute(async (tx) => {
        await sql`LOCK TABLE public.tag_asset IN ROW EXCLUSIVE MODE`.execute(tx);
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      try {
        await expect(context.sut.publish(publication(staged, [shared]))).resolves.toMatchObject({
          version: { state: StudioExportVersionState.Published, scope: StudioExportScope.Project },
        });
      } finally {
        release.resolve();
        await writer;
      }
    });

    it.each(['share', 'preferences'] as const)(
      'sees %s revocation committed while publication waits',
      async (grant) => {
        const { context, owner, recipient, shared, staged } = await sharedExport();
        const { tag } = await context.ctx.newTag({ userId: owner.id, value: 'Private' });
        await context.ctx.newTagAsset({ tagIds: [tag.id], assetIds: [shared.id] });
        const release = deferred();
        const { promise: locked, resolve: signalLocked } = Promise.withResolvers<number>();
        const revocation = defaultDatabase.transaction().execute(async (tx) => {
          if (grant === 'share') {
            // The same granting row deleted by ItemShareRepository.remove, held until the test commits.
            await sql`DELETE FROM public.asset_user_share
            WHERE "ownerId" = ${owner.id}::uuid AND "assetId" = ${shared.id}::uuid
              AND "sharedWithId" = ${recipient.id}::uuid`.execute(tx);
          } else {
            // Match DatabaseRepository.withUserPreferencesLock, including the first preferences save.
            await sql`SELECT pg_advisory_xact_lock(-2, hashtext(${owner.id})::int)`.execute(tx);
            await tx
              .insertInto('user_metadata')
              .values({
                userId: owner.id,
                key: UserMetadataKey.Preferences,
                value: { privacy: { suppression: { tagIds: [tag.id], scope: 'visible' } } },
              })
              .execute();
          }
          const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
          signalLocked(rows[0].pid);
          await release.promise;
        });
        const blockerPid = await locked;
        const publishing = context.sut.publish(publication(staged, [shared]));
        const settled = Promise.allSettled([revocation, publishing]);
        try {
          await vi.waitFor(
            async () => {
              const { rows } = await sql<{ waiting: boolean }>`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
              AND pg_blocking_pids(pid) @> ARRAY[${blockerPid}]::integer[]) AS waiting
          `.execute(defaultDatabase);
              expect(rows[0].waiting).toBe(true);
            },
            { timeout: 5000 },
          );
        } finally {
          release.resolve();
          await settled;
        }

        expect(await settled).toMatchObject([
          { status: 'fulfilled' },
          { status: 'rejected', reason: { code: 'source-access-lost' } },
        ]);
        expect((await context.sut.getById(staged.version.id))!.state).toBe(StudioExportVersionState.Staged);
      },
      10_000,
    );
  });

  describe('publish: current access', () => {
    it('refuses a multi-owner export once the album that shared a source is left', async () => {
      const context = setup();
      const { user: owner } = await context.ctx.newUser();
      const { user: other } = await context.ctx.newUser();
      const shared = { ...(await ownSource(context.ctx, other.id)), access: 'shared' as const };
      const { album } = await context.ctx.newAlbum({ ownerId: other.id }, [shared.id]);
      await context.ctx.newAlbumUser({ albumId: album.id, userId: owner.id });
      const sources = [await ownSource(context.ctx, owner.id), shared];
      const staged = await stagedExport(context, owner.id, sources);

      await defaultDatabase
        .deleteFrom('album_user')
        .where('albumId', '=', album.id)
        .where('userId', '=', owner.id)
        .execute();

      await expectRefusal(context.sut.publish(publication(staged, sources)), 'source-access-lost');
      expect((await context.sut.getById(staged.version.id))!.state).toBe(StudioExportVersionState.Staged);
    });

    it('sees a revocation that commits while publication waits for the membership row', async () => {
      const context = setup();
      const { user: owner } = await context.ctx.newUser();
      const { user: other } = await context.ctx.newUser();
      const shared = { ...(await ownSource(context.ctx, other.id)), access: 'shared' as const };
      const { album } = await context.ctx.newAlbum({ ownerId: other.id }, [shared.id]);
      await context.ctx.newAlbumUser({ albumId: album.id, userId: owner.id });
      const sources = [shared];
      const staged = await stagedExport(context, owner.id, sources);

      const removed = deferred();
      const release = deferred();
      const revocation = defaultDatabase.transaction().execute(async (trx) => {
        await trx.deleteFrom('album_user').where('albumId', '=', album.id).where('userId', '=', owner.id).execute();
        removed.resolve();
        await release.promise;
      });
      await removed.promise;
      const publishing = context.sut.publish(publication(staged, sources));
      await new Promise((done) => setTimeout(done, 200));
      release.resolve();
      await revocation;

      await expectRefusal(publishing, 'source-access-lost');
    });

    it('refuses publication when the sharing album is deleted while its access check waits', async () => {
      const context = setup();
      const { user: owner } = await context.ctx.newUser();
      const { user: other } = await context.ctx.newUser();
      const shared = { ...(await ownSource(context.ctx, other.id)), access: 'shared' as const };
      const { album } = await context.ctx.newAlbum({ ownerId: other.id }, [shared.id]);
      await context.ctx.newAlbumUser({ albumId: album.id, userId: owner.id });
      const staged = await stagedExport(context, owner.id, [shared]);

      const release = deferred();
      const { promise: locked, resolve: signalLocked } = Promise.withResolvers<number>();
      const revocation = defaultDatabase.transaction().execute(async (trx) => {
        await trx.updateTable('album').set({ deletedAt: new Date() }).where('id', '=', album.id).execute();
        const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
        signalLocked(rows[0].pid);
        await release.promise;
      });
      const blockerPid = await locked;
      const publishing = context.sut.publish(publication(staged, [shared]));
      let settled: PromiseSettledResult<unknown>[];
      try {
        await vi.waitFor(
          async () => {
            const { rows } = await sql<{ waiting: boolean }>`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE wait_event_type = 'Lock'
                  AND pg_blocking_pids(pid) @> ARRAY[${blockerPid}]::integer[]
              ) AS waiting
            `.execute(defaultDatabase);
            expect(rows[0].waiting).toBe(true);
          },
          { timeout: 5000 },
        );
      } finally {
        release.resolve();
        settled = await Promise.allSettled([revocation, publishing]);
      }

      expect(settled[0]).toEqual({ status: 'fulfilled', value: undefined });
      expect(settled[1]).toMatchObject({ status: 'rejected', reason: { code: 'source-access-lost' } });
      expect((await context.sut.getById(staged.version.id))!.state).toBe(StudioExportVersionState.Staged);
    }, 10_000);

    it('orders publication and bulk revocation locks when albums were inserted in the opposite order', async () => {
      const context = setup();
      const { user: owner } = await context.ctx.newUser();
      const { user: other } = await context.ctx.newUser();
      const albumIds = [randomUUID(), randomUUID()].toSorted();
      const sources: Source[] = [];
      for (const id of albumIds.toReversed()) {
        const shared = { ...(await ownSource(context.ctx, other.id)), access: 'shared' as const };
        await context.ctx.newAlbum({ id, ownerId: other.id }, [shared.id]);
        await context.ctx.newAlbumUser({ albumId: id, userId: owner.id });
        sources.push(shared);
      }
      const staged = await stagedExport(context, owner.id, sources);
      const release = deferred();
      const locked = deferred();
      const blocker = defaultDatabase.transaction().execute(async (trx) => {
        await sql`SELECT id FROM album WHERE id = ${albumIds[0]}::uuid FOR UPDATE`.execute(trx);
        locked.resolve();
        await release.promise;
      });
      await locked.promise;

      const run = (action: (db: Kysely<DB>) => Promise<unknown>) => {
        const { promise: started, resolve: signalStarted, reject: signalFailed } = Promise.withResolvers<number>();
        const operation = defaultDatabase.connection().execute(async (connection) => {
          // Make an unordered scan follow insertion order, opposing the required UUID lock order.
          const settings = ['enable_indexscan', 'enable_bitmapscan', 'enable_mergejoin', 'enable_hashjoin'];
          const { rows } = await sql<{ name: string; value: string }>`
            SELECT name, setting AS value FROM pg_settings WHERE name = ANY(${settings}::text[])
          `.execute(connection);
          try {
            for (const { name } of rows) {
              await sql`SELECT set_config(${name}, 'off', false)`.execute(connection);
            }
            const backend = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(connection);
            signalStarted(backend.rows[0].pid);
            return await action(connection);
          } catch (error) {
            signalFailed(error);
            throw error;
          } finally {
            for (const { name, value } of rows) {
              await sql`SELECT set_config(${name}, ${value}, false)`.execute(connection);
            }
          }
        });
        return { started, settled: Promise.allSettled([operation]) };
      };
      const waitForLock = async (pid: number) =>
        vi.waitFor(
          async () => {
            const { rows } = await sql<{ waiting: boolean }>`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'
              ) AS waiting
            `.execute(defaultDatabase);
            expect(rows[0].waiting).toBe(true);
          },
          { timeout: 5000 },
        );

      const revocation = run((db) => new AlbumRepository(db).softDeleteAll(other.id));
      let publishing: ReturnType<typeof run> | undefined;
      try {
        await waitForLock(await revocation.started);
        publishing = run((db) => setup(db).sut.publish(publication(staged, sources)));
        await waitForLock(await publishing.started);
        await defaultDatabase.transaction().execute(async (trx) => {
          await sql`SELECT id FROM album WHERE id = ${albumIds[1]}::uuid FOR UPDATE NOWAIT`.execute(trx);
        });
      } finally {
        release.resolve();
        await Promise.all([blocker, revocation.settled, publishing?.settled]);
      }

      expect(await revocation.settled).toEqual([{ status: 'fulfilled', value: undefined }]);
      expect(await publishing!.settled).toMatchObject([{ status: 'rejected', reason: { code: 'source-access-lost' } }]);
      const albums = await defaultDatabase
        .selectFrom('album')
        .select('deletedAt')
        .where('id', 'in', albumIds)
        .execute();
      expect(albums).toHaveLength(2);
      expect(albums.every((album) => album.deletedAt !== null)).toBe(true);
      expect((await context.sut.getById(staged.version.id))!.state).toBe(StudioExportVersionState.Staged);
    }, 20_000);

    it('refuses when a source was deleted, and lists the pending export as orphaned', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id), await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);

      await context.ctx.softDeleteAsset(sources[1].id);

      await expectRefusal(context.sut.publish(publication(staged, sources)), 'source-unavailable');
      const orphaned = await context.sut.listOrphanedWork();
      expect(orphaned).toEqual([
        expect.objectContaining({ id: staged.version.id, orphanReason: 'source-unavailable' }),
      ]);
    });

    it('keeps provenance when a source is removed for good after publication, and leaves its original alone', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const before = await defaultDatabase
        .selectFrom('asset')
        .select(['originalPath', 'checksum'])
        .where('id', '=', sources[0].id)
        .executeTakeFirstOrThrow();
      const staged = await stagedExport(context, user.id, sources);
      await context.sut.publish(publication(staged, sources));

      const after = await defaultDatabase
        .selectFrom('asset')
        .select(['originalPath', 'checksum'])
        .where('id', '=', sources[0].id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual(before);

      await defaultDatabase.deleteFrom('asset').where('id', '=', sources[0].id).execute();
      expect(await context.sut.getSources(staged.version.id)).toEqual([
        expect.objectContaining({ assetId: sources[0].id }),
      ]);
    });

    it('refuses a source whose bytes changed after the render', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);
      await defaultDatabase
        .updateTable('asset')
        .set({ checksum: randomBytes(32) })
        .where('id', '=', sources[0].id)
        .execute();

      await expectRefusal(context.sut.publish(publication(staged, sources)), 'source-changed');
    });

    it('waits for a source deletion racing it, and refuses once the deletion commits first', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);

      const locked = deferred();
      const release = deferred();
      const deletion = defaultDatabase.transaction().execute(async (trx) => {
        await trx.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', sources[0].id).execute();
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const publishing = context.sut.publish(publication(staged, sources));
      await new Promise((done) => setTimeout(done, 200));
      release.resolve();
      await deletion;

      await expectRefusal(publishing, 'source-unavailable');
    });
  });

  describe('publish: owner and project', () => {
    it('refuses for an owner being deleted, and the export is orphaned', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);
      await defaultDatabase.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', user.id).execute();

      await expectRefusal(context.sut.publish(publication(staged, sources)), 'owner-unavailable');
      expect(await context.sut.listOrphanedWork()).toEqual([
        expect.objectContaining({ id: staged.version.id, orphanReason: 'owner-unavailable' }),
      ]);
    });

    it('keeps remote references when the owner is removed for good', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const staged = await stagedExport(context, user.id, [], { destination: MediaOperationDestination.Lan });
      await context.sut.recordRemoteReference({
        versionId: staged.version.id,
        operationId: staged.render.id,
        ownerId: user.id,
        workerId: 'worker-1',
        destination: MediaOperationDestination.Lan,
        remoteRef: null,
        reason: StudioExportRemoteReason.Cancel,
      });
      await context.sut.recordRemoteReference({
        versionId: staged.version.id,
        operationId: staged.render.id,
        ownerId: user.id,
        workerId: 'worker-1',
        destination: MediaOperationDestination.Lan,
        remoteRef: null,
        reason: StudioExportRemoteReason.Cancel,
      });

      await defaultDatabase.deleteFrom('user').where('id', '=', user.id).execute();

      const references = await context.sut.listRemoteReferences('worker-1');
      expect(references).toEqual([expect.objectContaining({ operationId: staged.render.id, versionId: null })]);
      expect(await context.sut.acknowledgeRemoteReference(references[0].id, 'worker-2')).toBe(false);
      expect(await context.sut.acknowledgeRemoteReference(references[0].id, 'worker-1')).toBe(true);
      expect(await context.sut.listRemoteReferences('worker-1')).toEqual([]);
    });

    it('refuses a trashed project', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);
      await context.projects.trash(staged.projectId, new Date(Date.now() + 86_400_000));

      await expectRefusal(context.sut.publish(publication(staged, sources)), 'project-unavailable');
    });
  });

  describe('versions and integrity', () => {
    it('numbers versions per project and leaves the last good one when a later export fails', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const first = await stagedExport(context, user.id, sources);
      const v1 = await context.sut.publish(publication(first, sources));

      const second = await stagedExport(context, user.id, sources, { projectId: first.projectId });
      await context.sut.markFailed(second.version.id, { errorCode: 'gpu', error: 'lost' });
      await expectRefusal(context.sut.publish(publication(second, sources)), 'not-staged');

      const third = await stagedExport(context, user.id, sources, { projectId: first.projectId });
      const v3 = await context.sut.publish(publication(third, sources));

      expect(v1.version.version).toBe(1);
      expect(v3.version.version).toBe(2);
      expect(await context.sut.getById(first.version.id)).toEqual(
        expect.objectContaining({
          state: StudioExportVersionState.Published,
          version: 1,
          resultAssetId: v1.createdAssetId,
        }),
      );
      expect(await context.sut.markFailed(first.version.id, { errorCode: 'late', error: 'late' })).toBeUndefined();
      expect(await context.sut.cancel(first.version.id, { errorCode: 'late', error: 'late' })).toBeUndefined();
    });

    it('answers a repeated publication after an uncertain commit with the same version, creating nothing twice', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);

      const first = await context.sut.publish(publication(staged, sources));
      const again = await context.sut.publish(publication(staged, sources));

      expect(again.version).toEqual(
        expect.objectContaining({ id: first.version.id, version: 1, resultAssetId: first.createdAssetId }),
      );
      expect(again.createdAssetId).toBeNull();
      const results = await defaultDatabase
        .selectFrom('asset')
        .select('id')
        .where('checksum', '=', staged.checksum)
        .execute();
      expect(results).toHaveLength(1);
      const quota = await defaultDatabase
        .selectFrom('user')
        .select('quotaUsageInBytes')
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow();
      expect(Number(quota.quotaUsageInBytes)).toBe(1024);
    });

    it('lets exactly one of two concurrent publications of the same version through', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);

      const outcomes = await Promise.allSettled([
        context.sut.publish(publication(staged, sources)),
        context.sut.publish(publication(staged, sources)),
      ]);

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<StudioExportRepository['publish']>>
      >[];
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(fulfilled.filter((outcome) => outcome.value.createdAssetId)).toHaveLength(1);
      const results = await defaultDatabase
        .selectFrom('asset')
        .select('id')
        .where('checksum', '=', staged.checksum)
        .execute();
      expect(results).toHaveLength(1);
    });

    it('refuses to reference an existing copy of the bytes that is less restricted than the sources', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id, { visibility: AssetVisibility.Locked })];
      const staged = await stagedExport(context, user.id, sources);
      const { asset: existing } = await context.ctx.newAsset({ ownerId: user.id, checksum: staged.checksum });

      await expectRefusal(context.sut.publish(publication(staged, sources)), 'duplicate-restricted');
      expect(await lockOf(existing.id!)).toBeNull();
    });

    it('refuses a result that does not fit the owner’s quota, changing nothing', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser({ quotaSizeInBytes: 100 });
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);

      await expectRefusal(context.sut.publish(publication(staged, sources)), 'quota-exceeded');
      expect((await context.sut.getById(staged.version.id))!.state).toBe(StudioExportVersionState.Staged);
    });

    it('lists and counts a Locked result only for an unlocked session, reading sources in one query', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const open = [await ownSource(context.ctx, user.id)];
      const locked = [await ownSource(context.ctx, user.id, { visibility: AssetVisibility.Locked })];
      const first = await stagedExport(context, user.id, open);
      await context.sut.publish(publication(first, open));
      const second = await stagedExport(context, user.id, locked, { projectId: first.projectId });
      await context.sut.publish(publication(second, locked));

      const ordinary = await context.sut.listForProject(first.projectId, user.id, {
        take: 10,
        skip: 0,
        visibility: { revealed: false },
      });
      expect(ordinary.total).toBe(1);
      expect(ordinary.items.map((item) => item.id)).toEqual([first.version.id]);

      const unlocked = await context.sut.listForProject(first.projectId, user.id, {
        take: 10,
        skip: 0,
        visibility: { revealed: true, revealLockedOwnerId: user.id },
      });
      expect(unlocked.total).toBe(2);

      const sources = await context.sut.getSourcesFor([first.version.id, second.version.id]);
      expect(sources.get(first.version.id)).toEqual([expect.objectContaining({ assetId: open[0].id })]);
      expect(sources.get(second.version.id)).toEqual([
        expect.objectContaining({ assetId: locked[0].id, locked: true }),
      ]);
    });

    it('hides a result from a locked session once a source is hidden, whenever it was rendered (FL-195)', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);
      await context.sut.publish(publication(staged, sources));
      const id = staged.version.id;
      const locked = { revealed: false };
      const unlocked = { revealed: true, revealLockedOwnerId: user.id };
      const list = (visibility: typeof locked | typeof unlocked) =>
        context.sut.listForProject(staged.projectId, user.id, { take: 10, skip: 0, visibility });

      await expect(context.sut.getForOwner(id, user.id, locked)).resolves.toEqual(expect.objectContaining({ id }));

      // a lock written after the render, by a path that does not propagate it: judged at read time
      await sql`INSERT INTO asset_lock ("assetId", reason) VALUES (${sources[0].id}::uuid, 'immich-locked-folder')`.execute(
        defaultDatabase,
      );
      await expect(context.sut.getForOwner(id, user.id, locked)).resolves.toBeUndefined();
      await expect(list(locked)).resolves.toEqual({ items: [], total: 0 });
      await expect(context.sut.getForOwner(id, user.id, unlocked)).resolves.toEqual(expect.objectContaining({ id }));
      await expect(list(unlocked)).resolves.toEqual(expect.objectContaining({ total: 1 }));
      // another account's unlocked session never reveals it
      const { user: other } = await context.ctx.newUser();
      await expect(
        context.sut.getForOwner(id, user.id, { revealed: true, revealLockedOwnerId: other.id }),
      ).resolves.toBeUndefined();

      // a Locked rule hides it the same way while the session is locked
      await sql`DELETE FROM asset_lock WHERE "assetId" = ${sources[0].id}::uuid`.execute(defaultDatabase);
      await expect(context.sut.getForOwner(id, user.id, locked)).resolves.toEqual(expect.objectContaining({ id }));
      const [tag] = await sql<{ id: string }>`
        INSERT INTO tag ("userId", value) VALUES (${user.id}::uuid, 'FL-195 rule') RETURNING id
      `
        .execute(defaultDatabase)
        .then(({ rows }) => rows);
      await sql`INSERT INTO tag_closure (id_ancestor, id_descendant) VALUES (${tag.id}::uuid, ${tag.id}::uuid)`.execute(
        defaultDatabase,
      );
      await sql`INSERT INTO tag_asset ("tagId", "assetId") VALUES (${tag.id}::uuid, ${sources[0].id}::uuid)`.execute(
        defaultDatabase,
      );
      const rule = {
        revealed: false,
        hiddenContent: {
          userId: user.id,
          includeNsfw: false,
          tagIds: [tag.id],
          personIds: [],
          petIds: [],
          scope: 'owned' as const,
        },
      };
      await expect(context.sut.getForOwner(id, user.id, rule)).resolves.toBeUndefined();
    });

    it('offers only unreferenced files to retention', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const published = await stagedExport(context, user.id, sources);
      await context.sut.publish(publication(published, sources));
      const failed = await stagedExport(context, user.id, sources, { projectId: published.projectId });
      await context.sut.markFailed(failed.version.id, { errorCode: 'x', error: 'x' });

      const removable = await context.sut.listRemovableOutputs();
      expect(removable.map((version) => version.id)).toEqual([failed.version.id]);
      const unlink = vi.fn().mockResolvedValue(undefined);
      expect(await context.sut.markOutputRemoved(published.version.id, unlink)).toBe(false);
      expect(unlink).not.toHaveBeenCalled();
    });
  });

  describe('a source locked after publication (coordinator decision, September 23, 2026)', () => {
    it('locks every published result made from it, in the same transaction, and follows exports of exports', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const first = await stagedExport(context, user.id, sources);
      const published = await context.sut.publish(publication(first, sources));
      const resultId = published.createdAssetId!;
      expect(await lockOf(resultId)).toBeNull();

      const derived = await defaultDatabase
        .selectFrom('asset')
        .select(['id', 'checksum'])
        .where('id', '=', resultId)
        .executeTakeFirstOrThrow();
      const second: Source = { id: derived.id, ownerId: user.id, checksum: derived.checksum, access: 'owner' };
      const next = await stagedExport(context, user.id, [second]);
      const again = await context.sut.publish(publication(next, [second]));

      const locked = await context.assets.lock([sources[0].id], AssetLockReason.Marked, user.id);

      expect(locked).toEqual(expect.arrayContaining([sources[0].id, resultId, again.createdAssetId]));
      expect(await lockOf(resultId)).toBe(AssetLockReason.Marked);
      expect(await lockOf(again.createdAssetId!)).toBe(AssetLockReason.Marked);
      const version = await context.sut.getById(first.version.id);
      expect(version!.privacy).toEqual(expect.objectContaining({ lockReason: AssetLockReason.Marked }));
    });

    it('unlocks the results again once their last locked source is unlocked (FL-195 follow-up)', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id), await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);
      const resultId = (await context.sut.publish(publication(staged, sources))).createdAssetId!;
      const locked = { revealed: false };
      const inherited = async () =>
        (
          await defaultDatabase
            .selectFrom('asset_lock')
            .select('inherited')
            .where('assetId', '=', resultId)
            .executeTakeFirst()
        )?.inherited;

      await context.assets.lock([sources[0].id, sources[1].id], AssetLockReason.Marked, user.id);
      expect(await lockOf(resultId)).toBe(AssetLockReason.Marked);
      expect(await inherited()).toBe(true);
      await expect(context.sut.getForOwner(staged.version.id, user.id, locked)).resolves.toBeUndefined();

      // one source still locked: the result stays locked
      await context.assets.unlock([sources[0].id]);
      expect(await lockOf(resultId)).toBe(AssetLockReason.Marked);
      await expect(context.sut.getForOwner(staged.version.id, user.id, locked)).resolves.toBeUndefined();

      // the last one unlocked: so is the result, its version and its entry
      await context.assets.unlock([sources[1].id]);
      expect(await lockOf(resultId)).toBeNull();
      const version = await context.sut.getById(staged.version.id);
      expect(version!.privacy).toEqual(expect.objectContaining({ lockReason: null }));
      await expect(context.sut.getForOwner(staged.version.id, user.id, locked)).resolves.toEqual(
        expect.objectContaining({ id: staged.version.id }),
      );
      const rows = await context.sut.getSources(staged.version.id);
      expect(rows.every((row) => !row.locked)).toBe(true);
    });

    it.each([false, true])(
      'releases motion-derived privacy only after its still unlocks (separate locked source: %s)',
      async (withSeparateSource) => {
        const context = setup();
        const { user } = await context.ctx.newUser();
        const motion = await ownSource(context.ctx, user.id, {
          type: AssetType.Video,
          visibility: AssetVisibility.Hidden,
        });
        const still = await ownSource(context.ctx, user.id, { visibility: AssetVisibility.Locked });
        await context.assets.update({ id: still.id, livePhotoVideoId: motion.id });
        expect(await lockOf(motion.id)).toBeNull();
        const other = withSeparateSource
          ? await ownSource(context.ctx, user.id, { visibility: AssetVisibility.Locked })
          : null;
        const sources = other ? [motion, other] : [motion];
        const staged = await stagedExport(context, user.id, sources);
        const resultId = (await context.sut.publish(publication(staged, sources))).createdAssetId!;
        const lockedSession = { revealed: false };
        const access = new AccessRepository(defaultDatabase);

        if (other) {
          await context.assets.unlock([other.id]);
        }
        // Unlocking X must not release a result that still contains M, whose paired still S is Locked.
        expect(await lockOf(resultId)).toBe(AssetLockReason.Marked);
        expect((await context.sut.getById(staged.version.id))!.privacy).toMatchObject({
          lockReason: AssetLockReason.Marked,
        });
        expect(await context.sut.getSources(staged.version.id)).toEqual(
          expect.arrayContaining([expect.objectContaining({ assetId: motion.id, locked: true })]),
        );
        await expect(context.sut.getForOwner(staged.version.id, user.id, lockedSession)).resolves.toBeUndefined();
        await expect(access.asset.checkOwnerAccess(user.id, new Set([resultId]), false)).resolves.toEqual(new Set());

        await context.assets.unlock([still.id]);

        expect(await lockOf(resultId)).toBeNull();
        expect((await context.sut.getById(staged.version.id))!.privacy).toMatchObject({ lockReason: null });
        expect((await context.sut.getSources(staged.version.id)).every((source) => !source.locked)).toBe(true);
        await expect(context.sut.getForOwner(staged.version.id, user.id, lockedSession)).resolves.toMatchObject({
          id: staged.version.id,
        });
        await expect(access.asset.checkOwnerAccess(user.id, new Set([resultId]), false)).resolves.toEqual(
          new Set([resultId]),
        );
      },
    );

    it('never releases a lock the owner put on the result directly (FL-195 follow-up)', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);
      const resultId = (await context.sut.publish(publication(staged, sources))).createdAssetId!;
      const locked = { revealed: false };

      // locked directly before the source, and again on top of the inherited lock: both stay
      await context.assets.lock([sources[0].id], AssetLockReason.Marked, user.id);
      await context.assets.lock([resultId], AssetLockReason.Marked, user.id);
      const row = await defaultDatabase
        .selectFrom('asset_lock')
        .select(['inherited', 'lockedBy'])
        .where('assetId', '=', resultId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ inherited: false, lockedBy: user.id });

      await context.assets.unlock([sources[0].id]);

      expect(await lockOf(resultId)).toBe(AssetLockReason.Marked);
      // the version's entry follows its directly locked library item
      await expect(context.sut.getForOwner(staged.version.id, user.id, locked)).resolves.toBeUndefined();
      await expect(
        context.sut.getForOwner(staged.version.id, user.id, { revealed: true, revealLockedOwnerId: user.id }),
      ).resolves.toEqual(expect.objectContaining({ id: staged.version.id }));
    });

    it('locks descendants beyond eight generations, crossing existing locks and stopping cycles', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const root = await ownSource(context.ctx, user.id);
      let source = root;
      const descendants: { assetId: string; versionId: string }[] = [];
      for (let depth = 0; depth < 10; depth++) {
        const staged = await stagedExport(context, user.id, [source]);
        const published = await context.sut.publish(publication(staged, [source]));
        source = { id: published.createdAssetId!, ownerId: user.id, checksum: staged.checksum, access: 'owner' };
        descendants.push({ assetId: source.id, versionId: staged.version.id });
      }
      // Existing locks must not stop traversal; a reused result can form a cycle.
      await defaultDatabase
        .insertInto('asset_lock')
        .values({ assetId: descendants[0].assetId, reason: AssetLockReason.Marked, lockedBy: user.id })
        .execute();
      await defaultDatabase
        .insertInto('studio_export_version_source')
        .values({
          versionId: descendants[0].versionId,
          key: 'cycle',
          kind: 'library-asset',
          resourceId: source.id,
          assetId: source.id,
          ownerId: user.id,
          checksum: source.checksum.toString('base64'),
          sourceAccess: 'owner',
        })
        .execute();
      await context.assets.lock([root.id], AssetLockReason.Marked, user.id);
      for (const descendant of descendants) {
        expect(await lockOf(descendant.assetId)).toBe(AssetLockReason.Marked);
        expect((await context.sut.getById(descendant.versionId))!.privacy).toMatchObject({
          lockReason: AssetLockReason.Marked,
        });
      }
    });

    it('locks a project result too, which its download then refuses outside an unlocked session', async () => {
      const context = setup();
      const { user: owner } = await context.ctx.newUser();
      const { user: partner } = await context.ctx.newUser();
      const shared = { ...(await ownSource(context.ctx, partner.id)), access: 'shared' as const };
      // FL-326: a partnership grants nothing any more, so the media is shared through an album
      const { album } = await context.ctx.newAlbum({ ownerId: partner.id }, [shared.id]);
      await context.ctx.newAlbumUser({ albumId: album.id, userId: owner.id });
      const staged = await stagedExport(context, owner.id, [shared]);
      await context.sut.publish(publication(staged, [shared]));

      await context.assets.lock([shared.id], AssetLockReason.Marked, partner.id);

      const version = await context.sut.getById(staged.version.id);
      expect(version!.privacy).toEqual(expect.objectContaining({ lockReason: AssetLockReason.Marked }));
      expect(await context.sut.getSources(staged.version.id)).toEqual([expect.objectContaining({ locked: true })]);
    });

    it('never leaves an unlocked result when the lock races the publication', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      for (let round = 0; round < 5; round++) {
        const sources = [await ownSource(context.ctx, user.id)];
        const staged = await stagedExport(context, user.id, sources);

        const [published] = await Promise.all([
          context.sut.publish(publication(staged, sources)),
          context.assets.lock([sources[0].id], AssetLockReason.Marked, user.id),
        ]);

        expect(await lockOf(published.createdAssetId!)).toBe(AssetLockReason.Marked);
      }
    });
  });

  describe('pending work', () => {
    it('lists a staged export whose publication job ended elsewhere', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const staged = await stagedExport(context, user.id, []);
      await defaultDatabase
        .updateTable('media_operation')
        .set({ status: 'failed' as never })
        .where('id', '=', staged.publishId)
        .execute();

      expect(await context.sut.listSettledWork()).toEqual([
        expect.objectContaining({ id: staged.version.id, jobStatus: 'failed' }),
      ]);
    });

    it('does not stage a render whose version was cancelled meanwhile', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const projectId = (await context.projects.create({ ownerId: user.id, name: 'x' })).id;
      const { operation, version } = await context.sut.createWithRender(
        {
          ownerId: user.id,
          kind: MediaOperationKind.StudioExport,
          destination: MediaOperationDestination.Local,
          destinationDetail: null,
          label: 'x',
          assetId: null,
          resultAssetId: null,
          retryOfId: null,
          projectId,
          revisionId: 'd',
          snapshot: {},
          settings: {},
          estimate: null,
          maxAttempts: 3,
        },
        {
          ownerId: user.id,
          projectId,
          revision: 1,
          revisionDigest: 'd',
          destination: MediaOperationDestination.Local,
          settings: {},
        },
      );
      await context.sut.cancel(version.id, { errorCode: 'c', error: 'c' });
      const claimToken = randomUUID();
      await defaultDatabase
        .updateTable('media_operation')
        .set({ status: MediaOperationStatus.Validating, claimToken })
        .where('id', '=', operation.id)
        .execute();

      const staged = await context.sut.stage(
        operation.id,
        claimToken,
        { path: '/x', checksum: randomBytes(32), sizeInBytes: 1, contentType: 'video/mp4', remoteRef: null },
        () => {
          throw new Error('must not queue a publication');
        },
      );
      expect(staged).toBeUndefined();
    });
  });
});
