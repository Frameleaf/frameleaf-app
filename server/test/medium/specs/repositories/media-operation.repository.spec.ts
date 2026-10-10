import { Kysely, sql } from 'kysely';
import {
  AssetVisibility,
  DatabaseLock,
  JobName,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { EditOperationTracker } from 'src/utils/edit-operation-tracker.js';
import { EditOperationEdit, JOB_QUEUE_CLAIMANT, editOperationCreate } from 'src/utils/edit-operation.js';
import { resetMediaOperationsAfterRestore } from 'src/utils/media-operation-restore.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  // The medium factory builds it for real, but its typed dependency list is BaseService's, which
  // does not name this repository.
  return { ctx, sut: ctx.get(MediaOperationRepository as never) as MediaOperationRepository };
};

const LEASE_MS = 60_000;

/**
 * The unreleased-remote query is deliberately global — it is the cleanup pass's view of the whole
 * instance — so a test that shares the database with its neighbours must look for its own row
 * rather than counting rows.
 */
const unreleasedIds = async (sut: MediaOperationRepository, id: string) =>
  (await sut.getUnreleasedRemoteOperations(1000)).filter((operation) => operation.id === id);

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/**
 * Claiming picks the oldest queued job on the instance, so a row left behind by one test would
 * be handed to the next one. Each test starts from an empty table; checkpoints cascade away.
 */
afterEach(async () => {
  await defaultDatabase.deleteFrom('media_operation').execute();
});

describe(MediaOperationRepository.name, () => {
  const newOperation = async (sut: MediaOperationRepository, ownerId: string, overrides = {}) =>
    sut.create({
      ownerId,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Local,
      label: 'Summer in the Rockies',
      snapshot: { engineDigest: 'engine-1', outputProfile: 'rec709' },
      settings: { resolution: '3840×2160' },
      ...overrides,
    });

  it('strict heartbeat refuses cancellation while the live worker retains its token to acknowledge stop', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const operation = await newOperation(sut, user.id);
    const claim = await sut.claimNext({
      kinds: [MediaOperationKind.StudioExport],
      workerId: 'worker-a',
      leaseMs: LEASE_MS,
    });
    await sut.requestCancel(operation.id, user.id);
    await expect(sut.heartbeat(operation.id, claim!.claimToken, LEASE_MS, { requireActiveClaim: true })).resolves.toBe(
      false,
    );
    await expect(sut.acknowledgeCancel(operation.id, claim!.claimToken, { released: true })).resolves.toBe(true);
  });

  it('never revives an expired lease through heartbeat or a bulk checkpoint', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const operation = await newOperation(sut, user.id);
    const claim = await sut.claimNext({
      kinds: [MediaOperationKind.StudioExport],
      workerId: 'worker-a',
      leaseMs: LEASE_MS,
    });
    await defaultDatabase
      .updateTable('media_operation')
      .set({ claimExpiresAt: sql<Date>`clock_timestamp() - interval '1 second'` })
      .where('id', '=', operation.id)
      .execute();
    await expect(sut.heartbeat(operation.id, claim!.claimToken, LEASE_MS)).resolves.toBe(false);
    await expect(sut.heartbeat(operation.id, claim!.claimToken, LEASE_MS, { requireActiveClaim: true })).resolves.toBe(
      false,
    );
    await expect(
      sut.setBulkResult(operation.id, claim!.claimToken, {
        result: {},
        processedUnits: 1,
        totalUnits: 2,
        progress: 50,
        leaseMs: LEASE_MS,
      }),
    ).resolves.toBeUndefined();
  });

  describe('mergeStreamSignal (FL-96)', () => {
    it('merges the patch into the result as an object, and only on the expected negotiation round', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const stream = await newOperation(sut, user.id, { kind: MediaOperationKind.StudioPreviewStream });

      const first = await sut.mergeStreamSignal(stream.id, { negotiation: 1, offer: { sdp: 'v=0' } });
      expect(first?.result).toEqual({ negotiation: 1, offer: { sdp: 'v=0' } });

      const answered = await sut.mergeStreamSignal(stream.id, { answer: { sdp: 'v=1' } }, { negotiation: 1 });
      expect(answered?.result).toEqual({ negotiation: 1, offer: { sdp: 'v=0' }, answer: { sdp: 'v=1' } });

      await expect(
        sut.mergeStreamSignal(stream.id, { answer: { sdp: 'late' } }, { negotiation: 0 }),
      ).resolves.toBeUndefined();
      const stored = await ctx.database
        .selectFrom('media_operation')
        .select(sql<string>`jsonb_typeof("result")`.as('type'))
        .where('id', '=', stream.id)
        .executeTakeFirstOrThrow();
      expect(stored.type).toBe('object');
    });
  });

  describe('restored execution state', () => {
    const restoredClaim = {
      status: MediaOperationStatus.Rendering,
      claimToken: '0195e2a0-0000-7000-8000-0000000000bb',
      claimedBy: 'worker-from-backup',
      claimExpiresAt: new Date(Date.now() + LEASE_MS),
      heartbeatAt: new Date(),
      attemptStartedAt: new Date(),
      attempt: 1,
    };

    it('revokes safe work once and keeps completed checkpoints and publication results', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await sut.claimNext({
        kinds: [MediaOperationKind.StudioExport],
        workerId: 'worker-a',
        leaseMs: LEASE_MS,
      });
      await sut.upsertCheckpoint(operation.id, claim!.claimToken, {
        operationId: operation.id,
        sequence: 0,
        chunkKey: 'kept-chunk',
        inputDigest: 'source',
        historyDigest: 'history',
        configDigest: 'config',
        timebase: '1/30',
        startTicks: '0',
        endTicks: '30',
      });
      await sut.completeCheckpoint(operation.id, claim!.claimToken, {
        sequence: 0,
        chunkKey: 'kept-chunk',
        outputPath: '/backups/render/kept-chunk',
        outputChecksum: Buffer.from('abcd', 'hex'),
        sizeInBytes: 4,
      });
      await ctx.database
        .updateTable('media_operation')
        .set({ result: { committedChunks: 1 } })
        .where('id', '=', operation.id)
        .execute();
      const checkpoints = await ctx.database
        .selectFrom('media_operation_checkpoint')
        .selectAll()
        .where('operationId', '=', operation.id)
        .execute();

      await ctx.database.transaction().execute(resetMediaOperationsAfterRestore);
      const first = await sut.getForOwner(operation.id, user.id);
      expect(first).toMatchObject({
        status: MediaOperationStatus.Queued,
        autoRetries: 1,
        claimToken: null,
        claimedBy: null,
        claimExpiresAt: null,
        heartbeatAt: null,
        attemptStartedAt: null,
        result: { committedChunks: 1 },
        snapshot: operation.snapshot,
        destination: operation.destination,
        errorCode: 'restore_retry',
      });
      expect(first!.retryAt!.getTime() - Date.now()).toBeGreaterThan(20_000);
      await expect(sut.complete(operation.id, claim!.claimToken, { resultAssetId: null })).resolves.toBe(false);
      await expect(
        ctx.database
          .selectFrom('media_operation_checkpoint')
          .selectAll()
          .where('operationId', '=', operation.id)
          .execute(),
      ).resolves.toEqual(checkpoints);

      // Repeating restore cleanup in the same restored database does not spend another retry.
      await ctx.database.transaction().execute(resetMediaOperationsAfterRestore);
      expect(await sut.getForOwner(operation.id, user.id)).toMatchObject({ autoRetries: 1, retryAt: first!.retryAt });
    });

    it('reports an interrupted attempt whose one automatic retry was already used', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      await ctx.database
        .updateTable('media_operation')
        .set({ ...restoredClaim, autoRetries: 1 })
        .where('id', '=', operation.id)
        .execute();

      await ctx.database.transaction().execute(resetMediaOperationsAfterRestore);

      expect(await sut.getForOwner(operation.id, user.id)).toMatchObject({
        status: MediaOperationStatus.Failed,
        autoRetries: 1,
        claimToken: null,
        retryAt: null,
        errorCode: 'restore_needs_attention',
        finishedAt: expect.any(Date),
      });
    });

    it('preserves remote identity and leaves external effects for attention without an invented acknowledgement', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id, {
        destination: MediaOperationDestination.FrameleafCloud,
        destinationDetail: 'chosen-endpoint',
        remoteJobId: 'paid-remote-job',
      });
      await ctx.database
        .updateTable('media_operation')
        .set({ ...restoredClaim, cancelRequestedAt: new Date() })
        .where('id', '=', operation.id)
        .execute();
      const queuedUnsafe = await newOperation(sut, user.id, { kind: MediaOperationKind.PhysicalDeduplication });

      await ctx.database.transaction().execute(resetMediaOperationsAfterRestore);

      expect(await sut.getForOwner(operation.id, user.id)).toMatchObject({
        status: MediaOperationStatus.Failed,
        destination: MediaOperationDestination.FrameleafCloud,
        destinationDetail: 'chosen-endpoint',
        remoteJobId: 'paid-remote-job',
        cancelAcknowledgedAt: null,
        remoteReleasedAt: null,
        autoRetries: 0,
        claimToken: null,
        errorCode: 'restore_needs_attention',
      });
      expect(await sut.getForOwner(queuedUnsafe.id, user.id)).toMatchObject({
        status: MediaOperationStatus.Failed,
        autoRetries: 0,
        errorCode: 'restore_needs_attention',
      });
    });

    it('honours pauses and cancellation, and leaves untouched safe queued work eligible', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const paused = await newOperation(sut, user.id);
      const cancelled = await newOperation(sut, user.id);
      const queued = await newOperation(sut, user.id);
      await ctx.database
        .updateTable('media_operation')
        .set({ ...restoredClaim, pauseRequestedAt: new Date() })
        .where('id', '=', paused.id)
        .execute();
      await ctx.database
        .updateTable('media_operation')
        .set({ ...restoredClaim, cancelRequestedAt: new Date() })
        .where('id', '=', cancelled.id)
        .execute();

      await ctx.database.transaction().execute(resetMediaOperationsAfterRestore);

      expect(await sut.getForOwner(paused.id, user.id)).toMatchObject({
        status: MediaOperationStatus.Paused,
        autoRetries: 0,
        claimToken: null,
        retryAt: null,
      });
      expect(await sut.getForOwner(cancelled.id, user.id)).toMatchObject({
        status: MediaOperationStatus.Cancelled,
        autoRetries: 0,
        claimToken: null,
        cancelAcknowledgedAt: null,
        retryAt: null,
      });
      expect(await sut.getForOwner(queued.id, user.id)).toMatchObject({
        status: MediaOperationStatus.Queued,
        autoRetries: 0,
        retryAt: null,
      });
    });

    it('retains terminal facts while clearing historical lease fields', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const finishedAt = new Date('2026-10-01T12:00:00Z');
      await ctx.database
        .updateTable('media_operation')
        .set({
          status: MediaOperationStatus.Completed,
          finishedAt,
          progress: 100,
          heartbeatAt: new Date(),
          attemptStartedAt: new Date(),
          result: { output: 'committed' },
        })
        .where('id', '=', operation.id)
        .execute();

      await ctx.database.transaction().execute(resetMediaOperationsAfterRestore);

      expect(await sut.getForOwner(operation.id, user.id)).toMatchObject({
        status: MediaOperationStatus.Completed,
        finishedAt,
        progress: 100,
        autoRetries: 0,
        result: { output: 'committed' },
        heartbeatAt: null,
        attemptStartedAt: null,
      });
    });
  });

  describe('claimNext', () => {
    it('hands the same job to exactly one worker', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await newOperation(sut, user.id);

      const [first, second] = await Promise.all([
        sut.claimNext({ kinds: [MediaOperationKind.StudioExport], workerId: 'worker-a', leaseMs: LEASE_MS }),
        sut.claimNext({ kinds: [MediaOperationKind.StudioExport], workerId: 'worker-b', leaseMs: LEASE_MS }),
      ]);

      const claims = [first, second].filter(Boolean);
      expect(claims).toHaveLength(1);
      expect(claims[0]!.operation.status).toBe(MediaOperationStatus.Preparing);
      expect(claims[0]!.operation.attempt).toBe(1);
    });

    it('does not claim a job whose cancellation was already requested', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      await sut.requestCancel(operation.id, user.id);

      await expect(
        sut.claimNext({ kinds: [MediaOperationKind.StudioExport], workerId: 'worker-a', leaseMs: LEASE_MS }),
      ).resolves.toBeUndefined();
    });
  });

  describe('stale claims', () => {
    it('rejects progress, validation and completion from a token that is no longer current', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await sut.claimNext({
        kinds: [MediaOperationKind.StudioExport],
        workerId: 'worker-a',
        leaseMs: LEASE_MS,
      });
      const stale = claim!.claimToken;

      // The lease is taken away, as recovery does after a worker goes silent.
      await ctx.database
        .updateTable('media_operation')
        .set({ status: MediaOperationStatus.Queued, claimToken: null, claimedBy: null, claimExpiresAt: null })
        .where('id', '=', operation.id)
        .execute();
      const replacement = await sut.claimNext({
        kinds: [MediaOperationKind.StudioExport],
        workerId: 'worker-b',
        leaseMs: LEASE_MS,
      });

      await expect(
        sut.reportProgress(operation.id, stale, {
          status: MediaOperationStatus.Rendering,
          processedUnits: 900,
          totalUnits: 1000,
          progress: 90,
        }),
      ).resolves.toBe(false);
      await expect(sut.beginValidation(operation.id, stale)).resolves.toBe(false);
      await expect(sut.complete(operation.id, stale, { resultAssetId: null })).resolves.toBe(false);
      await expect(sut.fail(operation.id, stale, { error: 'late failure', errorCode: 'late' })).resolves.toBe(false);

      // The replacement's own claim still works.
      await expect(sut.beginValidation(operation.id, replacement!.claimToken)).resolves.toBe(true);
    });

    it('does not let a stale worker publish over a finished job', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await sut.claimNext({
        kinds: [MediaOperationKind.StudioExport],
        workerId: 'worker-a',
        leaseMs: LEASE_MS,
      });

      await sut.beginValidation(operation.id, claim!.claimToken);
      await expect(sut.complete(operation.id, claim!.claimToken, { resultAssetId: null })).resolves.toBe(true);

      // The same token, replayed after the job settled, changes nothing.
      await expect(sut.complete(operation.id, claim!.claimToken, { resultAssetId: null })).resolves.toBe(false);
      await expect(sut.fail(operation.id, claim!.claimToken, { error: 'x', errorCode: 'x' })).resolves.toBe(false);

      const after = await sut.getForOwner(operation.id, user.id);
      expect(after!.status).toBe(MediaOperationStatus.Completed);
      expect(after!.progress).toBe(100);
    });

    it('refuses to complete a job that never reached validation', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await sut.claimNext({
        kinds: [MediaOperationKind.StudioExport],
        workerId: 'worker-a',
        leaseMs: LEASE_MS,
      });

      await expect(sut.complete(operation.id, claim!.claimToken, { resultAssetId: null })).resolves.toBe(false);
    });
  });

  describe('automatic retry (FL-104)', () => {
    const claimExport = (sut: MediaOperationRepository) =>
      sut.claimNext({ kinds: [MediaOperationKind.StudioExport], workerId: 'worker-a', leaseMs: LEASE_MS });

    const releaseDelay = (ctx: { database: Kysely<DB> }, id: string) =>
      ctx.database
        .updateTable('media_operation')
        .set({ retryAt: new Date(Date.now() - 1000) })
        .where('id', '=', id)
        .execute();

    it('retries a failed job once, after the delay, and reports the second failure', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const first = await claimExport(sut);

      await expect(
        sut.fail(operation.id, first!.claimToken, { error: 'The encoder crashed', errorCode: 'encoder_crashed' }),
      ).resolves.toBe('retrying');

      const waiting = await sut.getForOwner(operation.id, user.id);
      expect(waiting).toMatchObject({
        status: MediaOperationStatus.Queued,
        autoRetries: 1,
        claimToken: null,
        errorCode: 'encoder_crashed',
        finishedAt: null,
      });
      expect(waiting!.retryAt).not.toBeNull();

      // Not before the delay has passed.
      await expect(claimExport(sut)).resolves.toBeUndefined();

      await releaseDelay(ctx, operation.id);
      const second = await claimExport(sut);
      expect(second!.operation).toMatchObject({ id: operation.id, attempt: 2, autoRetries: 1, retryAt: null });

      await expect(
        sut.fail(operation.id, second!.claimToken, { error: 'The encoder crashed again', errorCode: 'encoder_again' }),
      ).resolves.toBe('failed');
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Failed,
        autoRetries: 1,
        error: 'The encoder crashed again',
      });
    });

    it('clears the retried failure once the retry succeeds', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const first = await claimExport(sut);
      await sut.fail(operation.id, first!.claimToken, { error: 'gone', errorCode: 'worker_lost' });
      await releaseDelay(ctx, operation.id);
      const second = await claimExport(sut);

      await sut.beginValidation(operation.id, second!.claimToken);
      await expect(sut.complete(operation.id, second!.claimToken, { resultAssetId: null })).resolves.toBe(true);

      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Completed,
        error: null,
        errorCode: null,
        autoRetries: 1,
      });
    });

    it('never retries a job the owner asked to cancel', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await claimExport(sut);
      await sut.requestCancel(operation.id, user.id);

      await expect(sut.fail(operation.id, claim!.claimToken, { error: 'x', errorCode: 'x' })).resolves.toBe('failed');
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({ autoRetries: 0 });
    });

    it('requeues on purpose without using the automatic retry, keeping what was recorded', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id, { result: { succeeded: 3 } });
      const claim = await claimExport(sut);

      await expect(sut.requeue(operation.id, claim!.claimToken, { delayMs: 30_000 })).resolves.toBe(true);
      // The old claim is spent.
      await expect(sut.requeue(operation.id, claim!.claimToken, { delayMs: 30_000 })).resolves.toBe(false);

      const row = await sut.getForOwner(operation.id, user.id);
      expect(row).toMatchObject({ status: MediaOperationStatus.Queued, autoRetries: 0, result: { succeeded: 3 } });
      expect(row!.retryAt).not.toBeNull();
    });

    it('refuses a planned requeue once a cancel was requested', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await claimExport(sut);
      await sut.requestCancel(operation.id, user.id);

      await expect(sut.requeue(operation.id, claim!.claimToken, { delayMs: 0 })).resolves.toBe(false);
    });
  });

  describe('recoverExpiredClaims', () => {
    it('uses one retry for safe work regardless of maxAttempts and fails work that already retried', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const resumable = await newOperation(sut, user.id, { maxAttempts: 3 });
      const exhausted = await newOperation(sut, user.id, { maxAttempts: 1 });
      const retriedAlready = await newOperation(sut, user.id, { maxAttempts: 1 });

      for (const id of [resumable.id, exhausted.id, retriedAlready.id]) {
        await ctx.database
          .updateTable('media_operation')
          .set({
            status: MediaOperationStatus.Rendering,
            claimToken: '0195e2a0-0000-7000-8000-0000000000aa',
            claimedBy: 'worker-gone',
            claimExpiresAt: new Date(Date.now() - 60_000),
            attempt: 1,
            autoRetries: id === retriedAlready.id ? 1 : 0,
          })
          .where('id', '=', id)
          .execute();
      }

      const result = await sut.recoverExpiredClaims({
        errorCode: 'worker_lost',
        error: 'The worker stopped responding',
      });

      expect(result).toEqual({ requeued: 0, retried: 2, failed: 1, abandonedCancels: 0, paused: 0 });
      await expect(sut.getForOwner(resumable.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Queued,
        claimToken: null,
        autoRetries: 1,
        retryAt: expect.any(Date),
      });
      const retrying = await sut.getForOwner(exhausted.id, user.id);
      expect(retrying).toMatchObject({
        status: MediaOperationStatus.Queued,
        claimToken: null,
        autoRetries: 1,
        errorCode: 'worker_lost',
      });
      expect(retrying!.retryAt).not.toBeNull();
      await expect(sut.getForOwner(retriedAlready.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Failed,
        errorCode: 'worker_lost',
      });
    });

    it('settles a cancellation whose worker never came back, without claiming it was acknowledged', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id, {
        destination: MediaOperationDestination.FrameleafCloud,
        remoteJobId: 'cloud-3',
      });
      await sut.claimNext({ kinds: [MediaOperationKind.StudioExport], workerId: 'worker-a', leaseMs: LEASE_MS });
      await sut.requestCancel(operation.id, user.id);
      await ctx.database
        .updateTable('media_operation')
        .set({ claimExpiresAt: new Date(Date.now() - 60_000) })
        .where('id', '=', operation.id)
        .execute();

      const result = await sut.recoverExpiredClaims({ errorCode: 'worker_lost', error: 'gone' });

      expect(result.abandonedCancels).toBe(1);
      const after = await sut.getForOwner(operation.id, user.id);
      expect(after!.status).toBe(MediaOperationStatus.Cancelled);
      // Nobody confirmed the remote stopped, so the obligation survives.
      expect(after!.cancelAcknowledgedAt).toBeNull();
      await expect(unreleasedIds(sut, operation.id)).resolves.toHaveLength(1);
    });
  });

  describe('pause and resume (FL-104)', () => {
    const claimExport = (sut: MediaOperationRepository) =>
      sut.claimNext({ kinds: [MediaOperationKind.StudioExport], workerId: 'worker-a', leaseMs: LEASE_MS });
    const pausable = [MediaOperationKind.StudioExport, MediaOperationKind.Bulk, MediaOperationKind.Restoration];

    it('holds a queued job at once, and no worker claims it until it is resumed', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);

      const paused = await sut.requestPause(operation.id, user.id, pausable);
      expect(paused).toMatchObject({ status: MediaOperationStatus.Paused });
      expect(paused!.pauseRequestedAt).not.toBeNull();
      await expect(claimExport(sut)).resolves.toBeUndefined();

      await expect(sut.resume(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Queued,
        pauseRequestedAt: null,
      });
      await expect(claimExport(sut)).resolves.toMatchObject({ operation: { id: operation.id } });
    });

    it('lets a claimed job run to its checkpoint, then takes the claim back without counting an attempt', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id, { result: { succeeded: 3 } });
      const claim = await claimExport(sut);

      const requested = await sut.requestPause(operation.id, user.id, pausable);
      expect(requested).toMatchObject({ status: MediaOperationStatus.Preparing, claimToken: claim!.claimToken });
      expect(requested!.pauseRequestedAt).not.toBeNull();

      // The worker keeps its lease and learns of the pause from its next write.
      await expect(sut.heartbeat(operation.id, claim!.claimToken, LEASE_MS)).resolves.toBe(true);
      await expect(sut.settlePause(operation.id, '0195e2a0-0000-7000-8000-0000000000ff')).resolves.toBe(false);
      await expect(sut.settlePause(operation.id, claim!.claimToken)).resolves.toBe(true);

      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Paused,
        claimToken: null,
        attempt: 0,
        result: { succeeded: 3 },
      });
      // The handed-back claim writes nothing any more.
      await expect(sut.heartbeat(operation.id, claim!.claimToken, LEASE_MS)).resolves.toBe(false);
    });

    it('withdraws a pause the worker has not reached, so settling it changes nothing', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await claimExport(sut);
      await sut.requestPause(operation.id, user.id, pausable);

      await expect(sut.resume(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Preparing,
        pauseRequestedAt: null,
      });
      await expect(sut.settlePause(operation.id, claim!.claimToken)).resolves.toBe(false);
    });

    it('refuses kinds that cannot pause, and jobs that are finishing or finished', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const preview = await newOperation(sut, user.id, { kind: MediaOperationKind.StudioPreview });
      const validating = await newOperation(sut, user.id);
      await ctx.database
        .updateTable('media_operation')
        .set({ status: MediaOperationStatus.Validating })
        .where('id', '=', validating.id)
        .execute();

      await expect(sut.requestPause(preview.id, user.id, pausable)).resolves.toBeUndefined();
      await expect(sut.requestPause(validating.id, user.id, pausable)).resolves.toBeUndefined();
    });

    it('refuses another account’s job', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);

      await expect(sut.requestPause(operation.id, other.id, pausable)).resolves.toBeUndefined();
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Queued,
        pauseRequestedAt: null,
      });
    });

    it('cancels a paused job outright, since no worker holds it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      await sut.requestPause(operation.id, user.id, pausable);

      const cancelled = await sut.requestCancel(operation.id, user.id);

      expect(cancelled).toMatchObject({ status: MediaOperationStatus.Cancelled, pauseRequestedAt: null });
      expect(cancelled!.finishedAt).not.toBeNull();
    });

    it('holds a failed job’s automatic retry for the owner when a pause was asked for', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await claimExport(sut);
      await sut.requestPause(operation.id, user.id, pausable);

      await expect(sut.fail(operation.id, claim!.claimToken, { error: 'x', errorCode: 'x' })).resolves.toBe('retrying');
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Paused,
        autoRetries: 1,
        claimToken: null,
      });
    });

    it('pauses, rather than requeues, a job whose worker vanished after a pause was asked for', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      await claimExport(sut);
      await sut.requestPause(operation.id, user.id, pausable);
      await ctx.database
        .updateTable('media_operation')
        .set({ claimExpiresAt: new Date(Date.now() - 60_000) })
        .where('id', '=', operation.id)
        .execute();

      const result = await sut.recoverExpiredClaims({ errorCode: 'worker_lost', error: 'gone' });

      expect(result).toMatchObject({ paused: 1, requeued: 0, retried: 0, failed: 0 });
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Paused,
        claimToken: null,
      });
    });

    it('never settles a pause once the job is validating its output', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await claimExport(sut);
      await sut.requestPause(operation.id, user.id, pausable);
      await sut.beginValidation(operation.id, claim!.claimToken);

      await expect(sut.settlePause(operation.id, claim!.claimToken)).resolves.toBe(false);
      await expect(sut.complete(operation.id, claim!.claimToken, { resultAssetId: null })).resolves.toBe(true);
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Completed,
        pauseRequestedAt: null,
      });
    });

    it('never touches a job that is already paused during recovery', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      await sut.requestPause(operation.id, user.id, pausable);

      const result = await sut.recoverExpiredClaims({ errorCode: 'worker_lost', error: 'gone' });

      expect(result).toEqual({ requeued: 0, retried: 0, failed: 0, abandonedCancels: 0, paused: 0 });
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Paused,
      });
    });

    it('tells a bulk runner about the pause in the same write that records its batch', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id, { kind: MediaOperationKind.Bulk, totalUnits: '3' });
      const claim = await sut.claimNext({ kinds: [MediaOperationKind.Bulk], workerId: 'worker-a', leaseMs: LEASE_MS });
      await sut.requestPause(operation.id, user.id, pausable);

      const written = await sut.setBulkResult(operation.id, claim!.claimToken, {
        result: { succeeded: 1 },
        processedUnits: 1,
        totalUnits: 3,
        progress: 33,
        leaseMs: LEASE_MS,
      });

      expect(written!.pauseRequestedAt).not.toBeNull();
      expect(written!.cancelRequestedAt).toBeNull();
    });
  });

  describe('cancellation', () => {
    it('cancels a queued job outright', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);

      const cancelled = await sut.requestCancel(operation.id, user.id);

      expect(cancelled!.status).toBe(MediaOperationStatus.Cancelled);
      expect(cancelled!.cancelAcknowledgedAt).not.toBeNull();
    });

    it('holds a claimed job at cancelling until the remote acknowledges', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id, {
        destination: MediaOperationDestination.FrameleafCloud,
        remoteJobId: 'cloud-1',
      });
      const claim = await sut.claimNext({
        kinds: [MediaOperationKind.StudioExport],
        workerId: 'worker-a',
        leaseMs: LEASE_MS,
      });

      const cancelling = await sut.requestCancel(operation.id, user.id);
      expect(cancelling!.status).toBe(MediaOperationStatus.Cancelling);
      expect(cancelling!.cancelAcknowledgedAt).toBeNull();

      // Until the acknowledgement, the remote job is still an open obligation.
      await expect(unreleasedIds(sut, operation.id)).resolves.toHaveLength(1);

      await expect(sut.acknowledgeCancel(operation.id, claim!.claimToken, { released: true })).resolves.toBe(true);
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Cancelled,
      });
      await expect(unreleasedIds(sut, operation.id)).resolves.toHaveLength(0);
    });

    it('keeps an unacknowledged remote job visible after the owner clears it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id, {
        destination: MediaOperationDestination.FrameleafCloud,
        remoteJobId: 'cloud-2',
      });
      const claim = await sut.claimNext({
        kinds: [MediaOperationKind.StudioExport],
        workerId: 'worker-a',
        leaseMs: LEASE_MS,
      });
      await sut.requestCancel(operation.id, user.id);
      await sut.acknowledgeCancel(operation.id, claim!.claimToken, { released: false });

      await expect(sut.dismiss(operation.id, user.id)).resolves.toBe(true);
      const { items } = await sut.list({ ownerId: user.id, take: 50, skip: 0 });
      expect(items.map((item) => item.id)).not.toContain(operation.id);
      await expect(unreleasedIds(sut, operation.id)).resolves.toHaveLength(1);
    });

    it('refuses to cancel another account’s job', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);

      await expect(sut.requestCancel(operation.id, other.id)).resolves.toBeUndefined();
      await expect(sut.getForOwner(operation.id, other.id)).resolves.toBeUndefined();
    });
  });

  describe('revocation lookup (FL-90)', () => {
    it("lists a project's unfinished jobs of the named kinds, optionally for one account", async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: reviewer } = await ctx.newUser();
      const exported = await newOperation(sut, owner.id, { projectId: 'project-1' });
      const previewed = await newOperation(sut, reviewer.id, {
        projectId: 'project-1',
        kind: MediaOperationKind.StudioPreview,
      });
      const finished = await newOperation(sut, owner.id, { projectId: 'project-1' });
      await sut.requestCancel(finished.id, owner.id);
      await newOperation(sut, owner.id, { projectId: 'project-2' });
      await newOperation(sut, owner.id, { projectId: 'project-1', kind: MediaOperationKind.Bulk });

      const kinds = [MediaOperationKind.StudioExport, MediaOperationKind.StudioPreview];
      const all = await sut.listUnfinishedForProjects(['project-1'], kinds);
      expect(all.map((row) => row.id).toSorted()).toEqual([exported.id, previewed.id].toSorted());
      expect(await sut.listUnfinishedForProjects(['project-1'], kinds, reviewer.id)).toEqual([
        expect.objectContaining({ id: previewed.id, ownerId: reviewer.id }),
      ]);
      expect(await sut.listUnfinishedForProjects([], kinds)).toEqual([]);
    });
  });

  describe('checkpoints', () => {
    const chunk = (sequence: number) => ({
      sequence,
      chunkKey: `chunk-${sequence}`,
      inputDigest: `input-${sequence}`,
      historyDigest: `history-${sequence}`,
      configDigest: 'config',
      seed: 'seed',
      timebase: '30000/1001',
      startTicks: String(sequence * 1000),
      endTicks: String((sequence + 1) * 1000),
    });

    it('only lets the current claim record and complete a chunk', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await sut.claimNext({
        kinds: [MediaOperationKind.StudioExport],
        workerId: 'worker-a',
        leaseMs: LEASE_MS,
      });

      await expect(sut.upsertCheckpoint(operation.id, claim!.claimToken, chunk(0) as never)).resolves.toBe(true);
      await expect(
        sut.upsertCheckpoint(operation.id, '0195e2a0-0000-7000-8000-0000000000bb', chunk(1) as never),
      ).resolves.toBe(false);

      await expect(
        sut.completeCheckpoint(operation.id, claim!.claimToken, {
          sequence: 0,
          chunkKey: 'chunk-0',
          outputPath: '/chunks/0.mkv',
          outputChecksum: Buffer.from('checksum'),
          sizeInBytes: 2048,
        }),
      ).resolves.toBe(true);

      // A chunk key that no longer matches the row is not the work this worker did.
      await expect(
        sut.completeCheckpoint(operation.id, claim!.claimToken, {
          sequence: 0,
          chunkKey: 'chunk-from-another-render',
          outputPath: '/chunks/0.mkv',
          outputChecksum: Buffer.from('checksum'),
          sizeInBytes: 2048,
        }),
      ).resolves.toBe(false);

      const checkpoints = await sut.getCheckpoints(operation.id);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].state).toBe('complete');
    });

    it.each(['expired', 'paused', 'cancelled'] as const)(
      'guards verified artifact transitions atomically for a %s lease while retaining legacy defaults',
      async (condition) => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const operation = await newOperation(sut, user.id);
        const claim = await sut.claimNext({
          kinds: [MediaOperationKind.StudioExport],
          workerId: 'worker-a',
          leaseMs: LEASE_MS,
        });
        await sut.upsertCheckpoint(operation.id, claim!.claimToken, chunk(0) as never);
        await defaultDatabase
          .updateTable('media_operation')
          .set(
            condition === 'expired'
              ? { claimExpiresAt: new Date(0) }
              : condition === 'paused'
                ? { pauseRequestedAt: new Date() }
                : { cancelRequestedAt: new Date() },
          )
          .where('id', '=', operation.id)
          .execute();
        const artifact = {
          sequence: 0,
          chunkKey: 'chunk-0',
          outputPath: '/server/staging/artifact',
          outputChecksum: Buffer.alloc(32),
          sizeInBytes: 2048,
        };
        await expect(sut.completeCheckpoint(operation.id, claim!.claimToken, artifact, true)).resolves.toBe(false);
        expect((await sut.getCheckpoints(operation.id))[0].outputPath).toBeNull();
        await expect(sut.beginValidation(operation.id, claim!.claimToken, true)).resolves.toBe(false);
        await expect(sut.completeCheckpoint(operation.id, claim!.claimToken, artifact)).resolves.toBe(true);
        await expect(sut.beginValidation(operation.id, claim!.claimToken)).resolves.toBe(true);
        await expect(
          sut.complete(operation.id, claim!.claimToken, { resultAssetId: null }, undefined, true),
        ).resolves.toBe(false);
        await expect(sut.complete(operation.id, claim!.claimToken, { resultAssetId: null })).resolves.toBe(true);
      },
    );

    it('allows one durable verified artifact winner and refuses overwriting complete bytes', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await sut.claimNext({
        kinds: [MediaOperationKind.StudioExport],
        workerId: 'worker-a',
        leaseMs: LEASE_MS,
      });
      await sut.upsertCheckpoint(operation.id, claim!.claimToken, chunk(0) as never);
      const artifact = {
        sequence: 0,
        chunkKey: 'chunk-0',
        outputPath: '/server/staging/first',
        outputChecksum: Buffer.alloc(32),
        sizeInBytes: 2048,
      };
      const results = await Promise.all([
        sut.completeCheckpoint(operation.id, claim!.claimToken, artifact, true),
        sut.completeCheckpoint(
          operation.id,
          claim!.claimToken,
          { ...artifact, outputPath: '/server/staging/second' },
          true,
        ),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = (await sut.getCheckpoints(operation.id))[0];
      expect(winner.outputPath).toBe(results[0] ? artifact.outputPath : '/server/staging/second');
    });

    it('re-planning a chunk clears its stored output', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await sut.claimNext({
        kinds: [MediaOperationKind.StudioExport],
        workerId: 'worker-a',
        leaseMs: LEASE_MS,
      });

      await sut.upsertCheckpoint(operation.id, claim!.claimToken, chunk(0) as never);
      await sut.completeCheckpoint(operation.id, claim!.claimToken, {
        sequence: 0,
        chunkKey: 'chunk-0',
        outputPath: '/chunks/0.mkv',
        outputChecksum: Buffer.from('checksum'),
        sizeInBytes: 2048,
      });

      await sut.upsertCheckpoint(operation.id, claim!.claimToken, {
        ...chunk(0),
        chunkKey: 'chunk-0-after-an-edit',
        historyDigest: 'history-after-an-edit',
      } as never);

      const [checkpoint] = await sut.getCheckpoints(operation.id);
      expect(checkpoint.state).toBe('pending');
      expect(checkpoint.outputPath).toBeNull();
      expect(checkpoint.attempt).toBe(1);
    });
  });

  describe('list', () => {
    it('never returns another account’s jobs', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      await newOperation(sut, user.id);
      await newOperation(sut, other.id);

      const mine = await sut.list({ ownerId: user.id, take: 50, skip: 0 });
      expect(mine.total).toBe(1);
      expect(mine.items.every((item) => item.ownerId === user.id)).toBe(true);
    });
  });

  describe('bulk operations (FL-32)', () => {
    const newBulk = (sut: MediaOperationRepository, ownerId: string, assetIds: string[], requestId?: string) =>
      newOperation(sut, ownerId, {
        kind: MediaOperationKind.Bulk,
        label: 'favorite',
        snapshot: { action: 'favorite', assetIds, payload: {}, truncated: false, requestId: requestId ?? null },
        settings: {},
        totalUnits: String(assetIds.length),
      });

    it('records the result while cancelling and reports the cancel in the same write', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await newBulk(sut, user.id, ['a', 'b']);
      const claim = await sut.claimNext({ kinds: [MediaOperationKind.Bulk], workerId: 'bulk-1', leaseMs: LEASE_MS });
      await sut.requestCancel(claim!.operation.id, user.id);

      const written = await sut.setBulkResult(claim!.operation.id, claim!.claimToken, {
        result: { requested: 2, succeeded: 1 },
        processedUnits: 1,
        totalUnits: 2,
        progress: 50,
        leaseMs: LEASE_MS,
      });

      expect(written?.status).toBe(MediaOperationStatus.Cancelling);
      expect(written?.cancelRequestedAt).not.toBeNull();
      const row = await sut.getForOwner(claim!.operation.id, user.id);
      expect(row?.result).toEqual({ requested: 2, succeeded: 1 });
      expect(String(row?.processedUnits)).toBe('1');
    });

    it('refuses a result from a stale claim', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newBulk(sut, user.id, ['a']);
      await sut.claimNext({ kinds: [MediaOperationKind.Bulk], workerId: 'bulk-1', leaseMs: LEASE_MS });

      const written = await sut.setBulkResult(operation.id, '00000000-0000-4000-8000-000000000000', {
        result: {},
        processedUnits: 1,
        totalUnits: 1,
        progress: 100,
        leaseMs: LEASE_MS,
      });

      expect(written).toBeUndefined();
    });

    it('finds a submission by its request key, for this owner only', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const requestId = '6f1c1b0e-8d7a-4c2e-9b1a-0d3e5f7a9b2c';
      const operation = await newBulk(sut, user.id, ['a'], requestId);

      await expect(sut.getBulkByRequestId(user.id, requestId)).resolves.toEqual(
        expect.objectContaining({ id: operation.id }),
      );
      await expect(sut.getBulkByRequestId(other.id, requestId)).resolves.toBeUndefined();
    });

    it('leaves the frozen ids and recorded refusals out of the list', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await newBulk(sut, user.id, ['a', 'b']);

      const { items } = await sut.list({ ownerId: user.id, take: 10, skip: 0 });

      expect(items[0].snapshot).toEqual({ action: 'favorite', payload: {}, truncated: false, requestId: null });
    });

    it('keeps the retry ids and shift starting dates out of the list, and the retry count in', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newBulk(sut, user.id, ['a', 'b']);
      await ctx.database
        .updateTable('media_operation')
        .set({
          result: {
            requested: 2,
            succeeded: 1,
            items: [],
            retry: { ids: ['b'], total: 1, processed: 0, inFlight: null },
            shiftFrom: { b: '2026-01-01T10:00:00.000Z' },
          },
        })
        .where('id', '=', operation.id)
        .execute();

      const { items } = await sut.list({ ownerId: user.id, take: 10, skip: 0 });

      expect(items[0].result).toEqual({
        requested: 2,
        succeeded: 1,
        retry: { total: 1, processed: 0, inFlight: null },
      });
    });

    it('reads the capture dates of the owner’s assets only', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset: dated } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: dated.id, dateTimeOriginal: new Date('2026-01-01T10:00:00.000Z') });
      const { asset: undated } = await ctx.newAsset({ ownerId: user.id });
      const { asset: theirs } = await ctx.newAsset({ ownerId: other.id });

      const dates = await sut.getDateTimeOriginals(user.id, [dated.id, undated.id, theirs.id]);

      expect(dates.get(dated.id)?.toISOString()).toBe('2026-01-01T10:00:00.000Z');
      expect(dates.has(undated.id)).toBe(true);
      expect(dates.get(undated.id)).toBeNull();
      expect(dates.has(theirs.id)).toBe(false);
    });

    it('counts only the owner’s Locked items', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: timeline } = await ctx.newAsset({ ownerId: user.id });
      const { asset: theirs } = await ctx.newAsset({ ownerId: other.id, visibility: AssetVisibility.Locked });

      await expect(sut.countLockedAssets(user.id, [locked.id, timeline.id, theirs.id])).resolves.toBe(1);
      await expect(sut.countLockedAssets(user.id, [])).resolves.toBe(0);
    });

    it('recovers every kind in one pass, whichever worker held the claim (FL-104)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await newBulk(sut, user.id, ['a']);
      await newOperation(sut, user.id);
      await sut.claimNext({ kinds: [MediaOperationKind.Bulk], workerId: 'bulk-1', leaseMs: 1 });
      await sut.claimNext({ kinds: [MediaOperationKind.StudioExport], workerId: 'render-1', leaseMs: 1 });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const recovered = await sut.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'gone' });

      // Other tests' rows may share the database, so only this owner's two are counted on.
      expect(recovered.retried).toBeGreaterThanOrEqual(1);
      expect(recovered.failed).toBeGreaterThanOrEqual(1);
      const { items } = await sut.list({ ownerId: user.id, take: 10, skip: 0 });
      const byKind = Object.fromEntries(items.map((item) => [item.kind, item.status]));
      expect(byKind[MediaOperationKind.Bulk]).toBe(MediaOperationStatus.Failed);
      expect(byKind[MediaOperationKind.StudioExport]).toBe(MediaOperationStatus.Queued);
    });
  });

  describe('physical deduplication plans (FL-73)', () => {
    const plan = (fingerprint: string) => ({
      kind: MediaOperationKind.PhysicalDeduplication,
      label: 'Physical deduplication PD-ABABABAB (1 copy)',
      snapshot: {
        version: 1,
        planId: 'PD-ABABABAB',
        fingerprint,
        estimatedBytes: 10,
        items: [{ assetId: 'copy-1', originalPath: '/upload/private/copy-1.jpg' }],
        retained: [{ assetId: 'master-1', originalPath: '/upload/private/master-1.jpg' }],
        excludedRetainedAssetIds: ['master-2'],
      },
      settings: {},
      result: {
        items: [{ id: 'copy-1', state: 'applied', message: '/upload/private/copy-1.jpg' }],
        inFlight: 'copy-1',
        summary: { applied: 1, alreadyApplied: 0, skipped: 0, failed: 0, reclaimedBytes: 10 },
      },
    });

    it("lists every administrator's plans newest first, without the copies they name", async () => {
      const { ctx, sut } = setup();
      const { user: first } = await ctx.newUser();
      const { user: second } = await ctx.newUser();
      await newOperation(sut, first.id, plan('a'.repeat(64)));
      await newOperation(sut, second.id, plan('b'.repeat(64)));
      await newOperation(sut, first.id);

      const rows = await sut.listRecentOfKind(MediaOperationKind.PhysicalDeduplication, 10);

      expect(rows.map((row) => (row.snapshot as Record<string, unknown>).fingerprint)).toEqual([
        'b'.repeat(64),
        'a'.repeat(64),
      ]);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('/upload/private');
      expect(serialized).not.toContain('master-2');
      expect(rows[0].result).toEqual({
        summary: { applied: 1, alreadyApplied: 0, skipped: 0, failed: 0, reclaimedBytes: 10 },
      });
    });

    it('finds an unfinished plan whoever applied it, and none once it finished', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id, plan('c'.repeat(64)));

      await expect(sut.getActiveOfKind(MediaOperationKind.PhysicalDeduplication)).resolves.toEqual({
        id: operation.id,
        fingerprint: 'c'.repeat(64),
      });

      await sut.requestCancel(operation.id, user.id);
      await expect(sut.getActiveOfKind(MediaOperationKind.PhysicalDeduplication)).resolves.toBeUndefined();
    });

    it('starts only one of two plans applied at the same moment', async () => {
      const { ctx, sut } = setup();
      const { user: first } = await ctx.newUser();
      const { user: second } = await ctx.newUser();
      const values = (ownerId: string, fingerprint: string) => ({
        ownerId,
        destination: MediaOperationDestination.Local,
        ...plan(fingerprint),
      });

      const outcomes = await Promise.all([
        sut.createExclusive(values(first.id, 'd'.repeat(64)), DatabaseLock.PhysicalDeduplicationApply),
        sut.createExclusive(values(second.id, 'e'.repeat(64)), DatabaseLock.PhysicalDeduplicationApply),
      ]);

      expect(outcomes.filter((outcome) => 'created' in outcome)).toHaveLength(1);
      expect(outcomes.filter((outcome) => 'active' in outcome)).toHaveLength(1);
      const rows = await sut.listRecentOfKind(MediaOperationKind.PhysicalDeduplication, 10);
      expect(rows).toHaveLength(1);
    });
  });
  /**
   * The job contract gaps closed by FL-43: cancellation races, restarts, worker loss, retry and
   * changed access, against a real database.
   */
  describe('job contract (FL-43)', () => {
    const lapse = (ctx: ReturnType<typeof setup>['ctx'], id: string) =>
      ctx.database
        .updateTable('media_operation')
        .set({ claimExpiresAt: new Date(Date.now() - 60_000) })
        .where('id', '=', id)
        .execute();

    const claimKind = (sut: MediaOperationRepository, kind: MediaOperationKind, workerId: string) =>
      sut.claimNext({ kinds: [kind], workerId, leaseMs: LEASE_MS });

    /** Take the automatic retry's delay away, so the next claim can happen at once. */
    const skipRetryDelay = (ctx: ReturnType<typeof setup>['ctx'], id: string) =>
      ctx.database.updateTable('media_operation').set({ retryAt: null }).where('id', '=', id).execute();

    it('never lets a worker that lost its claim settle the cancel of the claim that replaced it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id, {
        destination: MediaOperationDestination.FrameleafCloud,
        remoteJobId: 'cloud-9',
      });
      const first = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-a');
      // A known owner yields its remote identity explicitly. Lease recovery must never replay
      // ambiguous remote work merely to manufacture a replacement for this cancellation race.
      expect(first).toBeDefined();
      await expect(sut.requeue(operation.id, first!.claimToken, { delayMs: 0 })).resolves.toBe(true);
      const second = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-b');
      expect(second).toBeDefined();
      expect(second!.claimToken).not.toBe(first!.claimToken);
      expect(second!.operation.remoteJobId).toBe('cloud-9');
      await sut.requestCancel(operation.id, user.id);

      // Worker A wakes up, finds its requeue refused and tries to settle the cancel: refused too.
      await expect(sut.requeue(operation.id, first!.claimToken, { delayMs: 0 })).resolves.toBe(false);
      await expect(sut.acknowledgeCancel(operation.id, first!.claimToken, { released: true })).resolves.toBe(false);
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Cancelling,
        claimToken: second!.claimToken,
        cancelAcknowledgedAt: null,
      });
      await expect(unreleasedIds(sut, operation.id)).resolves.toHaveLength(1);

      // Only the worker actually running it can say it stopped.
      await expect(sut.acknowledgeCancel(operation.id, second!.claimToken, { released: true })).resolves.toBe(true);
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Cancelled,
        claimToken: null,
      });
      await expect(unreleasedIds(sut, operation.id)).resolves.toHaveLength(0);
    });

    it('retains an ambiguous remote execution without admitting a replacement after lease loss', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id, {
        destination: MediaOperationDestination.FrameleafCloud,
        remoteJobId: 'cloud-lost',
      });
      const first = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-a');
      expect(first).toBeDefined();
      await lapse(ctx, operation.id);
      await sut.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'gone' });
      expect(await claimKind(sut, MediaOperationKind.StudioExport, 'worker-b')).toBeUndefined();
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Failed,
        claimToken: null,
        autoRetries: 0,
        remoteJobId: 'cloud-lost',
      });
      await expect(sut.acknowledgeCancel(operation.id, first!.claimToken, { released: true })).resolves.toBe(false);
      await expect(unreleasedIds(sut, operation.id)).resolves.toHaveLength(1);
    });

    it('resumes a lost claim once even when maxAttempts requests a larger retry budget', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      // Checkpoint reuse does not grant an independent budget for additional lost claims.
      const operation = await newOperation(sut, user.id, { maxAttempts: 20 });
      const statuses: string[] = [];

      for (let lost = 0; lost < 2; lost++) {
        await skipRetryDelay(ctx, operation.id);
        const claim = await claimKind(sut, MediaOperationKind.StudioExport, `worker-${lost}`);
        expect(claim?.operation.id).toBe(operation.id);
        await lapse(ctx, operation.id);
        await sut.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'gone' });
        const after = await sut.getForOwner(operation.id, user.id);
        statuses.push(`${after!.status}:${after!.autoRetries}`);
      }

      expect(statuses).toEqual(['queued:1', 'failed:1']);
    });

    it('treats a lost claim of a job that cannot resume as its one automatic retry, then reports it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      // A preview starts again from nothing on a new claim, so a lost claim is simply a failure.
      const operation = await newOperation(sut, user.id, { kind: MediaOperationKind.StudioPreview });
      const statuses: string[] = [];

      for (let lost = 0; lost < 2; lost++) {
        await skipRetryDelay(ctx, operation.id);
        await claimKind(sut, MediaOperationKind.StudioPreview, `worker-${lost}`);
        await lapse(ctx, operation.id);
        await sut.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'gone' });
        const after = await sut.getForOwner(operation.id, user.id);
        statuses.push(`${after!.status}:${after!.autoRetries}`);
      }

      expect(statuses).toEqual(['queued:1', 'failed:1']);
    });

    it('does not count a claim handed back on purpose as a lost one after a restart', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);

      // Two graceful shutdowns hand the job back with their attempts returned.
      for (let restart = 0; restart < 2; restart++) {
        const claim = await claimKind(sut, MediaOperationKind.StudioExport, `worker-${restart}`);
        await expect(sut.requeue(operation.id, claim!.claimToken, { delayMs: 0, returnAttempt: true })).resolves.toBe(
          true,
        );
      }

      // The first actual loss consumes the single retry, independent of graceful handbacks.
      await claimKind(sut, MediaOperationKind.StudioExport, 'worker-after-restart');
      await lapse(ctx, operation.id);
      await sut.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'gone' });
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Queued,
        autoRetries: 1,
        attempt: 1,
      });
    });

    it('never moves a job back from checking its output to rendering', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id);
      const claim = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-a');
      await expect(sut.beginValidation(operation.id, claim!.claimToken)).resolves.toBe(true);

      await expect(
        sut.reportProgress(operation.id, claim!.claimToken, {
          status: MediaOperationStatus.Rendering,
          processedUnits: 10,
          totalUnits: 100,
          progress: 10,
        }),
      ).resolves.toBe(false);
      await expect(
        sut.reportProgress(operation.id, claim!.claimToken, {
          status: MediaOperationStatus.Validating,
          processedUnits: 100,
          totalUnits: 100,
          progress: 100,
        }),
      ).resolves.toBe(true);
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Validating,
      });
    });

    it("refuses to publish another account's asset, or a deleted one, as the job's result", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset: theirs } = await ctx.newAsset({ ownerId: other.id });
      const { asset: deleted } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      const { asset: mine } = await ctx.newAsset({ ownerId: user.id });
      const operation = await newOperation(sut, user.id);
      const claim = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-a');
      await sut.beginValidation(operation.id, claim!.claimToken);

      await expect(sut.isPublishableResult(user.id, theirs.id)).resolves.toBe(false);
      await expect(sut.complete(operation.id, claim!.claimToken, { resultAssetId: theirs.id })).resolves.toBe(false);
      await expect(sut.complete(operation.id, claim!.claimToken, { resultAssetId: deleted.id })).resolves.toBe(false);
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Validating,
        resultAssetId: null,
      });

      await expect(sut.isPublishableResult(user.id, mine.id)).resolves.toBe(true);
      await expect(sut.complete(operation.id, claim!.claimToken, { resultAssetId: mine.id })).resolves.toBe(true);
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Completed,
        resultAssetId: mine.id,
      });
    });

    describe('publishValidated', () => {
      it('publishes nothing once the owner cancelled while the output was being checked', async () => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const operation = await newOperation(sut, user.id);
        const claim = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-a');
        await sut.beginValidation(operation.id, claim!.claimToken);
        await sut.requestCancel(operation.id, user.id);

        const publish = vi.fn().mockResolvedValue(true);
        await expect(sut.publishValidated(operation.id, claim!.claimToken, publish)).resolves.toBe('lost');
        expect(publish).not.toHaveBeenCalled();
        await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
          status: MediaOperationStatus.Cancelling,
        });
      });

      it('publishes nothing for a worker whose claim was handed to another', async () => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const operation = await newOperation(sut, user.id);
        const stale = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-a');
        await sut.beginValidation(operation.id, stale!.claimToken);
        await lapse(ctx, operation.id);
        await sut.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'gone' });
        await claimKind(sut, MediaOperationKind.StudioExport, 'worker-b');

        const publish = vi.fn().mockResolvedValue(true);
        await expect(sut.publishValidated(operation.id, stale!.claimToken, publish)).resolves.toBe('lost');
        expect(publish).not.toHaveBeenCalled();
      });

      it('keeps the job validating under its claim when the publication is declined', async () => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const operation = await newOperation(sut, user.id);
        const claim = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-a');
        await sut.beginValidation(operation.id, claim!.claimToken);

        await expect(sut.publishValidated(operation.id, claim!.claimToken, () => Promise.resolve(false))).resolves.toBe(
          'rejected',
        );
        await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
          status: MediaOperationStatus.Validating,
          claimToken: claim!.claimToken,
        });
      });

      it('holds off a cancel that arrives during publication until the job has completed', async () => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const operation = await newOperation(sut, user.id);
        const claim = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-a');
        await sut.beginValidation(operation.id, claim!.claimToken);

        let cancel: Promise<unknown> | undefined;
        const outcome = await sut.publishValidated(operation.id, claim!.claimToken, async (trx) => {
          // The owner presses Cancel while the output is being moved into place.
          cancel = sut.requestCancel(operation.id, user.id);
          await new Promise((resolve) => setTimeout(resolve, 50));
          // The write the publication makes goes through the same transaction.
          await trx.updateTable('media_operation').set({ progress: 100 }).where('id', '=', operation.id).execute();
          return true;
        });

        expect(outcome).toBe('completed');
        // The cancel waited for the row and then found a finished job: nothing to cancel.
        await expect(cancel).resolves.toBeUndefined();
        await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
          status: MediaOperationStatus.Completed,
          cancelRequestedAt: null,
        });
      });
    });

    describe('retry lineage', () => {
      it('queues one retry when two requests race, and answers the second with it', async () => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const failed = await newOperation(sut, user.id);
        await ctx.database
          .updateTable('media_operation')
          .set({ status: MediaOperationStatus.Failed, finishedAt: new Date() })
          .where('id', '=', failed.id)
          .execute();
        const retryOf = (label: string) =>
          sut.createRetry({
            ownerId: user.id,
            kind: MediaOperationKind.StudioExport,
            destination: MediaOperationDestination.Local,
            label,
            retryOfId: failed.id,
            snapshot: failed.snapshot,
            settings: failed.settings,
          });

        const [first, second] = await Promise.all([retryOf('first'), retryOf('second')]);

        expect([first.created, second.created].toSorted((a, b) => Number(a) - Number(b))).toEqual([false, true]);
        expect(first.operation.id).toBe(second.operation.id);
        const { items } = await sut.list({ ownerId: user.id, take: 10, skip: 0 });
        expect(items.filter((item) => item.retryOfId === failed.id)).toHaveLength(1);
      });

      it('lets a job be retried again once its earlier retry has finished', async () => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const failed = await newOperation(sut, user.id);
        const input = {
          ownerId: user.id,
          kind: MediaOperationKind.StudioExport,
          destination: MediaOperationDestination.Local,
          label: 'retry',
          retryOfId: failed.id,
          snapshot: {},
          settings: {},
        };
        const { operation: earlier } = await sut.createRetry(input);
        await sut.requestCancel(earlier.id, user.id);

        const later = await sut.createRetry(input);

        expect(later.created).toBe(true);
        expect(later.operation.id).not.toBe(earlier.id);
      });
    });

    describe('checkpoints after worker loss', () => {
      it('refuses a chunk from a worker whose claim lapsed and was recovered', async () => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const operation = await newOperation(sut, user.id);
        const stale = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-a');
        const chunk = {
          operationId: operation.id,
          sequence: 0,
          chunkKey: 'key-0',
          inputDigest: 'in',
          historyDigest: 'history',
          configDigest: 'config',
          timebase: '30000/1001',
          startTicks: '0',
          endTicks: '1001',
        };
        await expect(sut.upsertCheckpoint(operation.id, stale!.claimToken, chunk)).resolves.toBe(true);
        await lapse(ctx, operation.id);
        await sut.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'gone' });

        await expect(sut.upsertCheckpoint(operation.id, stale!.claimToken, chunk)).resolves.toBe(false);
        await expect(
          sut.completeCheckpoint(operation.id, stale!.claimToken, {
            sequence: 0,
            chunkKey: 'key-0',
            outputPath: '/tmp/chunk-0',
            outputChecksum: Buffer.from('00', 'hex'),
            sizeInBytes: 1,
          }),
        ).resolves.toBe(false);

        await skipRetryDelay(ctx, operation.id);
        const replacement = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-b');
        await expect(sut.upsertCheckpoint(operation.id, replacement!.claimToken, chunk)).resolves.toBe(true);
        await expect(
          sut.completeCheckpoint(operation.id, replacement!.claimToken, {
            sequence: 0,
            chunkKey: 'key-0',
            outputPath: '/tmp/chunk-0',
            outputChecksum: Buffer.from('00', 'hex'),
            sizeInBytes: 1,
          }),
        ).resolves.toBe(true);
      });
    });
  });

  /**
   * Edits the job queue runs (FL-43): saved photo edits, photo versions, video edits and exports. The
   * executors are the edit jobs; these tests hold the row to the same rules as every other job, with
   * a real database, through cancellation races, worker loss, restart, retry and changed access.
   */
  describe('job-queue edits (FL-43)', () => {
    const quiet = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const newEdit = async (
      ctx: ReturnType<typeof setup>['ctx'],
      sut: MediaOperationRepository,
      ownerId: string,
      edit = EditOperationEdit.PhotoEdit,
    ) => {
      const { asset } = await ctx.newAsset({ ownerId, originalFileName: 'IMG_0042.jpg' });
      const operation = await sut.create(
        editOperationCreate({
          ownerId,
          edit,
          assetId: asset.id,
          label: 'IMG_0042.jpg',
          job: { name: JobName.AssetEditThumbnailGeneration, data: { id: asset.id } },
        }),
      );
      return { asset, operation };
    };

    const lapse = (ctx: ReturnType<typeof setup>['ctx'], id: string) =>
      ctx.database
        .updateTable('media_operation')
        .set({ claimExpiresAt: new Date(Date.now() - 60_000) })
        .where('id', '=', id)
        .execute();

    const tracker = (sut: MediaOperationRepository) => {
      const jobs = { queue: vi.fn().mockResolvedValue(undefined), queueAll: vi.fn().mockResolvedValue(undefined) };
      return { jobs, edits: new EditOperationTracker(sut, jobs as never, quiet as never, LEASE_MS) };
    };

    it('is never claimed by a polling worker, only by its own job, and only once', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { operation } = await newEdit(ctx, sut, user.id);

      await expect(
        sut.claimNext({ kinds: [MediaOperationKind.QuickEdit], workerId: 'render-worker', leaseMs: LEASE_MS }),
      ).resolves.toBeUndefined();

      const [first, second] = await Promise.all([
        sut.beginJobQueueRun(operation.id, LEASE_MS),
        sut.beginJobQueueRun(operation.id, LEASE_MS),
      ]);
      const runs = [first, second].filter(Boolean);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.operation).toMatchObject({
        status: MediaOperationStatus.Preparing,
        claimedBy: JOB_QUEUE_CLAIMANT,
        attempt: 1,
      });
    });

    it('cancels an unsafe edit only while queued and unclaimed', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { operation } = await newEdit(ctx, sut, user.id);

      await expect(sut.requestCancel(operation.id, other.id, undefined, true)).resolves.toBeUndefined();
      await expect(sut.requestCancel(operation.id, user.id, undefined, true)).resolves.toMatchObject({
        status: MediaOperationStatus.Cancelled,
        claimToken: null,
        cancelAcknowledgedAt: expect.any(Date),
      });
      await expect(sut.beginJobQueueRun(operation.id, LEASE_MS)).resolves.toBeUndefined();

      const { operation: active } = await newEdit(ctx, sut, user.id);
      const run = await sut.beginJobQueueRun(active.id, LEASE_MS);
      expect(run).toBeDefined();
      await expect(sut.requestCancel(active.id, user.id, undefined, true)).resolves.toBeUndefined();
      await expect(sut.getForOwner(active.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Preparing,
        claimToken: run!.claimToken,
        cancelRequestedAt: null,
      });
    });

    it('never runs an edit cancelled while it waited, whichever reaches the row first', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { operation } = await newEdit(ctx, sut, user.id, EditOperationEdit.PhotoVersion);

      const [cancelled, run] = await Promise.all([
        sut.requestCancel(operation.id, user.id),
        sut.beginJobQueueRun(operation.id, LEASE_MS),
      ]);

      const row = await sut.getForOwner(operation.id, user.id);
      if (run) {
        // The run won: the cancel waits for it to acknowledge, and it can.
        expect(row!.status).toBe(MediaOperationStatus.Cancelling);
        await expect(sut.acknowledgeCancel(operation.id, run.claimToken, { released: true })).resolves.toBe(true);
      } else {
        // The cancel won: the job's delivery finds nothing to run.
        expect(cancelled!.status).toBe(MediaOperationStatus.Cancelled);
        await expect(sut.beginJobQueueRun(operation.id, LEASE_MS)).resolves.toBeUndefined();
      }
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Cancelled,
      });
    });

    it('recovers a run whose worker died: the row is dispatched once, and the old run can no longer publish', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { operation } = await newEdit(ctx, sut, user.id);
      const lost = await sut.beginJobQueueRun(operation.id, LEASE_MS);
      await lapse(ctx, operation.id);

      await sut.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'gone' });
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Queued,
        claimedBy: null,
        autoRetries: 1,
      });
      await ctx.database.updateTable('media_operation').set({ retryAt: null }).where('id', '=', operation.id).execute();

      const [first, second] = await Promise.all([
        sut.claimJobQueueDispatch({ limit: 10, staleMs: 60_000 }),
        sut.claimJobQueueDispatch({ limit: 10, staleMs: 60_000 }),
      ]);
      expect([...first, ...second].map(({ id }) => id)).toEqual([operation.id]);

      // The dead worker comes back and tries to publish: refused.
      await expect(sut.beginValidation(operation.id, lost!.claimToken)).resolves.toBe(false);
      await expect(sut.complete(operation.id, lost!.claimToken, { resultAssetId: null })).resolves.toBe(false);

      const replacement = await sut.beginJobQueueRun(operation.id, LEASE_MS);
      expect(replacement?.operation.attempt).toBe(2);
    });

    it('dispatches an edit again after a restart lost its queued job, but not one waiting normally', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { operation: waiting } = await newEdit(ctx, sut, user.id);
      const { operation: lostJob } = await newEdit(ctx, sut, user.id);
      // The updatedAt trigger would stamp now(); replica mode skips it so the row really looks old.
      await ctx.database.transaction().execute(async (trx) => {
        await sql`SET LOCAL session_replication_role = replica`.execute(trx);
        await trx
          .updateTable('media_operation')
          .set({ updatedAt: new Date(Date.now() - 3_600_000) })
          .where('id', '=', lostJob.id)
          .execute();
      });

      const dispatched = await sut.claimJobQueueDispatch({ limit: 10, staleMs: 15 * 60_000 });

      expect(dispatched.map(({ id }) => id)).toEqual([lostJob.id]);
      expect(dispatched.map(({ id }) => id)).not.toContain(waiting.id);
    });

    it('retries a failure once through the dispatcher, then reports it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { operation } = await newEdit(ctx, sut, user.id);
      const { edits } = tracker(sut);

      await expect(edits.execute(operation.id, () => Promise.resolve(JobStatus.Failed))).resolves.toBe(
        JobStatus.Failed,
      );
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Queued,
        claimedBy: null,
        autoRetries: 1,
        errorCode: 'edit_render_failed',
      });

      await ctx.database.updateTable('media_operation').set({ retryAt: null }).where('id', '=', operation.id).execute();
      await expect(sut.claimJobQueueDispatch({ limit: 10, staleMs: 60_000 })).resolves.toHaveLength(1);
      await edits.execute(operation.id, () => Promise.resolve(JobStatus.Failed));

      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Failed,
      });
    });

    it('completes a published edit with the edited item as its result', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset, operation } = await newEdit(ctx, sut, user.id);
      const { edits } = tracker(sut);

      await edits.execute(operation.id, async (run) => {
        expect(await run!.validate()).toBe(true);
        return JobStatus.Success;
      });

      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Completed,
        resultAssetId: asset.id,
      });
    });

    describe('changed access while the job is claimed', () => {
      it('withholds the job’s details from a locked session once its item is Locked mid-run', async () => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const { asset, operation } = await newEdit(ctx, sut, user.id);
        const run = await sut.beginJobQueueRun(operation.id, LEASE_MS);
        expect(run).toBeDefined();

        await ctx.database
          .insertInto('asset_lock')
          .values({ assetId: asset.id, reason: 'marked' } as never)
          .execute();

        const service = new MediaOperationService(
          quiet as never,
          sut,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
        );
        const locked = factory.auth({ user: { id: user.id } });
        const unlocked = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });

        const { items } = await service.search(locked, {} as never);
        expect(items.find(({ id }) => id === operation.id)).toMatchObject({
          withheld: true,
          label: '',
          assetId: null,
          status: MediaOperationStatus.Preparing,
        });
        await expect(service.get(locked, operation.id)).resolves.toMatchObject({ withheld: true, snapshot: {} });

        await expect(service.get(unlocked, operation.id)).resolves.toMatchObject({
          withheld: false,
          label: 'IMG_0042.jpg',
          assetId: asset.id,
        });

        // Another account never learns the job exists.
        const { user: other } = await ctx.newUser();
        await expect(service.get(factory.auth({ user: { id: other.id } }), operation.id)).rejects.toThrow(
          'Media operation not found',
        );
      });

      it('refuses to publish once the item left the owner’s library mid-run, and reports it', async () => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const { user: other } = await ctx.newUser();
        const { asset, operation } = await newEdit(ctx, sut, user.id);
        const { edits } = tracker(sut);

        await edits.execute(operation.id, async (run) => {
          // Mid-render the item is handed to another account (the owner lost access to it).
          await ctx.database.updateTable('asset').set({ ownerId: other.id }).where('id', '=', asset.id).execute();
          expect(await run!.validate()).toBe(true);
          return JobStatus.Success;
        });

        await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
          status: MediaOperationStatus.Failed,
          errorCode: 'result_not_owned',
          resultAssetId: null,
        });
      });

      it('refuses to publish an item trashed mid-run', async () => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const { asset, operation } = await newEdit(ctx, sut, user.id);
        const run = await sut.beginJobQueueRun(operation.id, LEASE_MS);
        await sut.beginValidation(operation.id, run!.claimToken);

        await ctx.database.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();

        await expect(sut.complete(operation.id, run!.claimToken, { resultAssetId: asset.id })).resolves.toBe(false);
        await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
          status: MediaOperationStatus.Validating,
          resultAssetId: null,
        });
      });
    });

    it('lists every unfinished job first, however many finished since (reload recovery)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { operation: running } = await newEdit(ctx, sut, user.id);
      for (let finished = 0; finished < 3; finished++) {
        const { operation } = await newEdit(ctx, sut, user.id);
        await sut.requestCancel(operation.id, user.id);
      }

      const newestFirst = await sut.list({ ownerId: user.id, take: 2, skip: 0 });
      expect(newestFirst.items.map(({ id }) => id)).not.toContain(running.id);

      const unfinishedFirst = await sut.list({ ownerId: user.id, take: 2, skip: 0, unfinishedFirst: true });
      expect(unfinishedFirst.items[0].id).toBe(running.id);
      expect(unfinishedFirst.total).toBe(4);
    });

    it('tells its listeners which owner’s job changed, and nothing else', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const changes: Array<{ id: string; ownerId: string }> = [];
      const stop = sut.onChange((batch) => {
        changes.push(...batch);
      });

      const { operation } = await newEdit(ctx, sut, user.id);
      const run = await sut.beginJobQueueRun(operation.id, LEASE_MS);
      await sut.beginValidation(operation.id, run!.claimToken);
      await sut.complete(operation.id, run!.claimToken, { resultAssetId: null });
      stop();
      await sut.dismiss(operation.id, user.id);

      expect(changes).toEqual(Array.from({ length: 4 }, () => ({ id: operation.id, ownerId: user.id })));
    });
  });

  describe('Frameleaf Cloud description batches (FL-163)', () => {
    const destinationId = 'destination-cloud';

    const batch = async (
      sut: MediaOperationRepository,
      ownerId: string,
      options: {
        status?: MediaOperationStatus;
        origin?: 'automatic' | 'backfill';
        assetIds?: string[];
        job?: { admittedAt: Date; holdUsd: number } | null;
        settledUsd?: number | null;
        remoteJobId?: string | null;
        destination?: string;
      } = {},
    ) => {
      const created = await newOperation(sut, ownerId, {
        kind: MediaOperationKind.CloudDescriptionBatch,
        destination: MediaOperationDestination.FrameleafCloud,
        snapshot: {
          version: 1,
          origin: options.origin ?? 'automatic',
          destinationId: options.destination ?? destinationId,
          assetIds: options.assetIds ?? [],
        },
        result: {
          phase: 'submitted',
          job: options.job
            ? { jobId: 'job', holdUsd: options.job.holdUsd, admittedAt: options.job.admittedAt.toISOString() }
            : null,
          settledUsd: options.settledUsd ?? null,
        },
        remoteJobId: options.remoteJobId ?? null,
      });
      if (options.status) {
        await defaultDatabase
          .updateTable('media_operation')
          .set({ status: options.status })
          .where('id', '=', created.id)
          .execute();
      }
      return created;
    };

    it('finds the photos of unfinished batches only', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await batch(sut, user.id, { assetIds: ['a1', 'a2'] });
      await batch(sut, user.id, { assetIds: ['a3'], status: MediaOperationStatus.Completed });
      await newOperation(sut, user.id, { snapshot: { assetIds: ['a4'] } });

      await expect(sut.getOpenCloudDescriptionAssetIds()).resolves.toEqual(new Set(['a1', 'a2']));
    });

    it('sums settled charges, else holds, of batches admitted in the window, by origin', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const from = new Date('2026-09-26T00:00:00.000Z');
      const to = new Date('2026-09-27T00:00:00.000Z');
      const today = new Date('2026-09-26T10:00:00.000Z');
      await batch(sut, user.id, { job: { admittedAt: today, holdUsd: 1 }, settledUsd: 0.3 });
      await batch(sut, user.id, { job: { admittedAt: today, holdUsd: 0.2 } });
      await batch(sut, user.id, { job: { admittedAt: new Date('2026-09-25T23:00:00.000Z'), holdUsd: 5 } });
      await batch(sut, user.id, { origin: 'backfill', job: { admittedAt: today, holdUsd: 7 } });
      await batch(sut, user.id, { job: null });

      await expect(sut.sumCloudDescriptionSpend({ from, to, origin: 'automatic' })).resolves.toBeCloseTo(0.5, 6);
      await expect(sut.sumCloudDescriptionSpend({ from, to })).resolves.toBeCloseTo(7.5, 6);
    });

    it("adds up the unsettled holds of a destination's unfinished batches and recent finished ones", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const since = new Date('2026-09-01T00:00:00.000Z');
      const recent = new Date('2026-09-26T10:00:00.000Z');
      const old = new Date('2026-08-01T10:00:00.000Z');
      await batch(sut, user.id, { job: { admittedAt: recent, holdUsd: 0.2 } });
      await batch(sut, user.id, { job: { admittedAt: recent, holdUsd: 0.3 }, status: MediaOperationStatus.Failed });
      // unfinished, admitted before the window: still held
      await batch(sut, user.id, { job: { admittedAt: old, holdUsd: 0.4 } });
      // finished before the window and never settled: its hold no longer counts
      await batch(sut, user.id, { job: { admittedAt: old, holdUsd: 50 }, status: MediaOperationStatus.Cancelled });
      await batch(sut, user.id, { job: { admittedAt: recent, holdUsd: 9 }, settledUsd: 1 });
      await batch(sut, user.id, { job: { admittedAt: recent, holdUsd: 4 }, destination: 'elsewhere' });
      await batch(sut, user.id, { job: null });

      await expect(sut.sumCloudDescriptionOpenHolds(destinationId, since)).resolves.toBeCloseTo(0.9, 6);
    });

    it('tells whether an admitted batch still waits for its settlement, bounded as the holds are', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const since = new Date('2026-09-01T00:00:00.000Z');
      const old = new Date('2026-08-01T10:00:00.000Z');
      await batch(sut, user.id, { job: { admittedAt: new Date(), holdUsd: 1 }, settledUsd: 1 });
      await batch(sut, user.id, { job: { admittedAt: old, holdUsd: 1 }, status: MediaOperationStatus.Failed });
      await expect(sut.hasUnsettledCloudDescriptionJobs(since)).resolves.toBe(false);

      await batch(sut, user.id, { job: { admittedAt: old, holdUsd: 1 } });
      await expect(sut.hasUnsettledCloudDescriptionJobs(since)).resolves.toBe(true);
    });

    it('lists finished batches whose submission was sent but whose job was never recorded', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const attempted = { idempotencyKey: 'desc-1', attemptedAt: new Date().toISOString() };
      const pending = await newOperation(sut, user.id, {
        kind: MediaOperationKind.CloudDescriptionBatch,
        destination: MediaOperationDestination.FrameleafCloud,
        snapshot: { version: 1 },
        result: { submission: attempted, job: null },
      });
      const running = await newOperation(sut, user.id, {
        kind: MediaOperationKind.CloudDescriptionBatch,
        destination: MediaOperationDestination.FrameleafCloud,
        snapshot: { version: 1 },
        result: { submission: attempted, job: null },
      });
      const recorded = await newOperation(sut, user.id, {
        kind: MediaOperationKind.CloudDescriptionBatch,
        destination: MediaOperationDestination.FrameleafCloud,
        snapshot: { version: 1 },
        result: { submission: attempted, job: { jobId: 'job-1' } },
        remoteJobId: 'job-1',
      });
      for (const { id } of [pending, recorded]) {
        await defaultDatabase
          .updateTable('media_operation')
          .set({ status: MediaOperationStatus.Failed })
          .where('id', '=', id)
          .execute();
      }

      const rows = await sut.listCloudDescriptionPendingReleases(10);

      expect(rows.map(({ id }) => id)).toEqual([pending.id]);
      expect(rows.map(({ id }) => id)).not.toContain(running.id);
    });

    it('limits the cleanup list to the kinds asked for before its limit', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const other = await newOperation(sut, user.id, { remoteJobId: 'render-1' });
      const cloud = await batch(sut, user.id, { remoteJobId: 'job-1' });
      for (const { id } of [other, cloud]) {
        await defaultDatabase
          .updateTable('media_operation')
          .set({ status: MediaOperationStatus.Cancelled })
          .where('id', '=', id)
          .execute();
      }

      const unreleased = await sut.getUnreleasedRemoteOperations(1, [MediaOperationKind.CloudDescriptionBatch]);

      expect(unreleased.map(({ id }) => id)).toEqual([cloud.id]);
    });

    it('records a remote job without a claim only into an empty handle', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const created = await batch(sut, user.id);

      await expect(sut.recordRemoteJobId(created.id, 'job-1')).resolves.toBe(true);
      await expect(sut.recordRemoteJobId(created.id, 'job-1')).resolves.toBe(true);
      await expect(sut.recordRemoteJobId(created.id, 'job-2')).resolves.toBe(false);
      await expect(sut.getForWorker(created.id)).resolves.toMatchObject({ remoteJobId: 'job-1' });
    });

    it('reads several jobs for a worker in one query', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const first = await batch(sut, user.id);
      const second = await batch(sut, user.id);

      const rows = await sut.getManyForWorker([first.id, second.id]);

      expect(rows.map(({ id }) => id).toSorted((a, b) => a.localeCompare(b))).toEqual(
        [first.id, second.id].toSorted((a, b) => a.localeCompare(b)),
      );
      await expect(sut.getManyForWorker([])).resolves.toEqual([]);
    });
  });
});
