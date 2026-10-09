import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DuplicateUndoClaim } from 'src/repositories/duplicate-undo-authority.js';
import {
  AlbumUserRole,
  AssetLockReason,
  AssetStatus,
  AssetVisibility,
  DuplicateDecisionKind,
  MediaOperationBulkAction,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  Permission,
  UserMetadataKey,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DuplicateDecisionRepository } from 'src/repositories/duplicate-decision.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { BulkOperationService } from 'src/services/bulk-operation.service.js';
import { DuplicateDecisionService } from 'src/services/duplicate-decision.service.js';
import { TrashService } from 'src/services/trash.service.js';
import { initializeEffectiveConfig } from 'src/utils/config.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** Actual claimed worker and restoration transaction; unrelated metadata services must stay unused. */
describe('recorded duplicate Undo lease', () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await getKyselyDB();
    await initializeEffectiveConfig({
      configRepo: new ConfigRepository(),
      metadataRepo: new SystemMetadataRepository(db),
      logger: LoggingRepository.create(),
    });
  });
  afterAll(async () => {
    await db.destroy();
  });

  const fixture = async (metadata = false) => {
    const { sut: trash, ctx } = newMediumService(TrashService, {
      database: db,
      real: [
        AccessRepository,
        AssetRepository,
        PartnerOriginRepository,
        ConfigRepository,
        SystemMetadataRepository,
        TrashRepository,
      ],
      mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
    });
    ctx.getMock(EventRepository).emit.mockResolvedValue();
    ctx.getMock(JobRepository).queueAll.mockResolvedValue();
    ctx.getMock(WebsocketRepository).clientSend.mockReturnValue(undefined);
    const logger = LoggingRepository.create(),
      access = ctx.get(AccessRepository),
      operations = new MediaOperationRepository(db),
      decisions = new DuplicateDecisionRepository(db);
    const unused = new Proxy(
      {},
      {
        get: (_, key) => () => {
          throw new Error(`Unexpected unrelated service: ${String(key)}`);
        },
      },
    ) as never;
    const { sut: assets, ctx: assetCtx } = newMediumService(AssetService, {
      database: db,
      real: [AccessRepository, AssetRepository, PartnerOriginRepository],
      mock: [EventRepository, JobRepository, LoggingRepository],
    });
    assetCtx.getMock(JobRepository).queueAll.mockResolvedValue();
    const duplicates = new DuplicateDecisionService(
      logger,
      decisions,
      access,
      unused,
      assets,
      unused,
      unused,
      unused,
      trash,
    );
    const worker = new BulkOperationService(
      logger,
      operations,
      access,
      ctx.get(UserRepository),
      ctx.get(ApiKeyRepository),
      unused,
      unused,
      unused,
      trash,
      unused,
      unused,
      unused,
      duplicates,
      unused,
      unused,
      unused,
    );
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id, pinExpiresAt: new Date(Date.now() + 60_000) });
    const ownerAuth = (await currentAuth(db, user.id, session.id, false))!;
    const members: string[] = [];
    for (let n = 0; n < 3; n++)
      members.push(
        (
          await ctx.newAsset({
            ownerId: user.id,
            duplicateId: null,
            isFavorite: metadata && n === 0,
            originalPath: `/data/library/${randomUUID()}.jpg`,
            ...(n === 2 && { status: AssetStatus.Trashed, deletedAt: new Date() }),
          })
        ).asset.id,
      );
    const duplicateId = randomUUID();
    const newJob = (action: MediaOperationBulkAction, groups: unknown[]) =>
      operations.create({
        ownerId: user.id,
        kind: MediaOperationKind.Bulk,
        destination: MediaOperationDestination.Local,
        label: 'Undo fixture',
        snapshot: {
          action,
          assetIds: members,
          payload: { duplicateGroups: groups },
          submittedTotal: 3,
          truncated: false,
          requestId: null,
          apiKeyId: null,
          elevated: false,
        },
        settings: {},
      });
    const original = await newJob(MediaOperationBulkAction.ResolveDuplicates, []);
    const originalClaim = (await operations.claimNext({
      kinds: [MediaOperationKind.Bulk],
      workerId: 'fixture-history',
      leaseMs: 120_000,
    }))!;
    expect(originalClaim.operation.id).toBe(original.id);
    await operations.fail(original.id, originalClaim.claimToken, {
      error: 'Applied history fixture',
      errorCode: 'fixture',
    });
    const recorded = await decisions.create({
      ownerId: user.id,
      duplicateId,
      operationId: original.id,
      decision: DuplicateDecisionKind.Keepers,
      memberIds: members,
      keepAssetIds: members.slice(0, 2),
      trashAssetIds: [members[2]],
      stackId: null,
      appliedAt: new Date(),
      undoOperationId: null,
      undoneAt: null,
      state: metadata
        ? {
            before: {
              [members[0]]: {
                isFavorite: false,
                visibility: AssetVisibility.Timeline,
                rating: null,
                description: '',
                latitude: null,
                longitude: null,
                albumIds: [],
                tagIds: [],
              },
            },
            after: {
              [members[0]]: {
                isFavorite: true,
                visibility: AssetVisibility.Timeline,
                rating: null,
                description: '',
                latitude: null,
                longitude: null,
                albumIds: [],
                tagIds: [],
              },
            },
          }
        : {},
    });
    const group = {
      duplicateId,
      decision: DuplicateDecisionKind.Keepers,
      memberIds: members,
      keepAssetIds: members.slice(0, 2),
      decisionId: recorded.id,
    };
    const undo = await newJob(MediaOperationBulkAction.UndoDuplicates, [group]);
    const claimed = (await operations.claimNext({
      kinds: [MediaOperationKind.Bulk],
      workerId: 'fixture-worker',
      leaseMs: 120_000,
    }))!;
    expect(claimed.operation.id).toBe(undo.id);
    const claim: DuplicateUndoClaim = {
      operationId: undo.id,
      claimToken: claimed.claimToken,
      decisionId: recorded.id,
      duplicateId,
      memberIds: members,
    };
    await decisions.beginUndo(recorded.id, undo.id);
    await operations.reportProgress(undo.id, claimed.claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: 0,
      totalUnits: 3,
      progress: 0,
    });
    const restore = () => trash.restoreDuplicateUndo(ownerAuth, { ids: [members[2]] }, claim);
    const state = () =>
      db
        .selectFrom('asset')
        .select(['id', 'status', 'duplicateId', 'isFavorite'])
        .where('id', 'in', members)
        .orderBy('id')
        .execute();
    return {
      trash,
      ctx,
      worker,
      duplicates,
      decisions,
      operations,
      user,
      ownerAuth,
      members,
      original,
      recorded,
      group,
      undo,
      claimed,
      claim,
      restore,
      state,
    };
  };
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  it('restores keeper metadata and relinks all three members through the actual claimed BulkOperationService', async () => {
    const f = await fixture(true);
    const workerAuth = await f.worker.authFor(f.user.id);
    expect(await db.selectFrom('session').select('id').where('id', '=', workerAuth!.session!.id).execute()).toEqual([]);
    await f.worker.run(f.claimed.operation, f.claimed.claimToken);
    expect(
      (await f.state()).every((a) => a.status === AssetStatus.Active && a.duplicateId === f.group.duplicateId),
    ).toBe(true);
    expect((await f.state()).find((a) => a.id === f.members[0])!.isFavorite).toBe(false);
    expect((await f.decisions.getById(f.user.id, f.recorded.id))?.undoneAt).not.toBeNull();
    const operation = await db
      .selectFrom('media_operation')
      .select(['status', 'result'])
      .where('id', '=', f.undo.id)
      .executeTakeFirstOrThrow();
    expect(operation.status).toBe(MediaOperationStatus.Completed);
    expect(operation.result).toMatchObject({ succeeded: 3, skipped: 0, failed: 0 });
    // A completed replay reports the original outcome and makes no further restoration.
    expect(
      (await f.duplicates.undoGroup(f.ownerAuth, f.undo.id, f.group, f.claim)).every((a) => a.status === 'ok'),
    ).toBe(true);
    await f.worker.onShutdown();
  });

  it('atomically restores keeper motion, EXIF, visibility, albums and tags while preserving newer edits', async () => {
    const f = await fixture(true),
      keeper = f.members[0];
    const { asset: motion } = await f.ctx.newAsset({ ownerId: f.user.id, visibility: AssetVisibility.Hidden });
    await db
      .updateTable('asset')
      .set({ livePhotoVideoId: motion.id })
      .where('id', 'in', [keeper, f.members[2]])
      .execute();
    const albumId = randomUUID(),
      keptAlbumId = randomUUID(),
      tagId = randomUUID(),
      keptTagId = randomUUID();
    await db
      .insertInto('album')
      .values([
        { id: albumId, albumName: 'merge-added' },
        { id: keptAlbumId, albumName: 'original' },
      ])
      .execute();
    await db
      .insertInto('album_user')
      .values([
        { albumId, userId: f.user.id, role: AlbumUserRole.Owner },
        { albumId: keptAlbumId, userId: f.user.id, role: AlbumUserRole.Owner },
      ])
      .execute();
    await db
      .insertInto('album_asset')
      .values([
        { albumId, assetId: keeper },
        { albumId: keptAlbumId, assetId: keeper },
      ])
      .execute();
    await db
      .insertInto('tag')
      .values([
        { id: tagId, userId: f.user.id, value: 'merge-added' },
        { id: keptTagId, userId: f.user.id, value: 'original' },
      ])
      .execute();
    await db
      .insertInto('tag_asset')
      .values([
        { tagId, assetId: keeper },
        { tagId: keptTagId, assetId: keeper },
      ])
      .execute();
    await db
      .insertInto('asset_exif')
      .values({ assetId: keeper, description: 'merged', rating: 4, latitude: 3, longitude: 4 })
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet({ description: 'merged', rating: 4, latitude: 3, longitude: 4 }),
      )
      .execute();
    await db.updateTable('asset').set({ visibility: AssetVisibility.Archive }).where('id', '=', keeper).execute();
    const after = (await f.decisions.getKeeperStates([keeper])).get(keeper)!;
    const before = {
      ...after,
      livePhotoVideoId: null,
      isFavorite: false,
      visibility: AssetVisibility.Timeline,
      description: 'before',
      rating: 1,
      latitude: 1,
      longitude: 2,
      albumIds: [keptAlbumId],
      tagIds: [keptTagId],
    };
    await db
      .updateTable('duplicate_decision')
      .set({ state: { before: { [keeper]: before }, after: { [keeper]: after } } })
      .where('id', '=', f.recorded.id)
      .execute();
    // A newer edit wins, while every still-matching merged field is reversed.
    await db.updateTable('asset_exif').set({ description: 'newer owner edit' }).where('assetId', '=', keeper).execute();
    expect(
      (await f.duplicates.undoGroup(f.ownerAuth, f.undo.id, f.group, f.claim)).every((a) => a.status === 'ok'),
    ).toBe(true);
    expect((await f.decisions.getKeeperStates([keeper])).get(keeper)).toEqual({
      ...before,
      description: 'newer owner edit',
    });
    expect(
      (await db.selectFrom('asset').select('livePhotoVideoId').where('id', '=', f.members[2]).executeTakeFirstOrThrow())
        .livePhotoVideoId,
    ).toBe(motion.id);
    expect((await f.decisions.getById(f.user.id, f.recorded.id))!.undoneAt).not.toBeNull();
  });

  it('restores nonempty keeper metadata under recorded elevation without changing Locked visibility', async () => {
    const f = await fixture(true),
      keeper = f.members[0];
    const state = f.recorded.state as {
      before: Record<string, { visibility: AssetVisibility }>;
      after: Record<string, { visibility: AssetVisibility }>;
    };
    state.after[keeper].visibility = AssetVisibility.Archive;
    await db.updateTable('asset').set({ visibility: AssetVisibility.Archive }).where('id', '=', keeper).execute();
    await db
      .insertInto('asset_lock')
      .values({ assetId: keeper, lockedBy: f.user.id, reason: AssetLockReason.Marked })
      .execute();
    await db.updateTable('duplicate_decision').set({ state }).where('id', '=', f.recorded.id).execute();
    await db
      .updateTable('media_operation')
      .set({ snapshot: { ...f.undo.snapshot, elevated: true } })
      .where('id', '=', f.undo.id)
      .execute();
    expect(
      (await f.duplicates.undoGroup(f.ownerAuth, f.undo.id, f.group, f.claim)).every((a) => a.status === 'ok'),
    ).toBe(true);
    expect((await f.decisions.getKeeperStates([keeper])).get(keeper)).toMatchObject({
      isFavorite: false,
      visibility: AssetVisibility.Archive,
    });
    expect(await f.decisions.getLockedIds([keeper])).toEqual(new Set([keeper]));
    expect((await f.decisions.getById(f.user.id, f.recorded.id))!.undoneAt).not.toBeNull();
  });

  it('rolls back restore and preceding metadata when recorded album removal loses current membership authority', async () => {
    const f = await fixture(true),
      keeper = f.members[0],
      albumId = randomUUID();
    const { user: other } = await f.ctx.newUser();
    await db.insertInto('album').values({ id: albumId, albumName: 'changed membership' }).execute();
    await db.insertInto('album_user').values({ albumId, userId: other.id, role: AlbumUserRole.Owner }).execute();
    await db.insertInto('album_asset').values({ albumId, assetId: keeper }).execute();
    const state = f.recorded.state as { after: Record<string, { albumIds: string[] }> };
    state.after[keeper].albumIds = [albumId];
    await db.updateTable('duplicate_decision').set({ state }).where('id', '=', f.recorded.id).execute();
    expect(
      (await f.duplicates.undoGroup(f.ownerAuth, f.undo.id, f.group, f.claim)).every((a) => a.status !== 'ok'),
    ).toBe(true);
    expect((await f.state()).find((a) => a.id === keeper)!.isFavorite).toBe(true);
    expect((await f.state()).find((a) => a.id === f.members[2])!.status).toBe(AssetStatus.Trashed);
    expect((await f.state()).every((a) => a.duplicateId === null)).toBe(true);
    expect((await f.decisions.getById(f.user.id, f.recorded.id))!.undoneAt).toBeNull();
    expect(await db.selectFrom('album_asset').select('assetId').where('albumId', '=', albumId).execute()).toEqual([
      { assetId: keeper },
    ]);
  });

  const afterRestoreChanges: [string, (f: Fixture) => Promise<unknown>][] = [
    [
      'cancellation',
      async (f) =>
        db.updateTable('media_operation').set({ cancelRequestedAt: new Date() }).where('id', '=', f.undo.id).execute(),
    ],
    [
      'replacement token',
      async (f) =>
        db.updateTable('media_operation').set({ claimToken: randomUUID() }).where('id', '=', f.undo.id).execute(),
    ],
    [
      'lease expiry',
      async (f) =>
        db
          .updateTable('media_operation')
          .set({ claimExpiresAt: new Date(0) })
          .where('id', '=', f.undo.id)
          .execute(),
    ],
    [
      'owner deletion',
      async (f) => db.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', f.user.id).execute(),
    ],
    [
      'regroup',
      async (f) => db.updateTable('asset').set({ duplicateId: randomUUID() }).where('id', '=', f.members[1]).execute(),
    ],
    [
      'Locked change',
      async (f) =>
        db
          .insertInto('asset_lock')
          .values({ assetId: f.members[0], lockedBy: f.user.id, reason: AssetLockReason.Marked })
          .execute(),
    ],
    [
      'pause',
      async (f) =>
        db.updateTable('media_operation').set({ pauseRequestedAt: new Date() }).where('id', '=', f.undo.id).execute(),
    ],
    [
      'API key revocation',
      async (f) => {
        const row = await db
          .selectFrom('media_operation')
          .select('snapshot')
          .where('id', '=', f.undo.id)
          .executeTakeFirstOrThrow();
        await f.ctx.get(ApiKeyRepository).delete(f.user.id, row.snapshot.apiKeyId as string);
      },
    ],
  ];
  it.each(afterRestoreChanges)(
    'makes no authoritative writes after %s at the post-restore await boundary with keeper metadata',
    async (name, change) => {
      const f = await fixture(true);
      if (name === 'API key revocation') {
        const key = await f.ctx
          .get(ApiKeyRepository)
          .create({ userId: f.user.id, name: 'boundary fixture', key: randomBytes(32), permissions: [Permission.All] });
        await db
          .updateTable('media_operation')
          .set({ snapshot: { ...f.undo.snapshot, apiKeyId: key.id } })
          .where('id', '=', f.undo.id)
          .execute();
      }
      const restore = f.trash.restoreDuplicateUndo.bind(f.trash);
      let boundary: unknown;
      vi.spyOn(f.trash, 'restoreDuplicateUndo').mockImplementation(async (...args) => {
        const result = await restore(...args);
        // This awaited boundary can expose only a fully committed group, never partial restoration.
        expect(
          (await f.state()).every((a) => a.duplicateId === f.group.duplicateId && a.status === AssetStatus.Active),
        ).toBe(true);
        expect((await f.state()).find((a) => a.id === f.members[0])!.isFavorite).toBe(false);
        expect((await f.decisions.getById(f.user.id, f.recorded.id))!.undoneAt).not.toBeNull();
        await change(f);
        boundary = {
          assets: await f.state(),
          undoneAt: (await f.decisions.getById(f.user.id, f.recorded.id))!.undoneAt,
        };
        return result;
      });
      expect(
        (await f.duplicates.undoGroup(f.ownerAuth, f.undo.id, f.group, f.claim)).every((a) => a.status === 'ok'),
      ).toBe(true);
      expect({
        assets: await f.state(),
        undoneAt: (await f.decisions.getById(f.user.id, f.recorded.id))!.undoneAt,
      }).toEqual(boundary);
    },
  );

  it('refuses a concurrently regrouped member after a real asset-row wait without partial restoration or completion', async () => {
    const f = await fixture(true);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let blockerPid = 0;
    const otherGroup = randomUUID();
    const blocker = db.connection().execute((c) =>
      c.transaction().execute(async (tx) => {
        blockerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0].pid;
        await tx.updateTable('asset').set({ duplicateId: otherGroup }).where('id', '=', f.members[1]).execute();
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    const result = f.duplicates.undoGroup(f.ownerAuth, f.undo.id, f.group, f.claim);
    try {
      await vi.waitFor(async () =>
        expect(
          (
            await sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND ${blockerPid}=ANY(pg_blocking_pids(pid))`.execute(
              db,
            )
          ).rows[0].count,
        ).toBeGreaterThan(0),
      );
    } finally {
      release.resolve();
    }
    await blocker;
    expect((await result).every((a) => a.status !== 'ok')).toBe(true);
    expect((await f.state()).find((a) => a.id === f.members[2])!.status).toBe(AssetStatus.Trashed);
    expect((await f.state()).find((a) => a.id === f.members[0])!.isFavorite).toBe(true);
    expect((await f.state()).find((a) => a.id === f.members[1])!.duplicateId).toBe(otherGroup);
    expect((await f.decisions.getById(f.user.id, f.recorded.id))!.undoneAt).toBeNull();
  });

  it('retains authenticated owner restoration and rejects ordinary expired/revoked sessions and foreign owners', async () => {
    const f = await fixture();
    const { session: expired } = await f.ctx.newSession({
      userId: f.user.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(
      f.trash.restoreAssets(factory.auth({ user: f.user, session: { id: expired.id, hasElevatedPermission: true } }), {
        ids: [f.members[2]],
      }),
    ).rejects.toThrow('trash_owner_session_required');
    const { session: revoked } = await f.ctx.newSession({ userId: f.user.id });
    await db.deleteFrom('session').where('id', '=', revoked.id).execute();
    await expect(
      f.trash.restoreAssets(factory.auth({ user: f.user, session: { id: revoked.id, hasElevatedPermission: true } }), {
        ids: [f.members[2]],
      }),
    ).rejects.toThrow('trash_owner_session_required');
    const { user: other } = await f.ctx.newUser();
    await expect(f.trash.restoreAssets(factory.auth({ user: other }), { ids: [f.members[2]] })).rejects.toThrow();
    expect((await f.duplicates.undoGroup(f.ownerAuth, f.undo.id, f.group)).every((a) => a.status === 'ok')).toBe(true);
    expect(
      (await f.state()).every((a) => a.status === AssetStatus.Active && a.duplicateId === f.group.duplicateId),
    ).toBe(true);
  });

  const refuseCases: [string, (f: Fixture) => Promise<unknown> | void][] = [
    [
      'wrong token',
      (f) => {
        f.claim.claimToken = randomUUID();
      },
    ],
    [
      'replacement token',
      async (f) =>
        db.updateTable('media_operation').set({ claimToken: randomUUID() }).where('id', '=', f.undo.id).execute(),
    ],
    [
      'expired lease',
      async (f) =>
        db
          .updateTable('media_operation')
          .set({ claimExpiresAt: new Date(Date.now() - 1000) })
          .where('id', '=', f.undo.id)
          .execute(),
    ],
    [
      'cancelled operation',
      async (f) =>
        db.updateTable('media_operation').set({ cancelRequestedAt: new Date() }).where('id', '=', f.undo.id).execute(),
    ],
    [
      'paused operation',
      async (f) =>
        db.updateTable('media_operation').set({ pauseRequestedAt: new Date() }).where('id', '=', f.undo.id).execute(),
    ],
    [
      'terminal operation',
      async (f) =>
        db
          .updateTable('media_operation')
          .set({ status: MediaOperationStatus.Completed })
          .where('id', '=', f.undo.id)
          .execute(),
    ],
    [
      'wrong operation owner',
      async (f) => {
        const { user } = await f.ctx.newUser();
        await db.updateTable('media_operation').set({ ownerId: user.id }).where('id', '=', f.undo.id).execute();
      },
    ],
    [
      'deleted account',
      async (f) => db.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', f.user.id).execute(),
    ],
    [
      'wrong action',
      async (f) =>
        db
          .updateTable('media_operation')
          .set({ snapshot: { ...f.undo.snapshot, action: MediaOperationBulkAction.Favorite } })
          .where('id', '=', f.undo.id)
          .execute(),
    ],
    [
      'changed queued members',
      async (f) =>
        db
          .updateTable('media_operation')
          .set({ snapshot: { ...f.undo.snapshot, assetIds: f.members.slice(1) } })
          .where('id', '=', f.undo.id)
          .execute(),
    ],
    [
      'foreign decision owner',
      async (f) => {
        const { user } = await f.ctx.newUser();
        await db.updateTable('duplicate_decision').set({ ownerId: user.id }).where('id', '=', f.recorded.id).execute();
      },
    ],
    [
      'other undo holds decision',
      async (f) =>
        db
          .updateTable('duplicate_decision')
          .set({ undoOperationId: f.original.id })
          .where('id', '=', f.recorded.id)
          .execute(),
    ],
    [
      'permanent decision',
      async (f) =>
        db
          .updateTable('duplicate_decision')
          .set({ state: { permanent: true } })
          .where('id', '=', f.recorded.id)
          .execute(),
    ],
    [
      'already undone decision',
      async (f) =>
        db.updateTable('duplicate_decision').set({ undoneAt: new Date() }).where('id', '=', f.recorded.id).execute(),
    ],
    [
      'new Locked keeper',
      async (f) =>
        db
          .insertInto('asset_lock')
          .values({ assetId: f.members[0], reason: AssetLockReason.Marked, lockedBy: f.user.id })
          .execute(),
    ],
    [
      'deleted copy',
      async (f) =>
        db.updateTable('asset').set({ status: AssetStatus.Deleted }).where('id', '=', f.members[2]).execute(),
    ],
    [
      'regrouped keeper',
      async (f) => db.updateTable('asset').set({ duplicateId: randomUUID() }).where('id', '=', f.members[0]).execute(),
    ],
    [
      'hidden keeper',
      async (f) =>
        db.updateTable('asset').set({ visibility: AssetVisibility.Hidden }).where('id', '=', f.members[0]).execute(),
    ],
    [
      'current suppression hides keeper',
      async (f) => {
        const { tag } = await f.ctx.newTag({ userId: f.user.id, value: 'hidden' });
        await f.ctx.newTagAsset({ tagIds: [tag.id], assetIds: [f.members[0]] });
        await db
          .insertInto('user_metadata')
          .values({
            userId: f.user.id,
            key: UserMetadataKey.Preferences,
            value: { privacy: { suppression: { tagIds: [tag.id], personIds: [], petIds: [], scope: 'owned' } } },
          })
          .execute();
      },
    ],
    [
      'revoked API key',
      async (f) => {
        const key = await f.ctx
          .get(ApiKeyRepository)
          .create({ userId: f.user.id, name: 'fixture', key: randomBytes(32), permissions: [Permission.All] });
        await db
          .updateTable('media_operation')
          .set({ snapshot: { ...f.undo.snapshot, apiKeyId: key.id } })
          .where('id', '=', f.undo.id)
          .execute();
        await f.ctx.get(ApiKeyRepository).delete(f.user.id, key.id);
      },
    ],
    [
      'narrowed API key',
      async (f) => {
        const key = await f.ctx
          .get(ApiKeyRepository)
          .create({ userId: f.user.id, name: 'fixture', key: randomBytes(32), permissions: [Permission.AssetRead] });
        await db
          .updateTable('media_operation')
          .set({ snapshot: { ...f.undo.snapshot, apiKeyId: key.id } })
          .where('id', '=', f.undo.id)
          .execute();
      },
    ],
  ];
  it.each(refuseCases)('refuses %s before restoration', async (_name, mutate) => {
    const f = await fixture();
    await mutate(f);
    await expect(f.restore()).rejects.toThrow();
    expect((await f.state()).find((a) => a.id === f.members[2])?.status).not.toBe(AssetStatus.Active);
    expect(
      await db.selectFrom('asset_local_effect').select('effectId').where('ownerId', '=', f.user.id).execute(),
    ).toEqual([]);
  });

  it('refuses restoration outside the recorded trashed selection', async () => {
    const f = await fixture();
    await expect(f.trash.restoreDuplicateUndo(f.ownerAuth, { ids: [f.members[0]] }, f.claim)).rejects.toThrow(
      'duplicate_undo_selection_changed',
    );
    expect((await f.state()).find((a) => a.id === f.members[2])?.status).toBe(AssetStatus.Trashed);
  });

  it('retains the persisted elevated choice without removing any lock', async () => {
    const f = await fixture();
    await db
      .updateTable('media_operation')
      .set({ snapshot: { ...f.undo.snapshot, elevated: true } })
      .where('id', '=', f.undo.id)
      .execute();
    await db
      .insertInto('asset_lock')
      .values({ assetId: f.members[0], reason: AssetLockReason.Marked, lockedBy: f.user.id })
      .execute();
    await expect(f.restore()).resolves.toEqual({ count: 1 });
    expect(
      await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', f.members[0]).execute(),
    ).toHaveLength(1);
  });

  it('revalidates an already restored replay under the live claim', async () => {
    const f = await fixture();
    await f.trash.restoreAssets(f.ownerAuth, { ids: [f.members[2]] });
    await expect(f.trash.restoreDuplicateUndo(f.ownerAuth, { ids: [] }, f.claim)).resolves.toEqual({ count: 0 });
    f.claim.claimToken = randomUUID();
    await expect(f.trash.restoreDuplicateUndo(f.ownerAuth, { ids: [] }, f.claim)).rejects.toThrow(
      'duplicate_undo_claim_required',
    );
  });

  it.each(['expiry', 'cancellation', 'replacement'] as const)(
    'rolls back all Undo writes and effects on expiry during a real stream-counter wait with %s',
    async (mutation) => {
      const f = await fixture(true);
      // An actual associated edit family exercises the existing config/item/effects transaction.
      await sql`INSERT INTO icloud_edit_version(id,"ownerId",item,"assetId",sha256,"isOriginal") VALUES(${randomUUID()}::uuid,${f.user.id}::uuid,${randomUUID().toUpperCase()},${f.members[2]}::uuid,${randomBytes(32)},true)`.execute(
        db,
      );
      await db
        .insertInto('asset_local_effect_stream')
        .values({ ownerId: f.user.id, streamEpoch: randomUUID() })
        .execute();
      const beforeStream = await db
        .selectFrom('asset_local_effect_stream')
        .select('nextSequence')
        .where('ownerId', '=', f.user.id)
        .executeTakeFirstOrThrow();
      await sql`UPDATE media_operation SET status='rendering',"claimExpiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=${f.undo.id}::uuid`.execute(
        db,
      );
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let blockerPid = 0;
      const blocker = db.connection().execute((c) =>
        c.transaction().execute(async (tx) => {
          blockerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0].pid;
          await tx
            .selectFrom('asset_local_effect_stream')
            .select('ownerId')
            .where('ownerId', '=', f.user.id)
            .forUpdate()
            .execute();
          entered.resolve();
          await release.promise;
        }),
      );
      await entered.promise;
      let authorityWrite: Promise<unknown> | undefined;
      const rejected = expect(f.restore()).rejects.toThrow('duplicate_undo_claim_required');
      try {
        await vi.waitFor(async () => {
          expect(
            (
              await sql<{
                count: number;
              }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND ${blockerPid}=ANY(pg_blocking_pids(pid))`.execute(
                db,
              )
            ).rows[0].count,
          ).toBeGreaterThan(0);
        });
        if (mutation !== 'expiry') {
          authorityWrite = db
            .updateTable('media_operation')
            .set(mutation === 'cancellation' ? { cancelRequestedAt: new Date() } : { claimToken: randomUUID() })
            .where('id', '=', f.undo.id)
            .execute();
          // The operation lock keeps a competing authority mutation outside the Undo transaction.
          await vi.waitFor(async () =>
            expect(
              (
                await sql<{
                  count: number;
                }>`SELECT count(*)::int AS count FROM pg_stat_activity a WHERE a.datname=current_database() AND cardinality(pg_blocking_pids(a.pid))>0 AND a.query LIKE 'update "media_operation"%'`.execute(
                  db,
                )
              ).rows[0].count,
            ).toBeGreaterThan(0),
          );
        }
        await vi.waitFor(
          async () => {
            expect(
              (
                await sql<{
                  expired: boolean;
                }>`SELECT "claimExpiresAt"<=clock_timestamp() AS expired FROM media_operation WHERE id=${f.undo.id}::uuid`.execute(
                  db,
                )
              ).rows[0].expired,
            ).toBe(true);
          },
          { timeout: 3000 },
        );
      } finally {
        release.resolve();
      }
      await blocker;
      await rejected;
      await authorityWrite;
      expect((await f.state()).find((a) => a.id === f.members[2])?.status).toBe(AssetStatus.Trashed);
      expect((await f.state()).find((a) => a.id === f.members[0])!.isFavorite).toBe(true);
      expect((await f.state()).every((a) => a.duplicateId === null)).toBe(true);
      expect((await f.decisions.getById(f.user.id, f.recorded.id))!.undoneAt).toBeNull();
      expect(await db.selectFrom('asset_local_effect').selectAll().where('ownerId', '=', f.user.id).execute()).toEqual(
        [],
      );
      expect(
        (
          await db
            .selectFrom('asset_local_effect_stream')
            .select('nextSequence')
            .where('ownerId', '=', f.user.id)
            .executeTakeFirstOrThrow()
        ).nextSequence,
      ).toBe(beforeStream.nextSequence);
    },
  );
});
