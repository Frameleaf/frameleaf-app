import { BadRequestException } from '@nestjs/common';
import type { VideoEditVersion } from 'src/repositories/asset-edit.repository.js';
import type { JobItem } from 'src/types.js';
import { JOBS_NOT_RETRIED } from 'src/constants.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetType, ImmichWorker, JobName, JobStatus, ManualJobName, QueueName } from 'src/enum.js';
import { JobService } from 'src/services/job.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForAsset } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(JobService.name, () => {
  let sut: JobService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(JobService));

    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('create', () => {
    it('never applies physical deduplication from a queue button; that needs a reviewed plan (FL-73)', async () => {
      await expect(sut.create({ name: ManualJobName.PhysicalDeduplicationApply })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('still queues a physical deduplication preview', async () => {
      await sut.create({ name: ManualJobName.PhysicalDeduplicationDryRun });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.PhysicalDeduplicationMigrationDryRun });
    });
  });

  describe('onJobRun', () => {
    it('should process a successful job', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      const job: JobItem = { name: JobName.FileDelete, data: { files: ['path/to/file'] } };
      await sut.onJobRun(QueueName.BackgroundTask, job);

      expect(mocks.event.emit).toHaveBeenCalledWith('JobStart', QueueName.BackgroundTask, job);
      expect(mocks.event.emit).toHaveBeenCalledWith('JobSuccess', { job, response: JobStatus.Success });
      expect(mocks.event.emit).toHaveBeenCalledWith('JobComplete', QueueName.BackgroundTask, job);
      expect(mocks.logger.error).not.toHaveBeenCalled();
    });

    it.each(['save', 'revert'] as const)('publishes a global asset update after a ready video %s', async (purpose) => {
      const asset = getForAsset(AssetFactory.create({ type: AssetType.Video }));
      const versionId = newUuid();
      mocks.job.run.mockResolvedValue(JobStatus.Success);
      mocks.asset.getById.mockResolvedValue(asset);
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([{ ...asset, faces: [] }]);
      mocks.assetEdit.getWithSyncInfo.mockResolvedValue([]);
      mocks.assetEdit.getVideoVersion.mockResolvedValue({
        id: versionId,
        purpose,
        status: 'ready',
      } as VideoEditVersion);

      await sut.onJobRun(QueueName.VideoConversion, {
        name: JobName.AssetVideoEditGeneration,
        data: { id: asset.id, versionId },
      });

      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_asset_update', asset.ownerId, mapAsset(asset));
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AssetEditReadyV2', asset.ownerId, expect.anything());
    });

    it.each([{ purpose: 'export', status: 'ready' }, { purpose: 'save', status: 'pending' }, undefined])(
      'does not publish a playback update for export, stale or removed versions: %j',
      async (version) => {
        const asset = getForAsset(AssetFactory.create({ type: AssetType.Video }));
        mocks.job.run.mockResolvedValue(JobStatus.Skipped);
        mocks.asset.getById.mockResolvedValue(asset);
        mocks.assetEdit.getWithSyncInfo.mockResolvedValue([]);
        mocks.assetEdit.getVideoVersion.mockResolvedValue(version as VideoEditVersion | undefined);

        await sut.onJobRun(QueueName.VideoConversion, {
          name: JobName.AssetVideoEditGeneration,
          data: { id: asset.id, versionId: newUuid() },
        });

        expect(mocks.websocket.clientSend).not.toHaveBeenCalledWith(
          'on_asset_update',
          expect.anything(),
          expect.anything(),
        );
        expect(mocks.asset.getByIdsWithAllRelationsButStacks).not.toHaveBeenCalled();
        expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AssetEditReadyV2', asset.ownerId, expect.anything());
      },
    );

    it('notifies only fork history views when a video version render fails', async () => {
      const asset = getForAsset(AssetFactory.create({ type: AssetType.Video }));
      const versionId = newUuid();
      mocks.job.run.mockResolvedValue(JobStatus.Failed);
      mocks.asset.getById.mockResolvedValue(asset);

      await sut.onJobRun(QueueName.VideoConversion, {
        name: JobName.AssetVideoEditGeneration,
        data: { id: asset.id, versionId },
      });

      // Official clients read AssetEditReadyV2 as a published edit, so a failure never sends it.
      expect(mocks.websocket.clientSend).toHaveBeenCalledExactlyOnceWith('VideoEditVersionFailedV1', asset.ownerId, {
        assetId: asset.id,
        versionId,
      });
      expect(mocks.asset.getByIdsWithAllRelationsButStacks).not.toHaveBeenCalled();
    });

    it('should not run duplicate detection follow-up when video duplicate frame generation is skipped', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Skipped);

      const job: JobItem = { name: JobName.AssetGenerateVideoDuplicateFrames, data: { id: 'asset-1' } };
      await sut.onJobRun(QueueName.VideoDuplicateDetection, job);

      expect(mocks.job.queue).not.toHaveBeenCalledWith({
        name: JobName.AssetDetectDuplicates,
        data: { id: 'asset-1' },
      });
    });

    const tests: Array<{ item: JobItem; jobs: JobName[]; stub?: any }> = [
      {
        item: { name: JobName.SidecarCheck, data: { id: 'asset-1' } },
        jobs: [JobName.AssetExtractMetadata],
      },
      {
        item: { name: JobName.SidecarCheck, data: { id: 'asset-1' } },
        jobs: [JobName.AssetExtractMetadata],
      },
      {
        item: { name: JobName.StorageTemplateMigrationSingle, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.AssetGenerateThumbnails],
      },
      {
        item: { name: JobName.StorageTemplateMigrationSingle, data: { id: 'asset-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.PersonGenerateThumbnail, data: { ownerId: 'owner-1', personGroupId: 'person-group-1' } },
        jobs: [],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
        jobs: [],
        stub: [AssetFactory.create({ id: 'asset-1' })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
        jobs: [],
        stub: [AssetFactory.create({ id: 'asset-1', type: AssetType.Video })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        jobs: [
          JobName.SmartSearch,
          JobName.AssetDetectFaces,
          JobName.Ocr,
          JobName.BestPhotosScore,
          JobName.ImageDescription,
        ],
        stub: [AssetFactory.create({ id: 'asset-1', livePhotoVideoId: newUuid() })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        jobs: [
          JobName.SmartSearch,
          JobName.AssetDetectFaces,
          JobName.Ocr,
          JobName.AssetEncodeVideo,
          JobName.BestPhotosScore,
        ],
        stub: [AssetFactory.create({ id: 'asset-1', type: AssetType.Video })],
      },
      {
        // FL-58: a fresh CLIP embedding is read by pet recognition
        item: { name: JobName.SmartSearch, data: { id: 'asset-1' } },
        jobs: [JobName.PetRecognition],
      },
      {
        item: { name: JobName.AssetDetectFaces, data: { id: 'asset-1' } },
        jobs: [JobName.BestPhotosScore],
      },
      {
        item: { name: JobName.FacialRecognition, data: { id: 'asset-1' } },
        jobs: [],
      },
    ];

    for (const { item, jobs, stub } of tests) {
      it(`should queue ${jobs.length} jobs when a ${item.name} job finishes successfully`, async () => {
        if (stub) {
          mocks.asset.getById.mockResolvedValue(stub[0]);
          mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue(stub);
        }

        mocks.job.run.mockResolvedValue(JobStatus.Success);

        await sut.onJobRun(QueueName.BackgroundTask, item);

        if (jobs.length > 1) {
          expect(mocks.job.queueAll).toHaveBeenCalledWith(
            jobs.map((jobName) => ({ name: jobName, data: expect.anything() })),
          );
        } else {
          expect(mocks.job.queue).toHaveBeenCalledTimes(jobs.length);
          for (const jobName of jobs) {
            expect(mocks.job.queue).toHaveBeenCalledWith({ name: jobName, data: expect.anything() });
          }
        }
      });

      it(`should not queue any jobs when ${item.name} fails`, async () => {
        mocks.job.run.mockResolvedValue(JobStatus.Failed);

        await sut.onJobRun(QueueName.BackgroundTask, item);

        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      });
    }
  });

  describe('a handler that throws (FL-71)', () => {
    it('reports the error and rethrows it, so BullMQ records the job as failed', async () => {
      const error = new Error('Input file is missing');
      mocks.job.run.mockRejectedValue(error);
      const item = { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } } as const;

      await expect(sut.onJobRun(QueueName.ThumbnailGeneration, item)).rejects.toBe(error);

      expect(mocks.event.emit).toHaveBeenCalledWith('JobError', { job: item, error });
      expect(mocks.event.emit).toHaveBeenCalledWith('JobComplete', QueueName.ThumbnailGeneration, item);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('keeps the thumbnail job the retry-failed e2e fails out of the no-retry set', () => {
      expect(JOBS_NOT_RETRIED.has(JobName.AssetGenerateThumbnails)).toBe(false);
    });

    it.each([
      { name: JobName.NotifyUserSignup, data: { id: 'user-1', password: 'secret' } },
      { name: JobName.SendMail, data: { to: 'a@b.c', subject: 's', html: 'secret', text: 'secret' } },
      { name: JobName.NotifyAlbumInvite, data: { id: 'album-1', recipientId: 'user-1' } },
      { name: JobName.NotifyAlbumUpdate, data: { id: 'album-1', recipientId: 'user-1' } },
      { name: JobName.IntegrityDeleteReports, data: { reports: [] } },
      { name: JobName.StorageTemplateMigrationSingle, data: { id: 'asset-1' } },
      { name: JobName.LibrarySyncFiles, data: { libraryId: 'library-1', paths: [] } },
      { name: JobName.FacialRecognition, data: { id: 'face-1' } },
    ] as JobItem[])('reports but does not rethrow a $name failure, so no failed record is kept', async (item) => {
      const error = new Error('boom');
      mocks.job.run.mockRejectedValue(error);

      await expect(sut.onJobRun(QueueName.BackgroundTask, item)).resolves.toBeUndefined();

      expect(mocks.event.emit).toHaveBeenCalledWith('JobError', { job: item, error });
      expect(mocks.event.emit).not.toHaveBeenCalledWith('JobSuccess', expect.anything());
      expect(mocks.event.emit).toHaveBeenCalledWith('JobComplete', QueueName.BackgroundTask, item);
    });

    it('rethrows the handler error, not an error from a JobError listener', async () => {
      const error = new Error('Input file is missing');
      mocks.job.run.mockRejectedValue(error);
      mocks.event.emit.mockImplementation((...[name]) =>
        name === 'JobError' ? Promise.reject(new Error('listener')) : Promise.resolve(),
      );
      const item = { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } } as const;

      await expect(sut.onJobRun(QueueName.ThumbnailGeneration, item)).rejects.toBe(error);
      expect(mocks.logger.error).toHaveBeenCalled();
    });
  });

  describe('after a handler succeeds (FL-71)', () => {
    it('logs an error from a JobSuccess listener instead of failing the job', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Success);
      mocks.event.emit.mockImplementation((...[name]) =>
        name === 'JobSuccess' ? Promise.reject(new Error('redis down')) : Promise.resolve(),
      );
      const item = { name: JobName.SidecarCheck, data: { id: 'asset-1' } } as const;

      await expect(sut.onJobRun(QueueName.Sidecar, item)).resolves.toBeUndefined();

      expect(mocks.event.emit).not.toHaveBeenCalledWith('JobError', expect.anything());
      expect(mocks.event.emit).toHaveBeenCalledWith('JobComplete', QueueName.Sidecar, item);
      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('after it succeeded'),
        expect.any(String),
      );
    });

    it('logs an error from a follow-up job instead of failing the job', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Success);
      mocks.job.queue.mockRejectedValue(new Error('redis down'));
      const item = { name: JobName.SidecarCheck, data: { id: 'asset-1' } } as const;

      await expect(sut.onJobRun(QueueName.Sidecar, item)).resolves.toBeUndefined();

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetExtractMetadata, data: item.data });
      expect(mocks.event.emit).not.toHaveBeenCalledWith('JobError', expect.anything());
      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('after it succeeded'),
        expect.any(String),
      );
    });
  });

  describe('image enrichment job chaining', () => {
    it('should queue image descriptions after upload thumbnail generation when descriptions are enabled', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', type: AssetType.Image });
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([asset as never]);
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          facialRecognition: { enabled: true },
          imageDescription: { enabled: true },
          nsfwDetection: { enabled: true },
        },
      });
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.BackgroundTask, {
        name: JobName.AssetGenerateThumbnails,
        data: { id: asset.id, source: 'upload' },
      });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SmartSearch, data: { id: asset.id, source: 'upload' } },
        { name: JobName.AssetDetectFaces, data: { id: asset.id, source: 'upload' } },
        { name: JobName.Ocr, data: { id: asset.id, source: 'upload' } },
        { name: JobName.BestPhotosScore, data: { id: asset.id, source: 'upload' } },
        { name: JobName.ImageDescription, data: { id: asset.id, source: 'upload' } },
      ]);
    });

    it('should queue NSFW detection after upload thumbnail generation when descriptions are disabled', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', type: AssetType.Image });
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([asset as never]);
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          facialRecognition: { enabled: true },
          imageDescription: { enabled: false },
          nsfwDetection: { enabled: true },
        },
      });
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.BackgroundTask, {
        name: JobName.AssetGenerateThumbnails,
        data: { id: asset.id, source: 'upload' },
      });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SmartSearch, data: { id: asset.id, source: 'upload' } },
        { name: JobName.AssetDetectFaces, data: { id: asset.id, source: 'upload' } },
        { name: JobName.Ocr, data: { id: asset.id, source: 'upload' } },
        { name: JobName.BestPhotosScore, data: { id: asset.id, source: 'upload' } },
        { name: JobName.NsfwDetection, data: { id: asset.id, source: 'upload' } },
      ]);
    });

    it('should not queue image enrichment for videos after thumbnail generation', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', type: AssetType.Video });
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([asset as never]);
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          facialRecognition: { enabled: true },
          imageDescription: { enabled: true },
          nsfwDetection: { enabled: true },
        },
      });
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.BackgroundTask, {
        name: JobName.AssetGenerateThumbnails,
        data: { id: asset.id, source: 'upload' },
      });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SmartSearch, data: { id: asset.id, source: 'upload' } },
        { name: JobName.AssetDetectFaces, data: { id: asset.id, source: 'upload' } },
        { name: JobName.Ocr, data: { id: asset.id, source: 'upload' } },
        { name: JobName.AssetEncodeVideo, data: { id: asset.id, source: 'upload' } },
        { name: JobName.BestPhotosScore, data: { id: asset.id, source: 'upload' } },
      ]);
    });

    it('announces a finished upload as a new timeline item', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', type: AssetType.Image });
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([asset as never]);
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.BackgroundTask, {
        name: JobName.AssetGenerateThumbnails,
        data: { id: asset.id, source: 'upload' },
      });

      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_upload_success', asset.ownerId, expect.anything());
    });

    it('never announces an upload trashed before its thumbnails were ready (FL-169)', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', type: AssetType.Image, deletedAt: new Date() });
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([asset as never]);
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.BackgroundTask, {
        name: JobName.AssetGenerateThumbnails,
        data: { id: asset.id, source: 'upload' },
      });

      expect(mocks.websocket.clientSend).not.toHaveBeenCalledWith(
        'on_upload_success',
        expect.anything(),
        expect.anything(),
      );
    });

    it('should requeue Best Photos scoring after face detection succeeds', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          facialRecognition: { enabled: true },
        },
      });
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.FaceDetection, {
        name: JobName.AssetDetectFaces,
        data: { id: 'asset-1' },
      });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.BestPhotosScore, data: { id: 'asset-1' } });
    });

    it('should requeue Best Photos scoring after edited image thumbnails are generated', async () => {
      const asset = AssetFactory.create({ id: 'asset-1', type: AssetType.Image });
      mocks.asset.getById.mockResolvedValue(asset as never);
      mocks.assetEdit.getWithSyncInfo.mockResolvedValue([] as never);
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.Editor, {
        name: JobName.AssetEditThumbnailGeneration,
        data: { id: asset.id },
      });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.BestPhotosScore, data: { id: asset.id } });
    });
  });
});
