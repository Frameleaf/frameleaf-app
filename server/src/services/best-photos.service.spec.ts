import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { vitest } from 'vitest';
import type { QueueExecution } from 'src/queue/types.js';
import { BEST_PHOTO_SCORE_VERSION } from 'src/dtos/best-photos.dto.js';
import { AssetStatus, AssetType, AssetVisibility, JobName, JobStatus } from 'src/enum.js';
import { deferJobAdoption, queueExecution } from 'src/queue/context.js';
import { BestPhotosService } from 'src/services/best-photos.service.js';
import { executionSignal } from 'src/utils/execution-signal.js';
import { sourceOriginalPath } from 'src/utils/source-original.js';
import { probeStub, videoInfoStub } from 'test/fixtures/media.stub.js';
import { newSystemMetadataRepositoryMock } from 'test/repositories/system-metadata.repository.mock.js';
import { factory } from 'test/small.factory.js';

describe(BestPhotosService.name, () => {
  const logger = { setContext: vitest.fn(), warn: vitest.fn(), debug: vitest.fn(), error: vitest.fn() };
  const assetJobRepository = {
    getForBestPhotoScoring: vitest.fn(),
    getForVideoDuplicateFrameJob: vitest.fn(),
    selectionForBestPhotosScoring: vitest.fn(),
  };
  const bestPhotosRepository = {
    getBestPhotos: vitest.fn(),
    upsertScore: vitest.fn(),
  };
  const jobRepository = { queueSelection: vitest.fn(), guardAssetSource: vitest.fn() };
  const mediaRepository = { scoreThumbnailCandidate: vitest.fn(), transcode: vitest.fn(), probe: vitest.fn() };
  const configRepository = { getEnv: vitest.fn() };
  const systemMetadataRepository = newSystemMetadataRepositoryMock();

  let sut: BestPhotosService;

  beforeEach(() => {
    vitest.resetAllMocks();
    jobRepository.guardAssetSource.mockResolvedValue(undefined);
    configRepository.getEnv.mockReturnValue({});
    sut = new BestPhotosService(
      logger as never,
      assetJobRepository as never,
      bestPhotosRepository as never,
      jobRepository as never,
      mediaRepository as never,
      configRepository as never,
      systemMetadataRepository as never,
    );
  });

  it('should map an empty Best Photos response', async () => {
    bestPhotosRepository.getBestPhotos.mockResolvedValue({ hasNextPage: false, items: [], total: 0 });

    await expect(sut.getBestPhotos(factory.auth(), { page: 1, limit: 100, includeArchived: false })).resolves.toEqual({
      total: 0,
      count: 0,
      items: [],
      nextPage: null,
    });
  });

  it('does not read or score an asset when its source guard rejects the run', async () => {
    const sourceChanged = new Error('Asset inputs changed before publication');
    jobRepository.guardAssetSource.mockRejectedValueOnce(sourceChanged);

    await expect(sut.handleScore({ id: 'asset-1' })).rejects.toBe(sourceChanged);

    expect(jobRepository.guardAssetSource).toHaveBeenCalledExactlyOnceWith('asset-1');
    expect(assetJobRepository.getForBestPhotoScoring).not.toHaveBeenCalled();
    expect(mediaRepository.scoreThumbnailCandidate).not.toHaveBeenCalled();
    expect(mediaRepository.transcode).not.toHaveBeenCalled();
    expect(bestPhotosRepository.upsertScore).not.toHaveBeenCalled();
  });

  it('should score good images higher than low-quality images', async () => {
    const asset = {
      id: 'asset-1',
      ownerId: 'user-1',
      type: AssetType.Image,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      originalFileName: 'vacation.jpg',
      width: 4000,
      height: 3000,
      previewFile: '/preview.jpg',
      faceCount: 1,
    };
    assetJobRepository.getForBestPhotoScoring.mockResolvedValue(asset);
    mediaRepository.scoreThumbnailCandidate.mockResolvedValueOnce(150).mockResolvedValueOnce(-30);

    await expect(sut.handleScore({ id: asset.id })).resolves.toBe(JobStatus.Success);
    expect(jobRepository.guardAssetSource).toHaveBeenCalledExactlyOnceWith(asset.id);
    const goodScore = bestPhotosRepository.upsertScore.mock.calls[0][0].score;

    assetJobRepository.getForBestPhotoScoring.mockResolvedValue({
      ...asset,
      originalFileName: 'screenshot.png',
      width: 200,
      height: 200,
      faceCount: 0,
    });
    await expect(sut.handleScore({ id: asset.id })).resolves.toBe(JobStatus.Success);
    const badScore = bestPhotosRepository.upsertScore.mock.calls[1][0].score;

    expect(goodScore).toBeGreaterThan(badScore);
    expect(bestPhotosRepository.upsertScore).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scoreVersion: BEST_PHOTO_SCORE_VERSION,
        bestFrameTimestampMs: null,
        frameScore: null,
        frameMetadata: null,
      }),
    );
  });

  describe('video scoring', () => {
    const videoAsset = {
      id: 'video-1',
      ownerId: 'user-1',
      type: AssetType.Video,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      originalFileName: 'clip.mp4',
      width: 3840,
      height: 2160,
      previewFile: '/preview.jpg',
      faceCount: 0,
    };

    const videoJob = (durationMs: number) => ({
      id: videoAsset.id,
      ownerId: videoAsset.ownerId,
      originalPath: '/data/library/clip.mp4',
      visibility: AssetVisibility.Timeline,
      videoStream: probeStub.videoStream2160p.videoStream!,
      format: { ...probeStub.videoStream2160p.format, duration: durationMs },
    });

    describe('reference originals', () => {
      const logicalPath = sourceOriginalPath({
        sourceId: '12345678-1234-4234-8234-123456789012',
        resourceKey: 'a'.repeat(64),
      });
      const ownedFolders = new Set<string>();
      afterEach(async () => {
        // No real child is started by these mocks; remove only their retained frame fixture folders.
        for (const folder of ownedFolders) await rm(folder, { recursive: true, force: true });
        ownedFolders.clear();
      });
      const reference = () => {
        const controller = new AbortController();
        const assertCurrent = vitest.fn().mockResolvedValue(undefined);
        const context: QueueExecution = {
          claim: {
            id: '12345678-1234-4234-8234-123456789013',
            queue: 'backgroundTask',
            name: JobName.BestPhotosScore,
            data: { id: videoAsset.id },
            token: '12345678-1234-4234-8234-123456789014',
            workerId: 'test',
            attempt: 1,
            runId: null,
            itemKey: null,
            deadlineMs: 120_000,
            startedAt: new Date(),
          },
          signal: new AbortController().signal,
          progress: () => {},
          followups: [],
          adoptions: [],
          afterSettled: [],
          buffering: true,
          progressUnits: 0,
          sourceAuthorities: new Map([
            [
              videoAsset.id,
              {
                ownerId: videoAsset.ownerId,
                snapshot: {
                  assetId: videoAsset.id,
                  ownerId: videoAsset.ownerId,
                  derivatives: true,
                  checksum: 'aa',
                  revision: { originalPath: logicalPath },
                },
                assertCurrent,
              },
            ],
          ]),
        };
        let authorize!: () => Promise<void>;
        let retained = false;
        const release = vitest.fn().mockResolvedValue(undefined);
        const input = {
          localPath: '/fixture/borrowed.artifact',
          signal: controller.signal,
          check: vitest.fn(async () => {
            controller.signal.throwIfAborted();
            await authorize();
          }),
          retainOnUnconfirmedStop: vitest.fn(() => {
            retained = true;
            context.executorStopUnconfirmed = true;
          }),
        };
        const originals = {
          openForJob: vitest.fn(async (_id: string, guard: () => Promise<void>) => {
            authorize = guard;
            await guard();
            context.afterSettled!.push(async () => {
              if (!retained) await release();
            });
            return input;
          }),
        };
        Object.assign(sut, { sourceOriginalService: originals });
        assetJobRepository.getForBestPhotoScoring.mockResolvedValue(videoAsset);
        assetJobRepository.getForVideoDuplicateFrameJob.mockResolvedValue({
          ...videoJob(60_000),
          originalPath: logicalPath,
        });
        mediaRepository.probe.mockResolvedValue({
          ...videoInfoStub.videoStream2160p,
          format: { ...videoInfoStub.videoStream2160p.format, duration: 60 },
        });
        mediaRepository.transcode.mockImplementation((_input: string, output: string) => {
          ownedFolders.add(path.dirname(output));
          return Promise.resolve();
        });
        mediaRepository.scoreThumbnailCandidate.mockResolvedValue(80);
        const persisted: unknown[] = [];
        bestPhotosRepository.upsertScore.mockImplementation((score) => {
          deferJobAdoption(() => {
            persisted.push(score);
            return Promise.resolve();
          });
          return Promise.resolve();
        });
        return { context, controller, input, originals, release, persisted, assertCurrent };
      };

      it('probes and samples one leased original, retaining it through source-checked publication', async () => {
        const f = reference();
        assetJobRepository.getForVideoDuplicateFrameJob.mockResolvedValue({
          ...videoJob(3_600_000),
          originalPath: logicalPath,
        });
        mediaRepository.probe.mockResolvedValue({
          ...videoInfoStub.videoStream2160p,
          videoStreams: [{ ...videoInfoStub.videoStream2160p.videoStreams[0], width: 1280, height: 720 }],
          format: { ...videoInfoStub.videoStream2160p.format, duration: 60 },
        });
        const status = await queueExecution.run(f.context, () => sut.handleScore({ id: videoAsset.id }));
        expect(logger.warn.mock.calls).toEqual([]);
        expect(status).toBe(JobStatus.Success);
        expect(f.originals.openForJob).toHaveBeenCalledOnce();
        expect(mediaRepository.probe).toHaveBeenCalledWith(f.input.localPath, expect.anything());
        expect(mediaRepository.transcode).toHaveBeenCalledTimes(5);
        expect(mediaRepository.transcode.mock.calls.every(([input]) => input === f.input.localPath)).toBe(true);
        expect(bestPhotosRepository.upsertScore).toHaveBeenCalledWith(
          expect.objectContaining({ frameMetadata: expect.objectContaining({ durationMs: 60_000 }) }),
        );
        expect(bestPhotosRepository.upsertScore).toHaveBeenCalledWith(
          expect.objectContaining({ metadata: expect.objectContaining({ pixels: 1280 * 720 }) }),
        );
        expect(f.persisted).toEqual([]);
        expect(f.release).not.toHaveBeenCalled();
        for (const adopt of f.context.adoptions) await adopt({} as never);
        expect(f.persisted).toHaveLength(1);
        for (const settle of f.context.afterSettled!) await settle();
        expect(f.release).toHaveBeenCalledOnce();
        await expect(assetJobRepository.getForVideoDuplicateFrameJob.mock.results[0].value).resolves.toMatchObject({
          originalPath: logicalPath,
        });
      });

      it.each(['source_original_shutdown_unconfirmed', 'artifact_close_unconfirmed'])(
        'retains original and frame resources after %s',
        async (code) => {
          const f = reference();
          mediaRepository.transcode.mockImplementationOnce((_input: string, output: string) => {
            ownedFolders.add(path.dirname(output));
            throw new Error(code);
          });
          expect(await queueExecution.run(f.context, () => sut.handleScore({ id: videoAsset.id }))).toBe(
            JobStatus.Failed,
          );
          expect(f.input.retainOnUnconfirmedStop).toHaveBeenCalledOnce();
          expect(mediaRepository.transcode).toHaveBeenCalledOnce();
          expect(bestPhotosRepository.upsertScore).not.toHaveBeenCalled();
        },
      );

      it('marks an unknown managed encoder stop before declaring the attempt stopped', async () => {
        const f = reference();
        assetJobRepository.getForVideoDuplicateFrameJob.mockResolvedValue(videoJob(60_000));
        mediaRepository.transcode.mockImplementationOnce((_input: string, output: string) => {
          ownedFolders.add(path.dirname(output));
          throw new Error('media_process_shutdown_unconfirmed');
        });
        expect(await queueExecution.run(f.context, () => sut.handleScore({ id: videoAsset.id }))).toBe(
          JobStatus.Failed,
        );
        expect(f.context.executorStopUnconfirmed).toBe(true);
        expect(f.originals.openForJob).not.toHaveBeenCalled();
        expect(mediaRepository.transcode).toHaveBeenCalledOnce();
      });

      it('refuses provider revocation at adoption before publishing a prepared score', async () => {
        const f = reference();
        await queueExecution.run(f.context, () => sut.handleScore({ id: videoAsset.id }));
        expect(f.context.adoptions.length).toBeGreaterThan(0);
        f.input.check.mockRejectedValueOnce(new Error('source_original_unavailable'));
        await expect(f.context.adoptions[0]({} as never)).rejects.toThrow('source_original_unavailable');
        expect(f.persisted).toEqual([]);
      });

      it('does not swallow source cancellation and continue sampling other frames', async () => {
        const f = reference();
        mediaRepository.transcode.mockImplementationOnce((_input: string, output: string) => {
          ownedFolders.add(path.dirname(output));
          const signal = executionSignal();
          f.controller.abort();
          expect(signal?.aborted).toBe(true);
          expect(f.context.signal.aborted).toBe(false);
          throw new Error('cancelled input');
        });
        await expect(queueExecution.run(f.context, () => sut.handleScore({ id: videoAsset.id }))).resolves.toBe(
          JobStatus.Failed,
        );
        expect(mediaRepository.transcode).toHaveBeenCalledOnce();
        expect(mediaRepository.scoreThumbnailCandidate).not.toHaveBeenCalled();
        expect(bestPhotosRepository.upsertScore).not.toHaveBeenCalled();
      });

      it('refuses references without the executor source authority before acquisition', async () => {
        const f = reference();
        await expect(sut.handleScore({ id: videoAsset.id })).resolves.toBe(JobStatus.Failed);
        expect(f.originals.openForJob).not.toHaveBeenCalled();
        expect(mediaRepository.probe).not.toHaveBeenCalled();
        expect(mediaRepository.transcode).not.toHaveBeenCalled();
      });

      it('stops sampling when the provider revokes the input after one extraction', async () => {
        const f = reference();
        mediaRepository.transcode.mockImplementationOnce((_input: string, output: string) => {
          ownedFolders.add(path.dirname(output));
          f.input.check.mockRejectedValue(new Error('source_original_unavailable'));
          return Promise.resolve();
        });
        await expect(queueExecution.run(f.context, () => sut.handleScore({ id: videoAsset.id }))).resolves.toBe(
          JobStatus.Failed,
        );
        expect(mediaRepository.transcode).toHaveBeenCalledOnce();
        expect(mediaRepository.scoreThumbnailCandidate).not.toHaveBeenCalled();
        expect(bestPhotosRepository.upsertScore).not.toHaveBeenCalled();
      });

      it.each(['owner', 'privacy'] as const)('rechecks %s before starting the source reader', async (change) => {
        const f = reference();
        assetJobRepository.getForBestPhotoScoring.mockResolvedValueOnce(videoAsset).mockResolvedValue({
          ...videoAsset,
          ...(change === 'owner' ? { ownerId: 'other-owner' } : { visibility: AssetVisibility.Hidden }),
        });
        await expect(queueExecution.run(f.context, () => sut.handleScore({ id: videoAsset.id }))).resolves.toBe(
          JobStatus.Failed,
        );
        expect(mediaRepository.probe).not.toHaveBeenCalled();
        expect(mediaRepository.transcode).not.toHaveBeenCalled();
        expect(bestPhotosRepository.upsertScore).not.toHaveBeenCalled();
      });

      it.each(['flag', 'error'] as const)(
        'retains the lease and frames after unconfirmed child stop (%s)',
        async (failure) => {
          const f = reference();
          mediaRepository.transcode.mockImplementationOnce((_input: string, output: string) => {
            ownedFolders.add(path.dirname(output));
            if (failure === 'error') throw new Error('media_process_shutdown_unconfirmed');
            f.context.executorStopUnconfirmed = true;
            return Promise.resolve();
          });
          await expect(queueExecution.run(f.context, () => sut.handleScore({ id: videoAsset.id }))).resolves.toBe(
            JobStatus.Failed,
          );
          expect(mediaRepository.transcode).toHaveBeenCalledOnce();
          expect(f.input.retainOnUnconfirmedStop).toHaveBeenCalledOnce();
          expect(mediaRepository.scoreThumbnailCandidate).not.toHaveBeenCalled();
          expect(bestPhotosRepository.upsertScore).not.toHaveBeenCalled();
          for (const folder of ownedFolders) await expect(access(folder)).resolves.toBeUndefined();
          for (const settle of f.context.afterSettled!) await settle();
          expect(f.release).not.toHaveBeenCalled();
        },
      );
    });

    it('should score a video by its best sampled frame and persist frame columns', async () => {
      assetJobRepository.getForBestPhotoScoring.mockResolvedValue(videoAsset);
      assetJobRepository.getForVideoDuplicateFrameJob.mockResolvedValue(videoJob(60_000));
      mediaRepository.transcode.mockResolvedValue(void 0);
      mediaRepository.scoreThumbnailCandidate
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(80)
        .mockResolvedValueOnce(50)
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(5);

      await expect(sut.handleScore({ id: videoAsset.id })).resolves.toBe(JobStatus.Success);

      // 60s clip sampled at 10s/20s/30s/40s/50s; best raw score (80) is at 20s
      expect(mediaRepository.transcode).toHaveBeenCalledTimes(5);
      expect(bestPhotosRepository.upsertScore).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: videoAsset.id,
          ownerId: videoAsset.ownerId,
          scoreVersion: BEST_PHOTO_SCORE_VERSION,
          bestFrameTimestampMs: 20_000,
          frameScore: (80 + 40) / 220,
          frameMetadata: expect.objectContaining({
            durationMs: 60_000,
            sampledFrameCount: 5,
            frames: expect.arrayContaining([expect.objectContaining({ timestampMs: 20_000, thumbnailScore: 80 })]),
          }),
        }),
      );
    });

    it('should skip a video over the duration cap without extracting frames', async () => {
      assetJobRepository.getForBestPhotoScoring.mockResolvedValue(videoAsset);
      assetJobRepository.getForVideoDuplicateFrameJob.mockResolvedValue(videoJob(3_600_000));

      await expect(sut.handleScore({ id: videoAsset.id })).resolves.toBe(JobStatus.Skipped);
      expect(mediaRepository.transcode).not.toHaveBeenCalled();
      expect(bestPhotosRepository.upsertScore).not.toHaveBeenCalled();
    });

    it('should skip a video without probed metadata', async () => {
      assetJobRepository.getForBestPhotoScoring.mockResolvedValue(videoAsset);
      assetJobRepository.getForVideoDuplicateFrameJob.mockResolvedValue(void 0);

      await expect(sut.handleScore({ id: videoAsset.id })).resolves.toBe(JobStatus.Skipped);
      expect(bestPhotosRepository.upsertScore).not.toHaveBeenCalled();
    });

    it('should skip gracefully when every frame extraction fails', async () => {
      assetJobRepository.getForBestPhotoScoring.mockResolvedValue(videoAsset);
      assetJobRepository.getForVideoDuplicateFrameJob.mockResolvedValue(videoJob(60_000));
      mediaRepository.transcode.mockRejectedValue(new Error('ffmpeg failed'));

      await expect(sut.handleScore({ id: videoAsset.id })).resolves.toBe(JobStatus.Skipped);
      expect(bestPhotosRepository.upsertScore).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should pick the best frame among the frames that extract successfully', async () => {
      assetJobRepository.getForBestPhotoScoring.mockResolvedValue(videoAsset);
      assetJobRepository.getForVideoDuplicateFrameJob.mockResolvedValue(videoJob(60_000));
      mediaRepository.transcode
        .mockResolvedValueOnce(void 0)
        .mockRejectedValueOnce(new Error('dead zone'))
        .mockResolvedValueOnce(void 0)
        .mockResolvedValueOnce(void 0)
        .mockResolvedValueOnce(void 0);
      mediaRepository.scoreThumbnailCandidate
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(60)
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(5);

      await expect(sut.handleScore({ id: videoAsset.id })).resolves.toBe(JobStatus.Success);

      // frame at 20s failed to extract; best of the remaining (60) is at 30s
      expect(bestPhotosRepository.upsertScore).toHaveBeenCalledWith(
        expect.objectContaining({
          bestFrameTimestampMs: 30_000,
          frameMetadata: expect.objectContaining({ sampledFrameCount: 5 }),
        }),
      );
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  it('should queue single asset scoring jobs for a backfill', async () => {
    assetJobRepository.selectionForBestPhotosScoring.mockReturnValue([{ id: 'asset-1' }, { id: 'asset-2' }]);

    await expect(sut.handleQueueAll({ force: true })).resolves.toBe(JobStatus.Success);
    expect(jobRepository.queueSelection).toHaveBeenCalledWith(
      JobName.BestPhotosScore,
      assetJobRepository.selectionForBestPhotosScoring.mock.results[0].value,
    );
  });
});
