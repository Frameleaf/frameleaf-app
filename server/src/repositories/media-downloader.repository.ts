import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sanitize from 'sanitize-filename';
import type { MediaQuality, MediaSaves } from 'src/schema/tables/media-import.table.js';
import { MediaBrokerError, startMediaDownloadBroker, validateMediaUrl } from 'src/utils/media-download-broker.js';
import { MediaDownloadFileError, copyMediaDownload } from 'src/utils/media-download-file.js';

export type MediaDownloadCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  expires?: number;
  storeId?: string;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor?: boolean };
};

export type MediaDownloadSession = {
  cookies?: MediaDownloadCookie[];
  domains: string[];
  username?: string;
  password?: string;
  refreshToken?: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
};

export type MediaDownloadEntry = {
  provider: string;
  creatorId: string | null;
  postId: string;
  attachmentId: string;
  pageUrl: string;
  mediaUrl?: string;
  extractionUrl?: string;
  title: string;
  description: string;
  creator: string | null;
  publishedAt: string | null;
  kind: 'image' | 'video' | 'audio';
  thumbnailUrl?: string;
  /** Present only when the extractor's own fields say so. */
  section?: string;
  tags?: string[];
  playlistId?: string;
  playlistTitle?: string;
  duration?: number;
};

/** What the extractor reports about the account itself. The picture URLs are never sent to a client. */
export type MediaCreatorProfile = {
  handle?: string;
  about?: string;
  url?: string;
  avatarUrl?: string;
  bannerUrl?: string;
};

export type MediaDownloadInspection = {
  kind: 'item' | 'feed';
  provider: string;
  creatorId: string | null;
  creator: string | null;
  title: string;
  canonicalUrl: string;
  entries: MediaDownloadEntry[];
  checkpoint: string | null;
  complete: boolean;
  limitation: string | null;
  profile?: MediaCreatorProfile | null;
};

export type MediaDownloadedFile = {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  entry: MediaDownloadEntry;
};

export type MediaDownloadErrorCode =
  | 'unavailable'
  | 'invalid_url'
  | 'blocked_target'
  | 'unsupported'
  | 'unsupported_session'
  | 'authentication_required'
  | 'rate_limited'
  | 'no_media'
  | 'incomplete'
  | 'too_large'
  | 'timeout'
  | 'cancelled'
  | 'failed';

const errorMessages: Record<MediaDownloadErrorCode, string> = {
  unavailable: 'Media extraction is unavailable on this server.',
  invalid_url: 'Enter an HTTP or HTTPS URL without credentials.',
  blocked_target: 'Media extraction can only reach public HTTP and HTTPS servers.',
  unsupported: 'The extraction engines do not support this media.',
  unsupported_session: 'The extraction engine cannot use this session for the requested media.',
  authentication_required: 'The provider requires a valid connection or session.',
  rate_limited: 'The provider is temporarily limiting requests.',
  no_media: 'The provider returned no downloadable media.',
  incomplete: 'The provider did not return a complete media file.',
  too_large: 'The media exceeded the download limit.',
  timeout: 'Media extraction exceeded its time limit.',
  cancelled: 'Media extraction was cancelled.',
  failed: 'Media extraction failed.',
};

export class MediaDownloadError extends Error {
  constructor(
    public readonly code: MediaDownloadErrorCode,
    public readonly retryAfter?: number,
  ) {
    super(errorMessages[code]);
    this.name = 'MediaDownloadError';
  }
}

type InspectionOptions = { session?: MediaDownloadSession; signal?: AbortSignal };
type EnumerationOptions = InspectionOptions & {
  checkpoint?: string | null;
  since?: string | null;
  limit?: number;
  saves?: MediaSaves;
};
type DownloadOptions = InspectionOptions & {
  directory: string;
  streamMp4?: boolean;
  quality?: MediaQuality;
  maxBytes: number;
  onProgress?: (bytes: number, phase: 'downloading' | 'assembling') => void;
};

export type MediaDownloadCapabilities = {
  available: boolean;
  reason: string | null;
  ytDlpVersion: string | null;
  galleryDlVersion: string | null;
};

type BridgeFile = { filename: string; mimeType: string };
type BridgeRequest =
  | { operation: 'capabilities' }
  | ({ operation: 'inspect' | 'enumerate'; url: string } & Omit<EnumerationOptions, 'signal'>)
  | ({ operation: 'download'; entry: MediaDownloadEntry } & Pick<
      DownloadOptions,
      'maxBytes' | 'streamMp4' | 'session' | 'quality'
    >);
type BridgeResult = MediaDownloadCapabilities | MediaDownloadInspection | BridgeFile[];
type RunnerOptions = InspectionOptions & Pick<DownloadOptions, 'onProgress'>;

const bundle = '/opt/frameleaf-media-downloader';
const maxOutput = 8 * 1024 * 1024;

function mediaError(error: unknown): MediaDownloadError {
  if (error instanceof MediaDownloadError) {
    return error;
  }
  if (error instanceof MediaBrokerError || error instanceof MediaDownloadFileError) {
    return new MediaDownloadError(error.code);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new MediaDownloadError('cancelled');
  }
  return new MediaDownloadError('failed');
}

@Injectable()
export class MediaDownloaderRepository {
  async capabilities(): Promise<MediaDownloadCapabilities> {
    try {
      return (await this.run({ operation: 'capabilities' }, {})) as MediaDownloadCapabilities;
    } catch {
      return {
        available: false,
        reason: 'The isolated extraction runtime is unavailable on this server.',
        ytDlpVersion: null,
        galleryDlVersion: null,
      };
    }
  }

  async inspect(url: string, options: InspectionOptions = {}): Promise<MediaDownloadInspection> {
    const { signal, session } = options;
    return (await this.run(
      { operation: 'inspect', url: this.validateUrl(url), session },
      { signal },
    )) as MediaDownloadInspection;
  }

  async enumerate(url: string, options: EnumerationOptions = {}): Promise<MediaDownloadInspection> {
    const { signal, session, checkpoint, since, limit, saves } = options;
    return (await this.run(
      { operation: 'enumerate', url: this.validateUrl(url), session, checkpoint, since, limit, saves },
      { signal },
    )) as MediaDownloadInspection;
  }

  async download(entry: MediaDownloadEntry, options: DownloadOptions): Promise<MediaDownloadedFile[]> {
    const { directory, maxBytes, session, streamMp4, quality, signal, onProgress } = options;
    this.validateUrl(entry.pageUrl);
    if (entry.mediaUrl) {
      this.validateUrl(entry.mediaUrl);
    }
    if (entry.extractionUrl) {
      this.validateUrl(entry.extractionUrl);
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new MediaDownloadError('too_large');
    }
    const created: string[] = [];
    try {
      return (await this.run(
        { operation: 'download', entry, session, streamMp4, quality, maxBytes },
        { signal, onProgress },
        async (stage, result) => {
          if (!Array.isArray(result) || result.length === 0) {
            throw new MediaDownloadError('incomplete');
          }
          const destination = await realpath(directory);
          const files: MediaDownloadedFile[] = [];
          let total = 0;
          for (const { filename, mimeType } of result) {
            if (!/^media\.[a-z\d]{1,8}$/.test(filename) || !/^(?:image|video|audio)\/[a-z\d.+-]+$/.test(mimeType)) {
              throw new MediaDownloadError('incomplete');
            }
            const path = join(destination, `${randomUUID()}-${filename}`);
            const copied = await copyMediaDownload(join(stage, filename), path, maxBytes - total, signal);
            created.push(path);
            total += copied.size;
            const extension = filename.slice('media'.length);
            const title = sanitize([...entry.title].slice(0, 100).join('')).trim() || 'Media';
            files.push({ path, filename: title + extension, mimeType, ...copied, entry });
          }
          return files;
        },
      )) as MediaDownloadedFile[];
    } catch (error) {
      await Promise.allSettled(created.map((file) => rm(file, { force: true })));
      throw mediaError(error);
    }
  }

  /**
   * One public picture (a creator's avatar or banner, a video's cover) through the same isolated,
   * public-only path as media, with no site session. The file is checked to be a picture.
   */
  async fetchImage(url: string, options: Pick<DownloadOptions, 'directory' | 'signal'>): Promise<MediaDownloadedFile> {
    const id = createHash('sha256').update(url).digest('hex').slice(0, 32);
    const [file] = await this.download(
      {
        provider: 'generic',
        creatorId: null,
        postId: id,
        attachmentId: id,
        pageUrl: url,
        mediaUrl: url,
        title: 'Picture',
        description: '',
        creator: null,
        publishedAt: null,
        kind: 'image',
      },
      { ...options, maxBytes: 10 * 1024 * 1024 },
    );
    return file;
  }

  private validateUrl(value: string): string {
    try {
      return validateMediaUrl(value).href;
    } catch (error) {
      throw mediaError(error);
    }
  }

  private async run<T extends BridgeResult | MediaDownloadedFile[]>(
    request: BridgeRequest,
    { signal, onProgress }: RunnerOptions,
    consume?: (stage: string, result: BridgeResult) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new MediaDownloadError('cancelled');
    }
    if (process.platform !== 'linux') {
      throw new MediaDownloadError('unavailable');
    }

    const directory = await mkdtemp('/tmp/flmd-').catch(() => {
      throw new MediaDownloadError('unavailable');
    });
    const stage = join(directory, 'stage');
    const socketPath = join(directory, 's');
    const token = randomBytes(32).toString('hex');
    const download = request.operation === 'download';
    let broker: Awaited<ReturnType<typeof startMediaDownloadBroker>> | undefined;
    try {
      await mkdir(stage, { mode: 0o700 });
      await chmod(directory, 0o711);
      broker = await startMediaDownloadBroker(
        socketPath,
        token,
        (download ? Math.ceil(request.maxBytes * 1.1) : 0) + 32 * 1024 * 1024,
      );
      const result = await this.execute(
        request,
        stage,
        socketPath,
        token,
        download ? 30 * 60_000 : 90_000,
        signal,
        onProgress,
      ).catch((error: unknown) => {
        if (
          broker?.failure === 'too_large' ||
          (broker?.failure && error instanceof MediaDownloadError && error.code === 'failed')
        ) {
          throw new MediaDownloadError(broker.failure);
        }
        throw error;
      });
      if (broker.failure === 'too_large') {
        throw new MediaDownloadError('too_large');
      }
      return consume ? await consume(stage, result) : (result as T);
    } catch (error) {
      throw mediaError(error);
    } finally {
      await broker?.close();
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  private execute(
    request: BridgeRequest,
    stage: string,
    socketPath: string,
    token: string,
    timeout: number,
    signal?: AbortSignal,
    onProgress?: DownloadOptions['onProgress'],
  ): Promise<BridgeResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new MediaDownloadError('cancelled'));
        return;
      }
      const child = spawn(
        join(bundle, 'launcher'),
        [
          stage,
          String(randomInt(200_000, 10_000_000)),
          join(bundle, 'venv/bin/python3'),
          '-Bs',
          join(bundle, 'bridge.py'),
        ],
        {
          detached: true,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: {
            LANG: 'C.UTF-8',
            PATH: '/usr/local/bin:/usr/bin:/bin',
            TMPDIR: stage,
            XDG_CACHE_HOME: stage,
            XDG_CONFIG_HOME: stage,
          },
        },
      );
      const kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // The child group can exit before cancellation reaches it.
          }
        }
      };
      let reason: MediaDownloadError | undefined;
      const stop = (error: MediaDownloadError) => {
        reason ??= error;
        kill();
      };
      const onAbort = () => stop(new MediaDownloadError('cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => stop(new MediaDownloadError('timeout')), timeout);
      let received = 0;
      let partial = '';
      let result: BridgeResult | undefined;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        received += Buffer.byteLength(chunk);
        if (received > maxOutput) {
          stop(new MediaDownloadError('failed'));
          return;
        }
        const lines = (partial + chunk).split('\n');
        partial = lines.pop() ?? '';
        try {
          for (const line of lines) {
            const message = JSON.parse(line);
            switch (message.type) {
              case 'progress': {
                if (
                  Number.isSafeInteger(message.bytes) &&
                  message.bytes >= 0 &&
                  (message.phase === 'downloading' || message.phase === 'assembling')
                ) {
                  onProgress?.(message.bytes, message.phase);
                }
                break;
              }
              case 'result': {
                result = message.result;
                break;
              }
              case 'error': {
                const code = Object.hasOwn(errorMessages, message.code)
                  ? (message.code as MediaDownloadErrorCode)
                  : 'failed';
                const retryAfter =
                  Number.isSafeInteger(message.retryAfter) && message.retryAfter > 0 && message.retryAfter <= 86_400
                    ? (message.retryAfter as number)
                    : undefined;
                reason ??= new MediaDownloadError(code, retryAfter);
                break;
              }
              default: {
                stop(new MediaDownloadError('failed'));
              }
            }
          }
        } catch {
          stop(new MediaDownloadError('failed'));
        }
      });
      child.once('error', () => stop(new MediaDownloadError('unavailable')));
      child.stdin.on('error', () => {});
      child.once('exit', kill);
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (reason || code !== 0 || !result || partial) {
          reject(reason ?? new MediaDownloadError(code === 125 ? 'unavailable' : 'failed'));
        } else {
          resolve(result);
        }
      });
      if (signal?.aborted) {
        onAbort();
      }
      child.stdin.end(JSON.stringify({ ...request, socketPath, token }));
    });
  }
}
