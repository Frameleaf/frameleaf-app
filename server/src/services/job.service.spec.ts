import { BadRequestException } from '@nestjs/common';
import type { QueueExecution } from 'src/queue/types.js';
import type { VideoEditVersion } from 'src/repositories/asset-edit.repository.js';
import type { JobItem } from 'src/types.js';
import { JOBS_NOT_RETRIED } from 'src/constants.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetType, FrameleafWorker, JobName, JobStatus, LibraryScope, ManualJobName, QueueName } from 'src/enum.js';
import { NO_FAILURE_REASON, noteJobHandedToCare, noteJobProblem, queueExecution } from 'src/queue/context.js';
import { JobService } from 'src/services/job.service.js';
import { LockedKeyUnavailableError } from 'src/utils/locked-read.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForAsset } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(JobService.name, () => {
  let sut: JobService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(JobService));

    mocks.config.getWorker.mockReturnValue(FrameleafWorker.Microservices);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('create', () => {
    it.each([ManualJobName.PhysicalDeduplicationDryRun, ManualJobName.PhysicalDeduplicationApply])(
      'refuses the retired %s (FL-413)',
      async (name) => {
        await expect(sut.create({ name })).rejects.toBeInstanceOf(BadRequestException);
        expect(mocks.job.queue).not.toHaveBeenCalled();
      },
    );

    it('queues an identical-files check (FL-413)', async () => {
      await sut.create({ name: ManualJobName.IdenticalFilesCheck });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.IdenticalFilesCheck });
    });
  });

  describe('onJobRun', () => {
    it.each([
      [JobName.AssetMetadataPostprocess, QueueName.MetadataExtraction, JobName.AssetGenerateThumbnails],
      [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration, JobName.SmartSearch],
    ] as const)('queues eligible work only after an overnight %s publishes', async (name, queue, eligible) => {
      const id = newUuid();
      mocks.job.run.mockResolvedValue(JobStatus.Success);
      mocks.job.getQueueName.mockReturnValue(queue);
      const where = vi.fn();
      mocks.assetJob.selectionForUnfinished.mockImplementation((step) => {
        const result = step === eligible ? { id } : undefined;
        return {
          where: (...args: unknown[]) => {
            where(...args);
            return { executeTakeFirst: () => Promise.resolve(result) };
          },
        } as never;
      });
      const execution = { signal: new AbortController().signal, adoptions: [] } as unknown as QueueExecution;
      await queueExecution.run(execution, () => sut.onJobRun(queue, { name, data: { id, reconcileUnfinished: true } }));

      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(execution.adoptions).toHaveLength(1);
      await execution.adoptions[0]({} as never);
      expect(where).toHaveBeenCalledWith('asset.id', '=', id);
      expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith([
        {
          name: eligible,
          data: eligible === JobName.AssetGenerateThumbnails ? { id, reconcileUnfinished: true } : { id },
        },
      ]);
      expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
    });

    it('does not follow designer semantic or face jobs with personal enrichment', async () => {
      const asset = AssetFactory.create({ libraryScope: LibraryScope.Design });
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.job.run.mockResolvedValue(JobStatus.Success);
      await sut.onJobRun(QueueName.SmartSearch, { name: JobName.SmartSearch, data: { id: asset.id } });
      await sut.onJobRun(QueueName.FaceDetection, { name: JobName.AssetDetectFaces, data: { id: asset.id } });
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.PetRecognition }));
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.BestPhotosScore }));
    });
    it.each([
      [true, JobName.AssetVideoFingerprint],
      [false, JobName.AssetDetectDuplicates],
    ])('follows an uploaded video with %s video comparison by %s (FL-651)', async (enabled, next) => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { duplicateDetection: { enhancedVideo: { enabled } } },
      });
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.SmartSearch, {
        name: JobName.SmartSearch,
        data: { id: asset.id, source: 'upload' },
      });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: next, data: { id: asset.id, source: 'upload' } });
    });

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

      await expect(
        sut.onJobRun(QueueName.VideoConversion, {
          name: JobName.AssetVideoEditGeneration,
          data: { id: asset.id, versionId },
        }),
      ).resolves.toBeUndefined();

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

    it('reports a failed video render and sends only the failure event', async () => {
      const asset = getForAsset(AssetFactory.create({ type: AssetType.Video }));
      const versionId = newUuid();
      mocks.job.run.mockResolvedValue(JobStatus.Failed);
      mocks.asset.getById.mockResolvedValue(asset);

      await expect(
        sut.onJobRun(QueueName.VideoConversion, {
          name: JobName.AssetVideoEditGeneration,
          data: { id: asset.id, versionId },
        }),
      ).rejects.toThrow(NO_FAILURE_REASON);

      // Clients read AssetEditReadyV2 as a published edit, so a failure never sends it.
      expect(mocks.websocket.clientSend).toHaveBeenCalledExactlyOnceWith('VideoEditVersionFailedV1', asset.ownerId, {
        assetId: asset.id,
        versionId,
      });
      expect(mocks.asset.getByIdsWithAllRelationsButStacks).not.toHaveBeenCalled();
    });

    it('should not run duplicate detection follow-up when a video fingerprint is skipped', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Skipped);

      const job: JobItem = { name: JobName.AssetVideoFingerprint, data: { id: 'asset-1' } };
      await sut.onJobRun(QueueName.VideoDuplicateDetection, job);

      expect(mocks.job.queue).not.toHaveBeenCalledWith({
        name: JobName.AssetDetectDuplicates,
        data: { id: 'asset-1' },
      });
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should check a fingerprinted video and its group mates for duplicates again', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Success);
      mocks.duplicateRepository.getGroupMateIds.mockResolvedValue(['asset-2']);

      await sut.onJobRun(QueueName.VideoDuplicateDetection, {
        name: JobName.AssetVideoFingerprint,
        data: { id: 'asset-1' },
      });

      expect(mocks.duplicateRepository.getGroupMateIds).toHaveBeenCalledWith('asset-1');
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetDetectDuplicates, data: { id: 'asset-1', recheckAfter: 'asset-1' } },
        { name: JobName.AssetDetectDuplicates, data: { id: 'asset-2', recheckAfter: 'asset-1' } },
      ]);
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
        // FL-650: seek-bar previews follow the encode, from the copy playback serves
        item: { name: JobName.AssetEncodeVideo, data: { id: 'asset-1' } },
        jobs: [JobName.AssetWarmFilmstrip],
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
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.SmartSearch, JobName.Ocr, JobName.ImageDescription],
        stub: [AssetFactory.create({ id: 'asset-1', libraryScope: LibraryScope.Design })],
      },
      {
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        jobs: [JobName.SmartSearch, JobName.Ocr, JobName.AssetEncodeVideo],
        stub: [AssetFactory.create({ id: 'asset-1', type: AssetType.Video, libraryScope: LibraryScope.Design })],
      },
      {
        // FL-1359: a font's thumbnail is its specimen, not a picture to search, read or caption
        item: { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1', source: 'upload' } },
        jobs: [],
        stub: [
          AssetFactory.create({
            id: 'asset-1',
            type: AssetType.Other,
            originalFileName: 'Lodge.ttf',
            libraryScope: LibraryScope.Design,
          }),
        ],
      },
      {
        // FL-58: a fresh CLIP embedding is read by pet recognition
        item: { name: JobName.SmartSearch, data: { id: 'asset-1' } },
        jobs: [JobName.PetRecognition],
        stub: [AssetFactory.create({ id: 'asset-1' })],
      },
      {
        item: { name: JobName.AssetDetectFaces, data: { id: 'asset-1' } },
        jobs: [JobName.BestPhotosScore],
        stub: [AssetFactory.create({ id: 'asset-1' })],
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

      it(`fails ${item.name} with what the handler logged (FL-1482)`, async () => {
        mocks.job.run.mockImplementation(() => {
          noteJobProblem('The preview could not be made: the file is empty');
          return Promise.resolve(JobStatus.Failed);
        });
        const execution = { claim: {}, signal: new AbortController().signal } as never;

        await expect(queueExecution.run(execution, () => sut.onJobRun(QueueName.BackgroundTask, item))).rejects.toThrow(
          'The preview could not be made: the file is empty',
        );
      });

      it(`should not queue any jobs when ${item.name} fails`, async () => {
        mocks.job.run.mockResolvedValue(JobStatus.Failed);

        await expect(sut.onJobRun(QueueName.BackgroundTask, item)).rejects.toThrow(NO_FAILURE_REASON);

        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      });
    }

    it.each([
      { disabled: 'enabled', type: AssetType.Image, jobs: [JobName.BestPhotosScore] },
      {
        disabled: 'clip',
        type: AssetType.Image,
        jobs: [JobName.AssetDetectFaces, JobName.Ocr, JobName.BestPhotosScore],
      },
      {
        disabled: 'facialRecognition',
        type: AssetType.Image,
        jobs: [JobName.SmartSearch, JobName.Ocr, JobName.BestPhotosScore],
      },
      {
        disabled: 'ocr',
        type: AssetType.Image,
        jobs: [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.BestPhotosScore],
      },
      { disabled: 'enabled', type: AssetType.Video, jobs: [JobName.AssetEncodeVideo, JobName.BestPhotosScore] },
    ])('skips disabled $disabled automatic upload ML for $type', async ({ disabled, type, jobs }) => {
      const asset = AssetFactory.create({ id: 'asset-1', type });
      const data = { id: asset.id, source: 'upload' } as const;
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([asset as never]);
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: disabled !== 'enabled',
          clip: { enabled: disabled !== 'clip' },
          facialRecognition: { enabled: disabled !== 'facialRecognition' },
          ocr: { enabled: disabled !== 'ocr' },
          imageDescription: { enabled: false },
          nsfwDetection: { enabled: false },
        },
      });
      mocks.job.run.mockResolvedValue(JobStatus.Success);

      await sut.onJobRun(QueueName.ThumbnailGeneration, { name: JobName.AssetGenerateThumbnails, data });

      expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith(jobs.map((name) => ({ name, data })));
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_upload_success', asset.ownerId, expect.anything());
    });
  });

  describe('a skipped thumbnail job', () => {
    const attempt = () => ({ signal: new AbortController().signal, adoptions: [] }) as unknown as QueueExecution;
    /** Runs one attempt as the queue does, and accepts it: its adoptions, then what waits for the commit. */
    const runAttempt = async (execution: QueueExecution, item: JobItem) => {
      await queueExecution.run(execution, () => sut.onJobRun(QueueName.ThumbnailGeneration, item));
      for (const adopt of execution.adoptions) {
        await adopt({} as never);
      }
      for (const notify of execution.afterCommit ?? []) {
        await notify();
      }
    };
    /** The thumbnail handler, as the media service runs it: a photo that won't open is handed to Library care. */
    const skips = (handOff: boolean) => () => {
      if (handOff) {
        noteJobHandedToCare();
      }
      return Promise.resolve(JobStatus.Skipped);
    };
    const overnight = (id: string) => {
      mocks.job.getQueueName.mockReturnValue(QueueName.SmartSearch);
      mocks.assetJob.selectionForUnfinished.mockImplementation(
        (step) =>
          ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve(step === JobName.SmartSearch ? { id } : undefined),
            }),
          }) as never,
      );
      return { name: JobName.AssetGenerateThumbnails, data: { id, reconcileUnfinished: true } } as const;
    };
    const run = async (handOff = false) => {
      const asset = AssetFactory.create({ id: 'asset-1', type: AssetType.Image });
      const data = { id: asset.id, source: 'upload' } as const;
      mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([asset as never]);
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          clip: { enabled: true },
          facialRecognition: { enabled: true },
          ocr: { enabled: true },
          imageDescription: { enabled: false },
          nsfwDetection: { enabled: false },
        },
      });
      mocks.job.run.mockImplementation(skips(handOff));
      await runAttempt(attempt(), { name: JobName.AssetGenerateThumbnails, data });
      return { asset, data };
    };

    it('handed to Library care queues nothing after it, but still announces the upload', async () => {
      const { asset } = await run(true);

      expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith([]);
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_upload_success', asset.ownerId, expect.anything());
    });

    it.each([
      { handedToCare: true, what: 'handed to Library care queues none of its overnight processing' },
      { handedToCare: false, what: 'not handed to Library care still queues its overnight processing' },
    ])('from the overnight check (FL-811), one $what', async ({ handedToCare }) => {
      const id = newUuid();
      const item = overnight(id);
      mocks.job.run.mockImplementation(skips(handedToCare));
      await runAttempt(attempt(), item);

      if (handedToCare) {
        // Library care remakes the previews after a fix, and their follow-up work runs then
        expect(mocks.assetJob.selectionForUnfinished).not.toHaveBeenCalled();
        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      } else {
        expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith([{ name: JobName.SmartSearch, data: { id } }]);
      }
    });

    it('recognises a hand-off for a job queued with an upper-case id', async () => {
      const id = newUuid();
      const item = overnight(id);
      mocks.job.run.mockImplementation(skips(true));
      await runAttempt(attempt(), { ...item, data: { ...item.data, id: id.toUpperCase() } });

      expect(mocks.assetJob.selectionForUnfinished).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('a later attempt at the same photo starts with no hand-off', async () => {
      const id = newUuid();
      const item = overnight(id);
      mocks.job.run.mockImplementationOnce(skips(true)).mockImplementationOnce(skips(false));
      await runAttempt(attempt(), item);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();

      await runAttempt(attempt(), item);
      expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith([{ name: JobName.SmartSearch, data: { id } }]);
    });

    it.each([
      { handOff: true, what: 'the one that handed it over still holds back its follow-ups' },
      { handOff: false, what: 'a plain skipped one still queues its follow-ups' },
    ])('two attempts at one photo at once, the other handing it over and then failing: $what', async ({ handOff }) => {
      const id = newUuid();
      const item = overnight(id);
      const settling = attempt();
      const failing = attempt();
      const cleanupFailure = new Error('could not delete the temporary copy');
      const noted = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      mocks.job.run.mockImplementation(async () => {
        if (queueExecution.getStore() === settling) {
          await skips(handOff)();
          noted.resolve();
          // still running while the other attempt fails
          await release.promise;
          return JobStatus.Skipped;
        }
        await noted.promise;
        // the other attempt hands the photo over too, then cleaning up its encrypted temporary copy fails
        noteJobHandedToCare();
        throw cleanupFailure;
      });

      const settled = runAttempt(settling, item);
      await expect(runAttempt(failing, item)).rejects.toBe(cleanupFailure);
      release.resolve();
      await settled;

      if (handOff) {
        expect(mocks.assetJob.selectionForUnfinished).not.toHaveBeenCalled();
        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      } else {
        expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith([{ name: JobName.SmartSearch, data: { id } }]);
      }
      // each outcome is its own attempt's: one skipped, the other reported and failed, as before
      expect(mocks.event.emit).toHaveBeenCalledWith('JobSuccess', { job: item, response: JobStatus.Skipped });
      expect(mocks.event.emit.mock.calls.filter(([name]) => name === 'JobError')).toEqual([
        ['JobError', { job: item, error: cleanupFailure }],
      ]);
    });

    it.each(['a hidden asset', 'a partner copy sharing its source files'])('for %s keeps its follow-ups', async () => {
      const { data } = await run();

      expect(mocks.job.queueAll).toHaveBeenCalledExactlyOnceWith(
        [JobName.SmartSearch, JobName.AssetDetectFaces, JobName.Ocr, JobName.BestPhotosScore].map((name) => ({
          name,
          data,
        })),
      );
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith(
        'on_upload_success',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('a handler that throws (FL-71)', () => {
    it('reports the error and rethrows it, so the SQL queue records the job as failed', async () => {
      const error = new Error('Input file is missing');
      mocks.job.run.mockRejectedValue(error);
      const item = { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } } as const;

      await expect(sut.onJobRun(QueueName.ThumbnailGeneration, item)).rejects.toBe(error);

      expect(mocks.event.emit).toHaveBeenCalledWith('JobError', { job: item, error });
      expect(mocks.event.emit).toHaveBeenCalledWith('JobComplete', QueueName.ThumbnailGeneration, item);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('does not report a dependency refusal as a job error, so a deferred ML job is not logged on every retry', async () => {
      const error = new Error('Machine learning destination refused');
      mocks.job.run.mockRejectedValue(error);
      const item = { name: JobName.Ocr, data: { id: 'asset-1' } } as const;
      const execution = { dependencyReason: 'destination-unavailable' } as QueueExecution;

      await expect(queueExecution.run(execution, () => sut.onJobRun(QueueName.Ocr, item))).rejects.toBe(error);

      expect(mocks.event.emit).not.toHaveBeenCalledWith('JobError', expect.anything());
    });

    it('defers a job that waits for a Locked key: no job error, the queue defers it (FL-721)', async () => {
      const error = new LockedKeyUnavailableError(['owner-1']);
      mocks.job.run.mockRejectedValue(error);
      const item = { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } } as const;
      const execution = { claim: { id: 'job-1', attempt: 1, data: item.data } } as unknown as QueueExecution;

      await expect(queueExecution.run(execution, () => sut.onJobRun(QueueName.ThumbnailGeneration, item))).rejects.toBe(
        error,
      );

      expect(execution.dependencyReason).toBe('locked-key-unavailable');
      expect(mocks.event.emit).not.toHaveBeenCalledWith('JobError', expect.anything());
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
    ] as JobItem[])(
      'rethrows a $name failure so the queue retains a redacted needs-attention outcome',
      async (item) => {
        const error = new Error('boom');
        mocks.job.run.mockRejectedValue(error);

        await expect(sut.onJobRun(QueueName.BackgroundTask, item)).rejects.toBe(error);

        expect(mocks.event.emit).toHaveBeenCalledWith('JobError', { job: item, error });
        expect(mocks.event.emit).not.toHaveBeenCalledWith('JobSuccess', expect.anything());
        expect(mocks.event.emit).toHaveBeenCalledWith('JobComplete', QueueName.BackgroundTask, item);
      },
    );

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
        name === 'JobSuccess' ? Promise.reject(new Error('success listener unavailable')) : Promise.resolve(),
      );
      const item = { name: JobName.SidecarCheck, data: { id: 'asset-1' } } as const;

      await expect(sut.onJobRun(QueueName.Sidecar, item)).resolves.toBeUndefined();

      expect(mocks.event.emit).not.toHaveBeenCalledWith('JobError', expect.anything());
      expect(mocks.event.emit).toHaveBeenCalledWith('JobComplete', QueueName.Sidecar, item);
      expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('Unable to notify success'));
    });

    it('does not commit completion when required follow-up construction fails', async () => {
      mocks.job.run.mockResolvedValue(JobStatus.Success);
      mocks.job.queue.mockRejectedValue(new Error('database unavailable'));
      const item = { name: JobName.SidecarCheck, data: { id: 'asset-1' } } as const;
      await expect(sut.onJobRun(QueueName.Sidecar, item)).rejects.toThrow('database unavailable');
      expect(mocks.event.emit).toHaveBeenCalledWith('JobError', expect.anything());
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
      mocks.asset.getById.mockResolvedValue(getForAsset(AssetFactory.create({ id: 'asset-1' })));
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
      const publication = mocks.websocket.clientSend.mock.calls.find(([event]) => event === 'AssetEditReadyV2');
      expect(publication?.[1]).toBe(asset.ownerId);
      expect(publication?.[2]).toMatchObject({
        asset: { id: asset.id, checksum: asset.checksum.toString('base64'), isEdited: asset.isEdited },
        edit: [],
      });
      expect(publication?.[2]).not.toHaveProperty('asset.originalPath');
    });
  });
});
