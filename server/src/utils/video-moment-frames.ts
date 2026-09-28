import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SystemConfig } from 'src/config.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetStatus, AssetVisibility, StorageFolder, TranscodeTarget } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import {
  VideoMomentFrame,
  VideoMomentFrameInsert,
  VideoMomentRepository,
  VideoMomentSourceRow,
} from 'src/repositories/video-moment.repository.js';
import {
  VIDEO_MOMENT_EXTRACTOR_VERSION,
  VIDEO_MOMENT_MAX_DURATION_MS,
  rankVideoFrames,
  sourceFingerprint,
  videoMomentFrameTimestamps,
} from 'src/utils/enrichment-plan.js';
import { ThumbnailConfig } from 'src/utils/media.js';

/**
 * Cutting the reusable video frames (FL-59).
 *
 * Shared by the enrichment plan's frames stage, a description of a video that has no frames yet,
 * and a description preview. It is bounded on purpose: six frames, one ffmpeg seek at a time, at
 * the preview size, and never for videos longer than `VIDEO_MOMENT_MAX_DURATION_MS`. Nothing here
 * depends on duplicate detection.
 */

export type VideoFrameDeps = {
  media: MediaRepository;
  storage: StorageRepository;
  moments: VideoMomentRepository;
  logger: LoggingRepository;
};

export type FrameCutOutcome =
  | { status: 'cut'; frames: VideoMomentFrame[] }
  | { status: 'current'; frames: VideoMomentFrame[] }
  | { status: 'skipped'; reasonKey: 'not-a-video' | 'not-eligible' | 'too-short' | 'too-long' }
  | { status: 'source-changed' }
  | { status: 'failed'; message: string };

type CutFrame = VideoMomentFrameInsert;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isEligible = (source: Pick<VideoMomentSourceRow, 'status' | 'deletedAt' | 'visibility'>) =>
  source.status === AssetStatus.Active && source.deletedAt === null && source.visibility !== AssetVisibility.Hidden;

const ffmpegFor = (config: Pick<SystemConfig, 'ffmpeg' | 'image'>) => ({
  ...config.ffmpeg,
  targetResolution: config.image.preview.size.toString(),
});

/**
 * Cut the frames of one video into files named by `pathFor`, scoring and ranking them. A frame whose
 * seek yields nothing (a sparse keyframe near the end) is left out rather than failing the video.
 * Returns the frames cut; removes nothing it did not write.
 */
export const cutFrames = async (
  deps: Pick<VideoFrameDeps, 'media' | 'storage' | 'logger'>,
  source: VideoMomentSourceRow,
  config: Pick<SystemConfig, 'ffmpeg' | 'image'>,
  pathFor: (frameIndex: number) => string,
): Promise<CutFrame[]> => {
  const durationMs = Number(source.format.duration ?? source.duration ?? 0);
  const times = videoMomentFrameTimestamps(durationMs);
  const cut: Array<Omit<CutFrame, 'rank'>> = [];

  for (const [frameIndex, timestampMs] of times.entries()) {
    const path = pathFor(frameIndex);
    deps.storage.mkdirSync(dirname(path));
    try {
      const command = ThumbnailConfig.create(ffmpegFor(config), timestampMs / 1000).getCommand(
        TranscodeTarget.Video,
        source.videoStream,
        undefined,
        source.format,
      );
      await deps.media.transcode(source.originalPath, path, command);
      const score = await deps.media.scoreThumbnailCandidate(path);
      const { width, height } = await deps.media.getImageMetadata(path).catch(() => ({ width: 0, height: 0 }));
      cut.push({ frameIndex, timestampMs, path, width: width || null, height: height || null, score });
    } catch (error) {
      deps.logger.warn(
        `Could not cut moment frame ${frameIndex} of video ${source.id} at ${timestampMs} ms: ${errorMessage(error)}`,
      );
      await deps.storage.unlink(path).catch(() => {});
    }
  }

  const ranks = rankVideoFrames(cut);
  return cut.map((frame) => ({ ...frame, rank: ranks.get(frame.frameIndex) ?? cut.length }));
};

/** The body of `ensureVideoFrames`, run while its frame lock is held. */
const cutAndPublish = async (
  deps: VideoFrameDeps,
  assetId: string,
  config: Pick<SystemConfig, 'ffmpeg' | 'image'>,
  options: { force?: boolean },
): Promise<FrameCutOutcome> => {
  const source = await deps.moments.getVideoSource(assetId);
  if (!source) {
    return { status: 'skipped', reasonKey: 'not-a-video' };
  }
  if (!isEligible(source)) {
    return { status: 'skipped', reasonKey: 'not-eligible' };
  }

  const durationMs = Number(source.format.duration ?? source.duration ?? 0);
  if (durationMs > VIDEO_MOMENT_MAX_DURATION_MS) {
    return { status: 'skipped', reasonKey: 'too-long' };
  }
  if (videoMomentFrameTimestamps(durationMs).length === 0) {
    return { status: 'skipped', reasonKey: 'too-short' };
  }

  const fingerprint = sourceFingerprint(source as Parameters<typeof sourceFingerprint>[0]);
  if (!options.force) {
    const [index, existing] = await Promise.all([deps.moments.getIndex(assetId), deps.moments.getFrames(assetId)]);
    if (
      index &&
      existing.length > 0 &&
      index.sourceFingerprint === fingerprint &&
      index.extractorVersion === VIDEO_MOMENT_EXTRACTOR_VERSION
    ) {
      return { status: 'current', frames: existing };
    }
  }

  // A fresh name per cut, so a browser never shows a cached old frame and the old files can be
  // removed only once the new ones are published.
  const nonce = Date.now().toString(36);
  const frames = await cutFrames(deps, source, config, (frameIndex) =>
    StorageCore.getNestedPath(
      StorageFolder.Thumbnails,
      source.ownerId,
      `${source.id}_moment_${nonce}_${frameIndex}.jpeg`,
    ),
  );
  if (frames.length === 0) {
    return { status: 'failed', message: 'No frame could be cut from this video' };
  }

  const published = await deps.moments.replaceFrames(assetId, fingerprint, frames, {
    extractorVersion: VIDEO_MOMENT_EXTRACTOR_VERSION,
  });
  if (published.status === 'source-changed') {
    await Promise.all(frames.map(({ path }) => deps.storage.unlink(path).catch(() => {})));
    return { status: 'source-changed' };
  }

  await Promise.all(published.stalePaths.map((path) => deps.storage.unlink(path).catch(() => {})));
  return { status: 'cut', frames: published.frames };
};

/**
 * Make sure a video has current reusable frames, cutting them when it has none or when its
 * original changed since they were cut. With `force` they are cut again regardless.
 *
 * Publication is guarded by the source fingerprint read before cutting: if the original was
 * replaced while ffmpeg ran, the new files are removed and nothing is published (`source-changed`).
 * The old frames' files are deleted only after the new ones are in the database. Concurrent calls
 * for the same video are serialised by `withFrameLock`, so two cuts never race each other.
 */
export const ensureVideoFrames = (
  deps: VideoFrameDeps,
  assetId: string,
  config: Pick<SystemConfig, 'ffmpeg' | 'image'>,
  options: { force?: boolean } = {},
): Promise<FrameCutOutcome> =>
  // Whoever gets the lock second finds the frames the first one cut and uses them as they are.
  deps.moments.withFrameLock(assetId, () => cutAndPublish(deps, assetId, config, options));

/**
 * Cut frames into a temporary folder for a preview, without touching the library: nothing is
 * written to the database and the folder is removed when `use` returns.
 */
export const withTemporaryFrames = async <T>(
  deps: Pick<VideoFrameDeps, 'media' | 'storage' | 'logger' | 'moments'>,
  assetId: string,
  config: Pick<SystemConfig, 'ffmpeg' | 'image'>,
  use: (frames: CutFrame[]) => Promise<T>,
): Promise<T | undefined> => {
  const source = await deps.moments.getVideoSource(assetId);
  if (!source) {
    return undefined;
  }
  const durationMs = Number(source.format.duration ?? source.duration ?? 0);
  if (durationMs > VIDEO_MOMENT_MAX_DURATION_MS) {
    return undefined;
  }

  const folder = await mkdtemp(join(tmpdir(), 'frameleaf-moment-preview-'));
  try {
    const frames = await cutFrames(deps, source, config, (frameIndex) => join(folder, `frame_${frameIndex}.jpeg`));
    return frames.length > 0 ? await use(frames) : undefined;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};
