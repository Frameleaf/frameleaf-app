import { JobName, JobStatus, MediaOperationStatus } from 'src/enum.js';
import { EDIT_NOTHING_PUBLISHED, EditOperationTracker } from 'src/utils/edit-operation-tracker.js';
import { EDIT_OPERATION_REDISPATCH_MS, EditOperationEdit } from 'src/utils/edit-operation.js';

const LEASE_MS = 30_000;

const claimed = {
  operation: { id: 'op-1', ownerId: 'owner-1', assetId: 'asset-1' },
  claimToken: 'token-1',
};

const newOperations = () => ({
  create: vi.fn().mockResolvedValue({ id: 'op-1' }),
  getForWorker: vi.fn().mockResolvedValue({ cancelRequestedAt: null, claimToken: 'token-1' }),
  beginJobQueueRun: vi.fn().mockResolvedValue(claimed),
  heartbeat: vi.fn().mockResolvedValue(true),
  reportProgress: vi.fn().mockResolvedValue(true),
  beginValidation: vi.fn().mockResolvedValue(true),
  complete: vi.fn().mockResolvedValue(true),
  fail: vi.fn().mockResolvedValue('failed'),
  requeue: vi.fn().mockResolvedValue(true),
  requestCancel: vi.fn().mockResolvedValue(undefined),
  acknowledgeCancel: vi.fn().mockResolvedValue(true),
  claimJobQueueDispatch: vi.fn().mockResolvedValue([]),
  releaseJobQueueDispatch: vi.fn().mockResolvedValue(undefined),
  listActiveEditsOfRevision: vi.fn().mockResolvedValue([]),
});

describe(EditOperationTracker.name, () => {
  let operations: ReturnType<typeof newOperations>;
  let jobs: { queue: ReturnType<typeof vi.fn>; queueAll: ReturnType<typeof vi.fn> };
  let logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let sut: EditOperationTracker;

  beforeEach(() => {
    operations = newOperations();
    jobs = { queue: vi.fn().mockResolvedValue(undefined), queueAll: vi.fn().mockResolvedValue(undefined) };
    logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sut = new EditOperationTracker(operations as never, jobs as never, logger as never, LEASE_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('queue', () => {
    it('writes the row, then queues the job carrying its id', async () => {
      await expect(
        sut.queue({
          ownerId: 'owner-1',
          edit: EditOperationEdit.PhotoEdit,
          assetId: 'asset-1',
          label: 'IMG_0001.jpg',
          job: { name: JobName.AssetEditThumbnailGeneration, data: { id: 'asset-1' } },
        }),
      ).resolves.toBe('op-1');

      expect(operations.create.mock.invocationCallOrder[0]).toBeLessThan(jobs.queue.mock.invocationCallOrder[0]);
      expect(jobs.queue).toHaveBeenCalledWith({
        name: JobName.AssetEditThumbnailGeneration,
        data: { id: 'asset-1', operationId: 'op-1' },
      });
    });
  });

  describe('execute', () => {
    it('runs the executor exactly as before when the job names no row', async () => {
      const work = vi.fn().mockResolvedValue(JobStatus.Success);

      await expect(sut.execute(undefined, work)).resolves.toBe(JobStatus.Success);

      expect(work).toHaveBeenCalledWith();
      expect(operations.beginJobQueueRun).not.toHaveBeenCalled();
    });

    it('claims the row, reports the render stage and completes with the edited item', async () => {
      const work = vi.fn().mockImplementation(async (run) => {
        expect(await run.validate()).toBe(true);
        return JobStatus.Success;
      });

      await expect(sut.execute('op-1', work)).resolves.toBe(JobStatus.Success);

      expect(operations.beginJobQueueRun).toHaveBeenCalledWith('op-1', LEASE_MS);
      expect(operations.reportProgress).toHaveBeenCalledWith('op-1', 'token-1', {
        status: MediaOperationStatus.Rendering,
        processedUnits: 0,
        totalUnits: 100,
        progress: 0,
      });
      expect(operations.beginValidation).toHaveBeenCalledTimes(1);
      expect(operations.complete).toHaveBeenCalledWith('op-1', 'token-1', { resultAssetId: 'asset-1' });
    });

    it('completes without a result when there was nothing to publish', async () => {
      await sut.execute('op-1', () => Promise.resolve(JobStatus.Skipped));

      expect(operations.complete).toHaveBeenCalledWith('op-1', 'token-1', {
        resultAssetId: null,
        result: EDIT_NOTHING_PUBLISHED,
      });
    });

    it('fails with the executor’s own reason, with the automatic retry', async () => {
      await sut.execute('op-1', (run) => {
        run!.noteError(new Error('ffmpeg exited with 1'));
        return Promise.resolve(JobStatus.Failed);
      });

      expect(operations.fail).toHaveBeenCalledWith(
        'op-1',
        'token-1',
        { error: 'ffmpeg exited with 1', errorCode: 'edit_render_failed' },
        { retry: true },
      );
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('fails the row and rethrows when the executor throws', async () => {
      await expect(sut.execute('op-1', () => Promise.reject(new Error('disk full')))).rejects.toThrow('disk full');

      expect(operations.fail).toHaveBeenCalledWith(
        'op-1',
        'token-1',
        { error: 'disk full', errorCode: 'edit_render_failed' },
        { retry: true },
      );
    });

    it('does not run a job cancelled while it waited, and says so', async () => {
      operations.beginJobQueueRun.mockResolvedValue(undefined);
      operations.getForWorker.mockResolvedValue({ cancelRequestedAt: new Date(), claimToken: null });
      const work = vi.fn();
      const onCancelled = vi.fn().mockResolvedValue(undefined);

      await expect(sut.execute('op-1', work, { onCancelled })).resolves.toBe(JobStatus.Skipped);

      expect(work).not.toHaveBeenCalled();
      expect(onCancelled).toHaveBeenCalledTimes(1);
    });

    it('does not run a duplicate or stale delivery', async () => {
      operations.beginJobQueueRun.mockResolvedValue(undefined);
      operations.getForWorker.mockResolvedValue({ cancelRequestedAt: null, status: MediaOperationStatus.Completed });
      const work = vi.fn();

      await expect(sut.execute('op-1', work)).resolves.toBe(JobStatus.Skipped);
      expect(work).not.toHaveBeenCalled();
    });
  });

  describe('a run', () => {
    it('refuses to publish once its claim was lost, and writes nothing more', async () => {
      operations.beginValidation.mockResolvedValue(false);
      operations.getForWorker.mockResolvedValue({ cancelRequestedAt: null, claimToken: 'recovered-token' });
      let published = false;

      await sut.execute('op-1', async (run) => {
        if (await run!.validate()) {
          published = true;
        }
        return JobStatus.Skipped;
      });

      expect(published).toBe(false);
      expect(operations.complete).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lost its claim'));
    });

    it('acknowledges a cancel that lands before publishing instead of publishing', async () => {
      operations.beginValidation.mockResolvedValue(false);
      operations.getForWorker.mockResolvedValue({ cancelRequestedAt: new Date(), claimToken: 'token-1' });
      let published = false;

      await sut.execute('op-1', async (run) => {
        if (await run!.validate()) {
          published = true;
        }
        return JobStatus.Skipped;
      });

      expect(published).toBe(false);
      expect(operations.requestCancel).toHaveBeenCalledWith('op-1', 'owner-1', 'token-1');
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith('op-1', 'token-1', { released: true });
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('fails without a retry when the edited item left the library before completion', async () => {
      operations.complete.mockResolvedValue(false);

      await sut.execute('op-1', () => Promise.resolve(JobStatus.Success));

      expect(operations.fail).toHaveBeenCalledWith(
        'op-1',
        'token-1',
        { error: 'The edited item is no longer in this library', errorCode: 'result_not_owned' },
        { retry: false },
      );
    });

    it('heartbeats while it works and stops once settled', async () => {
      vi.useFakeTimers();
      let release!: () => void;
      const running = sut.execute(
        'op-1',
        () => new Promise<JobStatus>((resolve) => (release = () => resolve(JobStatus.Success))),
      );
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(LEASE_MS);
      const beats = operations.heartbeat.mock.calls.length;
      expect(beats).toBeGreaterThanOrEqual(2);
      expect(operations.heartbeat).toHaveBeenCalledWith('op-1', 'token-1', LEASE_MS);

      release();
      await running;
      await vi.advanceTimersByTimeAsync(LEASE_MS * 2);
      expect(operations.heartbeat).toHaveBeenCalledTimes(beats);
    });

    it('treats a refused heartbeat as a lost claim', async () => {
      vi.useFakeTimers();
      operations.heartbeat.mockResolvedValue(false);
      let release!: () => void;
      let validated: boolean | undefined;
      const running = sut.execute('op-1', async (run) => {
        await new Promise<void>((resolve) => (release = resolve));
        validated = await run!.validate();
        return JobStatus.Skipped;
      });
      await vi.advanceTimersByTimeAsync(LEASE_MS);

      release();
      await running;

      expect(validated).toBe(false);
      expect(operations.beginValidation).not.toHaveBeenCalled();
    });

    it('hands the row back without using an attempt', async () => {
      await sut.execute('op-1', async (run) => {
        await run!.release(60_000);
        return JobStatus.Skipped;
      });

      expect(operations.requeue).toHaveBeenCalledWith('op-1', 'token-1', { delayMs: 60_000, returnAttempt: true });
      expect(operations.complete).not.toHaveBeenCalled();
    });
  });

  describe('dispatch', () => {
    it('asks for rows without a job, and rows whose job the queue lost', async () => {
      await expect(sut.dispatch(10)).resolves.toBe(0);

      expect(operations.claimJobQueueDispatch).toHaveBeenCalledWith({
        limit: 10,
        staleMs: EDIT_OPERATION_REDISPATCH_MS,
      });
      expect(jobs.queueAll).not.toHaveBeenCalled();
    });
  });

  describe('cancelRevision', () => {
    it('cancels every unfinished job of the photo version for its owner', async () => {
      operations.listActiveEditsOfRevision.mockResolvedValue([{ id: 'op-1' }, { id: 'op-2' }]);

      await sut.cancelRevision('owner-1', 'revision-1');

      expect(operations.listActiveEditsOfRevision).toHaveBeenCalledWith('owner-1', 'revision-1');
      expect(operations.requestCancel).toHaveBeenCalledWith('op-1', 'owner-1');
      expect(operations.requestCancel).toHaveBeenCalledWith('op-2', 'owner-1');
    });
  });
});
