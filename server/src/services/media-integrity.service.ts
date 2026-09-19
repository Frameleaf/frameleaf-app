import { Injectable } from '@nestjs/common';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { Stats } from 'node:fs';
import { AssetType, Colorspace, MediaHealthStatus } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { classifyImageDecodeFailure } from 'src/utils/media-health.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { renderRawWithLibRaw } from 'src/utils/raw-renderer.js';

const execFile = promisify(execFileCallback);
// Admin override for full decoding of long videos. Native operations retain their concurrency slot after timeout.
const validationTimeout = () => {
  const value = Number(process.env.IMMICH_MEDIA_VALIDATION_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(value) ? Math.min(86_400_000, Math.max(10_000, Math.trunc(value))) : 120_000;
};
export type MediaIntegrityIdentity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;
export type MediaIntegrityResult =
  | {
      status: 'healthy';
      reason: 'verified';
      sha1: Buffer;
      sha256: Buffer;
      sizeInBytes: number;
      identity: MediaIntegrityIdentity;
    }
  | { status: 'missing'; reason: 'file_missing' }
  | { status: 'unreadable'; reason: 'access_denied' | 'not_regular_file' }
  | { status: 'corrupt'; reason: 'expected_mismatch' | 'empty_file' | 'decode_failed' }
  | { status: 'unsupported'; reason: 'raw_decode_unsupported' | 'media_type_unsupported' | 'decode_unsupported' }
  | { status: 'timeout'; reason: 'validation_timeout' | 'decode_timeout' }
  | {
      status: 'transient';
      reason: 'io_failed' | 'file_changed' | 'decoder_unavailable' | 'decode_unverified' | 'validation_busy';
    };
export type MediaIntegrityInput = {
  path: string;
  originalFileName: string;
  type: AssetType;
  expected?: { sha1?: Buffer; sha256?: Buffer; sizeInBytes?: number };
  deep?: boolean;
};

@Injectable()
export class MediaIntegrityService {
  // Hold a slot until native hashing/LibRaw settles, even after the caller's deadline expires.
  private activeValidations = 0;
  private readonly timeoutMs = validationTimeout();
  constructor(
    private storageRepository: StorageRepository,
    private cryptoRepository: CryptoRepository,
    private mediaRepository: MediaRepository,
  ) {}

  async validate(input: MediaIntegrityInput): Promise<MediaIntegrityResult> {
    if (this.activeValidations >= 2) {
      return { status: 'transient', reason: 'validation_busy' };
    }
    this.activeValidations++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      return await Promise.race([
        this.validateFile(input, controller.signal).finally(() => {
          this.activeValidations--;
        }),
        new Promise<MediaIntegrityResult>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ status: 'timeout', reason: 'validation_timeout' });
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async validateFile(input: MediaIntegrityInput, signal: AbortSignal): Promise<MediaIntegrityResult> {
    try {
      const before = await this.storageRepository.stat(input.path);
      if (!before.isFile()) {
        return { status: 'unreadable', reason: 'not_regular_file' };
      }
      if (signal.aborted) {
        return { status: 'timeout', reason: 'validation_timeout' };
      }
      const digests = await this.cryptoRepository.hashFileDigests(input.path);
      if (signal.aborted) {
        return { status: 'timeout', reason: 'validation_timeout' };
      }
      const failure = input.deep ? await this.decode(input, signal) : undefined;
      const after = await this.storageRepository.stat(input.path);
      const identity = {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      };
      if (
        !after.isFile() ||
        digests.sizeInBytes !== before.size ||
        Object.entries(identity).some(([key, value]) => after[key as keyof MediaIntegrityIdentity] !== value)
      ) {
        return { status: 'transient', reason: 'file_changed' };
      }
      const expected = input.expected;
      if (digests.sizeInBytes === 0) {
        return { status: 'corrupt', reason: 'empty_file' };
      }
      if (
        (expected?.sizeInBytes !== undefined && expected.sizeInBytes !== digests.sizeInBytes) ||
        (expected?.sha1 && !expected.sha1.equals(digests.sha1)) ||
        (expected?.sha256 && !expected.sha256.equals(digests.sha256))
      ) {
        return { status: 'corrupt', reason: 'expected_mismatch' };
      }
      return failure ?? { status: 'healthy', reason: 'verified', ...digests, identity };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { status: 'missing', reason: 'file_missing' };
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return { status: 'unreadable', reason: 'access_denied' };
      }
      return { status: 'transient', reason: 'io_failed' };
    }
  }

  private async decode(
    input: MediaIntegrityInput,
    signal: AbortSignal,
  ): Promise<Exclude<MediaIntegrityResult, { status: 'healthy' }> | undefined> {
    const isRaw = mimeTypes.isRaw(input.originalFileName);
    try {
      if (input.type === AssetType.Video) {
        await execFile(
          'ffmpeg',
          ['-nostdin', '-v', 'error', '-xerror', '-i', input.path, '-map', '0:v:0', '-f', 'null', '-'],
          { timeout: this.timeoutMs, signal },
        );
      } else if (input.type === AssetType.Image) {
        // RAW previews do not prove the original sensor data can be decoded.
        const source = isRaw ? await renderRawWithLibRaw(input.path) : input.path;
        if (signal.aborted) {
          return { status: 'timeout', reason: 'validation_timeout' };
        }
        await this.mediaRepository.decodeImage(source, { colorspace: Colorspace.Srgb, processInvalidImages: false });
      } else {
        return { status: 'unsupported', reason: 'media_type_unsupported' };
      }
    } catch (error) {
      const details = error && typeof error === 'object' ? error : {};
      if (
        signal.aborted ||
        ('killed' in details && details.killed) ||
        ('code' in details && details.code === 'ETIMEDOUT')
      ) {
        return { status: 'timeout', reason: 'decode_timeout' };
      }
      if ('code' in details && (details.code === 'EACCES' || details.code === 'EPERM')) {
        return { status: 'unreadable', reason: 'access_denied' };
      }
      if ('code' in details && details.code === 'ENOENT') {
        return { status: 'transient', reason: 'decoder_unavailable' };
      }
      if (isRaw) {
        return { status: 'unsupported', reason: 'raw_decode_unsupported' };
      }
      const message = error instanceof Error ? error.message : '';
      if (/unsupported|decoder.*not found|unknown decoder/i.test(message)) {
        return { status: 'unsupported', reason: 'decode_unsupported' };
      }
      if (classifyImageDecodeFailure(error, { isRaw: false }) === MediaHealthStatus.CorruptConfirmed) {
        return { status: 'corrupt', reason: 'decode_failed' };
      }
      return { status: 'transient', reason: 'decode_unverified' };
    }
  }
}
