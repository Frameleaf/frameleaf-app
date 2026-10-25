import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
import { isMediaProcessShutdownUnconfirmed } from 'src/queue/process-lifetime.js';
import { BaseService } from 'src/services/base.service.js';
import { SourceOriginalService } from 'src/services/source-original.service.js';
import { executionSignal, withExecutionSignal } from 'src/utils/execution-signal.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { assertOriginalPreserved } from 'src/utils/media-policy.js';
import { parseSourceOriginalPath } from 'src/utils/source-original.js';
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
const MAX_WAITING_GENERATIONS = 8;

type StudioMediaSource = {
  assetId: string;
  ownerId: string;
  path: string;
  version: string;
  folder: string;
  readPath: string;
  reference: boolean;
  check: () => Promise<void>;
};

type StudioMediaOwner = {
  deleting: boolean;
  stopUnconfirmed: boolean;
  requests: Set<{ abort: AbortController; stopped: Promise<void> }>;
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
 * the original), cached under the thumbnails folder by file identity or verified reference version.
 * Asset deletion removes the cache after its native writers stop. Access is exactly the thumbnail's:
 * `asset.view`, shared links included.
 */
@Injectable()
export class StudioMediaService extends BaseService {
  @Inject(SourceOriginalService)
  private sourceOriginalService!: SourceOriginalService;
  private readonly sourceReaderOwnerId = randomUUID();
  private inflight = new Map<string, { promise: Promise<unknown>; abort: AbortController; waiters: number }>();
  private sourceOwners = new Map<string, StudioMediaOwner>();
  private running = 0;
  private waiting: Array<() => void> = [];

  async getFilmstrip(
    auth: AuthDto,
    id: string,
    dto: AssetFilmstripOptionsDto,
    signal?: AbortSignal,
  ): Promise<AssetFilmstripResponseDto> {
    return this.withSource(auth, id, `filmstrip:${JSON.stringify(dto)}`, signal, async (source, signal) => {
      const { index } = await this.ensureFilmstrip(source, dto, signal);
      return index;
    });
  }

  async viewFilmstripSprite(
    auth: AuthDto,
    id: string,
    dto: AssetFilmstripSpriteOptionsDto,
    signal?: AbortSignal,
  ): Promise<FileDownloadResponse> {
    return this.withSource(auth, id, `sprite:${JSON.stringify(dto)}`, signal, async (source, signal) => {
      if (dto.version && dto.version !== source.version)
        throw new NotFoundException('The video changed; fetch the filmstrip index again');
      const { index, spritePath } = await this.ensureFilmstrip(source, dto, signal);
      return new FileDownloadResponse({
        path: spritePath,
        contentType: index.mimeType,
        cacheControl: CacheControl.PrivateWithCache,
      });
    });
  }

  async getWaveform(
    auth: AuthDto,
    id: string,
    dto: AssetWaveformOptionsDto,
    signal?: AbortSignal,
  ): Promise<AssetWaveformResponseDto> {
    return this.withSource(auth, id, `waveform:${JSON.stringify(dto)}`, signal, async (source, signal) => {
      const mode: WaveformChannelMode = dto.channels ?? 'mono';
      const cachePath = join(source.folder, `waveform-${source.version}-${mode}.bin`);
      const cached = await this.storageRepository
        .readFile(cachePath)
        .then((buffer) => decodeWaveformPeaks(buffer))
        .catch(() => null);
      const peaks =
        cached ??
        (source.reference
          ? await this.generateWaveform(source, mode, cachePath, signal!)
          : await this.once(cachePath, (signal) => this.generateWaveform(source, mode, cachePath, signal), signal));
      if (peaks.channels === 0)
        return {
          assetId: id,
          version: source.version,
          hasAudio: false,
          durationMs: 0,
          bucketCount: 0,
          bucketDurationMs: 0,
          channels: [],
        };
      return {
        assetId: id,
        version: source.version,
        hasAudio: true,
        ...resampleWaveformPeaks(peaks, dto.buckets ?? WAVEFORM_BUCKETS.default),
      };
    });
  }

  private async withSource<T>(
    auth: AuthDto,
    id: string,
    key: string,
    signal: AbortSignal | undefined,
    work: (source: StudioMediaSource, signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const owner = this.sourceOwners.get(id) ?? { deleting: false, stopUnconfirmed: false, requests: new Set() };
    if (owner.deleting || owner.stopUnconfirmed)
      throw new ServiceUnavailableException('Studio media generation is stopping; try again later');
    this.sourceOwners.set(id, owner);
    const abort = new AbortController();
    const stopped = Promise.withResolvers<void>();
    const request = { abort, stopped: stopped.promise };
    owner.requests.add(request);
    try {
      return await this.readSource(
        auth,
        id,
        key,
        signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
        work,
      );
    } catch (error) {
      if (isMediaProcessShutdownUnconfirmed(error)) owner.stopUnconfirmed = true;
      throw error;
    } finally {
      owner.requests.delete(request);
      if (!owner.deleting && !owner.stopUnconfirmed && owner.requests.size === 0) this.sourceOwners.delete(id);
      stopped.resolve();
    }
  }

  private async readSource<T>(
    auth: AuthDto,
    id: string,
    key: string,
    signal: AbortSignal | undefined,
    work: (source: StudioMediaSource, signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const source = await this.resolveSource(auth, id);
    let result: T;
    if (!source.reference) result = await work(source, signal);
    else
      result = await this.once(
        `source:${id}:${source.path}:${key}`,
        (signal) =>
          this.limited(async () => {
            const input = await this.sourceOriginalService.open(
              id,
              { kind: 'http', readerId: randomUUID(), ownerId: this.sourceReaderOwnerId },
              source.check,
              signal,
            );
            let confirmed = true;
            try {
              return await withExecutionSignal(signal, () =>
                withExecutionSignal(input.signal, async () => {
                  await input.check();
                  const selected = {
                    ...source,
                    readPath: input.localPath,
                    version: studioMediaFingerprint({
                      path: `${source.path}|${input.resourceId}|${input.resourceVersion}|${input.verifiedSha256}`,
                      size: input.byteLength,
                      mtimeMs: 0,
                    }),
                    check: async () => {
                      executionSignal()?.throwIfAborted();
                      await input.check();
                      executionSignal()?.throwIfAborted();
                    },
                  };
                  const result = await work(selected, signal);
                  await selected.check();
                  return result;
                }),
              );
            } catch (error) {
              confirmed = !isMediaProcessShutdownUnconfirmed(error);
              throw error;
            } finally {
              if (confirmed) await input.release();
            }
          }, signal),
        signal,
      );
    signal?.throwIfAborted();
    await source.check();
    signal?.throwIfAborted();
    return result;
  }

  /** The cache goes with the asset; nothing else refers to it. */
  @OnEvent({ name: 'AssetDelete' })
  async onAssetDelete({ assetId, userId }: ArgOf<'AssetDelete'>) {
    const owner = this.sourceOwners.get(assetId) ?? { deleting: false, stopUnconfirmed: false, requests: new Set() };
    this.sourceOwners.set(assetId, owner);
    owner.deleting = true;
    for (const request of owner.requests) request.abort.abort();
    await Promise.all([...owner.requests].map((request) => request.stopped));
    if (owner.stopUnconfirmed) return;
    try {
      await this.storageRepository
        .unlinkDir(getStudioMediaFolder(userId, assetId), { recursive: true, force: true })
        .catch((error) => this.logger.warn(`Could not remove the Studio timeline cache of ${assetId}: ${error}`));
    } finally {
      this.sourceOwners.delete(assetId);
    }
  }

  private async resolveSource(auth: AuthDto, id: string): Promise<StudioMediaSource> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });
    const asset = await this.assetRepository.getForVideo(id);
    if (!asset) {
      throw new NotFoundException('Asset not found or asset is not a video');
    }
    // the rendition playback serves to everyone (published edit, then transcode, then original)
    const path = asset.editedVideoPath || asset.encodedVideoPath || asset.originalPath;
    const reference = !!parseSourceOriginalPath(path);
    const stats = reference ? undefined : await this.storageRepository.stat(path).catch(() => null);
    if (!reference && !stats) {
      throw new NotFoundException('The video file is unavailable');
    }
    return {
      assetId: id,
      ownerId: asset.ownerId,
      path,
      version: stats ? studioMediaFingerprint({ path, size: stats.size, mtimeMs: stats.mtimeMs }) : '',
      folder: getStudioMediaFolder(asset.ownerId, id),
      readPath: path,
      reference,
      check: async () => {
        await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });
        const current = await this.assetRepository.getForVideo(id);
        if (
          !current ||
          current.ownerId !== asset.ownerId ||
          (current.editedVideoPath || current.encodedVideoPath || current.originalPath) !== path
        )
          throw new NotFoundException('The video changed; request timeline media again');
      },
    };
  }

  private async ensureFilmstrip(
    source: StudioMediaSource,
    dto: AssetFilmstripOptionsDto,
    signal?: AbortSignal,
  ): Promise<{ index: AssetFilmstripResponseDto; spritePath: string }> {
    const requestedCount = dto.count ?? FILMSTRIP_COUNT.default;
    const requestedHeight = dto.height ?? FILMSTRIP_HEIGHT.default;
    const count = [1, 2, 4, 20, 60, 120].find((value) => value >= requestedCount) ?? FILMSTRIP_COUNT.max;
    const height = [32, 90, 180, 240].find((value) => value >= requestedHeight) ?? FILMSTRIP_HEIGHT.max;
    const format: FilmstripFormat = dto.format ?? 'jpeg';
    const base = join(source.folder, `filmstrip-${source.version}-${count}x${height}`);
    const spritePath = `${base}.${format === 'webp' ? 'webp' : 'jpg'}`;
    const indexPath = `${base}.${format}.json`;

    const cached = await this.readFilmstripIndex(indexPath, spritePath);
    if (cached) {
      return { index: cached, spritePath };
    }
    // A borrowed input belongs to its outer request group, never another group's native work.
    const index = source.reference
      ? await this.generateFilmstrip(source, { count, height, format, spritePath, indexPath }, signal!)
      : await this.once(
          spritePath,
          (signal) => this.generateFilmstrip(source, { count, height, format, spritePath, indexPath }, signal),
          signal,
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
    signal: AbortSignal,
  ): Promise<AssetFilmstripResponseDto> {
    const generate = () =>
      withExecutionSignal(signal, async () => {
        await source.check();
        const { count, height, format, spritePath, indexPath } = options;
        await this.prepareFolder(source);
        const info = await this.mediaRepository.probe(source.readPath);
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
        let confirmed = true;
        try {
          const cut: Array<string | null> = [];
          for (const [frameIndex, timeMs] of plan.timesMs.entries()) {
            const output = join(work, `${frameIndex}.jpg`);
            assertOriginalPreserved({ originalPath: source.readPath, outputPath: output });
            await source.check();
            try {
              await this.mediaRepository.transcode(
                source.readPath,
                output,
                getFilmstripFrameCommand(ffmpeg, video, timeMs, height),
              );
              cut.push((await this.storageRepository.checkFileExists(output)) ? output : null);
            } catch (error) {
              if (isMediaProcessShutdownUnconfirmed(error)) throw error;
              executionSignal()?.throwIfAborted();
              this.logger.warn(`Could not cut filmstrip frame of ${source.assetId} at ${timeMs} ms: ${error}`);
              cut.push(null);
            }
          }
          const frames = fillMissingFrames(cut);
          if (!frames) {
            throw new NotFoundException('No frame could be cut from this video');
          }

          const sprite = join(work, `sprite.${format}`);
          const stagedIndex = join(work, 'index.json');
          for (const outputPath of [sprite, stagedIndex, spritePath, indexPath])
            assertOriginalPreserved({ originalPath: source.readPath, outputPath });
          await source.check();
          await this.mediaRepository.composeFilmstrip(frames, {
            columns: plan.columns,
            rows: plan.rows,
            tileWidth: plan.tileWidth,
            tileHeight: plan.tileHeight,
            format,
            quality: FILMSTRIP_QUALITY,
            output: sprite,
          });
          await source.check();
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
          await source.check();
          await this.storageRepository.createOrOverwriteFile(stagedIndex, Buffer.from(JSON.stringify(index)));
          await source.check();
          await this.storageRepository.rename(stagedIndex, indexPath);
          await this.pruneFilmstrips(source.folder);
          return index;
        } catch (error) {
          confirmed = !isMediaProcessShutdownUnconfirmed(error);
          throw error;
        } finally {
          if (confirmed) await this.storageRepository.unlinkDir(work, { recursive: true, force: true }).catch(() => {});
        }
      });
    return source.reference ? generate() : this.limited(generate, signal);
  }

  private generateWaveform(
    source: StudioMediaSource,
    mode: WaveformChannelMode,
    cachePath: string,
    signal: AbortSignal,
  ): Promise<WaveformPeaks> {
    const generate = () =>
      withExecutionSignal(signal, async () => {
        await source.check();
        await this.prepareFolder(source);
        const info = await this.mediaRepository.probe(source.readPath);
        const audio = info.audioStreams[0];
        let peaks: WaveformPeaks;
        if (audio) {
          const channels = waveformChannelCount(audio, mode);
          const accumulator = new PeakAccumulator(channels);
          await this.mediaRepository.transcode(
            source.readPath,
            accumulator.writable(),
            getWaveformCommand(audio, channels),
          );
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
        const temporary = `${cachePath}.${randomUUID()}.tmp`;
        for (const outputPath of [temporary, cachePath])
          assertOriginalPreserved({ originalPath: source.readPath, outputPath });
        await source.check();
        try {
          await this.storageRepository.createOrOverwriteFile(temporary, encodeWaveformPeaks(peaks));
          await source.check();
          await this.storageRepository.rename(temporary, cachePath);
          return peaks;
        } finally {
          await this.storageRepository.unlink(temporary).catch(() => {});
        }
      });
    return source.reference ? generate() : this.limited(generate, signal);
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

  /** One owner per key; the last departing waiter joins cancellation. */
  private async once<T>(key: string, generate: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let operation = this.inflight.get(key);
    if (!operation) {
      const abort = new AbortController();
      const promise = Promise.try(() => generate(abort.signal))
        .then((result) => {
          this.inflight.delete(key);
          return result;
        })
        .catch((error: unknown) => {
          // An unobserved native writer keeps its key and capacity until process recovery.
          if (!isMediaProcessShutdownUnconfirmed(error)) this.inflight.delete(key);
          throw error;
        });
      operation = { promise, abort, waiters: 0 };
      this.inflight.set(key, operation);
    }
    if (operation.abort.signal.aborted)
      throw new ServiceUnavailableException('Studio media generation is stopping; try again later');
    operation.waiters++;
    const canceled = Promise.withResolvers<never>();
    const abandon = () => canceled.reject(signal?.reason);
    signal?.addEventListener('abort', abandon, { once: true });
    try {
      signal?.throwIfAborted();
      return (await (signal ? Promise.race([operation.promise, canceled.promise]) : operation.promise)) as T;
    } finally {
      signal?.removeEventListener('abort', abandon);
      if (--operation.waiters === 0) {
        operation.abort.abort();
        await operation.promise.catch((error: unknown) => {
          if (isMediaProcessShutdownUnconfirmed(error)) throw error;
        });
      }
    }
  }

  private async limited<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      signal?.throwIfAborted();
      while (this.running >= MAX_CONCURRENT_GENERATIONS) {
        if (this.waiting.length >= MAX_WAITING_GENERATIONS)
          throw new ServiceUnavailableException('Studio media generation is busy; try again later');
        const pending = Promise.withResolvers<void>();
        const wake = () => {
          signal?.removeEventListener('abort', abandon);
          pending.resolve();
        };
        const abandon = () => {
          const index = this.waiting.indexOf(wake);
          if (index !== -1) this.waiting.splice(index, 1);
          signal?.removeEventListener('abort', abandon);
          pending.reject(signal?.reason);
        };
        this.waiting.push(wake);
        signal?.addEventListener('abort', abandon, { once: true });
        if (signal?.aborted) abandon();
        await pending.promise;
        signal?.throwIfAborted();
      }
    } catch (error) {
      if (this.running < MAX_CONCURRENT_GENERATIONS) this.waiting.shift()?.();
      throw error;
    }
    this.running++;
    let confirmed = true;
    try {
      return await work();
    } catch (error) {
      confirmed = !isMediaProcessShutdownUnconfirmed(error);
      throw error;
    } finally {
      if (confirmed) {
        this.running--;
        this.waiting.shift()?.();
      }
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
