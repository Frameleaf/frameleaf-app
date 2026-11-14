import { Injectable } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import {
  BEST_PHOTO_SCORE_VERSION,
  BestPhotoAssetResponseDto,
  BestPhotosQueryDto,
  BestPhotosResponseDto,
} from 'src/dtos/best-photos.dto.js';
import { AssetStatus, AssetType, AssetVisibility, JobName, JobStatus, QueueName, TranscodeTarget } from 'src/enum.js';
import { deferJobUntilDependency } from 'src/queue/dependency.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { BestPhotoScoreUpsert, BestPhotosRepository } from 'src/repositories/best-photos.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { AESTHETIC_HEAD_SCORE_VERSION, getAestheticHead, scoreAesthetic } from 'src/utils/aesthetic-head.js';
import { getConfig } from 'src/utils/config.js';
import { asDateTimeString } from 'src/utils/date.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { isLockedKeyUnavailable, makeWorkDirFor, withPlainCopy } from 'src/utils/locked-read.js';
import { ThumbnailConfig } from 'src/utils/media.js';

type BestPhotoScoringAsset = NonNullable<Awaited<ReturnType<AssetJobRepository['getForBestPhotoScoring']>>>;
type ImageQuality = Awaited<ReturnType<MediaRepository['measureImageQuality']>>;

/** Asset row joined with best_photo_score columns. Derived from the repository
 * return type so a schema change to `asset_best_photo_score` trips the
 * compiler at `mapBestPhotoAsset`. */
type BestPhotoAssetRow = Awaited<ReturnType<BestPhotosRepository['getBestPhotos']>>['items'][number];

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const isScreenshotLike = (fileName: string) =>
  /\b(screen ?shot|screen capture|scan|document|receipt|invoice)\b/i.test(fileName);

// Subject bump for recognizable people: up to two faces count, so a crowd
// shot does not outrank a portrait. A photo with no faces can still reach
// BEST_PHOTOS_MIN_SCORE on image quality alone.
const FACE_COUNT_CAP = 2;
const PER_FACE_WEIGHT = 0.2;

/** Image quality 0–1 from the preview's statistics. Ranges were measured on 2026-11-13 over 301 library
 * photos and 29 full-size camera files at preview size: sharpness 1 is the 10th percentile and 6 the 99th,
 * contrast 20–65 and entropy 5–7.5 span ordinary photos, and brightness is fine within 45 of mid-grey.
 * With 12 MP originals about 1–3% of photos clear BEST_PHOTOS_MIN_SCORE, the rest spread below it.
 * FL-978: this is aesthetic score version 1, kept for models without a learned head (`aesthetic-head.ts`). */
const imageQualityOf = ({ mean, contrast, entropy, sharpness }: ImageQuality) =>
  0.5 * clamp((sharpness - 1) / 5) +
  0.2 * clamp(1 - Math.max(0, Math.abs(mean - 120) - 45) / 60) +
  0.15 * clamp((contrast - 20) / 45) +
  0.15 * clamp((entropy - 5) / 2.5);

// Video frame sampling. Videos are scored by extracting a handful of frames
// (via the same ffmpeg thumbnail path used for video previews) and running
// each through the image scorer. The best frame supplies the score and is
// recorded (bestFrameTimestampMs / frameScore / frameMetadata) so clients can
// seek the player or preview to the best moment.
const VIDEO_FRAME_SAMPLE_COUNT = 5;
// Per-video cost ceiling. Each sampled frame is one ffmpeg seek + single-frame
// decode. Media-health bounds its ffmpeg probes at 120 seconds; five frame
// extractions from a <= 15-minute file stay comfortably inside that budget,
// while hour-long screen recordings and dashcam footage are skipped rather
// than monopolizing the background queue.
const VIDEO_SCORE_MAX_DURATION_SECONDS = 15 * 60;

/** FL-978: the image statistics a score stored, so an embedding-only re-score does not read the preview again. */
const storedQuality = (metadata: Record<string, unknown> | null): ImageQuality | null => {
  const { brightness: mean, contrast, entropy, sharpness, thumbnailScore } = metadata ?? {};
  const values = [mean, contrast, entropy, sharpness, thumbnailScore];
  return values.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? ({ mean, contrast, entropy, sharpness, thumbnailScore } as ImageQuality)
    : null;
};

/** FL-978: sigmoid(head(embedding)) for the visual search model that made the embedding, or null. */
type LearnedAesthetic = { score: number; modelName: string };

@Injectable()
export class BestPhotosService {
  private readonly modelsWithoutHead = new Set<string>();

  constructor(
    private logger: LoggingRepository,
    private assetJobRepository: AssetJobRepository,
    private bestPhotosRepository: BestPhotosRepository,
    private jobRepository: JobRepository,
    private mediaRepository: MediaRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
  ) {
    this.logger.setContext(BestPhotosService.name);
  }

  async getBestPhotos(auth: AuthDto, dto: BestPhotosQueryDto): Promise<BestPhotosResponseDto> {
    const { hasNextPage, items, total } = await this.bestPhotosRepository.getBestPhotos({
      ...getHiddenContentQueryOptions(auth),
      ownerId: auth.user.id,
      limit: dto.limit,
      page: dto.page,
      minScore: dto.minScore,
      includeArchived: dto.includeArchived,
    });

    return {
      total,
      count: items.length,
      items: items.map((asset) => this.mapBestPhotoAsset(auth, asset)),
      nextPage: hasNextPage ? String(dto.page + 1) : null,
    };
  }

  @OnJob({ name: JobName.BestPhotosScoreQueueAll, queue: QueueName.BackgroundTask })
  async handleQueueAll({ force }: JobOf<JobName.BestPhotosScoreQueueAll>): Promise<JobStatus> {
    await this.jobRepository.queueSelection(
      JobName.BestPhotosScore,
      this.assetJobRepository.selectionForBestPhotosScoring({
        force,
        scoreVersion: BEST_PHOTO_SCORE_VERSION,
      }),
    );
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.BestPhotosScore, queue: QueueName.BackgroundTask })
  async handleScore({ id, embeddingChanged }: JobOf<JobName.BestPhotosScore>): Promise<JobStatus> {
    await this.jobRepository.guardAssetSource(id);
    const asset = await this.assetJobRepository.getForBestPhotoScoring(id);
    if (!asset || !this.isEligible(asset)) {
      return JobStatus.Skipped;
    }

    if (!asset.previewFile) {
      deferJobUntilDependency('source-unavailable');
      this.logger.warn(`Skipping Best Photos scoring for asset ${id}: preview file is missing`);
      return JobStatus.Skipped;
    }

    try {
      const upsert =
        asset.type === AssetType.Video
          ? await this.scoreVideoAsset(asset)
          : await this.scoreImageAsset(asset, embeddingChanged);
      if (!upsert) {
        return JobStatus.Skipped;
      }

      await this.bestPhotosRepository.upsertScore(upsert);
      return JobStatus.Success;
    } catch (error: any) {
      if (isLockedKeyUnavailable(error)) {
        // FL-721: an encrypted Locked file waits for its owner's key; the job is deferred, not failed
        throw error;
      }
      this.logger.warn(`Failed to score Best Photos asset ${id}: ${error.message || error}`);
      return JobStatus.Failed;
    }
  }

  private isEligible(asset: BestPhotoScoringAsset) {
    return (
      (asset.type === AssetType.Image || asset.type === AssetType.Video) &&
      asset.status === AssetStatus.Active &&
      asset.deletedAt === null &&
      (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive)
    );
  }

  private async scoreImageAsset(asset: BestPhotoScoringAsset, embeddingChanged = false): Promise<BestPhotoScoreUpsert> {
    const stored = embeddingChanged ? storedQuality(asset.scoreMetadata) : null;
    // FL-721: an encrypted Locked preview is read through a plain copy
    const quality =
      stored ?? (await withPlainCopy(asset.previewFile!, (path) => this.mediaRepository.measureImageQuality(path)));
    return this.buildScoreUpsert(asset, quality, asset.width, asset.height, await this.learnedAesthetic(asset));
  }

  /** FL-978: the learned aesthetic score; null keeps version 1 (no embedding yet, or no head for the model). */
  private async learnedAesthetic(asset: BestPhotoScoringAsset): Promise<LearnedAesthetic | null> {
    if (!asset.embedding) {
      return null;
    }
    const { machineLearning } = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );
    const modelName = machineLearning.clip.modelName;
    const head = getAestheticHead(modelName);
    if (!head && !this.modelsWithoutHead.has(modelName)) {
      this.modelsWithoutHead.add(modelName);
      this.logger.log(`Visual search model ${modelName} has no learned aesthetic head; Best Photos keeps version 1`);
    }
    const score = head && scoreAesthetic(head, JSON.parse(asset.embedding) as number[]);
    return score === null ? null : { score, modelName };
  }

  /** Samples frames across the video, scores each with the image scorer, and
   * records the best frame. Returns null (job skipped) when the video has no
   * probe data, is over the duration cap, or no frame could be extracted. */
  private async scoreVideoAsset(asset: BestPhotoScoringAsset): Promise<BestPhotoScoreUpsert | null> {
    // Reuse the video-duplicate frame query: it returns exactly the metadata
    // frame extraction needs (originalPath + probed videoStream/format).
    const video = await this.assetJobRepository.getForVideoDuplicateFrameJob(asset.id);
    if (!video) {
      this.logger.debug(`Skipping Best Photos video scoring for asset ${asset.id}: missing video metadata`);
      return null;
    }

    const durationSeconds = video.format.duration / 1000;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      this.logger.debug(`Skipping Best Photos video scoring for asset ${asset.id}: unknown duration`);
      return null;
    }

    if (durationSeconds > VIDEO_SCORE_MAX_DURATION_SECONDS) {
      this.logger.debug(
        `Skipping Best Photos video scoring for asset ${asset.id}: duration ${Math.round(durationSeconds)}s exceeds the ${VIDEO_SCORE_MAX_DURATION_SECONDS}s cap`,
      );
      return null;
    }

    const timestamps = this.getVideoFrameSampleTimestamps(durationSeconds);
    if (timestamps.length === 0) {
      return null;
    }

    const config = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );
    const thumbnailConfig = { ...config.ffmpeg, targetResolution: config.image.preview.size.toString() };

    // FL-721: an encrypted Locked video is read through a plain copy
    return withPlainCopy(video.originalPath, (originalPath) =>
      this.scoreVideoFrames(asset, { ...video, originalPath }, timestamps, thumbnailConfig),
    );
  }

  private async scoreVideoFrames(
    asset: BestPhotoScoringAsset,
    video: NonNullable<Awaited<ReturnType<AssetJobRepository['getForVideoDuplicateFrameJob']>>>,
    timestamps: number[],
    thumbnailConfig: Parameters<typeof ThumbnailConfig.create>[0],
  ): Promise<BestPhotoScoreUpsert | null> {
    let best: { timestamp: number; quality: ImageQuality; frameScore: number } | null = null;
    const sampledFrames: Array<{ timestampMs: number; frameScore: number }> = [];
    // FL-721 M6: frames of an encrypted video (a plain copy) stay in the RAM-backed Locked folder
    const tempDir = await makeWorkDirFor(video.originalPath, 'best-photos');
    try {
      for (const [index, timestamp] of timestamps.entries()) {
        const framePath = path.join(tempDir, `frame_${index}.jpeg`);
        try {
          const command = ThumbnailConfig.create(thumbnailConfig, timestamp).getCommand(
            TranscodeTarget.Video,
            video.videoStream,
            undefined,
            video.format,
          );
          await this.mediaRepository.transcode(video.originalPath, framePath, command);
          const quality = await this.mediaRepository.measureImageQuality(framePath);
          const frameScore = imageQualityOf(quality);
          sampledFrames.push({ timestampMs: Math.round(timestamp * 1000), frameScore });
          if (!best || frameScore > best.frameScore) {
            best = { timestamp, quality, frameScore };
          }
        } catch (error: any) {
          // A frame can fail to extract when its start_time lands in the
          // sparse-keyframe dead zone near EOF. Skip just that frame.
          this.logger.warn(
            `Could not score Best Photos video frame for asset ${asset.id} at ${timestamp}s: ${error?.message ?? error}`,
          );
        }
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    if (!best) {
      this.logger.warn(`Skipping Best Photos video scoring for asset ${asset.id}: no frame could be extracted`);
      return null;
    }

    const upsert = this.buildScoreUpsert(
      asset,
      best.quality,
      asset.width ?? video.videoStream.width,
      asset.height ?? video.videoStream.height,
    );

    return {
      ...upsert,
      bestFrameTimestampMs: Math.round(best.timestamp * 1000),
      frameScore: best.frameScore,
      frameMetadata: {
        durationMs: video.format.duration,
        sampledFrameCount: timestamps.length,
        frames: sampledFrames,
      },
    };
  }

  /** Evenly spread sample points, avoiding the sparse-keyframe dead zone near
   * the end of the file (see the video thumbnail candidate logic in
   * media.service for the same tail reservation). */
  private getVideoFrameSampleTimestamps(durationSeconds: number): number[] {
    const tail = Math.min(Math.max(durationSeconds * 0.1, 0.5), 5);
    const latest = Math.max(durationSeconds - tail, 0);

    return [
      ...new Set(
        Array.from({ length: VIDEO_FRAME_SAMPLE_COUNT }, (_, index) => {
          const timestamp = (durationSeconds * (index + 1)) / (VIDEO_FRAME_SAMPLE_COUNT + 1);
          return Number(Math.min(timestamp, latest).toFixed(3));
        }),
      ),
    ].filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
  }

  private buildScoreUpsert(
    asset: BestPhotoScoringAsset,
    quality: ImageQuality,
    width: number | null,
    height: number | null,
    learned: LearnedAesthetic | null = null,
  ): BestPhotoScoreUpsert {
    const { thumbnailScore } = quality;
    const imageQuality = imageQualityOf(quality);
    const pixels = Math.max(0, (width ?? 0) * (height ?? 0));
    const tinyPenalty = pixels > 0 && pixels < 500_000 ? 0.2 : 0;
    const screenshotPenalty = isScreenshotLike(asset.originalFileName) ? 0.2 : 0;

    // technicalScore keeps its version 1 formula: Tidy up's "Accidental shots" cutoffs (0.1–0.22) are set
    // against it, and it only falls that low for black, blank or tiny frames.
    const normalizedThumbnailScore = clamp((thumbnailScore + 40) / 220);
    const technicalScore = clamp(
      normalizedThumbnailScore * 0.75 + clamp((Math.sqrt(pixels) - 700) / 3300) * 0.25 - tinyPenalty,
    );

    // 8 MP and up counts as full resolution: a 12 MP phone photo is not a lesser photo than a 24 MP one.
    const resolutionScore = clamp((Math.sqrt(pixels) - 700) / 2100);
    const subjectScore = clamp(0.6 + Math.min(asset.faceCount, FACE_COUNT_CAP) * PER_FACE_WEIGHT - screenshotPenalty);
    const aestheticScore = clamp((learned?.score ?? imageQuality) - screenshotPenalty);
    const diversityScore = 0.5;

    const score = clamp(0.75 * aestheticScore + 0.1 * resolutionScore + 0.15 * subjectScore - tinyPenalty);

    return {
      assetId: asset.id,
      ownerId: asset.ownerId,
      score,
      aestheticScore,
      technicalScore,
      subjectScore,
      diversityScore,
      scoreVersion: BEST_PHOTO_SCORE_VERSION,
      computedAt: new Date(),
      metadata: {
        thumbnailScore,
        normalizedThumbnailScore,
        imageQuality,
        brightness: quality.mean,
        contrast: quality.contrast,
        entropy: quality.entropy,
        sharpness: quality.sharpness,
        resolutionScore,
        pixels,
        faceCount: asset.faceCount,
        screenshotPenalty,
        tinyPenalty,
        aestheticScoreVersion: learned ? AESTHETIC_HEAD_SCORE_VERSION : 1,
        aestheticModel: learned?.modelName ?? null,
        learnedAestheticScore: learned?.score ?? null,
      },
      // Video scoring fills these in (see scoreVideoAsset); images have no frames.
      bestFrameTimestampMs: null,
      frameScore: null,
      frameMetadata: null,
    };
  }

  private mapBestPhotoAsset(auth: AuthDto, asset: BestPhotoAssetRow): BestPhotoAssetResponseDto {
    return {
      ...mapAsset(asset, { auth }),
      bestPhotoScore: {
        score: asset.bestPhotoScore,
        aestheticScore: asset.bestPhotoAestheticScore,
        aestheticScoreVersion: asset.bestPhotoMetadata?.aestheticScoreVersion === AESTHETIC_HEAD_SCORE_VERSION ? 2 : 1,
        technicalScore: asset.bestPhotoTechnicalScore,
        subjectScore: asset.bestPhotoSubjectScore,
        diversityScore: asset.bestPhotoDiversityScore,
        scoreVersion: asset.bestPhotoScoreVersion,
        computedAt: asDateTimeString(asset.bestPhotoComputedAt),
        metadata: asset.bestPhotoMetadata,
        bestFrameTimestampMs: asset.bestPhotoBestFrameTimestampMs,
        frameScore: asset.bestPhotoFrameScore,
        frameMetadata: asset.bestPhotoFrameMetadata,
      },
    };
  }
}
