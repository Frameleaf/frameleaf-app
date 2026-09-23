import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AssetLockReason,
  AssetType,
  AssetVisibility,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  StudioExportRemoteReason,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  StudioExportPublication,
  StudioExportRefusal,
  StudioExportRepository,
  StudioExportVersion,
} from 'src/repositories/studio-export.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const database = db || defaultDatabase;
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  const privacy = new DerivativePrivacyRepository(database);
  const sut = new StudioExportRepository(
    database,
    privacy,
    new ForkPrivacyRepository(database),
    new ForkEnrichmentRepository(database),
  );
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
  await sql`DELETE FROM immich_fork.migration_audit WHERE name = 'official-handoff-preparation'`.execute(
    defaultDatabase,
  );
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
    .set({ claimToken, status: MediaOperationStatus.Validating })
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
    .set({ claimToken, status: MediaOperationStatus.Validating })
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
  describe('claim fencing', () => {
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

    it('never puts a result made with a partner’s shared media in the owner’s library', async () => {
      const context = setup();
      const { user: owner } = await context.ctx.newUser();
      const { user: partner } = await context.ctx.newUser();
      await context.ctx.newPartner({ sharedById: partner.id, sharedWithId: owner.id });
      const shared = { ...(await ownSource(context.ctx, partner.id)), access: 'shared' as const };
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

  describe('publish: owner, project and handoff', () => {
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

    it('publishes nothing while a handover is being prepared', async () => {
      const context = setup();
      const { user } = await context.ctx.newUser();
      const sources = [await ownSource(context.ctx, user.id)];
      const staged = await stagedExport(context, user.id, sources);
      await sql`INSERT INTO immich_fork.migration_audit (name, phase, status, details)
        VALUES ('official-handoff-preparation', 'ready', 'running', '{}'::jsonb)`.execute(defaultDatabase);

      await expectRefusal(context.sut.publish(publication(staged, sources)), 'handoff-in-progress');
      expect(await context.sut.handoffInProgress()).toBe(true);
      expect(await context.sut.listOrphanedWork()).toEqual([
        expect.objectContaining({ id: staged.version.id, orphanReason: 'handoff-in-progress' }),
      ]);
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
        includeLocked: false,
      });
      expect(ordinary.total).toBe(1);
      expect(ordinary.items.map((item) => item.id)).toEqual([first.version.id]);

      const unlocked = await context.sut.listForProject(first.projectId, user.id, {
        take: 10,
        skip: 0,
        includeLocked: true,
      });
      expect(unlocked.total).toBe(2);

      const sources = await context.sut.getSourcesFor([first.version.id, second.version.id]);
      expect(sources.get(first.version.id)).toEqual([expect.objectContaining({ assetId: open[0].id })]);
      expect(sources.get(second.version.id)).toEqual([
        expect.objectContaining({ assetId: locked[0].id, locked: true }),
      ]);
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
      expect(await context.sut.markOutputRemoved(published.version.id)).toBe(false);
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
      await context.ctx.newPartner({ sharedById: partner.id, sharedWithId: owner.id });
      const shared = { ...(await ownSource(context.ctx, partner.id)), access: 'shared' as const };
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
