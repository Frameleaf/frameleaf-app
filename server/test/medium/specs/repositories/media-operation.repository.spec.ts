import { Kysely } from 'kysely';
import { AssetVisibility, MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(MediaOperationRepository) };
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
      await expect(
        sut.fail(operation.id, stale, { error: 'late failure', errorCode: 'late' }),
      ).resolves.toBe(false);

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
    it('requeues a job with attempts left, retries one without once, and fails one that already retried', async () => {
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

      expect(result).toEqual({ requeued: 1, retried: 1, failed: 1, abandonedCancels: 0, paused: 0 });
      await expect(sut.getForOwner(resumable.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Queued,
        claimToken: null,
        autoRetries: 0,
        retryAt: null,
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
        destination: MediaOperationDestination.RunPod,
        remoteJobId: 'runpod-3',
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
      await expect(sut.settlePause(operation.id, 'not-the-claim')).resolves.toBe(false);
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
        destination: MediaOperationDestination.RunPod,
        remoteJobId: 'runpod-1',
      });
      await sut.claimNext({ kinds: [MediaOperationKind.StudioExport], workerId: 'worker-a', leaseMs: LEASE_MS });

      const cancelling = await sut.requestCancel(operation.id, user.id);
      expect(cancelling!.status).toBe(MediaOperationStatus.Cancelling);
      expect(cancelling!.cancelAcknowledgedAt).toBeNull();

      // Until the acknowledgement, the remote job is still an open obligation.
      await expect(unreleasedIds(sut, operation.id)).resolves.toHaveLength(1);

      await expect(sut.acknowledgeCancel(operation.id, { released: true })).resolves.toBe(true);
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Cancelled,
      });
      await expect(unreleasedIds(sut, operation.id)).resolves.toHaveLength(0);
    });

    it('keeps an unacknowledged remote job visible after the owner clears it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newOperation(sut, user.id, {
        destination: MediaOperationDestination.RunPod,
        remoteJobId: 'runpod-2',
      });
      await sut.claimNext({ kinds: [MediaOperationKind.StudioExport], workerId: 'worker-a', leaseMs: LEASE_MS });
      await sut.requestCancel(operation.id, user.id);
      await sut.acknowledgeCancel(operation.id, { released: false });

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
      expect(recovered.requeued).toBeGreaterThanOrEqual(2);
      const { items } = await sut.list({ ownerId: user.id, take: 10, skip: 0 });
      const byKind = Object.fromEntries(items.map((item) => [item.kind, item.status]));
      expect(byKind[MediaOperationKind.Bulk]).toBe(MediaOperationStatus.Queued);
      expect(byKind[MediaOperationKind.StudioExport]).toBe(MediaOperationStatus.Queued);
    });
  });
});
