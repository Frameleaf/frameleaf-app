import { BadRequestException } from '@nestjs/common';
import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import {
  AssetType,
  DatabaseLock,
  FrameleafWorker,
  JobName,
  MlDestinationKind,
  MlWorkload,
  QueueCommand,
  QueueJobStatus,
  QueueJobWorkerKind,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { QueueService } from 'src/services/queue.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(QueueService.name, () => {
  let sut: QueueService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(QueueService));

    mocks.config.getWorker.mockReturnValue(FrameleafWorker.Microservices);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onShutdown (FL-291)', () => {
    it('stops the workers, handing back what is still running, whoever closes the app', async () => {
      mocks.job.stopWorkers.mockResolvedValue();
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ shutdown: { graceMs: 12_000, deadlineMs: 20_000, workerDeadlineMs: 19_000 } }),
      );

      await sut.onShutdown();

      expect(mocks.job.teardown).toHaveBeenCalledOnce();
      expect(mocks.job.stopWorkers).toHaveBeenCalledWith(12_000);
    });
  });

  describe('onConfigUpdate', () => {
    it('should update concurrency', () => {
      sut.onConfigUpdate({ newConfig: defaults, oldConfig: {} as SystemConfig });

      expect(mocks.job.setConcurrency).toHaveBeenCalledTimes(25);
      expect(mocks.job.setConcurrency).toHaveBeenNthCalledWith(5, QueueName.FacialRecognition, 1);
      expect(mocks.job.setConcurrency).toHaveBeenNthCalledWith(7, QueueName.DuplicateDetection, 1);
      expect(mocks.job.setConcurrency).toHaveBeenNthCalledWith(8, QueueName.VideoDuplicateDetection, 1);
      expect(mocks.job.setConcurrency).toHaveBeenNthCalledWith(9, QueueName.BackgroundTask, 5);
      expect(mocks.job.setConcurrency).toHaveBeenNthCalledWith(10, QueueName.StorageTemplateMigration, 1);
    });

    it('applies the job capacity setting live (FL-1265)', () => {
      sut.onConfigUpdate({ newConfig: { ...defaults, job: { ...defaults.job, capacity: 12 } }, oldConfig: defaults });

      expect(mocks.job.setExecutionCapacity).toHaveBeenCalledWith(12);
    });
  });

  describe('handleNightlyJobs', () => {
    beforeEach(() => {
      mocks.job.queueSelection.mockImplementation((_name, selection) => {
        if (typeof selection === 'function') selection(null);
        return Promise.resolve({ runId: factory.uuid(), inserted: 0 });
      });
      mocks.assetJob.selectionForUnfinished.mockReturnValue({} as never);
      mocks.job.getQueueName.mockReturnValue(QueueName.BackgroundTask);
      mocks.systemMetadata.set.mockResolvedValue();
    });

    it('reconciles missing outputs even on nights without the tidy-up', async () => {
      mocks.job.queueSelection.mockImplementation((_name, selection) => {
        if (typeof selection === 'function') selection(null);
        return Promise.resolve({ runId: factory.uuid(), inserted: 3 });
      });
      await sut.handleNightlyJobs({ cleanup: false });

      expect(mocks.assetJob.selectionForUnfinished.mock.calls.map(([name]) => name)).toEqual([
        JobName.AssetExtractMetadata,
        JobName.AssetGenerateThumbnails,
        JobName.AssetEncodeVideo,
        JobName.SmartSearch,
        JobName.AssetDetectFaces,
        JobName.Ocr,
      ]);
      for (const name of [JobName.AssetExtractMetadata, JobName.AssetGenerateThumbnails]) {
        expect(mocks.job.queueSelection).toHaveBeenCalledWith(
          name,
          expect.any(Function),
          { reconcileUnfinished: true },
          1000,
        );
      }
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.ProcessingReconcileLastRun, {
        completedAt: expect.any(String),
        metadata: 3,
        thumbnails: 3,
        video: 3,
        search: 3,
        faces: 3,
        text: 3,
      });
    });

    it('only reconciles local processing when machine learning is off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });
      await sut.handleNightlyJobs();
      expect(mocks.assetJob.selectionForUnfinished.mock.calls.map(([name]) => name)).toEqual([
        JobName.AssetExtractMetadata,
        JobName.AssetGenerateThumbnails,
        JobName.AssetEncodeVideo,
      ]);
    });

    it('leaves unfinished work alone when the overnight setting is off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ nightlyTasks: { reprocessUnfinished: false } });
      await sut.handleNightlyJobs();
      expect(mocks.job.queueSelection).not.toHaveBeenCalled();
    });

    it('should run the scheduled jobs', async () => {
      await sut.handleNightlyJobs();

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetDeleteCheck },
        { name: JobName.UserDeleteCheck },
        { name: JobName.PersonCleanup },
        { name: JobName.MemoryCleanup },
        { name: JobName.SessionCleanup },
        { name: JobName.HlsSessionCleanup },
        { name: JobName.AuditTableCleanup },
        { name: JobName.MemoryGenerate },
        { name: JobName.UserSyncUsage },
        { name: JobName.AssetGenerateThumbnailsQueueAll, data: { force: false } },
        { name: JobName.FacialRecognitionQueueAll, data: { force: false, nightly: true } },
        { name: JobName.AnalyticsCollect },
        { name: JobName.PushBackupStaleCheck },
      ]);
    });

    it('leaves the analytics collector out when local metrics are off (FL-71)', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ analytics: { enabled: false, historyDays: 730 } });

      await sut.handleNightlyJobs();

      expect(mocks.job.queueAll).toHaveBeenCalledWith(expect.not.arrayContaining([{ name: JobName.AnalyticsCollect }]));
    });

    it('leaves Trash alone while emptying it is off (FL-363)', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ nightlyTasks: { emptyTrash: false } });

      await sut.handleNightlyJobs();

      const [jobs] = mocks.job.queueAll.mock.calls[0];
      expect(jobs).not.toContainEqual({ name: JobName.AssetDeleteCheck });
      expect(jobs).not.toContainEqual({ name: JobName.UserDeleteCheck });
      expect(jobs).toContainEqual({ name: JobName.PersonCleanup });
    });

    it('queues only the nightly counts on a night the tidy-up does not run (FL-363)', async () => {
      await sut.handleNightlyJobs({ cleanup: false });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AnalyticsCollect },
        { name: JobName.PushBackupStaleCheck },
      ]);
    });
  });

  describe('getAllJobStatus', () => {
    it('reports durable unfinished work even with an empty execution buffer', async () => {
      const statistics = factory.queueStatistics();
      mocks.job.getJobCounts.mockResolvedValue(statistics);
      mocks.job.isPaused.mockResolvedValue(true);
      mocks.job.hasUnfinishedWork.mockResolvedValue(true);

      await expect(sut.get(factory.auth(), QueueName.Library)).resolves.toEqual({
        name: QueueName.Library,
        isPaused: true,
        statistics,
        hasUnfinishedWork: true,
      });
      expect(mocks.job.hasUnfinishedWork).toHaveBeenCalledExactlyOnceWith(QueueName.Library);
    });

    it('reads paused and unfinished state once for every queue, not once per queue', async () => {
      const statistics = factory.queueStatistics();
      mocks.job.getJobCounts.mockResolvedValue(statistics);
      mocks.job.getPausedQueues.mockResolvedValue(new Set([QueueName.Library]));
      mocks.job.getQueuesWithUnfinishedWork.mockResolvedValue(new Set([QueueName.SmartSearch]));

      const queues = await sut.getAll(factory.auth());

      expect(queues).toHaveLength(Object.values(QueueName).length);
      expect(queues.find(({ name }) => name === QueueName.Library)).toEqual({
        name: QueueName.Library,
        isPaused: true,
        statistics,
        hasUnfinishedWork: false,
      });
      expect(queues.find(({ name }) => name === QueueName.SmartSearch)).toMatchObject({
        isPaused: false,
        hasUnfinishedWork: true,
      });
      expect(mocks.job.getPausedQueues).toHaveBeenCalledOnce();
      expect(mocks.job.getQueuesWithUnfinishedWork).toHaveBeenCalledExactlyOnceWith(Object.values(QueueName));
      expect(mocks.job.isPaused).not.toHaveBeenCalled();
      expect(mocks.job.hasUnfinishedWork).not.toHaveBeenCalled();
    });

    it('bounds queue snapshots to four and retains queue order', async () => {
      const names = Object.values(QueueName);
      const releases: (() => void)[] = [];
      let active = 0;
      let maximum = 0;
      mocks.job.getJobCounts.mockImplementation(async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        active--;
        return factory.queueStatistics();
      });
      mocks.job.isPaused.mockResolvedValue(false);
      mocks.job.hasUnfinishedWork.mockResolvedValue(false);
      const result = sut.getAll(factory.auth());
      for (let offset = 0; offset < names.length; offset += 4) {
        await vi.waitFor(() => expect(releases).toHaveLength(Math.min(offset + 4, names.length)));
        expect(maximum).toBeLessThanOrEqual(4);
        for (const release of releases.slice(offset, offset + 4).toReversed()) {
          release();
        }
      }
      expect((await result).map(({ name }) => name)).toEqual(names);
      expect(maximum).toBe(4);
    });

    it('settles its admitted snapshot batch before propagating an error and starts no later batch', async () => {
      const error = new Error('database unavailable');
      const releases: (() => void)[] = [];
      mocks.job.getJobCounts.mockImplementation(async (name) => {
        if (name === Object.values(QueueName)[0]) {
          throw error;
        }
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return factory.queueStatistics();
      });
      mocks.job.isPaused.mockResolvedValue(false);
      mocks.job.hasUnfinishedWork.mockResolvedValue(false);
      let returned = false;
      const result = sut.getAll(factory.auth()).catch((error_) => {
        returned = true;
        throw error_;
      });
      const rejected = expect(result).rejects.toBe(error);
      await vi.waitFor(() => expect(releases).toHaveLength(3));
      expect(returned).toBe(false);
      for (const release of releases) {
        release();
      }
      await rejected;
      expect(mocks.job.getJobCounts).toHaveBeenCalledTimes(4);
    });

    it('should get all job statuses', async () => {
      const stats = factory.queueStatistics({ active: 1 });
      const expected = { jobCounts: stats, queueStatus: { isActive: true, isPaused: true } };

      mocks.job.getJobCounts.mockResolvedValue(stats);
      mocks.job.getPausedQueues.mockResolvedValue(new Set(Object.values(QueueName)));

      await expect(sut.getAllLegacy(factory.auth())).resolves.toEqual({
        [QueueName.BackgroundTask]: expected,
        [QueueName.DuplicateDetection]: expected,
        [QueueName.VideoDuplicateDetection]: expected,
        [QueueName.SmartSearch]: expected,
        [QueueName.MetadataExtraction]: expected,
        [QueueName.Search]: expected,
        [QueueName.StorageTemplateMigration]: expected,
        [QueueName.Migration]: expected,
        [QueueName.ThumbnailGeneration]: expected,
        [QueueName.VideoConversion]: expected,
        [QueueName.FaceDetection]: expected,
        [QueueName.FacialRecognition]: expected,
        [QueueName.Sidecar]: expected,
        [QueueName.Library]: expected,
        [QueueName.MediaHealth]: expected,
        [QueueName.Notification]: expected,
        [QueueName.BackupDatabase]: expected,
        [QueueName.Ocr]: expected,
        [QueueName.ImageEnrichment]: expected,
        [QueueName.ImageDescription]: expected,
        [QueueName.NsfwDetection]: expected,
        [QueueName.Workflow]: expected,
        [QueueName.IntegrityCheck]: expected,
        [QueueName.Editor]: expected,
        [QueueName.PetRecognition]: expected,
      });
    });
  });

  describe('handleCommand', () => {
    it('should handle a pause command', async () => {
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.MetadataExtraction, { command: QueueCommand.Pause, force: false });

      expect(mocks.job.pause).toHaveBeenCalledWith(QueueName.MetadataExtraction);
    });

    it('should handle a resume command', async () => {
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.MetadataExtraction, { command: QueueCommand.Resume, force: false });

      expect(mocks.job.resume).toHaveBeenCalledWith(QueueName.MetadataExtraction);
      expect(mocks.job.setQueueSchedule).toHaveBeenCalledWith(QueueName.MetadataExtraction, null);
      expect(mocks.event.emit).toHaveBeenCalledWith('QueueResumed', { queue: QueueName.MetadataExtraction });
    });

    it('stops quiet hours holding a queue the administrator resumes (FL-711)', async () => {
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());
      mocks.systemMetadata.get.mockResolvedValue({
        run: null,
        nights: [],
        quiet: { holding: [QueueName.VideoConversion, QueueName.SmartSearch] },
      });

      await sut.update(authStub.admin, QueueName.VideoConversion, { isPaused: false });

      expect(mocks.job.resume).toHaveBeenCalledWith(QueueName.VideoConversion);
      expect(mocks.job.setQueueSchedule).toHaveBeenCalledWith(QueueName.VideoConversion, null);
      expect(mocks.event.emit).toHaveBeenCalledWith('QueueResumed', { queue: QueueName.VideoConversion });
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.OvernightSequence, {
        run: null,
        nights: [],
        quiet: { holding: [QueueName.SmartSearch] },
      });
    });

    it('resumes a held queue under the quiet hours lock, before the hold is released (FL-711)', async () => {
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());
      mocks.systemMetadata.get.mockResolvedValue({
        run: null,
        nights: [],
        quiet: { holding: [QueueName.VideoConversion] },
      });
      const calls: string[] = [];
      let locked = false;
      mocks.database.withLock.mockImplementation(async (lock, fn) => {
        calls.push(`lock:${lock}`);
        locked = true;
        try {
          return await fn();
        } finally {
          locked = false;
          calls.push('unlock');
        }
      });
      mocks.job.resume.mockImplementation(() => {
        calls.push(`resume:${locked}`);
        return Promise.resolve();
      });
      mocks.job.setQueueSchedule.mockImplementation(() => {
        calls.push(`open:${locked}`);
        return Promise.resolve();
      });
      mocks.systemMetadata.set.mockImplementation(() => {
        calls.push(`release:${locked}`);
        return Promise.resolve();
      });

      await sut.runCommandLegacy(QueueName.VideoConversion, { command: QueueCommand.Resume, force: false });

      expect(calls).toEqual([
        `lock:${DatabaseLock.OvernightSequenceRun}`,
        'resume:true',
        'open:true',
        'release:true',
        'unlock',
      ]);
    });

    it('does not resume a queue when the quiet hours lock cannot be taken', async () => {
      mocks.database.withLock.mockRejectedValue(new Error('lock failed'));

      await expect(sut.update(authStub.admin, QueueName.VideoConversion, { isPaused: false })).rejects.toThrow(
        'lock failed',
      );

      expect(mocks.job.resume).not.toHaveBeenCalled();
      expect(mocks.job.setQueueSchedule).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('QueueResumed', expect.anything());
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('leaves the quiet hours record alone when the resumed queue is not held', async () => {
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());
      mocks.systemMetadata.get.mockResolvedValue({ run: null, nights: [], quiet: { holding: null } });

      await sut.runCommandLegacy(QueueName.VideoConversion, { command: QueueCommand.Resume, force: false });

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should handle an empty command', async () => {
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.MetadataExtraction, { command: QueueCommand.Empty, force: false });

      expect(mocks.job.empty).toHaveBeenCalledWith(QueueName.MetadataExtraction);
    });

    it('should not start a job that is already running', async () => {
      mocks.job.isActive.mockResolvedValue(true);

      await expect(
        sut.runCommandLegacy(QueueName.VideoConversion, { command: QueueCommand.Start, force: false }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should handle a start video conversion command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await expect(
        sut.runCommandLegacy(QueueName.VideoConversion, { command: QueueCommand.Start, force: false }),
      ).resolves.toMatchObject({ runId: 'test-run' });
      expect(mocks.job.createRun).toHaveBeenCalledWith(
        QueueName.VideoConversion,
        { force: false },
        expect.any(Function),
      );

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetEncodeVideoQueueAll, data: { force: false } });
    });

    it('should handle a start storage template migration command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.StorageTemplateMigration, { command: QueueCommand.Start, force: false });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.StorageTemplateMigration });
    });

    it('should handle a start smart search command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.SmartSearch, { command: QueueCommand.Start, force: false });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SmartSearchQueueAll, data: { force: false } });
    });

    it('should handle a start enhanced video duplicate detection command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.VideoDuplicateDetection, { command: QueueCommand.Start, force: true });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetVideoFingerprintQueueAll,
        data: { force: true },
      });
    });

    it('should handle a start metadata extraction command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.MetadataExtraction, { command: QueueCommand.Start, force: false });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadataQueueAll,
        data: { force: false },
      });
    });

    it('should handle a start sidecar command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.Sidecar, { command: QueueCommand.Start, force: false });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SidecarQueueAll, data: { force: false } });
    });

    it('should handle a start thumbnail generation command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.ThumbnailGeneration, { command: QueueCommand.Start, force: false });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetGenerateThumbnailsQueueAll,
        data: { force: false },
      });
    });

    it('should handle a start face detection command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.FaceDetection, { command: QueueCommand.Start, force: false });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetDetectFacesQueueAll, data: { force: false } });
    });

    it('should handle a start facial recognition command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.FacialRecognition, { command: QueueCommand.Start, force: false });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FacialRecognitionQueueAll, data: { force: false } });
    });

    it('should handle a start backup database command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.BackupDatabase, { command: QueueCommand.Start, force: false });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.DatabaseBackup, data: { force: false } });
    });

    it('should handle a start media health command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());

      await sut.runCommandLegacy(QueueName.MediaHealth, { command: QueueCommand.Start, force: false });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.MediaHealthScanMissing, data: { force: false } });
    });

    it('should handle a start NSFW detection command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: false } },
      });

      await sut.runCommandLegacy(QueueName.NsfwDetection, { command: QueueCommand.Start, force: false });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.NsfwDetectionQueueAll, data: { force: false } });
    });

    it('should handle a start image description command', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics());
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { nsfwDetection: { enabled: false }, imageDescription: { enabled: true } },
      });

      await sut.runCommandLegacy(QueueName.ImageDescription, { command: QueueCommand.Start, force: true });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.ImageDescriptionQueueAll, data: { force: true } });
    });

    it('should reject disabled image description queue starts', async () => {
      mocks.job.isActive.mockResolvedValue(false);
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { nsfwDetection: { enabled: true }, imageDescription: { enabled: false } },
      });

      await expect(
        sut.runCommandLegacy(QueueName.ImageDescription, { command: QueueCommand.Start, force: false }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should throw a bad request when an invalid queue is used', async () => {
      mocks.job.isActive.mockResolvedValue(false);

      await expect(
        sut.runCommandLegacy(QueueName.BackgroundTask, { command: QueueCommand.Start, force: false }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });

  describe('searchJobs (FL-71 Account and Worker columns)', () => {
    const assetId = '6f1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a01';
    const personId = '0f1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a02';
    const ownerId = 'af1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a03';
    const job = (overrides: Record<string, unknown> = {}) => ({
      id: '1',
      name: JobName.SmartSearch,
      timestamp: 1,
      data: { id: assetId },
      status: QueueJobStatus.Waiting,
      ...overrides,
    });

    it('keeps internal landmark inference jobs out of the public queue response', async () => {
      mocks.job.searchJobs.mockResolvedValue([job({ name: JobName.LandmarkInfer })]);
      mocks.user.getJobSubjectOwners.mockResolvedValue([]);
      await expect(sut.searchJobs(factory.auth(), QueueName.BackgroundTask, {})).resolves.toEqual([]);
      expect(mocks.job.searchJobs).toHaveBeenCalledWith(QueueName.BackgroundTask, {}, undefined, true);
      expect(mocks.user.getJobSubjectOwners).not.toHaveBeenCalled();
    });

    it('names the server as the worker of a queue that does not call machine learning', async () => {
      mocks.job.searchJobs.mockResolvedValue([job({ name: JobName.AssetGenerateThumbnails })]);
      mocks.user.getJobSubjectOwners.mockResolvedValue([{ subjectId: assetId, ownerId, ownerName: 'Ada' }]);

      await expect(sut.searchJobs(factory.auth(), QueueName.ThumbnailGeneration, {})).resolves.toEqual([
        expect.objectContaining({
          name: JobName.AssetGenerateThumbnails,
          account: { id: ownerId, name: 'Ada' },
          worker: { kind: QueueJobWorkerKind.Server, name: null },
        }),
      ]);
      expect(mocks.mlDestination.getRoute).not.toHaveBeenCalled();
      expect(mocks.mlDestination.getLatestJobDestinations).not.toHaveBeenCalled();
    });

    it('names the routed destination for a waiting job and the accounted one for a finished job', async () => {
      mocks.job.searchJobs.mockResolvedValue([
        job({ id: '1', status: QueueJobStatus.Waiting }),
        job({ id: '2', status: QueueJobStatus.Failed, data: { id: personId } }),
      ]);
      mocks.user.getJobSubjectOwners.mockResolvedValue([]);
      mocks.mlDestination.getRoute.mockResolvedValue({
        workload: MlWorkload.Clip,
        destinationId: mlDestinationStub.local.id,
        modelId: null,
        updatedAt: new Date(),
      });
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.local);
      mocks.mlDestination.getLatestJobDestinations.mockResolvedValue([
        {
          jobId: personId,
          jobName: JobName.SmartSearch,
          destinationKind: MlDestinationKind.FrameleafCloud,
          destinationName: 'Frameleaf Cloud',
        },
      ]);

      const result = await sut.searchJobs(factory.auth(), QueueName.SmartSearch, {});

      expect(mocks.mlDestination.getRoute).toHaveBeenCalledWith(MlWorkload.Clip);
      expect(mocks.mlDestination.getLatestJobDestinations).toHaveBeenCalledWith([personId], [JobName.SmartSearch]);
      expect(result[0].worker).toEqual({ kind: QueueJobWorkerKind.Local, name: mlDestinationStub.local.name });
      expect(result[1].worker).toEqual({ kind: QueueJobWorkerKind.FrameleafCloud, name: 'Frameleaf Cloud' });
      expect(result[0]).not.toHaveProperty('account');
      expect(result[0]).not.toHaveProperty('status');
    });

    it('only looks up the uuids a job names, and falls back to the server without a route', async () => {
      mocks.job.searchJobs.mockResolvedValue([job({ data: { id: 'not-a-uuid', userId: ownerId.toUpperCase() } })]);
      mocks.user.getJobSubjectOwners.mockResolvedValue([{ subjectId: ownerId, ownerId, ownerName: 'Ada' }]);
      mocks.mlDestination.getRoute.mockResolvedValue(undefined);

      const [result] = await sut.searchJobs(factory.auth(), QueueName.SmartSearch, {});

      expect(mocks.user.getJobSubjectOwners).toHaveBeenCalledWith([ownerId]);
      expect(result.account).toEqual({ id: ownerId, name: 'Ada' });
      expect(result.worker).toEqual({ kind: QueueJobWorkerKind.Server, name: null });
    });

    it('returns nothing without looking anything up for an empty queue', async () => {
      mocks.job.searchJobs.mockResolvedValue([]);

      await expect(sut.searchJobs(factory.auth(), QueueName.SmartSearch, {})).resolves.toEqual([]);
      expect(mocks.user.getJobSubjectOwners).not.toHaveBeenCalled();
    });
  });

  describe('retryFailedJobs', () => {
    it('reports actual admitted retries rather than the number of failed and needs-attention rows', async () => {
      mocks.job.retryFailed.mockResolvedValue(3);
      await expect(sut.retryFailedJobs(factory.auth(), QueueName.SmartSearch)).resolves.toEqual({ count: 3 });
      expect(mocks.job.retryFailed).toHaveBeenCalledWith(QueueName.SmartSearch);
    });
    it('reports zero when no failed work can be safely replayed', async () => {
      mocks.job.retryFailed.mockResolvedValue(0);
      await expect(sut.retryFailedJobs(factory.auth(), QueueName.SmartSearch)).resolves.toEqual({ count: 0 });
    });
  });

  describe('one job at a time (approved design, 2026-11-04)', () => {
    const jobId = '9a1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a01';
    const assetId = '9a1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a02';

    it('retries one failed job and refuses one that cannot run again', async () => {
      mocks.job.retryFailed.mockResolvedValueOnce(1);
      await sut.retryJob(factory.auth(), QueueName.FaceDetection, jobId);
      expect(mocks.job.retryFailed).toHaveBeenCalledWith(QueueName.FaceDetection, jobId);
      mocks.job.retryFailed.mockResolvedValueOnce(0);
      await expect(sut.retryJob(factory.auth(), QueueName.FaceDetection, jobId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('starts one waiting job now and refuses one that is not waiting', async () => {
      mocks.job.startNow.mockResolvedValueOnce(true);
      await sut.startJob(factory.auth(), QueueName.Ocr, jobId);
      expect(mocks.job.startNow).toHaveBeenCalledWith(QueueName.Ocr, jobId);
      mocks.job.startNow.mockResolvedValueOnce(false);
      await expect(sut.startJob(factory.auth(), QueueName.Ocr, jobId)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('runs a task on one item: queues its job for that item and starts it now', async () => {
      mocks.asset.getById.mockResolvedValue({ id: assetId, type: AssetType.Image } as never);
      mocks.job.findOpenJob.mockResolvedValueOnce(undefined).mockResolvedValue({ id: jobId, active: false });
      mocks.job.startNow.mockResolvedValue(true);
      await sut.runOne(factory.auth(), QueueName.ThumbnailGeneration, { assetId });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetGenerateThumbnails, data: { id: assetId } });
      expect(mocks.job.findOpenJob).toHaveBeenCalledWith(
        QueueName.ThumbnailGeneration,
        JobName.AssetGenerateThumbnails,
        assetId,
      );
      expect(mocks.job.startNow).toHaveBeenCalledWith(QueueName.ThumbnailGeneration, jobId);
    });

    it('counts the item’s job as started when it is already running (FL-1249)', async () => {
      mocks.asset.getById.mockResolvedValue({ id: assetId, type: AssetType.Image } as never);
      mocks.job.findOpenJob.mockResolvedValue({ id: jobId, active: true });
      await expect(sut.runOne(factory.auth(), QueueName.ThumbnailGeneration, { assetId })).resolves.toBeUndefined();
      // no second copy queued beside the running one
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.startNow).not.toHaveBeenCalled();
      mocks.job.findOpenJob.mockResolvedValue(undefined);
      await expect(sut.runOne(factory.auth(), QueueName.ThumbnailGeneration, { assetId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each([
      [QueueName.SmartSearch, JobName.SmartSearch],
      [QueueName.DuplicateDetection, JobName.AssetDetectDuplicates],
      [QueueName.ImageDescription, JobName.ImageDescription],
    ])("runs Library care's Redo one and Check one photo on %s (approved design, 2026-11-04)", async (queue, job) => {
      mocks.asset.getById.mockResolvedValue({ id: assetId, type: AssetType.Image } as never);
      mocks.job.findOpenJob.mockResolvedValueOnce(undefined).mockResolvedValue({ id: 'job-1', active: false });
      mocks.job.startNow.mockResolvedValue(true);
      await sut.runOne(factory.auth(), queue, { assetId });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: job, data: { id: assetId } });
      expect(mocks.job.startNow).toHaveBeenCalledWith(queue, 'job-1');
    });

    it('runs on one item only for the tasks that work one item at a time, videos only for playback and photos only for Locked content', async () => {
      await expect(sut.runOne(factory.auth(), QueueName.Library, { assetId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      mocks.asset.getById.mockResolvedValue({ id: assetId, type: AssetType.Image } as never);
      await expect(sut.runOne(factory.auth(), QueueName.VideoConversion, { assetId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // the Locked content reread is for one photo
      mocks.asset.getById.mockResolvedValue({ id: assetId, type: AssetType.Video } as never);
      await expect(sut.runOne(factory.auth(), QueueName.NsfwDetection, { assetId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      mocks.asset.getById.mockResolvedValue(undefined as never);
      await expect(sut.runOne(factory.auth(), QueueName.MetadataExtraction, { assetId })).rejects.toThrow(
        'Asset not found',
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('account filter (FL-71 J-1)', () => {
    const ada = 'af1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a03';
    const asset = (n: number) => `6f1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a${String(n).padStart(2, '0')}`;
    const job = (id: string, status: QueueJobStatus) => ({
      id,
      name: JobName.AssetGenerateThumbnails,
      timestamp: 1,
      data: { id },
      status,
    });

    it("asks the database for only the chosen account's jobs", async () => {
      mocks.job.searchJobs.mockResolvedValue([job(asset(1), QueueJobStatus.Waiting)]);
      mocks.user.getJobSubjectOwners.mockResolvedValue([{ subjectId: asset(1), ownerId: ada, ownerName: 'Ada' }]);

      const result = await sut.searchJobs(factory.auth(), QueueName.ThumbnailGeneration, { ownerId: ada });

      expect(mocks.job.searchJobs).toHaveBeenCalledWith(
        QueueName.ThumbnailGeneration,
        { ownerId: ada },
        undefined,
        true,
      );
      expect(result[0].account).toEqual({ id: ada, name: 'Ada' });
    });

    it("counts an account's jobs over the whole queue, never as a lower bound", async () => {
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics({ waiting: 300_000, failed: 2 }));

      await expect(sut.getOwnerStatistics(factory.auth(), QueueName.ThumbnailGeneration, ada)).resolves.toEqual({
        ...factory.queueStatistics({ waiting: 300_000, failed: 2 }),
        truncated: false,
      });
      expect(mocks.job.getJobCounts).toHaveBeenCalledWith(QueueName.ThumbnailGeneration, ada);
    });
  });

  describe('Background work › Advanced (FL-1486)', () => {
    const hold = (name: QueueName, more: object = {}) => ({
      name,
      paused: false,
      closedUntil: null,
      waitingFor: null,
      ...more,
    });
    const reasonOf = async (name: QueueName) =>
      (await sut.getOverview(authStub.admin)).tasks.find((task) => task.name === name);

    beforeEach(() => {
      mocks.job.listQueueProblems.mockResolvedValue([]);
      mocks.job.getQueueHolds.mockResolvedValue([]);
    });

    it('says since when a person paused a task, and forgets it on resume', async () => {
      mocks.job.getQueueHolds.mockResolvedValue([hold(QueueName.FaceDetection, { paused: true })]);
      await sut.update(authStub.admin, QueueName.FaceDetection, { isPaused: true });
      const [, saved] = mocks.systemMetadata.set.mock.calls.at(-1)!;
      expect(mocks.systemMetadata.set).toHaveBeenLastCalledWith(SystemMetadataKey.QueuePausedAt, {
        [QueueName.FaceDetection]: expect.any(String),
      });

      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(key === SystemMetadataKey.QueuePausedAt ? (saved as never) : null),
      );
      await expect(reasonOf(QueueName.FaceDetection)).resolves.toEqual({
        name: QueueName.FaceDetection,
        reason: 'paused',
        pausedAt: (saved as Record<string, string>)[QueueName.FaceDetection],
      });

      // pausing again keeps the first date
      mocks.systemMetadata.set.mockClear();
      await sut.update(authStub.admin, QueueName.FaceDetection, { isPaused: true });
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();

      mocks.database.withLock.mockImplementation((_, callback) => callback());
      await sut.update(authStub.admin, QueueName.FaceDetection, { isPaused: false });
      expect(mocks.systemMetadata.set).toHaveBeenLastCalledWith(SystemMetadataKey.QueuePausedAt, {});
    });

    it('a pause the server made has no date', async () => {
      mocks.job.getQueueHolds.mockResolvedValue([hold(QueueName.MetadataExtraction, { paused: true })]);
      await expect(reasonOf(QueueName.MetadataExtraction)).resolves.toEqual({
        name: QueueName.MetadataExtraction,
        reason: 'paused',
      });
    });

    it('quiet hours are not a pause', async () => {
      const closedUntil = new Date('2026-11-13T07:00:00.000Z');
      mocks.job.getQueueHolds.mockResolvedValue([hold(QueueName.VideoConversion, { closedUntil })]);
      await expect(reasonOf(QueueName.VideoConversion)).resolves.toEqual({
        name: QueueName.VideoConversion,
        reason: 'quietHours',
        closedUntil: '2026-11-13T07:00:00.000Z',
      });
    });

    it('names the task another waits for, and a feature that is off first', async () => {
      mocks.job.getQueueHolds.mockResolvedValue([
        hold(QueueName.StorageTemplateMigration, { waitingFor: QueueName.MetadataExtraction }),
        hold(QueueName.Ocr, { paused: true }),
      ]);
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          key === SystemMetadataKey.SystemConfig ? ({ machineLearning: { ocr: { enabled: false } } } as never) : null,
        ),
      );
      await expect(reasonOf(QueueName.StorageTemplateMigration)).resolves.toEqual({
        name: QueueName.StorageTemplateMigration,
        reason: 'waitingFor',
        waitingFor: QueueName.MetadataExtraction,
      });
      await expect(reasonOf(QueueName.Ocr)).resolves.toEqual({ name: QueueName.Ocr, reason: 'featureOff' });
      await expect(reasonOf(QueueName.Library)).resolves.toEqual({ name: QueueName.Library, reason: null });
    });

    it('passes the problems on with the reader’s privacy', async () => {
      const problem = {
        cause: 'mlUnavailable' as const,
        count: 3,
        unit: 'photos' as const,
        queues: [QueueName.FaceDetection],
        message: 'Machine learning request failed',
      };
      mocks.job.listQueueProblems.mockResolvedValue([problem]);
      await expect(sut.getOverview(authStub.admin)).resolves.toMatchObject({ problems: [problem] });
      expect(mocks.job.listQueueProblems).toHaveBeenCalledWith(
        expect.objectContaining({ othersRulesViewerId: authStub.admin.user.id }),
      );
    });

    it('only offers each action where it helps', async () => {
      mocks.job.actOnQueueProblem.mockResolvedValue(7);
      await expect(sut.actOnProblem(authStub.admin, { cause: 'tooLong', action: 'retry' })).resolves.toEqual({
        count: 7,
      });
      await expect(sut.actOnProblem(authStub.admin, { cause: 'unsupported', action: 'stop' })).resolves.toEqual({
        count: 7,
      });
      for (const [cause, action] of [
        ['missing', 'retry'],
        ['damaged', 'retry'],
        ['unsupported', 'retry'],
        ['mlUnavailable', 'stop'],
      ] as const) {
        await expect(sut.actOnProblem(authStub.admin, { cause, action })).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(mocks.job.actOnQueueProblem).toHaveBeenCalledTimes(2);
    });
  });
});
