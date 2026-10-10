import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  AssetFilmstripOptionsDto,
  AssetFilmstripResponseDto,
  AssetFilmstripSpriteOptionsDto,
  AssetWaveformOptionsDto,
  AssetWaveformResponseDto,
} from 'src/dtos/studio-media.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { CacheControl, Permission, StorageFolder } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import {
  FILMSTRIP_COUNT,
  FILMSTRIP_HEIGHT,
  FILMSTRIP_QUALITY,
  FilmstripFormat,
  PeakAccumulator,
  WAVEFORM_BUCKETS,
  WaveformChannelMode,
  WaveformPeaks,
  decodeWaveformPeaks,
  encodeWaveformPeaks,
  getFilmstripFrameCommand,
  getWaveformCommand,
  planFilmstrip,
  resampleWaveformPeaks,
  studioMediaFingerprint,
  waveformChannelCount,
} from 'src/utils/studio-media.js';

/** Filmstrip variants (count x height x format) kept per video; older ones are removed. */
const MAX_FILMSTRIP_VARIANTS = 8;
/** Generations running at once across the server; ffmpeg is the expensive part. */
const MAX_CONCURRENT_GENERATIONS = 2;

type StudioMediaSource = {
  assetId: string;
  ownerId: string;
  path: string;
  version: string;
  folder: string;
};

/**
 * The per-video cache folder. It is hidden (a leading dot) so the untracked-file integrity scan,
 * which walks the thumbnails folder without hidden entries, never reports these disposable files.
 */
export const getStudioMediaFolder = (ownerId: string, assetId: string) =>
  join(StorageCore.getNestedFolder(StorageFolder.Thumbnails, ownerId, assetId), `.${assetId}-timeline`);

/**
 * Studio timeline media for the native iPad and Android Studio apps (see utils/studio-media.ts):
 * a filmstrip sprite sheet with its JSON index, and audio waveform peaks. Both are made on first
 * request with ffmpeg from the rendition `/assets/{id}/video/playback` serves (never handed out as
 * the original), cached per video under the thumbnails folder, keyed by that file's path, size and
 * modification time, and removed with the asset. Access is exactly the thumbnail's: `asset.view`,
 * shared links included.
 */
@Injectable()
export class StudioMediaService extends BaseService {
  private inflight = new Map<string, Promise<unknown>>();
  private running = 0;
  private waiting: Array<() => void> = [];

  async getFilmstrip(auth: AuthDto, id: string, dto: AssetFilmstripOptionsDto): Promise<AssetFilmstripResponseDto> {
    const source = await this.resolveSource(auth, id);
    const { index } = await this.ensureFilmstrip(source, dto);
    return index;
  }

  async viewFilmstripSprite(
    auth: AuthDto,
    id: string,
    dto: AssetFilmstripSpriteOptionsDto,
  ): Promise<ImmichFileResponse> {
    const source = await this.resolveSource(auth, id);
    if (dto.version && dto.version !== source.version) {
      throw new NotFoundException('The video changed; fetch the filmstrip index again');
    }
    const { index, spritePath } = await this.ensureFilmstrip(source, dto);
    return new ImmichFileResponse({
      path: spritePath,
      contentType: index.mimeType,
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async getWaveform(auth: AuthDto, id: string, dto: AssetWaveformOptionsDto): Promise<AssetWaveformResponseDto> {
    const source = await this.resolveSource(auth, id);
    const mode: WaveformChannelMode = dto.channels ?? 'mono';
    const cachePath = join(source.folder, `waveform-${source.version}-${mode}.bin`);
    const cached = await this.storageRepository
      .readFile(cachePath)
      .then((buffer) => decodeWaveformPeaks(buffer))
      .catch(() => null);
    const peaks = cached ?? (await this.once(cachePath, () => this.generateWaveform(source, mode, cachePath)));
    if (peaks.channels === 0) {
      return {
        assetId: id,
        version: source.version,
        hasAudio: false,
        durationMs: 0,
        bucketCount: 0,
        bucketDurationMs: 0,
        channels: [],
      };
    }
    const resampled = resampleWaveformPeaks(peaks, dto.buckets ?? WAVEFORM_BUCKETS.default);
    return { assetId: id, version: source.version, hasAudio: true, ...resampled };
  }

  /** The cache goes with the asset; nothing else refers to it. */
  @OnEvent({ name: 'AssetDelete' })
  async onAssetDelete({ assetId, userId }: ArgOf<'AssetDelete'>) {
    await this.storageRepository
      .unlinkDir(getStudioMediaFolder(userId, assetId), { recursive: true, force: true })
      .catch((error) => this.logger.warn(`Could not remove the Studio timeline cache of ${assetId}: ${error}`));
  }

  private async resolveSource(auth: AuthDto, id: string): Promise<StudioMediaSource> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });
    const asset = await this.assetRepository.getForVideo(id);
    if (!asset) {
      throw new NotFoundException('Asset not found or asset is not a video');
    }
    // the rendition playback serves to everyone (published edit, then transcode, then original)
    const path = asset.editedVideoPath || asset.encodedVideoPath || asset.originalPath;
    const stats = await this.storageRepository.stat(path).catch(() => null);
    if (!stats) {
      throw new NotFoundException('The video file is unavailable');
    }
    return {
      assetId: id,
      ownerId: asset.ownerId,
      path,
      version: studioMediaFingerprint({ path, size: stats.size, mtimeMs: stats.mtimeMs }),
      folder: getStudioMediaFolder(asset.ownerId, id),
    };
  }

  private async ensureFilmstrip(
    source: StudioMediaSource,
    dto: AssetFilmstripOptionsDto,
  ): Promise<{ index: AssetFilmstripResponseDto; spritePath: string }> {
    const count = dto.count ?? FILMSTRIP_COUNT.default;
    const height = dto.height ?? FILMSTRIP_HEIGHT.default;
    const format: FilmstripFormat = dto.format ?? 'jpeg';
    const base = join(source.folder, `filmstrip-${source.version}-${count}x${height}`);
    const spritePath = `${base}.${format === 'webp' ? 'webp' : 'jpg'}`;
    const indexPath = `${base}.${format}.json`;

    const cached = await this.readFilmstripIndex(indexPath, spritePath);
    if (cached) {
      return { index: cached, spritePath };
    }
    const index = await this.once(spritePath, () =>
      this.generateFilmstrip(source, { count, height, format, spritePath, indexPath }),
    );
    return { index, spritePath };
  }

  private async readFilmstripIndex(indexPath: string, spritePath: string) {
    try {
      const [buffer, hasSprite] = await Promise.all([
        this.storageRepository.readFile(indexPath),
        this.storageRepository.checkFileExists(spritePath),
      ]);
      return hasSprite ? (JSON.parse(buffer.toString('utf8')) as AssetFilmstripResponseDto) : null;
    } catch {
      return null;
    }
  }

  private generateFilmstrip(
    source: StudioMediaSource,
    options: { count: number; height: number; format: FilmstripFormat; spritePath: string; indexPath: string },
  ): Promise<AssetFilmstripResponseDto> {
    return this.limited(async () => {
      const { count, height, format, spritePath, indexPath } = options;
      await this.prepareFolder(source);
      const info = await this.mediaRepository.probe(source.path);
      const video = info.videoStreams[0];
      if (!video) {
        throw new NotFoundException('The video has no video track');
      }
      const durationMs = Math.max(0, Math.round((info.format.duration || 0) * 1000));
      const plan = planFilmstrip({
        durationMs,
        width: video.width,
        height: video.height,
        rotation: video.rotation,
        count,
        tileHeight: height,
      });
      const { ffmpeg } = await this.getConfig({ withCache: true });

      const work = join(source.folder, `.work-${randomUUID()}`);
      this.storageRepository.mkdirSync(work);
      try {
        const cut: Array<string | null> = [];
        for (const [frameIndex, timeMs] of plan.timesMs.entries()) {
          const output = join(work, `${frameIndex}.jpg`);
          try {
            await this.mediaRepository.transcode(
              source.path,
              output,
              getFilmstripFrameCommand(ffmpeg, video, timeMs, height),
            );
            cut.push((await this.storageRepository.checkFileExists(output)) ? output : null);
          } catch (error) {
            this.logger.warn(`Could not cut filmstrip frame of ${source.assetId} at ${timeMs} ms: ${error}`);
            cut.push(null);
          }
        }
        const frames = fillMissingFrames(cut);
        if (!frames) {
          throw new NotFoundException('No frame could be cut from this video');
        }

        const sprite = join(work, `sprite.${format}`);
        await this.mediaRepository.composeFilmstrip(frames, {
          columns: plan.columns,
          rows: plan.rows,
          tileWidth: plan.tileWidth,
          tileHeight: plan.tileHeight,
          format,
          quality: FILMSTRIP_QUALITY,
          output: sprite,
        });
        await this.storageRepository.rename(sprite, spritePath);

        const index: AssetFilmstripResponseDto = {
          assetId: source.assetId,
          version: source.version,
          durationMs,
          format,
          mimeType: format === 'webp' ? 'image/webp' : 'image/jpeg',
          frameWidth: plan.tileWidth,
          frameHeight: plan.tileHeight,
          columns: plan.columns,
          rows: plan.rows,
          spriteWidth: plan.spriteWidth,
          spriteHeight: plan.spriteHeight,
          frames: plan.timesMs.map((timeMs, frameIndex) => ({
            index: frameIndex,
            timeMs,
            x: (frameIndex % plan.columns) * plan.tileWidth,
            y: Math.floor(frameIndex / plan.columns) * plan.tileHeight,
          })),
        };
        await this.storageRepository.createOrOverwriteFile(indexPath, Buffer.from(JSON.stringify(index)));
        await this.pruneFilmstrips(source.folder);
        return index;
      } finally {
        await this.storageRepository.unlinkDir(work, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  private generateWaveform(
    source: StudioMediaSource,
    mode: WaveformChannelMode,
    cachePath: string,
  ): Promise<WaveformPeaks> {
    return this.limited(async () => {
      await this.prepareFolder(source);
      const info = await this.mediaRepository.probe(source.path);
      const audio = info.audioStreams[0];
      let peaks: WaveformPeaks;
      if (audio) {
        const channels = waveformChannelCount(audio, mode);
        const accumulator = new PeakAccumulator(channels);
        await this.mediaRepository.transcode(source.path, accumulator.writable(), getWaveformCommand(audio, channels));
        peaks = accumulator.finish();
      } else {
        // remembered too, so a silent video is not probed on every request
        peaks = {
          channels: 0,
          sampleRate: 1,
          samplesPerBucket: 1,
          bucketCount: 0,
          frameCount: 0,
          peaks: new Int16Array(),
        };
      }
      const temporary = `${cachePath}.${process.pid}.tmp`;
      await this.storageRepository.createOrOverwriteFile(temporary, encodeWaveformPeaks(peaks));
      await this.storageRepository.rename(temporary, cachePath);
      return peaks;
    });
  }

  /** Creates the folder and drops whatever was made from an earlier version of the video. */
  private async prepareFolder(source: StudioMediaSource) {
    this.storageRepository.mkdirSync(source.folder);
    const entries = await this.storageRepository.readdir(source.folder).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((name) => !name.startsWith('.') && !name.includes(source.version))
        .map((name) => this.storageRepository.unlink(join(source.folder, name)).catch(() => {})),
    );
  }

  private async pruneFilmstrips(folder: string) {
    const entries = await this.storageRepository.readdir(folder).catch(() => [] as string[]);
    const indexes = entries.filter((name) => name.startsWith('filmstrip-') && name.endsWith('.json'));
    if (indexes.length <= MAX_FILMSTRIP_VARIANTS) {
      return;
    }
    const dated = await Promise.all(
      indexes.map(async (name) => ({
        name,
        mtimeMs: await this.storageRepository
          .stat(join(folder, name))
          .then((stats) => stats.mtimeMs)
          .catch(() => 0),
      })),
    );
    dated.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { name } of dated.slice(0, dated.length - MAX_FILMSTRIP_VARIANTS)) {
      // filmstrip-<version>-<count>x<height>.<format>.json beside its .jpg or .webp sprite
      const [stem, format] = name.slice(0, -'.json'.length).split(/\.(?=[^.]+$)/, 2);
      await Promise.all(
        [name, `${stem}.${format === 'webp' ? 'webp' : 'jpg'}`].map((file) =>
          this.storageRepository.unlink(join(folder, file)).catch(() => {}),
        ),
      );
    }
  }

  /** One generation per output at a time; concurrent requests for it share the result. */
  private once<T>(key: string, generate: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const promise = generate().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    while (this.running >= MAX_CONCURRENT_GENERATIONS) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * A seek that yields nothing (a sparse keyframe near the end) borrows the nearest earlier frame,
 * or the nearest later one at the start, so the sprite and its index always match. `null` when no
 * frame was cut at all.
 */
export const fillMissingFrames = (frames: Array<string | null>): string[] | null => {
  const first = frames.find((frame) => frame !== null);
  if (!first) {
    return null;
  }
  let previous = first;
  return frames.map((frame) => (previous = frame ?? previous));
};
