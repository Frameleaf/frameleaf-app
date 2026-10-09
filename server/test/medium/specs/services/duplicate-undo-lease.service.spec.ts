import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DuplicateUndoClaim } from 'src/repositories/duplicate-undo-authority.js';
import {
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
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DuplicateDecisionRepository } from 'src/repositories/duplicate-decision.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
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

  const fixture = async () => {
    const { sut: trash, ctx } = newMediumService(TrashService, {
      database: db,
      real: [AccessRepository, ConfigRepository, SystemMetadataRepository, TrashRepository],
      mock: [EventRepository, JobRepository, LoggingRepository],
    });
    ctx.getMock(EventRepository).emit.mockResolvedValue();
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
    const duplicates = new DuplicateDecisionService(
      logger,
      decisions,
      access,
      unused,
      unused,
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
      state: {},
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
      db.selectFrom('asset').select(['id', 'status', 'duplicateId']).where('id', 'in', members).execute();
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

  it('restores and relinks all three members through the actual claimed BulkOperationService', async () => {
    const f = await fixture();
    const workerAuth = await f.worker.authFor(f.user.id);
    expect(await db.selectFrom('session').select('id').where('id', '=', workerAuth!.session!.id).execute()).toEqual([]);
    await f.worker.run(f.claimed.operation, f.claimed.claimToken);
    expect(
      (await f.state()).every((a) => a.status === AssetStatus.Active && a.duplicateId === f.group.duplicateId),
    ).toBe(true);
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
    await f.restore();
    await expect(f.trash.restoreDuplicateUndo(f.ownerAuth, { ids: [] }, f.claim)).resolves.toEqual({ count: 0 });
    f.claim.claimToken = randomUUID();
    await expect(f.trash.restoreDuplicateUndo(f.ownerAuth, { ids: [] }, f.claim)).rejects.toThrow(
      'duplicate_undo_claim_required',
    );
  });

  it('rolls back restoration and local effects when the claim expires during a real stream-counter wait', async () => {
    const f = await fixture();
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
    expect((await f.state()).find((a) => a.id === f.members[2])?.status).toBe(AssetStatus.Trashed);
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
  });
});
