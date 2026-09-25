import { JobName, MediaOperationKind } from 'src/enum.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import {
  MEDIA_OPERATION_LEASE_EXPIRED,
  MEDIA_OPERATION_SWEEP_MS,
  MediaOperationSweepService,
} from 'src/services/media-operation-sweep.service.js';
import { getMocks } from 'test/utils.js';

const nothing = { requeued: 0, retried: 0, failed: 0, abandonedCancels: 0, paused: 0 };

describe(MediaOperationSweepService.name, () => {
  let sut: MediaOperationSweepService;
  let operations: {
    recoverExpiredClaims: ReturnType<typeof vi.fn>;
    claimJobQueueDispatch: ReturnType<typeof vi.fn>;
    releaseJobQueueDispatch: ReturnType<typeof vi.fn>;
    requestCancel: ReturnType<typeof vi.fn>;
  };
  let jobs: { queue: ReturnType<typeof vi.fn>; queueAll: ReturnType<typeof vi.fn> };
  let logger: ReturnType<typeof getMocks>['logger'];

  beforeEach(() => {
    logger = getMocks().logger;
    operations = {
      recoverExpiredClaims: vi.fn().mockResolvedValue(nothing),
      claimJobQueueDispatch: vi.fn().mockResolvedValue([]),
      releaseJobQueueDispatch: vi.fn().mockResolvedValue(undefined),
      requestCancel: vi.fn().mockResolvedValue(undefined),
    };
    jobs = { queue: vi.fn().mockResolvedValue(undefined), queueAll: vi.fn().mockResolvedValue(undefined) };
    sut = new MediaOperationSweepService(
      logger as never,
      operations as unknown as MediaOperationRepository,
      jobs as never,
    );
  });

  afterEach(async () => {
    await sut.onShutdown();
    vi.useRealTimers();
  });

  describe('sweep', () => {
    it('recovers every kind in one pass, with no kind filter', async () => {
      await sut.sweep();

      expect(operations.recoverExpiredClaims).toHaveBeenCalledTimes(1);
      expect(operations.recoverExpiredClaims).toHaveBeenCalledWith(MEDIA_OPERATION_LEASE_EXPIRED);
      expect(operations.recoverExpiredClaims.mock.calls[0][0]).not.toHaveProperty('kinds');
    });

    it('reports what it recovered, automatic retries included', async () => {
      const recovered = { requeued: 2, retried: 1, failed: 1, abandonedCancels: 1, paused: 0 };
      operations.recoverExpiredClaims.mockResolvedValue(recovered);

      await expect(sut.sweep()).resolves.toEqual(recovered);
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('1 retrying'));
    });

    it('reports a job it held for its owner’s pause, rather than requeuing it (FL-104)', async () => {
      operations.recoverExpiredClaims.mockResolvedValue({ ...nothing, paused: 1 });

      await sut.sweep();

      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('1 paused'));
    });

    it('puts edits the job queue runs back on it, each with its row (FL-43)', async () => {
      operations.claimJobQueueDispatch.mockResolvedValue([
        {
          id: 'op-1',
          ownerId: 'owner-1',
          snapshot: {
            executor: 'job_queue',
            job: { name: JobName.AssetDevelopRender, data: { id: 'revision-1' } },
          },
        },
      ]);

      await sut.sweep();

      // Recovery first, so a lapsed claim it just requeued is dispatched in the same pass.
      expect(operations.recoverExpiredClaims.mock.invocationCallOrder[0]).toBeLessThan(
        operations.claimJobQueueDispatch.mock.invocationCallOrder[0],
      );
      expect(jobs.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetDevelopRender, data: { id: 'revision-1', operationId: 'op-1' } },
      ]);
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Dispatched 1 edit render'));
    });

    it('never dispatches a row whose snapshot names no edit job, and stops it instead', async () => {
      operations.claimJobQueueDispatch.mockResolvedValue([
        { id: 'op-2', ownerId: 'owner-1', snapshot: { executor: 'job_queue', job: { name: JobName.FileDelete } } },
        { id: 'op-3', ownerId: 'owner-1', snapshot: { kind: MediaOperationKind.QuickEdit } },
      ]);

      await sut.sweep();

      expect(jobs.queueAll).toHaveBeenCalledWith([]);
      expect(operations.requestCancel).toHaveBeenCalledWith('op-2', 'owner-1');
      expect(operations.requestCancel).toHaveBeenCalledWith('op-3', 'owner-1');
    });

    it('hands the rows back when the job queue cannot take them', async () => {
      operations.claimJobQueueDispatch.mockResolvedValue([
        {
          id: 'op-4',
          ownerId: 'owner-1',
          snapshot: { executor: 'job_queue', job: { name: JobName.AssetEditThumbnailGeneration, data: { id: 'a' } } },
        },
      ]);
      jobs.queueAll.mockRejectedValue(new Error('redis went away'));

      await expect(sut.sweep()).rejects.toThrow('redis went away');
      expect(operations.releaseJobQueueDispatch).toHaveBeenCalledWith(['op-4']);
    });

    it('stays quiet when there was nothing to recover', async () => {
      await sut.sweep();

      expect(logger.log).not.toHaveBeenCalled();
    });
  });

  describe('tick', () => {
    it('never runs two passes at once', async () => {
      let release!: (value: typeof nothing) => void;
      operations.recoverExpiredClaims.mockReturnValue(new Promise((resolve) => (release = resolve)));

      const first = sut.tick();
      const second = sut.tick();
      release(nothing);

      await expect(first).resolves.toEqual(nothing);
      await expect(second).resolves.toEqual(nothing);
      expect(operations.recoverExpiredClaims).toHaveBeenCalledTimes(1);
    });

    it('logs a failed pass instead of throwing, and runs again next time', async () => {
      operations.recoverExpiredClaims.mockRejectedValueOnce(new Error('database went away'));

      await expect(sut.tick()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('database went away'));

      await expect(sut.tick()).resolves.toEqual(nothing);
    });
  });

  describe('onBootstrap', () => {
    it('sweeps at once and then on its interval', async () => {
      vi.useFakeTimers();

      sut.onBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(operations.recoverExpiredClaims).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(MEDIA_OPERATION_SWEEP_MS);
      expect(operations.recoverExpiredClaims).toHaveBeenCalledTimes(2);
    });

    it('stops sweeping on shutdown', async () => {
      vi.useFakeTimers();

      sut.onBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      await sut.onShutdown();
      await vi.advanceTimersByTimeAsync(MEDIA_OPERATION_SWEEP_MS * 2);

      expect(operations.recoverExpiredClaims).toHaveBeenCalledTimes(1);
    });
  });
});
