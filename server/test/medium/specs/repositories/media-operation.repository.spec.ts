import { Kysely } from 'kysely';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
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

  describe('recoverExpiredClaims', () => {
    it('requeues a job with attempts left and fails one without', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const resumable = await newOperation(sut, user.id, { maxAttempts: 3 });
      const exhausted = await newOperation(sut, user.id, { maxAttempts: 1 });

      for (const id of [resumable.id, exhausted.id]) {
        await ctx.database
          .updateTable('media_operation')
          .set({
            status: MediaOperationStatus.Rendering,
            claimToken: '0195e2a0-0000-7000-8000-0000000000aa',
            claimedBy: 'worker-gone',
            claimExpiresAt: new Date(Date.now() - 60_000),
            attempt: 1,
          })
          .where('id', '=', id)
          .execute();
      }

      const result = await sut.recoverExpiredClaims({
        errorCode: 'worker_lost',
        error: 'The worker stopped responding',
      });

      expect(result).toEqual({ requeued: 1, failed: 1, abandonedCancels: 0 });
      await expect(sut.getForOwner(resumable.id, user.id)).resolves.toMatchObject({
        status: MediaOperationStatus.Queued,
        claimToken: null,
      });
      await expect(sut.getForOwner(exhausted.id, user.id)).resolves.toMatchObject({
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
});
