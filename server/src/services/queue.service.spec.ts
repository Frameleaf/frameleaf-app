import { BadRequestException } from '@nestjs/common';
import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import {
  ImmichWorker,
  JobName,
  MlDestinationKind,
  MlWorkload,
  QueueCommand,
  QueueJobStatus,
  QueueJobWorkerKind,
  QueueName,
} from 'src/enum.js';
import { QueueService } from 'src/services/queue.service.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(QueueService.name, () => {
  let sut: QueueService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(QueueService));

    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
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
  });

  describe('handleNightlyJobs', () => {
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
      ]);
    });

    it('leaves the analytics collector out when local metrics are off (FL-71)', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ analytics: { enabled: false, historyDays: 730 } });

      await sut.handleNightlyJobs();

      expect(mocks.job.queueAll).toHaveBeenCalledWith(expect.not.arrayContaining([{ name: JobName.AnalyticsCollect }]));
    });
  });

  describe('getAllJobStatus', () => {
    it('should get all job statuses', async () => {
      const stats = factory.queueStatistics({ active: 1 });
      const expected = { jobCounts: stats, queueStatus: { isActive: true, isPaused: true } };

      mocks.job.getJobCounts.mockResolvedValue(stats);
      mocks.job.isPaused.mockResolvedValue(true);

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

      await sut.runCommandLegacy(QueueName.VideoConversion, { command: QueueCommand.Start, force: false });

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
        name: JobName.AssetGenerateVideoDuplicateFramesQueueAll,
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

  describe('retryFailedJobs (FL-71)', () => {
    it('retries the failed jobs and reports how many there were', async () => {
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics({ failed: 3 }));

      await expect(sut.retryFailedJobs(factory.auth(), QueueName.SmartSearch)).resolves.toEqual({ count: 3 });
      expect(mocks.job.retryFailed).toHaveBeenCalledWith(QueueName.SmartSearch);
    });

    it('does nothing when no job has failed', async () => {
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics({ failed: 0 }));

      await expect(sut.retryFailedJobs(factory.auth(), QueueName.SmartSearch)).resolves.toEqual({ count: 0 });
      expect(mocks.job.retryFailed).not.toHaveBeenCalled();
    });
  });

  describe('account filter (FL-71 J-1)', () => {
    const ada = 'af1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a03';
    const grace = 'bf1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a04';
    const asset = (n: number) => `6f1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a${String(n).padStart(2, '0')}`;
    const job = (id: string, status: QueueJobStatus) => ({
      id,
      name: JobName.AssetGenerateThumbnails,
      timestamp: 1,
      data: { id },
      status,
    });

    it("lists only the jobs of the chosen account's items", async () => {
      mocks.job.searchJobs.mockResolvedValue([
        job(asset(1), QueueJobStatus.Waiting),
        job(asset(2), QueueJobStatus.Waiting),
      ]);
      mocks.user.getJobSubjectOwners.mockResolvedValue([
        { subjectId: asset(1), ownerId: ada, ownerName: 'Ada' },
        { subjectId: asset(2), ownerId: grace, ownerName: 'Grace' },
      ]);

      const result = await sut.searchJobs(factory.auth(), QueueName.ThumbnailGeneration, { ownerId: ada });

      expect(result).toHaveLength(1);
      expect(result[0].account).toEqual({ id: ada, name: 'Ada' });
    });

    it("counts an account's jobs per state and says when a state was not read in full", async () => {
      mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics({ waiting: 1500, failed: 2 }));
      mocks.job.searchJobs.mockImplementation((_name, dto) =>
        Promise.resolve(
          dto.status?.[0] === QueueJobStatus.Waiting
            ? [job(asset(1), QueueJobStatus.Waiting), job(asset(2), QueueJobStatus.Waiting)]
            : dto.status?.[0] === QueueJobStatus.Failed
              ? [job(asset(1), QueueJobStatus.Failed), job(asset(3), QueueJobStatus.Failed)]
              : [],
        ),
      );
      mocks.user.getJobSubjectOwners.mockResolvedValue([
        { subjectId: asset(1), ownerId: ada, ownerName: 'Ada' },
        { subjectId: asset(2), ownerId: grace, ownerName: 'Grace' },
        { subjectId: asset(3), ownerId: ada, ownerName: 'Ada' },
      ]);

      await expect(sut.getOwnerStatistics(factory.auth(), QueueName.ThumbnailGeneration, ada)).resolves.toEqual({
        active: 0,
        completed: 0,
        failed: 2,
        delayed: 0,
        waiting: 1,
        paused: 0,
        truncated: true,
      });
      expect(mocks.job.searchJobs).toHaveBeenCalledWith(
        QueueName.ThumbnailGeneration,
        { status: [QueueJobStatus.Waiting] },
        1000,
      );
    });
  });

  it('marks an account count as a lower bound when a state fills the scan (FL-71 J-1)', async () => {
    mocks.job.getJobCounts.mockResolvedValue(factory.queueStatistics({ waiting: 1000 }));
    mocks.job.searchJobs.mockImplementation((_name, dto) =>
      Promise.resolve(
        dto.status?.[0] === QueueJobStatus.Waiting
          ? Array.from({ length: 1000 }, (_, index) => ({
              id: String(index),
              name: JobName.AssetGenerateThumbnails,
              timestamp: 1,
              data: {},
              status: QueueJobStatus.Waiting,
            }))
          : [],
      ),
    );
    mocks.user.getJobSubjectOwners.mockResolvedValue([]);

    await expect(
      sut.getOwnerStatistics(factory.auth(), QueueName.ThumbnailGeneration, 'af1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a03'),
    ).resolves.toEqual(expect.objectContaining({ truncated: true }));
  });
});
