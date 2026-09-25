import { Kysely, sql } from 'kysely';
import {
  AssetVisibility,
  DatabaseLock,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { up as migrateRetryIndex } from 'src/schema/migrations/2100000000590-HardenMediaOperationRetryAndCheckpoints.js';
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
        destination: MediaOperationDestination.RunPod,
        remoteJobId: 'runpod-1',
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
        destination: MediaOperationDestination.RunPod,
        remoteJobId: 'runpod-2',
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
        destination: MediaOperationDestination.RunPod,
        remoteJobId: 'runpod-9',
      });
      const first = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-a');
      await lapse(ctx, operation.id);
      await sut.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'gone' });
      const second = await claimKind(sut, MediaOperationKind.StudioExport, 'worker-b');
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

    it('resumes a lost claim of a resumable job twice, then retries it once, then reports it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      // Even a job that asks for more claims gets two resumes (owner decision, September 22, 2026).
      const operation = await newOperation(sut, user.id, { maxAttempts: 20 });
      const statuses: string[] = [];

      for (let lost = 0; lost < 4; lost++) {
        await skipRetryDelay(ctx, operation.id);
        const claim = await claimKind(sut, MediaOperationKind.StudioExport, `worker-${lost}`);
        expect(claim?.operation.id).toBe(operation.id);
        await lapse(ctx, operation.id);
        await sut.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'gone' });
        const after = await sut.getForOwner(operation.id, user.id);
        statuses.push(`${after!.status}:${after!.autoRetries}`);
      }

      expect(statuses).toEqual(['queued:0', 'queued:0', 'queued:1', 'failed:1']);
    });

    it('treats a lost claim of a job that cannot resume as its one automatic retry, then reports it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      // A preview starts again from nothing on a new claim, so a lost claim is simply a failure.
      const operation = await newOperation(sut, user.id, { kind: MediaOperationKind.RestorationPreview });
      const statuses: string[] = [];

      for (let lost = 0; lost < 2; lost++) {
        await skipRetryDelay(ctx, operation.id);
        await claimKind(sut, MediaOperationKind.RestorationPreview, `worker-${lost}`);
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

      // So the next lost claim still resumes rather than using the automatic retry.
      await claimKind(sut, MediaOperationKind.StudioExport, 'worker-after-restart');
      await lapse(ctx, operation.id);
      await sut.recoverExpiredClaims({ errorCode: 'lease_expired', error: 'gone' });
      await expect(sut.getForOwner(operation.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Queued,
        autoRetries: 0,
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

    describe('retry index migration (2100000000590)', () => {
      it('cancels duplicate unfinished retries so the unique index can be built', async () => {
        const database = await getKyselyDB();
        try {
          const { ctx, sut } = setup(database);
          const { user } = await ctx.newUser();
          const failed = await newOperation(sut, user.id);
          await database
            .updateTable('media_operation')
            .set({ status: MediaOperationStatus.Failed })
            .where('id', '=', failed.id)
            .execute();
          await sql`DROP INDEX "media_operation_retryOfId_active_uq"`.execute(database);

          const retry = (label: string, status: MediaOperationStatus, claimToken: string | null = null) =>
            sut
              .create({
                ownerId: user.id,
                kind: MediaOperationKind.StudioExport,
                destination: MediaOperationDestination.Local,
                label,
                retryOfId: failed.id,
                snapshot: {},
                settings: {},
              })
              .then(async (operation) => {
                await database
                  .updateTable('media_operation')
                  .set({ status, claimToken, claimedBy: claimToken ? 'worker-a' : null })
                  .where('id', '=', operation.id)
                  .execute();
                return operation;
              });
          const olderQueued = await retry('older queued', MediaOperationStatus.Queued);
          const rendering = await retry(
            'rendering',
            MediaOperationStatus.Rendering,
            '0195e2a0-0000-7000-8000-00000000c1a1',
          );
          const laterQueued = await retry('later queued', MediaOperationStatus.Queued);
          const finished = await retry('finished', MediaOperationStatus.Completed);

          await migrateRetryIndex(database);

          const rows = await database
            .selectFrom('media_operation')
            .select(['id', 'status', 'claimToken', 'cancelAcknowledgedAt', 'finishedAt'])
            .where('retryOfId', '=', failed.id)
            .execute();
          const byId = new Map(rows.map((row) => [row.id, row]));
          // The claimed retry is kept over the older queued one; the rest are cancelled.
          expect(byId.get(rendering.id)).toMatchObject({ status: MediaOperationStatus.Rendering });
          expect(byId.get(olderQueued.id)).toMatchObject({ status: MediaOperationStatus.Cancelled, claimToken: null });
          expect(byId.get(olderQueued.id)!.cancelAcknowledgedAt).not.toBeNull();
          expect(byId.get(laterQueued.id)).toMatchObject({ status: MediaOperationStatus.Cancelled });
          expect(byId.get(finished.id)).toMatchObject({ status: MediaOperationStatus.Completed });

          const index = await sql<{ indexname: string }>`
            SELECT indexname FROM pg_indexes WHERE indexname = 'media_operation_retryOfId_active_uq'
          `.execute(database);
          expect(index.rows).toHaveLength(1);
        } finally {
          await database.destroy();
        }
      });

      it('keeps a live retry over an older one that is already being cancelled', async () => {
        const database = await getKyselyDB();
        try {
          const { ctx, sut } = setup(database);
          const { user } = await ctx.newUser();
          const failed = await newOperation(sut, user.id);
          await sql`DROP INDEX "media_operation_retryOfId_active_uq"`.execute(database);
          const input = {
            ownerId: user.id,
            kind: MediaOperationKind.StudioExport,
            destination: MediaOperationDestination.Local,
            label: 'retry',
            retryOfId: failed.id,
            snapshot: {},
            settings: {},
          };
          const cancelling = await sut.create(input);
          const rendering = await sut.create(input);
          await database
            .updateTable('media_operation')
            .set({ status: MediaOperationStatus.Cancelling, cancelRequestedAt: new Date() })
            .where('id', '=', cancelling.id)
            .execute();
          await database
            .updateTable('media_operation')
            .set({ status: MediaOperationStatus.Rendering })
            .where('id', '=', rendering.id)
            .execute();

          await migrateRetryIndex(database);

          const rows = await database
            .selectFrom('media_operation')
            .select(['id', 'status'])
            .where('id', 'in', [cancelling.id, rendering.id])
            .execute();
          expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
            [rendering.id]: MediaOperationStatus.Rendering,
            [cancelling.id]: MediaOperationStatus.Cancelled,
          });
        } finally {
          await database.destroy();
        }
      });

      it('cancels a claimed duplicate without acknowledging it, so remote cleanup still runs', async () => {
        const database = await getKyselyDB();
        try {
          const { ctx, sut } = setup(database);
          const { user } = await ctx.newUser();
          const failed = await newOperation(sut, user.id);
          await sql`DROP INDEX "media_operation_retryOfId_active_uq"`.execute(database);
          const input = {
            ownerId: user.id,
            kind: MediaOperationKind.StudioExport,
            destination: MediaOperationDestination.Local,
            label: 'retry',
            retryOfId: failed.id,
            snapshot: {},
            settings: {},
          };
          const first = await sut.create(input);
          const second = await sut.create(input);
          await database
            .updateTable('media_operation')
            .set({ status: MediaOperationStatus.Rendering, claimToken: '0195e2a0-0000-7000-8000-00000000c1a2' })
            .where('id', 'in', [first.id, second.id])
            .execute();

          await migrateRetryIndex(database);

          const loser = await database
            .selectFrom('media_operation')
            .selectAll()
            .where('id', '=', second.id)
            .executeTakeFirstOrThrow();
          expect(loser).toMatchObject({
            status: MediaOperationStatus.Cancelled,
            claimToken: null,
            cancelAcknowledgedAt: null,
          });
          expect(loser.cancelRequestedAt).not.toBeNull();
        } finally {
          await database.destroy();
        }
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
});
