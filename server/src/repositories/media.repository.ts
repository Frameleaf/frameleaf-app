import { Injectable } from '@nestjs/common';
import { ExifDateTime, WriteTags, exiftool } from 'exiftool-vendored';
import ffmpeg, { FfprobeData, FfprobeStream } from 'fluent-ffmpeg';
import { camelCase, upperFirst } from 'lodash-es';
import { Duration } from 'luxon';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
import { parentPort } from 'node:worker_threads';
import type { HdrCodecCapabilities } from 'src/queue/image-hdr.js';
import type { SharpArguments } from 'src/queue/sharp-protocol.js';
import type {
  DecodeToBufferOptions,
  GenerateThumbhashOptions,
  GenerateThumbnailOptions,
  ImageDimensions,
  ProbeOptions,
  RawImageInfo,
  TranscodeCommand,
  VideoInfo,
  VideoPacketInfo,
} from 'src/types.js';
import type { DevelopDetailPlan, DevelopGeometryPlan } from 'src/utils/develop-recipe.js';
import { Exif } from 'src/database.js';
import {
  AacProfile,
  Av1Profile,
  ColorMatrix,
  ColorPrimaries,
  ColorTransfer,
  DvProfile,
  DvSignalCompatibility,
  H264Profile,
  HevcProfile,
  ImageFormat,
  LogLevel,
  RawExtractedFormat,
} from 'src/enum.js';
import { advanceJobProgress, jobSignal } from 'src/queue/context.js';
import { superviseMediaProcess } from 'src/queue/process-lifetime.js';
import { SharpOperationError, sharpProcessPool } from 'src/queue/sharp-pool.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { executionSignal } from 'src/utils/execution-signal.js';
import { LOCATION_DELETE_ARGS } from 'src/utils/location-tags.js';
import { parseFfprobeColorRange } from 'src/utils/media-policy.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { tryParseRational } from 'src/utils/rational-time.js';
import { renderRawWithLibRaw } from 'src/utils/raw-renderer.js';

const probe = (input: string, options: string[]): Promise<FfprobeData> => {
  executionSignal()?.throwIfAborted();
  const child = spawn('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', ...options, input], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lifetime = superviseMediaProcess(child, { signal: executionSignal() });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let stderr = '';
  let failure: Error | undefined;
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) {
      lifetime.stop(new Error('Media probe output exceeds its resource limit'));
      return;
    }
    chunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-65_536);
  });
  child.on('error', (error) => {
    failure = error;
  });
  return new Promise((resolve, reject) => {
    child.once('close', (code) => {
      if (lifetime.error() || failure || code !== 0)
        return reject(lifetime.error() ?? failure ?? new Error(`ffprobe exited with code ${code}: ${stderr}`));
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString()) as FfprobeData;
        if (!Array.isArray(data.streams) || !data.format) throw new Error('Media probe returned an invalid result');
        // The previous parser flattened side-data fields, including rotation and Dolby Vision.
        for (const stream of data.streams) {
          const sideData = (stream as FfprobeStream & { side_data_list?: Record<string, unknown>[] }).side_data_list;
          for (const entry of sideData ?? []) Object.assign(stream, entry);
        }
        resolve(data);
      } catch (error) {
        reject(error);
      }
    });
  });
};

const pascalCase = (str: string) => upperFirst(camelCase(str.toLowerCase()));

type ProgressEvent = {
  frames: number;
  currentFps: number;
  currentKbps: number;
  targetSize: number;
  timemark: string;
  percent?: number;
};

export type ExtractResult = {
  buffer: Buffer;
  format: RawExtractedFormat;
};

@Injectable()
export class MediaRepository {
  private hdrCodecProbe?: { value: Promise<HdrCodecCapabilities | null>; expires: number };

  getHdrCodecCapabilities(): Promise<HdrCodecCapabilities | null> {
    if (this.hdrCodecProbe && this.hdrCodecProbe.expires > Date.now()) return this.hdrCodecProbe.value;
    const value = sharpProcessPool.run('getHdrCodecCapabilities', [], AbortSignal.timeout(2000)).catch(() => null);
    const probe = { value, expires: Infinity };
    this.hdrCodecProbe = probe;
    void value.then((codec) => {
      // Installed codecs do not change without a restart; retry a busy/unavailable worker after 30 seconds.
      if (!codec) probe.expires = Date.now() + 30_000;
    });
    return value;
  }

  inspectImageEncoding(input: string | Buffer) {
    return sharpProcessPool.run('inspectImageEncoding', [input]);
  }

  decodeHdrImage(input: string | Buffer, preserveSdrBaseline = false) {
    return sharpProcessPool.run('decodeHdrImage', [input, preserveSdrBaseline]);
  }

  generateHdrRenditions(
    input: string | Buffer,
    outputs: SharpArguments<'generateHdrRenditions'>[1],
    develop?: SharpArguments<'generateHdrRenditions'>[2],
    signal?: AbortSignal,
  ) {
    return sharpProcessPool.run(
      'generateHdrRenditions',
      develop ? [input, outputs, develop] : [input, outputs],
      signal,
    );
  }

  encodeHdrImage(image: SharpArguments<'encodeHdrImage'>[0]) {
    return sharpProcessPool.run('encodeHdrImage', [image]);
  }
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(MediaRepository.name);
  }

  async onModuleDestroy() {
    await sharpProcessPool.close();
  }

  /**
   *
   * @param input file path to the input image
   * @returns ExtractResult if succeeded, or null if failed
   */
  async extract(input: string): Promise<ExtractResult | null> {
    for (const { tag, format } of [
      { tag: 'JpgFromRaw2', format: RawExtractedFormat.Jpeg },
      { tag: 'JpgFromRaw', format: RawExtractedFormat.Jpeg },
      { tag: 'PreviewJXL', format: RawExtractedFormat.Jxl },
      { tag: 'PreviewImage', format: RawExtractedFormat.Jpeg },
    ]) {
      try {
        const buffer = await exiftool.extractBinaryTagToBuffer(tag, input);
        this.logger.debug(`Successfully extracted ${tag} buffer from image`);
        return { buffer, format };
      } catch (error: any) {
        this.logger.debug(`Could not extract ${tag} buffer from image: ${error}`);
      }
    }
    return null;
  }

  async writeExif(tags: Partial<Exif>, output: string): Promise<boolean> {
    try {
      const tagsToWrite: WriteTags = {
        ExifImageWidth: tags.exifImageWidth,
        ExifImageHeight: tags.exifImageHeight,
        DateTimeOriginal: tags.dateTimeOriginal && ExifDateTime.fromMillis(tags.dateTimeOriginal.getTime()),
        ModifyDate: tags.modifyDate && ExifDateTime.fromMillis(tags.modifyDate.getTime()),
        TimeZone: tags.timeZone,
        GPSLatitude: tags.latitude,
        GPSLongitude: tags.longitude,
        ProjectionType: tags.projectionType,
        City: tags.city,
        Country: tags.country,
        Make: tags.make,
        Model: tags.model,
        LensModel: tags.lensModel,
        Fnumber: tags.fNumber?.toFixed(1),
        FocalLength: tags.focalLength?.toFixed(1),
        ISO: tags.iso,
        ExposureTime: tags.exposureTime,
        ProfileDescription: tags.profileDescription,
        ColorSpace: tags.colorspace,
        Rating: tags.rating === null ? 0 : tags.rating,
        // specially convert Orientation to numeric Orientation# for exiftool
        'Orientation#': tags.orientation ? Number(tags.orientation) : undefined,
      };

      await exiftool.write(output, tagsToWrite, {
        ignoreMinorErrors: true,
        writeArgs: ['-overwrite_original'],
      });
      return true;
    } catch (error: any) {
      this.logger.warn(`Could not write exif data to image: ${error.message}`);
      return false;
    }
  }

  /**
   * FL-54: removes every location tag from a derived file in place. A preview extracted from a RAW keeps the
   * camera's own EXIF, GPS included; nobody needs it in a derived image, and the fullsize file is served to
   * partners and shared links without the original's location policy. Returns false when exiftool fails.
   */
  async removeLocation(path: string): Promise<boolean> {
    try {
      await exiftool.write(path, {}, { writeArgs: [...LOCATION_DELETE_ARGS, '-overwrite_original'] });
      return true;
    } catch (error: any) {
      this.logger.warn(`Could not remove the location from ${path}: ${error.message}`);
      return false;
    }
  }

  async copyTagGroup(tagGroup: string, source: string, target: string): Promise<boolean> {
    try {
      await exiftool.write(
        target,
        {},
        {
          ignoreMinorErrors: true,
          writeArgs: ['-TagsFromFile', source, `-${tagGroup}:all>${tagGroup}:all`, '-overwrite_original'],
        },
      );
      return true;
    } catch (error: any) {
      this.logger.warn(`Could not copy tag data to image: ${error.message}`);
      return false;
    }
  }

  async decodeImage(input: string | Buffer, options: DecodeToBufferOptions) {
    try {
      return await sharpProcessPool.run('decodeImage', [input, options]);
    } catch (error) {
      executionSignal()?.throwIfAborted();
      if (
        !(error instanceof SharpOperationError) ||
        typeof input !== 'string' ||
        options.raw ||
        !mimeTypes.isRaw(input)
      ) {
        throw error;
      }
      const rendered = await renderRawWithLibRaw(input, executionSignal());
      // LibRaw applies sensor orientation. Keep colour, size and edit semantics.
      return sharpProcessPool.run('decodeImage', [rendered, { ...options, orientation: undefined }]);
    }
  }

  async generateThumbnail(input: string | Buffer, options: GenerateThumbnailOptions, output: string): Promise<void> {
    return sharpProcessPool.run('generateThumbnail', [input, options, output]);
  }

  async generateImageThumbnails(...args: SharpArguments<'generateImageThumbnails'>) {
    const [input, options, batch] = args;
    try {
      return await sharpProcessPool.run('generateImageThumbnails', args);
    } catch (error) {
      executionSignal()?.throwIfAborted();
      if (
        !(error instanceof SharpOperationError) ||
        !error.decodeFailure ||
        typeof input !== 'string' ||
        options.raw ||
        !mimeTypes.isRaw(input)
      ) {
        throw error;
      }
      const rendered = await renderRawWithLibRaw(input, executionSignal());
      return sharpProcessPool.run('generateImageThumbnails', [rendered, { ...options, orientation: undefined }, batch]);
    }
  }

  async writeCloudUpload(input: string, output: string): Promise<void> {
    return sharpProcessPool.run('writeCloudUpload', [input, output]);
  }

  async writeStrippedStill(input: string, output: string, format: 'jpeg' | 'png'): Promise<void> {
    return sharpProcessPool.run('writeStrippedStill', [input, output, format]);
  }

  async composeImageGrid(
    inputs: string[],
    options: { cols: number; rows: number; cellSize: number; output: string },
  ): Promise<void> {
    return sharpProcessPool.run('composeImageGrid', [inputs, options]);
  }

  async renderDevelopGeometry(
    input: Buffer,
    raw: RawImageInfo,
    plan: DevelopGeometryPlan,
  ): Promise<{ data: Buffer; info: RawImageInfo }> {
    return sharpProcessPool.run('renderDevelopGeometry', [input, raw, plan]);
  }

  async encodeDevelopOutput(
    input: Buffer,
    raw: RawImageInfo,
    options: {
      detail: DevelopDetailPlan;
      colorspace: string;
      format: ImageFormat;
      quality: number;
      progressive?: boolean;
      size?: number;
    },
    output?: string,
  ): Promise<Buffer | undefined> {
    return sharpProcessPool.run('encodeDevelopOutput', [input, raw, options, output]);
  }

  async generateThumbhash(input: string | Buffer, options: GenerateThumbhashOptions): Promise<Buffer> {
    return sharpProcessPool.run('generateThumbhash', [input, options]);
  }

  async probe(input: string, options?: ProbeOptions): Promise<VideoInfo> {
    const results = await probe(input, options?.countFrames ? ['-count_packets'] : []); // gets frame count quickly: https://stackoverflow.com/a/28376817
    return {
      format: {
        formatName: results.format.format_name,
        formatLongName: results.format.format_long_name,
        duration: this.parseFloat(results.format.duration),
        bitrate: this.parseInt(results.format.bit_rate),
      },
      videoStreams: results.streams
        .filter((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
        .sort((a, b) => this.compareStreams(a, b))
        .map((stream) => {
          const height = this.parseInt(stream.height);
          const dar = this.getDar(stream.display_aspect_ratio);
          return {
            index: stream.index,
            height,
            width: dar ? Math.round(height * dar) : this.parseInt(stream.width),
            codecName: stream.codec_name === 'h265' ? 'hevc' : (stream.codec_name ?? null),
            profile: this.parseVideoProfile(stream.codec_name, stream.profile as string | undefined) ?? null,
            level: this.parseOptionalInt(stream.level),
            frameCount: this.parseInt(options?.countFrames ? stream.nb_read_packets : stream.nb_frames),
            frameRate: this.parseFrameRate(stream.avg_frame_rate ?? stream.r_frame_rate),
            timeBase: this.parseRational(stream.time_base)?.den ?? null,
            // FL-93: the same two values kept exactly, so nothing downstream has to
            // reconstruct 30000/1001 or 1/30000 out of a float.
            timeBaseRational: tryParseRational(stream.time_base),
            frameRateRational: tryParseRational(stream.avg_frame_rate ?? stream.r_frame_rate),
            duration: this.parseStreamDuration(stream),
            startTime: this.parseStartTime(stream.start_time),
            rotation: this.parseInt(stream.rotation),
            bitrate: this.parseInt(stream.bit_rate),
            pixelFormat: stream.pix_fmt || 'yuv420p',
            colorPrimaries: this.parseEnum(ColorPrimaries, stream.color_primaries) ?? ColorPrimaries.Unknown,
            colorMatrix: this.parseEnum(ColorMatrix, stream.color_space) ?? ColorMatrix.Unknown,
            colorTransfer: this.parseEnum(ColorTransfer, stream.color_transfer) ?? ColorTransfer.Unknown,
            colorRange: parseFfprobeColorRange(stream.color_range),
            dvProfile: this.parseOptionalInt(stream.dv_profile) as DvProfile | null,
            dvLevel: this.parseOptionalInt(stream.dv_level),
            dvBlSignalCompatibilityId: this.parseOptionalInt(
              stream.dv_bl_signal_compatibility_id,
            ) as DvSignalCompatibility | null,
          };
        }),
      audioStreams: results.streams
        .filter((stream) => stream.codec_type === 'audio')
        .sort((a, b) => this.compareStreams(a, b))
        .map((stream) => ({
          index: stream.index,
          codecName: stream.codec_name ?? null,
          profile:
            stream.codec_name === 'aac' ? this.parseEnum(AacProfile, stream.profile as string | undefined) : null,
          bitrate: this.parseInt(stream.bit_rate),
          // FL-102: the channel layout and sample rate are facts about the source, kept so a
          // render can preserve them instead of falling back to a stereo downmix.
          channels: this.parseOptionalInt(stream.channels),
          channelLayout: this.parseChannelLayout(stream.channel_layout),
          sampleRate: this.parseOptionalInt(stream.sample_rate),
          duration: this.parseStreamDuration(stream),
          startTime: this.parseStartTime(stream.start_time),
        })),
    };
  }

  /** Read static mastering SEI from the selected output stream's first decoded picture. */
  async probeHdrMastering(input: string, streamIndex: number): Promise<Record<string, unknown>[]> {
    const data = (await probe(input, [
      '-select_streams',
      String(streamIndex),
      '-read_intervals',
      '%+#1',
      '-show_frames',
    ])) as FfprobeData & {
      frames?: { side_data_list?: Record<string, unknown>[] }[];
    };
    const stream = data.streams[0] as (FfprobeStream & { side_data_list?: Record<string, unknown>[] }) | undefined;
    return [...(stream?.side_data_list ?? []), ...(data.frames?.[0]?.side_data_list ?? [])];
  }

  /**
   * Needed for accurate segments, especially when remuxing, seeking and/or VFR is involved.
   * Scanning packets for keyframes in JS is much faster than -skip_frame nokey since it avoids decoding the video.
   */
  probePackets(input: string, streamIndex: number): Promise<VideoPacketInfo | null> {
    jobSignal()?.throwIfAborted();
    const ffprobe = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        String(streamIndex),
        '-show_entries',
        'packet=pts,duration,flags',
        '-of',
        'csv=p=0',
        input,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const lifetime = superviseMediaProcess(ffprobe);

    let totalDuration = 0;
    const keyframePts: number[] = [];
    const keyframeAccDuration: number[] = [];
    const keyframeOwnDuration: number[] = [];
    const postDiscard: { pts: number; duration: number }[] = [];
    // FL-93: the stream's own origin and cadence, observed rather than assumed. `startPts` is
    // the smallest presentation timestamp seen — packets arrive in decode order, so a B-frame
    // reorder means the first line is not necessarily the earliest picture. `firstDuration`
    // seeds the variable-frame-rate check: any packet whose duration differs makes the source
    // genuinely VFR, and a VFR source must never be coerced onto a nominal fps.
    let startPts: number | null = null;
    let firstDuration: number | null = null;
    let variableFrameRate = false;
    let presentationValid = true;
    const parseLine = (line: string) => {
      if (!line) {
        return;
      }
      const [ptsStr, durationStr, flags] = line.split(',', 3);
      const pts = Number.parseInt(ptsStr);
      const duration = Number.parseInt(durationStr);
      if (
        flags?.[1] !== 'D' &&
        (!/^-?\d+$/.test(ptsStr) ||
          !/^\d+$/.test(durationStr) ||
          !flags ||
          !Number.isSafeInteger(pts) ||
          !Number.isSafeInteger(duration) ||
          duration <= 0 ||
          !Number.isSafeInteger(pts + duration))
      ) {
        presentationValid = false;
      }
      if (Number.isNaN(pts) || Number.isNaN(duration) || !flags) {
        return;
      }
      lifetime.progress(1);
      if (startPts === null || pts < startPts) {
        startPts = pts;
      }
      if (firstDuration === null) {
        firstDuration = duration;
      } else if (duration !== firstDuration) {
        variableFrameRate = true;
      }
      // Discarded packets don't contribute to packet count, but still contribute to video duration
      totalDuration += duration;
      if (flags[1] !== 'D') {
        postDiscard.push({ pts, duration });
      }
      if (flags[0] === 'K') {
        keyframePts.push(pts);
        keyframeAccDuration.push(totalDuration);
        // VFR content can have variable duration keyframes,
        // so we need to track their duration separately for accurate segment boundaries.
        // Non-keyframes are accounted for in totalDuration.
        keyframeOwnDuration.push(duration);
      }
    };

    let stderr = '';
    let remainder = '';
    ffprobe.stderr.setEncoding('utf8');
    ffprobe.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-65_536);
    });
    ffprobe.stdout.setEncoding('utf8');
    ffprobe.stdout.on('data', (chunk: string) => {
      const lines = chunk.split('\n');
      lines[0] = remainder + lines[0];
      remainder = lines.pop() as string;
      for (const line of lines) {
        parseLine(line);
      }
    });

    return new Promise<VideoPacketInfo | null>((resolve, reject) => {
      let failure: Error | undefined;
      ffprobe.on('error', (error) => {
        failure = error;
      });
      ffprobe.on('close', (code) => {
        if (lifetime.error() || failure) return reject(lifetime.error() ?? failure);
        if (code !== 0) {
          return reject(new Error(`ffprobe exited with code ${code}: ${stderr.trim()}`));
        }
        parseLine(remainder);
        if (postDiscard.length === 0) {
          return resolve(null);
        }

        // The existing CFR calculation sorts packets by PTS, allowing decode-order reordering.
        const outputFrames = this.cfrOutputFrames(postDiscard, postDiscard.length / totalDuration);
        const duration = postDiscard[0].duration;
        const presentationCadenceTicks =
          presentationValid &&
          postDiscard.every((packet, index) => {
            const offset = index * duration;
            const pts = postDiscard[0].pts + offset;
            return (
              Number.isSafeInteger(offset) &&
              Number.isSafeInteger(pts) &&
              packet.duration === duration &&
              packet.pts === pts
            );
          })
            ? duration
            : null;
        let presentation: VideoPacketInfo['presentation'] = null;
        if (presentationValid) {
          presentation = { startPts: Infinity, endPts: -Infinity };
          for (const packet of postDiscard) {
            presentation.startPts = Math.min(presentation.startPts, packet.pts);
            presentation.endPts = Math.max(presentation.endPts, packet.pts + packet.duration);
          }
        }

        resolve({
          presentation,
          presentationCadenceTicks,
          totalDuration,
          packetCount: postDiscard.length,
          outputFrames,
          keyframePts,
          keyframeAccDuration,
          keyframeOwnDuration,
          startPts: startPts ?? 0,
          variableFrameRate,
        });
      });
    });
  }

  async transcode(input: string, output: string | Writable, options: TranscodeCommand): Promise<void> {
    const signal = jobSignal();
    signal?.throwIfAborted();
    const run = (target: string | Writable, pass?: number) =>
      new Promise<void>((resolve, reject) => {
        const command = this.configureFfmpegCall(input, target, options);
        if (pass) {
          command.addOptions('-pass', String(pass)).addOptions('-passlogfile', output as string);
          if (pass === 1) {
            command.addOptions('-f null');
          }
        }
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => {
          command.kill('SIGTERM');
          killTimer ??= setTimeout(() => command.kill('SIGKILL'), 5000);
        };
        let pid: number | undefined;
        command.on('start', () => {
          pid = (command as unknown as { ffmpegProc?: { pid?: number } }).ffmpegProc?.pid;
          if (pid) {
            parentPort?.postMessage({ type: 'queue-child', pid, active: true });
          }
        });
        const cleanup = () => {
          if (pid) {
            parentPort?.postMessage({ type: 'queue-child', pid, active: false });
          }
          signal?.removeEventListener('abort', abort);
          clearTimeout(killTimer);
        };
        let lastFrames = 0;
        command
          .on('progress', (progress: ProgressEvent) => {
            if (!(progress.frames > lastFrames)) return;
            advanceJobProgress(progress.frames - lastFrames);
            lastFrames = progress.frames;
          })
          .on('error', (error) => {
            cleanup();
            reject(error);
          })
          .on('end', () => {
            cleanup();
            if (signal?.aborted) {
              reject(signal.reason);
            } else {
              resolve();
            }
          });
        signal?.addEventListener('abort', abort, { once: true });
        command.run();
        if (signal?.aborted) {
          abort();
        }
      });
    if (!options.twoPass) {
      await run(output);
      return;
    }
    if (typeof output !== 'string') {
      throw new TypeError('Two-pass transcoding does not support writing to a stream');
    }
    try {
      await run('/dev/null', 1);
      signal?.throwIfAborted();
      await run(output, 2);
    } finally {
      await Promise.all([fs.rm(`${output}-0.log`, { force: true }), fs.rm(`${output}-0.log.mbtree`, { force: true })]);
    }
  }

  async normalizeDevelopArtifact(
    input: string,
    kind: 'mask' | 'fill',
  ): Promise<{ data: Buffer; width: number; height: number }> {
    return sharpProcessPool.run('normalizeDevelopArtifact', [input, kind]);
  }

  async decodeDevelopArtifact(
    input: string,
    kind: 'mask' | 'fill',
  ): Promise<{ data: Buffer; width: number; height: number; channels: 1 | 4 }> {
    return sharpProcessPool.run('decodeDevelopArtifact', [input, kind]);
  }

  async getImageMetadata(input: string | Buffer): Promise<ImageDimensions & { isTransparent: boolean }> {
    return sharpProcessPool.run('getImageMetadata', [input]);
  }

  async getOrientedSize(input: string): Promise<ImageDimensions> {
    return sharpProcessPool.run('getOrientedSize', [input]);
  }

  async scoreThumbnailCandidate(input: string): Promise<number> {
    return sharpProcessPool.run('scoreThumbnailCandidate', [input]);
  }

  private configureFfmpegCall(input: string, output: string | Writable, options: TranscodeCommand) {
    const ffmpegCall = ffmpeg(input, { niceness: 10 })
      .inputOptions(options.inputOptions)
      .outputOptions(options.outputOptions)
      .output(output)
      .on('start', (command: string) => this.logger.debug(command))
      .on('error', (error, _, stderr) => this.logger.error(stderr || error));

    const { frameCount, percentInterval } = options.progress;
    const frameInterval = Math.ceil(frameCount / (100 / percentInterval));
    if (this.logger.isLevelEnabled(LogLevel.Debug) && frameCount && frameInterval) {
      let lastProgressFrame: number = 0;
      ffmpegCall.on('progress', (progress: ProgressEvent) => {
        if (progress.frames - lastProgressFrame < frameInterval) {
          return;
        }

        lastProgressFrame = progress.frames;
        const percent = ((progress.frames / frameCount) * 100).toFixed(2);
        const ms = progress.currentFps ? Math.floor((frameCount - progress.frames) / progress.currentFps) * 1000 : 0;
        const duration = ms ? Duration.fromMillis(ms).rescale().toHuman({ unitDisplay: 'narrow' }) : '';
        const outputText = output instanceof Writable ? 'stream' : output.split('/').pop();
        this.logger.debug(
          `Transcoding ${percent}% done${duration ? `, estimated ${duration} remaining` : ''} for output ${outputText}`,
        );
      });
    }

    return ffmpegCall;
  }

  private parseInt(value: string | number | undefined): number {
    return Number.parseInt(value as string) || 0;
  }

  /**
   * FL-102: the channel layout as ffmpeg names it, or null. The ffprobe parser turns `5.1` and
   * `7.1` into numbers, which would be stored and compared as something other than a layout name;
   * and `unknown` means only the count is known, which is not a layout: passed back as
   * `-channel_layout unknown` it makes ffmpeg refuse the whole render.
   */
  private parseChannelLayout(value: unknown): string | null {
    const layout = value === undefined || value === null ? '' : String(value);
    return ['', 'unknown'].includes(layout) ? null : layout;
  }

  /**
   * FL-102: a stream's own duration in seconds, or null when the container does not state one.
   * MP4 and MOV report `duration`; Matroska and WebM carry it only as a `DURATION` tag
   * (`00:00:05.005000000`). Compared per stream, it is what shows audio drifting from video.
   */
  /** A stream's stated start time in seconds, or null when ffprobe gave none. */
  private parseStartTime(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }

  private parseStreamDuration(stream: FfprobeStream): number | null {
    const stated = stream.duration === undefined || stream.duration === 'N/A' ? NaN : Number(stream.duration);
    if (Number.isFinite(stated) && stated >= 0) {
      return stated;
    }
    const tags = (stream.tags ?? {}) as Record<string, unknown>;
    const tag = tags.DURATION ?? tags.duration;
    const match = typeof tag === 'string' ? /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(tag.trim()) : null;
    if (!match) {
      return null;
    }
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }

  private parseFloat(value: string | number | undefined): number {
    // eslint-disable-next-line unicorn/prefer-number-coercion
    return Number.parseFloat(value as string) || 0;
  }

  private parseOptionalInt(value: string | number | undefined): number | null {
    const parsed = Number.parseInt(value as string);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private parseEnum<E extends Record<string, number | string>>(enumObj: E, value?: string) {
    return value ? ((enumObj[pascalCase(value)] as Extract<E[keyof E], number> | undefined) ?? null) : null;
  }

  /** Parse a rational like "60000/1001" or "1/600" into `{ num, den }`. */
  private parseRational(value: string | undefined): { num: number; den: number } | null {
    if (value) {
      const [num, den = 1] = value.split('/').map(Number);
      if (num && den) {
        return { num, den };
      }
    }
    return null;
  }

  private parseFrameRate(value: string | undefined): number | null {
    const r = this.parseRational(value);
    return r ? r.num / r.den : null;
  }

  private getDar(dar: string | undefined): number {
    if (dar) {
      const [darW, darH] = dar.split(':').map(Number);
      if (darW && darH) {
        return darW / darH;
      }
    }

    return 0;
  }

  private parseVideoProfile(codec?: string, profile?: string) {
    switch (codec) {
      case 'h264': {
        return this.parseEnum(H264Profile, profile);
      }
      case 'h265':
      case 'hevc': {
        return this.parseEnum(HevcProfile, profile);
      }
      case 'av1': {
        return this.parseEnum(Av1Profile, profile);
      }
      default: {
        return null;
      }
    }
  }

  private compareStreams(a: FfprobeStream, b: FfprobeStream): number {
    const d = (b.disposition?.default ?? 0) - (a.disposition?.default ?? 0);
    if (d !== 0) {
      return d;
    }
    return this.parseInt(b.bit_rate) - this.parseInt(a.bit_rate);
  }

  /* Ported from https://code.ffmpeg.org/FFmpeg/FFmpeg/src/commit/5c44245878e235ae64fe87fb9877644856d33d1d/fftools/ffmpeg_filter.c
   * SPDX-License-Identifier: LGPL-2.1-or-later
   * Copyright (c) FFmpeg authors and contributors — https://ffmpeg.org/
   * Modifications: TS port operating on probe-derived packet metadata rather than decoded AVFrames. */
  private cfrOutputFrames(packets: { pts: number; duration: number }[], slotsPerTick: number) {
    packets.sort((a, b) => a.pts - b.pts);
    const firstPts = packets[0].pts;
    let outputFrames = 0;
    let nextPts = 0;
    const history = [0, 0, 0];
    for (const pkt of packets) {
      const syncIpts = (pkt.pts - firstPts) * slotsPerTick;
      const duration = pkt.duration * slotsPerTick;
      let delta0 = syncIpts - nextPts;
      const delta = delta0 + duration;

      if (delta0 < 0 && delta > 0) {
        delta0 = 0;
      }

      let nb = 1;
      let nbPrev = 0;
      if (delta < -1.1) {
        nb = 0;
      } else if (delta > 1.1) {
        nb = Math.round(delta);
        if (delta0 > 1.1) {
          nbPrev = Math.round(delta0 - 0.6);
        }
      }
      outputFrames += nb;
      nextPts += nb;
      history[2] = history[1];
      history[1] = history[0];
      history[0] = nbPrev;
    }
    const median = history.sort((a, b) => a - b)[1];
    return outputFrames + median;
  }
}
