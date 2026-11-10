import { Injectable } from '@nestjs/common';
import { open } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { StillRung } from 'src/types.js';
import { AssetType, Colorspace, MediaHealthStatus } from 'src/enum.js';
import { SharpResourceLimitError } from 'src/queue/sharp-protocol.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { designFileHasSignature } from 'src/utils/design-preview.js';
import { readAliasedEnv } from 'src/utils/env-aliases.js';
import { executionSignal } from 'src/utils/execution-signal.js';
import { JPEG_MARKER_WINDOW, findJpegMarker, isJpegFileName } from 'src/utils/file-problem.js';
import { isLockedPath } from 'src/utils/locked-read.js';
import { isUndecodableError } from 'src/utils/media-decode.js';
import { classifyImageDecodeFailure } from 'src/utils/media-health.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { RawRenderError, renderRawWithLibRaw } from 'src/utils/raw-renderer.js';

/** Whether the file's first 64 KiB hold a JPEG start marker; undefined when it could not be read (FL-1337). */
const hasJpegMarker = async (path: string): Promise<boolean | undefined> => {
  try {
    const file = await open(path, 'r');
    try {
      const { bytesRead, buffer } = await file.read(Buffer.alloc(JPEG_MARKER_WINDOW), 0, JPEG_MARKER_WINDOW, 0);
      return findJpegMarker(buffer.subarray(0, bytesRead)) !== null;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
};
// FL-1353: how long a check may go without progress (bytes hashed, packets read), not how long it may run:
// a 50 GB video takes minutes and is fine. Native operations retain their concurrency slot after timeout.
const validationTimeout = () => {
  const value = Number(readAliasedEnv('FRAMELEAF_MEDIA_VALIDATION_TIMEOUT_MS') ?? 120_000);
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
  /**
   * FL-1337: `message` is the decoder's own words, when a decode failed, so a damaged file can be told
   * apart by its cause (`classifyFileProblem`). Raw text: never shown on an everyday screen or stored.
   */
  | { status: 'corrupt'; reason: 'expected_mismatch' | 'empty_file' | 'decode_failed'; message?: string }
  | {
      status: 'unsupported';
      reason: 'raw_decode_unsupported' | 'media_type_unsupported' | 'decode_unsupported';
      message?: string;
    }
  | { status: 'timeout'; reason: 'validation_timeout' | 'decode_timeout' }
  /**
   * FL-721 (spec §8.3): a sealed Locked file (its bytes start with `FLLK`). It is never hashed or
   * decoded here, so never called damaged: "encrypted, not checked". Its GCM tags prove it intact.
   */
  | { status: 'encrypted'; reason: 'locked_encrypted' }
  | {
      status: 'transient';
      reason:
        | 'io_failed'
        | 'file_changed'
        | 'decoder_unavailable'
        | 'decoder_resource_limit'
        | 'raw_decode_damaged'
        | 'decode_unverified'
        | 'validation_busy';
      message?: string;
    };
export type MediaIntegrityInput = {
  path: string;
  originalFileName: string;
  type: AssetType;
  expected?: { sha1?: Buffer; sha256?: Buffer; sizeInBytes?: number };
  deep?: boolean;
};
export type MediaIntegrityValidation = {
  result: Promise<MediaIntegrityResult>;
  /** Actual hashing/decoder completion, including noncooperative work after the deadline. */
  settled: Promise<void>;
  cancel: () => void;
};

/** Over the pixel or memory limit, or the image worker died: nothing about the file. */
const isDecoderLimit = (error: unknown) =>
  error instanceof SharpResourceLimitError || (error instanceof Error && /^Sharp child closed \(/.test(error.message));

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
    return this.validateWithSettlement(input).result;
  }

  validateWithSettlement(input: MediaIntegrityInput): MediaIntegrityValidation {
    if (this.activeValidations >= 2) {
      return {
        result: Promise.resolve({ status: 'transient', reason: 'validation_busy' }),
        settled: Promise.resolve(),
        cancel: () => {},
      };
    }
    this.activeValidations++;
    const controller = new AbortController();
    const refusal = Promise.withResolvers<MediaIntegrityResult>();
    const cancel = () => {
      controller.abort();
      refusal.resolve({ status: 'timeout', reason: 'validation_timeout' });
    };
    // Each sign of progress restarts the window, so only a read that has stalled for the whole window is
    // stopped. The timer alone keeps the time: no clock is read.
    let timer = setTimeout(cancel, this.timeoutMs);
    const touch = () => {
      if (controller.signal.aborted) {
        return; // a read that outlives its refusal starts no new window
      }
      clearTimeout(timer);
      timer = setTimeout(cancel, this.timeoutMs);
    };
    // a cancelled job stops a read that is still making progress, and frees its slot
    const execution = executionSignal();
    const signal = execution ? AbortSignal.any([controller.signal, execution]) : controller.signal;
    const work = this.validateFile(input, signal, touch).finally(() => {
      this.activeValidations--;
    });
    return {
      result: Promise.race([work, refusal.promise]).finally(() => clearTimeout(timer)),
      settled: work.then(() => {}).catch(() => {}),
      cancel,
    };
  }

  private async validateFile(
    input: MediaIntegrityInput,
    signal: AbortSignal,
    touch: () => void,
  ): Promise<MediaIntegrityResult> {
    try {
      const before = await this.storageRepository.stat(input.path);
      if (!before.isFile()) {
        return { status: 'unreadable', reason: 'not_regular_file' };
      }
      if (await isLockedPath(input.path)) {
        return { status: 'encrypted', reason: 'locked_encrypted' };
      }
      if (signal.aborted) {
        return { status: 'timeout', reason: 'validation_timeout' };
      }
      const digests = await this.cryptoRepository.hashFileDigests(input.path, { signal, onProgress: touch });
      if (signal.aborted) {
        return { status: 'timeout', reason: 'validation_timeout' };
      }
      touch();
      const failure = input.deep ? await this.decode(input, signal, touch) : undefined;
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
      if (signal.aborted) {
        return { status: 'timeout', reason: 'validation_timeout' };
      }
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

  /**
   * FL-1353: a video is checked by opening its container and reading every packet of its picture track,
   * never by decoding it. Decoding a 50 GB file outlasts any budget, and a decoder's complaints about
   * frames that still play are not damage: the checksum already proves the bytes are the ones stored.
   * ponytail: no sample decode. Add one if a codec-level note is ever wanted; it must never be a verdict.
   */
  private async checkVideo(
    input: MediaIntegrityInput,
    signal: AbortSignal,
    touch: () => void,
  ): Promise<Exclude<MediaIntegrityResult, { status: 'healthy' }> | undefined> {
    try {
      const { videoStreams } = await this.mediaRepository.probe(input.path, { countFrames: false, signal });
      touch();
      const stream = videoStreams[0];
      if (!stream) {
        return { status: 'unsupported', reason: 'decode_unsupported' };
      }
      const tick = stream.timeBaseRational
        ? stream.timeBaseRational.num / stream.timeBaseRational.den
        : stream.timeBase
          ? 1 / stream.timeBase
          : undefined;
      const readable = async () => {
        const packets = await this.mediaRepository.probePackets(input.path, stream.index, {
          signal,
          onProgress: touch,
        });
        return packets?.presentation && tick
          ? (packets.presentation.endPts - packets.presentation.startPts) * tick
          : undefined;
      };
      // Only what could be measured counts: packets without timing say nothing about the length.
      const short = (seconds?: number) =>
        seconds !== undefined && !!stream.duration && seconds < stream.duration * 0.9 - 2;
      const seconds = await readable();
      if (short(seconds)) {
        // A read that failed partway also ends early. The file is only cut short when a second read stops
        // at the same place; anything else is a drive that could not be read, which is no verdict.
        const again = await readable();
        if (!short(again)) {
          return undefined;
        }
        if (again !== seconds) {
          return { status: 'transient', reason: 'decode_unverified' };
        }
        return {
          status: 'corrupt',
          reason: 'decode_failed',
          message: `truncated: ${Math.floor(seconds!)} of ${Math.floor(stream.duration!)} seconds can be read`,
        };
      }
      return undefined;
    } catch (error) {
      if (signal.aborted) {
        return { status: 'timeout', reason: 'validation_timeout' };
      }
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') {
        return { status: 'transient', reason: 'decoder_unavailable' };
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return { status: 'unreadable', reason: 'access_denied' };
      }
      // The path is the person's own words ("corrupt backups/…"); it must never decide the verdict.
      const text = (error instanceof Error ? error.message : '').replaceAll(input.path, '');
      if (/deadline exceeded|stopped making progress|was cancelled/i.test(text)) {
        return { status: 'timeout', reason: 'decode_timeout' };
      }
      if (/exited with code null/i.test(text)) {
        // killed from outside (out of memory, the host shutting down): nothing about the file
        return { status: 'transient', reason: 'decoder_resource_limit' };
      }
      if (mimeTypes.isCinemaRaw(input.originalFileName) && isUndecodableError(error)) {
        // FL-1357: cinema RAW has no open decoder. What ffmpeg makes of one says nothing about the file.
        return { status: 'unsupported', reason: 'decode_unsupported' };
      }
      const message = text
        .replace(/^ffprobe exited with code \d+:/i, '')
        .replace(/^[\s:]+/, '')
        .trim();
      const said = message ? { message } : {};
      // "End of file" and "partial file" are also what a failed read looks like, so they stay unverified.
      if (/moov atom not found|invalid data found when processing input/i.test(message)) {
        return { status: 'corrupt', reason: 'decode_failed', ...said };
      }
      return { status: 'transient', reason: 'decode_unverified', ...said };
    }
  }

  private async decode(
    input: MediaIntegrityInput,
    signal: AbortSignal,
    touch: () => void,
  ): Promise<Exclude<MediaIntegrityResult, { status: 'healthy' }> | undefined> {
    if (input.type === AssetType.Video) {
      return this.checkVideo(input, signal, touch);
    }
    if (input.type === AssetType.Image && mimeTypes.isDesign(input.originalFileName)) {
      // FL-1358: a design file is proved by its checksum and by starting the way its format does. Whether a
      // renderer can draw it says nothing about the file, so it is never decoded here and never called damaged.
      return (await designFileHasSignature(input.path, input.originalFileName))
        ? undefined
        : { status: 'unsupported', reason: 'media_type_unsupported' };
    }
    const isRaw = mimeTypes.isRaw(input.originalFileName);
    try {
      if (input.type === AssetType.Image) {
        // RAW previews do not prove the original sensor data can be decoded.
        const source = isRaw ? await renderRawWithLibRaw(input.path, signal) : input.path;
        if (signal.aborted) {
          return { status: 'timeout', reason: 'validation_timeout' };
        }
        // The strict reading only: what it complains about decides between "healthy" and "cut short" below.
        await this.mediaRepository.decodeImage(source, {
          colorspace: Colorspace.Srgb,
          processInvalidImages: false,
          ladder: 'strict',
        });
      } else {
        return { status: 'unsupported', reason: 'media_type_unsupported' };
      }
    } catch (error) {
      if (signal.aborted) {
        return { status: 'timeout', reason: 'validation_timeout' };
      }
      if (error instanceof RawRenderError) {
        switch (error.reason) {
          case 'cancelled': {
            return { status: 'timeout', reason: 'validation_timeout' };
          }
          case 'timeout': {
            return { status: 'timeout', reason: 'decode_timeout' };
          }
          case 'dependency_missing': {
            return { status: 'transient', reason: 'decoder_unavailable' };
          }
          case 'resource_limit': {
            return { status: 'transient', reason: 'decoder_resource_limit' };
          }
          case 'damaged': {
            // A decoder report alone cannot confirm damage or make a RAW eligible for trash.
            return { status: 'transient', reason: 'raw_decode_damaged' };
          }
          case 'io': {
            return error.code === 'EACCES' || error.code === 'EPERM'
              ? { status: 'unreadable', reason: 'access_denied' }
              : { status: 'transient', reason: 'io_failed' };
          }
          case 'unsupported': {
            return { status: 'unsupported', reason: 'raw_decode_unsupported' };
          }
          case 'decode_failed': {
            return { status: 'transient', reason: 'decode_unverified' };
          }
        }
      }
      const details = error && typeof error === 'object' ? error : {};
      if (('killed' in details && details.killed) || ('code' in details && details.code === 'ETIMEDOUT')) {
        return { status: 'timeout', reason: 'decode_timeout' };
      }
      if ('code' in details && (details.code === 'EACCES' || details.code === 'EPERM')) {
        return { status: 'unreadable', reason: 'access_denied' };
      }
      if ('code' in details && details.code === 'ENOENT') {
        return { status: 'transient', reason: 'decoder_unavailable' };
      }
      // the path is never part of the verdict: a folder may be called "corrupt"
      const message = error instanceof Error ? error.message.replaceAll(input.path, '') : '';
      if (isDecoderLimit(error)) {
        return { status: 'transient', reason: 'decoder_resource_limit' };
      }
      if (isRaw) {
        return { status: 'unsupported', reason: 'raw_decode_unsupported' };
      }
      const said = message ? { message } : {};
      // FL-1353 (owner 2026-11-10): a picture that opens when read leniently is not damaged because a strict
      // decoder complains about it. The one exception is a JPEG cut short with rows really missing.
      // FL-1356: the rest of the still ladder counts too (another decoder reading the picture itself), but
      // not the small preview stored inside the file, which says nothing about the picture.
      const lenient = { colorspace: Colorspace.Srgb, processInvalidImages: true, ladder: 'pixels' as const };
      let rung: StillRung | undefined;
      let opens = true;
      try {
        rung = (await this.mediaRepository.decodeImage(input.path, lenient)).rung;
      } catch (lenientError) {
        // the second read could not finish: that says nothing about the file
        if (signal.aborted) {
          return { status: 'timeout', reason: 'validation_timeout' };
        }
        if (isDecoderLimit(lenientError)) {
          return { status: 'transient', reason: 'decoder_resource_limit' };
        }
        opens = false;
      }
      if (opens) {
        // Rows can only be counted in what libvips itself read: another decoder's copy is whole or absent.
        const cutShort =
          rung === 'lenient' &&
          isJpegFileName(input.originalFileName) &&
          /premature end|truncated|incomplete|unexpected end/i.test(message) &&
          (await this.mediaRepository.pictureSaved(input.path)) < 100;
        return cutShort ? { status: 'corrupt', reason: 'decode_failed', ...said } : undefined;
      }
      if (/unsupported|decoder.*not found|unknown decoder/i.test(message)) {
        // "Unsupported" on a file that holds a JPEG start marker is a damaged JPEG, not an unknown format.
        if (/unsupported/i.test(message) && isJpegFileName(input.originalFileName)) {
          const marked = await hasJpegMarker(input.path);
          if (marked === undefined) {
            // FL-1337: a read that failed says nothing, and an unsupported file is left as it is: so it is busy
            return { status: 'transient', reason: 'io_failed' };
          }
          if (marked) {
            return { status: 'corrupt', reason: 'decode_failed', ...said };
          }
        }
        return { status: 'unsupported', reason: 'decode_unsupported', ...said };
      }
      if (classifyImageDecodeFailure(message, { isRaw: false }) === MediaHealthStatus.CorruptConfirmed) {
        return { status: 'corrupt', reason: 'decode_failed', ...said };
      }
      return { status: 'transient', reason: 'decode_unverified', ...said };
    }
  }
}
