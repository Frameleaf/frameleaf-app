import { ModuleRef } from '@nestjs/core';
import { JobsOptions } from 'bullmq';
import { JobName, QueueJobStatus, QueueName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository, getForkSchemaBackfillJobOptions } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { JobItem } from 'src/types.js';

const mocks = vi.hoisted(() => ({
  worker: vi.fn(function () {
    return { on: vi.fn() };
  }),
}));

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Worker: mocks.worker,
}));

/**
 * Drives the worker `completed` listener directly. startWorkers() registers
 * one Worker per queue; each Worker mock captures its `on(event, handler)`
 * calls so we can replay synthetic completion events.
 */
const completedHandlerFor = (queueName: QueueName): ((job: Record<string, unknown>) => void) => {
  const workerCalls = mocks.worker.mock.calls as unknown as Array<[QueueName, unknown, unknown]>;
  const idx = workerCalls.findIndex(([qn]) => qn === queueName);
  if (idx === -1) {
    throw new Error(`Worker for ${queueName} was never created`);
  }
  const workerInstance = mocks.worker.mock.results[idx].value as { on: ReturnType<typeof vi.fn> };
  const onCalls = workerInstance.on.mock.calls as unknown as Array<[string, (job: any) => void]>;
  const completed = onCalls.find(([event]) => event === 'completed');
  if (!completed) {
    throw new Error(`No completed listener registered for ${queueName}`);
  }
  return completed[1];
};

describe(JobRepository.name, () => {
  let sut: JobRepository;

  beforeEach(() => {
    mocks.worker.mockClear();

    sut = new JobRepository(
      {} as ModuleRef,
      {
        getEnv: () => ({
          bull: {
            config: {
              connection: {},
              prefix: 'immich_bull',
            },
          },
        }),
      } as ConfigRepository,
      {} as EventRepository,
      {
        debug: vi.fn(),
        error: vi.fn(),
        setContext: vi.fn(),
        warn: vi.fn(),
      } as unknown as LoggingRepository,
    );
  });

  describe('searchJobs', () => {
    it("returns each job's attempts and a failed job's last error (FL-71)", async () => {
      const getJobs = vi.fn().mockResolvedValue([
        {
          id: '1',
          name: JobName.AssetDetectFaces,
          timestamp: 1000,
          data: { id: 'asset-1' },
          attemptsMade: 3,
          failedReason: 'Machine learning is unreachable',
        },
        { id: '2', name: JobName.AssetDetectFaces, timestamp: 2000, data: {}, attemptsMade: 0, failedReason: '' },
      ]);
      const moduleRef = { get: vi.fn().mockReturnValue({ getJobs }) } as unknown as ModuleRef;
      const repository = new JobRepository(
        moduleRef,
        {} as ConfigRepository,
        {} as EventRepository,
        { setContext: vi.fn() } as unknown as LoggingRepository,
      );

      await expect(repository.searchJobs(QueueName.FaceDetection, { status: [] })).resolves.toEqual([
        {
          status: QueueJobStatus.Waiting,
          id: '1',
          name: JobName.AssetDetectFaces,
          timestamp: 1000,
          data: { id: 'asset-1' },
          attemptsMade: 3,
          failedReason: 'Machine learning is unreachable',
        },
        {
          status: QueueJobStatus.Waiting,
          id: '2',
          name: JobName.AssetDetectFaces,
          timestamp: 2000,
          data: {},
          attemptsMade: 0,
        },
      ]);
    });

    it('reports the requested status, or infers it from the job when several were asked for (FL-71)', async () => {
      const job = (overrides: Record<string, unknown>) => ({
        id: '1',
        name: JobName.AssetDetectFaces,
        timestamp: Date.now(),
        data: {},
        attemptsMade: 1,
        delay: 0,
        ...overrides,
      });
      const getJobs = vi
        .fn()
        .mockResolvedValue([
          job({ finishedOn: 1, failedReason: 'boom' }),
          job({ finishedOn: 1 }),
          job({ processedOn: 1 }),
          job({ delay: 60_000 }),
          job({}),
        ]);
      const moduleRef = { get: vi.fn().mockReturnValue({ getJobs }) } as unknown as ModuleRef;
      const repository = new JobRepository(
        moduleRef,
        {} as ConfigRepository,
        {} as EventRepository,
        { setContext: vi.fn() } as unknown as LoggingRepository,
      );

      const inferred = await repository.searchJobs(QueueName.FaceDetection, {});
      expect(inferred.map(({ status }) => status)).toEqual([
        QueueJobStatus.Failed,
        QueueJobStatus.Complete,
        QueueJobStatus.Active,
        QueueJobStatus.Delayed,
        QueueJobStatus.Waiting,
      ]);
      const requested = await repository.searchJobs(QueueName.FaceDetection, { status: [QueueJobStatus.Paused] });
      expect(requested.every(({ status }) => status === QueueJobStatus.Paused)).toBe(true);
      expect(getJobs).toHaveBeenLastCalledWith([QueueJobStatus.Paused], 0, 999);
    });

    it('cuts a long last error to 500 characters', async () => {
      const getJobs = vi.fn().mockResolvedValue([
        {
          id: '1',
          name: JobName.AssetDetectFaces,
          timestamp: 1000,
          data: {},
          attemptsMade: 1,
          failedReason: 'x'.repeat(2000),
        },
      ]);
      const moduleRef = { get: vi.fn().mockReturnValue({ getJobs }) } as unknown as ModuleRef;
      const repository = new JobRepository(
        moduleRef,
        {} as ConfigRepository,
        {} as EventRepository,
        { setContext: vi.fn() } as unknown as LoggingRepository,
      );

      const [job] = await repository.searchJobs(QueueName.FaceDetection, { status: [] });
      expect(job.failedReason).toHaveLength(500);
    });

    it('never returns the data of a signup notice or its mail, which carry a password (FL-71)', async () => {
      const getJobs = vi.fn().mockResolvedValue([
        {
          id: '1',
          name: JobName.NotifyUserSignup,
          timestamp: 1,
          data: { id: 'u', password: 'secret' },
          attemptsMade: 1,
        },
        { id: '2', name: JobName.SendMail, timestamp: 1, data: { html: 'secret', text: 'secret' }, attemptsMade: 1 },
        { id: '3', name: JobName.AssetDetectFaces, timestamp: 1, data: { id: 'asset-1' }, attemptsMade: 1 },
      ]);
      const moduleRef = { get: vi.fn().mockReturnValue({ getJobs }) } as unknown as ModuleRef;
      const repository = new JobRepository(
        moduleRef,
        {} as ConfigRepository,
        {} as EventRepository,
        { setContext: vi.fn() } as unknown as LoggingRepository,
      );

      const jobs = await repository.searchJobs(QueueName.Notification, { status: [QueueJobStatus.Failed] });
      expect(jobs.map(({ data }) => data)).toEqual([{}, {}, { id: 'asset-1' }]);
      expect(JSON.stringify(jobs)).not.toContain('secret');
    });
  });

  it('should use a longer lock for the database backup worker', () => {
    sut.startWorkers();

    const workerCalls = mocks.worker.mock.calls as unknown as Array<[QueueName, unknown, Record<string, unknown>]>;
    const backupWorkerCall = workerCalls.find(([queueName]) => queueName === QueueName.BackupDatabase);
    const backgroundWorkerCall = workerCalls.find(([queueName]) => queueName === QueueName.BackgroundTask);

    expect(backupWorkerCall?.[2]).toMatchObject({
      concurrency: 1,
      lockDuration: 30 * 60_000,
      lockRenewTime: 15 * 60_000,
    });
    expect(backgroundWorkerCall?.[2]).not.toHaveProperty('lockDuration');
    expect(mocks.worker).toHaveBeenCalled();
  });

  it('deduplicates fork schema batches per kind', () => {
    const getJobOptions = (sut as unknown as { getJobOptions(item: JobItem): JobsOptions | null }).getJobOptions.bind(
      sut,
    );

    expect(getJobOptions({ name: JobName.ICloudSync, data: { id: 'connection' } })).toEqual({
      deduplication: { id: `${JobName.ICloudSync}:connection`, keepLastIfActive: true },
    });
    expect(getJobOptions({ name: JobName.ForkSchemaBackfill, data: { kind: 'privacy', batchSize: 100 } })).toEqual({
      deduplication: { id: `${JobName.ForkSchemaBackfill}:privacy`, keepLastIfActive: true },
    });
    expect(getJobOptions({ name: JobName.ForkSchemaBackfill, data: { kind: 'albums', batchSize: 100 } })).toEqual({
      deduplication: { id: `${JobName.ForkSchemaBackfill}:albums`, keepLastIfActive: true },
    });
    expect(getForkSchemaBackfillJobOptions('privacy')).toEqual({
      deduplication: { id: `${JobName.ForkSchemaBackfill}:privacy`, keepLastIfActive: true },
    });
  });

  describe('jobs that are never retried (FL-71)', () => {
    const queueWith = () => {
      const queue = { add: vi.fn(), addBulk: vi.fn() };
      const repository = new JobRepository(
        { get: vi.fn().mockReturnValue(queue) } as unknown as ModuleRef,
        {} as ConfigRepository,
        {} as EventRepository,
        { setContext: vi.fn() } as unknown as LoggingRepository,
      );
      // one queue is enough here; the handlers that map a job to its queue are not registered
      vi.spyOn(repository as unknown as { getQueueName(): QueueName }, 'getQueueName').mockReturnValue(
        QueueName.BackgroundTask,
      );
      return { queue, repository };
    };

    it('are queued with removeOnFail, so a stalled or failed one is not kept either', async () => {
      const { queue, repository } = queueWith();

      await repository.queueAll([
        { name: JobName.NotifyUserSignup, data: { id: 'user-1', password: 'secret' } },
        { name: JobName.FacialRecognition, data: { id: 'face-1' } },
        { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
      ]);

      expect(queue.addBulk.mock.calls.flatMap(([jobs]) => jobs)).toEqual(
        expect.arrayContaining([
          { name: JobName.NotifyUserSignup, data: expect.anything(), opts: { removeOnFail: true } },
          { name: JobName.FacialRecognition, data: expect.anything(), opts: { removeOnFail: true } },
          { name: JobName.AssetGenerateThumbnails, data: expect.anything(), opts: undefined },
        ]),
      );
    });

    it('keep their own options next to removeOnFail', async () => {
      const { queue, repository } = queueWith();

      await repository.queue({ name: JobName.StorageTemplateMigrationSingle, data: { id: 'asset-1' } });
      await repository.queue({ name: JobName.NotifyAlbumUpdate, data: { id: 'album-1', recipientId: 'user-1' } });

      expect(queue.add).toHaveBeenCalledWith(JobName.StorageTemplateMigrationSingle, expect.anything(), {
        jobId: 'asset-1',
        removeOnFail: true,
      });
      expect(queue.add).toHaveBeenCalledWith(JobName.NotifyAlbumUpdate, expect.anything(), {
        jobId: 'album-1/user-1',
        delay: undefined,
        removeOnFail: true,
      });
    });

    it('queues person thumbnails without a priority, which would hide them from the waiting counts', async () => {
      const { queue, repository } = queueWith();

      await repository.queueAll([
        { name: JobName.PersonGenerateThumbnail, data: { ownerId: 'user-1', personGroupId: 'group-1' } },
      ]);

      expect(queue.addBulk).toHaveBeenCalledWith([
        { name: JobName.PersonGenerateThumbnail, data: expect.anything(), opts: undefined },
      ]);
    });
  });

  describe('getRollingAvgMs (job completion telemetry)', () => {
    it('returns null when no samples have been recorded', () => {
      sut.startWorkers();
      expect(sut.getRollingAvgMs(JobName.ImageDescription)).toBeNull();
    });

    it('averages recorded completion durations', () => {
      sut.startWorkers();
      const handler = completedHandlerFor(QueueName.ImageDescription);

      handler({ name: JobName.ImageDescription, processedOn: 1000, finishedOn: 2000 });
      handler({ name: JobName.ImageDescription, processedOn: 5000, finishedOn: 7000 });
      handler({ name: JobName.ImageDescription, processedOn: 10_000, finishedOn: 13_000 });

      // (1000 + 2000 + 3000) / 3 = 2000
      expect(sut.getRollingAvgMs(JobName.ImageDescription)).toBe(2000);
    });

    it('caps the buffer at 100 samples (oldest dropped first)', () => {
      sut.startWorkers();
      const handler = completedHandlerFor(QueueName.ImageDescription);

      // Push 105 samples: 5 quick (100ms) then 100 slow (1000ms). After
      // ROLLING_AVG_BUFFER_SIZE=100 fills, the 5 quick ones get dropped and
      // only the 100 slow ones remain -> avg = 1000.
      for (let i = 0; i < 5; i++) {
        handler({ name: JobName.ImageDescription, processedOn: 0, finishedOn: 100 });
      }
      for (let i = 0; i < 100; i++) {
        handler({ name: JobName.ImageDescription, processedOn: 0, finishedOn: 1000 });
      }

      expect(sut.getRollingAvgMs(JobName.ImageDescription)).toBe(1000);
    });

    it('ignores events with missing or inverted timestamps', () => {
      sut.startWorkers();
      const handler = completedHandlerFor(QueueName.ImageDescription);

      handler({ name: JobName.ImageDescription, processedOn: undefined, finishedOn: 1000 });
      handler({ name: JobName.ImageDescription, processedOn: 1000, finishedOn: undefined });
      handler({ name: JobName.ImageDescription, processedOn: 2000, finishedOn: 1000 });

      expect(sut.getRollingAvgMs(JobName.ImageDescription)).toBeNull();

      handler({ name: JobName.ImageDescription, processedOn: 0, finishedOn: 500 });
      expect(sut.getRollingAvgMs(JobName.ImageDescription)).toBe(500);
    });

    it('keeps buffers per job name', () => {
      sut.startWorkers();
      const imageDescriptionHandler = completedHandlerFor(QueueName.ImageDescription);
      const ocrHandler = completedHandlerFor(QueueName.Ocr);

      imageDescriptionHandler({ name: JobName.ImageDescription, processedOn: 0, finishedOn: 1000 });
      ocrHandler({ name: JobName.Ocr, processedOn: 0, finishedOn: 5000 });

      expect(sut.getRollingAvgMs(JobName.ImageDescription)).toBe(1000);
      expect(sut.getRollingAvgMs(JobName.Ocr)).toBe(5000);
    });
  });
});
