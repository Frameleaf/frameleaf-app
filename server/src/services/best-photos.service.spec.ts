import { vitest } from 'vitest';
import { BEST_PHOTOS_MIN_SCORE, BEST_PHOTO_SCORE_VERSION } from 'src/dtos/best-photos.dto.js';
import { AssetStatus, AssetType, AssetVisibility, JobName, JobStatus } from 'src/enum.js';
import { BestPhotosService } from 'src/services/best-photos.service.js';
import { LockedKeyUnavailableError } from 'src/utils/locked-read.js';
import { lockedFixture } from 'test/fixtures/locked.stub.js';
import { probeStub } from 'test/fixtures/media.stub.js';
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
  const mediaRepository = { measureImageQuality: vitest.fn(), transcode: vitest.fn() };
  /** Preview statistics as sharp reports them; the defaults are an ordinary, well-exposed photo. */
  const quality = (
    overrides: Partial<{ mean: number; contrast: number; entropy: number; sharpness: number }> = {},
  ) => ({
    mean: 115,
    contrast: 60,
    entropy: 7.3,
    sharpness: 2.3,
    thumbnailScore: 220,
    ...overrides,
  });
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
    expect(mediaRepository.measureImageQuality).not.toHaveBeenCalled();
    expect(mediaRepository.transcode).not.toHaveBeenCalled();
    expect(bestPhotosRepository.upsertScore).not.toHaveBeenCalled();
  });

  it('reads an encrypted Locked preview through a plain copy, and waits for the key without failing', async () => {
    const locked = await lockedFixture('user-1');
    try {
      const plain = Buffer.from('a plain preview');
      const previewFile = await locked.seal('preview.jpg', plain, 'image/jpeg');
      assetJobRepository.getForBestPhotoScoring.mockResolvedValue({
        id: 'asset-1',
        ownerId: 'user-1',
        type: AssetType.Image,
        status: AssetStatus.Active,
        deletedAt: null,
        visibility: AssetVisibility.Timeline,
        originalFileName: 'vacation.jpg',
        width: 4000,
        height: 3000,
        previewFile,
        faceCount: 1,
      });

      await expect(sut.handleScore({ id: 'asset-1' })).rejects.toBeInstanceOf(LockedKeyUnavailableError);
      expect(mediaRepository.measureImageQuality).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();

      locked.loadKey();
      let read: Buffer | undefined;
      mediaRepository.measureImageQuality.mockImplementation(async (path: string) => {
        expect(path).not.toBe(previewFile);
        read = await import('node:fs/promises').then((fs) => fs.readFile(path));
        return quality();
      });
      await expect(sut.handleScore({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);
      expect(read).toEqual(plain);
      expect(await locked.copiesLeft()).toBe(0);
    } finally {
      await locked.cleanup();
    }
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
    mediaRepository.measureImageQuality
      .mockResolvedValueOnce(quality({ sharpness: 6 }))
      .mockResolvedValueOnce(quality({ sharpness: 0.5, contrast: 3, entropy: 1, thumbnailScore: -30 }));

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

  describe('calibration', () => {
    const photo = {
      id: 'asset-1',
      ownerId: 'user-1',
      type: AssetType.Image,
      status: AssetStatus.Active,
      deletedAt: null,
      visibility: AssetVisibility.Timeline,
      originalFileName: 'IMG_0001.JPG',
      width: 4032,
      height: 3024,
      previewFile: '/preview.jpg',
      faceCount: 0,
    };
    const scoreOf = async (stats: ReturnType<typeof quality>, asset = photo) => {
      assetJobRepository.getForBestPhotoScoring.mockResolvedValue(asset);
      mediaRepository.measureImageQuality.mockResolvedValue(stats);
      await sut.handleScore({ id: asset.id });
      return bestPhotosRepository.upsertScore.mock.lastCall![0];
    };

    it('lets a crisp, well-exposed 12 MP photo with no people reach the Best Photos threshold', async () => {
      // the 99th percentile of measured library photos
      const { score } = await scoreOf(quality({ sharpness: 6.2, contrast: 75, entropy: 7.6 }));
      expect(score).toBeGreaterThanOrEqual(BEST_PHOTOS_MIN_SCORE);
    });

    it('keeps an ordinary photo (the median of measured library photos) below the threshold', async () => {
      const { score } = await scoreOf(quality());
      expect(score).toBeLessThan(BEST_PHOTOS_MIN_SCORE);
      expect(score).toBeGreaterThan(0.6);
    });

    it('never ranks a flat, single-colour image near the top', async () => {
      const flat = quality({ mean: 87, contrast: 0, entropy: 0, sharpness: 0, thumbnailScore: -53 });
      const { score, technicalScore } = await scoreOf(flat, { ...photo, width: 1, height: 1 });
      expect(score).toBeLessThan(0.2);
      // Tidy up's Accidental shots (technicalScore below 0.1–0.22) still finds it
      expect(technicalScore).toBeLessThan(0.1);
    });

    it('keeps technicalScore on its version 1 scale for an ordinary photo, so Tidy up leaves it alone', async () => {
      const { technicalScore } = await scoreOf(quality({ sharpness: 1, contrast: 30 }));
      expect(technicalScore).toBeGreaterThan(0.9);
    });
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

    it('should score a video by its best sampled frame and persist frame columns', async () => {
      assetJobRepository.getForBestPhotoScoring.mockResolvedValue(videoAsset);
      assetJobRepository.getForVideoDuplicateFrameJob.mockResolvedValue(videoJob(60_000));
      mediaRepository.transcode.mockResolvedValue(void 0);
      mediaRepository.measureImageQuality
        .mockResolvedValueOnce(quality({ sharpness: 1.5 }))
        .mockResolvedValueOnce(quality({ sharpness: 5 }))
        .mockResolvedValueOnce(quality({ sharpness: 3 }))
        .mockResolvedValueOnce(quality({ sharpness: 2 }))
        .mockResolvedValueOnce(quality({ sharpness: 1 }));

      await expect(sut.handleScore({ id: videoAsset.id })).resolves.toBe(JobStatus.Success);

      // 60s clip sampled at 10s/20s/30s/40s/50s; the sharpest frame is at 20s
      expect(mediaRepository.transcode).toHaveBeenCalledTimes(5);
      expect(bestPhotosRepository.upsertScore).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: videoAsset.id,
          ownerId: videoAsset.ownerId,
          scoreVersion: BEST_PHOTO_SCORE_VERSION,
          bestFrameTimestampMs: 20_000,
          frameScore: expect.closeTo(0.5 * 0.8 + 0.2 + 0.15 * (40 / 45) + 0.15 * (2.3 / 2.5), 6),
          frameMetadata: expect.objectContaining({
            durationMs: 60_000,
            sampledFrameCount: 5,
            frames: expect.arrayContaining([
              expect.objectContaining({ timestampMs: 20_000, frameScore: expect.any(Number) }),
            ]),
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
      mediaRepository.measureImageQuality
        .mockResolvedValueOnce(quality({ sharpness: 1.5 }))
        .mockResolvedValueOnce(quality({ sharpness: 4 }))
        .mockResolvedValueOnce(quality({ sharpness: 2 }))
        .mockResolvedValueOnce(quality({ sharpness: 1 }));

      await expect(sut.handleScore({ id: videoAsset.id })).resolves.toBe(JobStatus.Success);

      // frame at 20s failed to extract; the sharpest of the rest is at 30s
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
