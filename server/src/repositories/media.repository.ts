import { Injectable } from '@nestjs/common';
import { ExifDateTime, WriteTags, exiftool } from 'exiftool-vendored';
import ffmpeg, { FfprobeData, FfprobeStream } from 'fluent-ffmpeg';
import { camelCase, upperFirst } from 'lodash-es';
import { Duration } from 'luxon';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
import sharp, { Sharp } from 'sharp';
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
import { ORIENTATION_TO_SHARP_ROTATION } from 'src/constants.js';
import { Exif } from 'src/database.js';
import { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import {
  AacProfile,
  Av1Profile,
  ColorMatrix,
  ColorPrimaries,
  ColorTransfer,
  Colorspace,
  DvProfile,
  DvSignalCompatibility,
  H264Profile,
  HevcProfile,
  ImageFormat,
  LogLevel,
  RawExtractedFormat,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { LOCATION_DELETE_ARGS } from 'src/utils/location-tags.js';
import { parseFfprobeColorRange } from 'src/utils/media-policy.js';
import { handlePromiseError } from 'src/utils/misc.js';
import { tryParseRational } from 'src/utils/rational-time.js';
import { createAffineMatrix } from 'src/utils/transform.js';

const probe = (input: string, options: string[]): Promise<FfprobeData> =>
  new Promise((resolve, reject) =>
    // eslint-disable-next-line import-x/no-named-as-default-member
    ffmpeg.ffprobe(input, options, (error, data) => (error ? reject(error) : resolve(data))),
  );

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
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(MediaRepository.name);
    // eslint-disable-next-line import-x/no-named-as-default-member
    sharp.concurrency(0);
    // eslint-disable-next-line import-x/no-named-as-default-member
    sharp.cache({ files: 0 });
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

  decodeImage(input: string | Buffer, options: DecodeToBufferOptions) {
    return this.getImageDecodingPipeline(input, options).raw().toBuffer({ resolveWithObject: true });
  }

  private applyEdits(pipeline: Sharp, edits: AssetEditActionItem[]): Sharp {
    const crop = edits.find((edit) => edit.action === 'crop');
    if (crop) {
      pipeline = pipeline.extract({
        left: Math.round(crop.parameters.x),
        top: Math.round(crop.parameters.y),
        width: Math.round(crop.parameters.width),
        height: Math.round(crop.parameters.height),
      });
    }

    const affineEditOperations = edits.filter((edit) => edit.action !== 'crop');
    if (affineEditOperations.length > 0) {
      const { a, b, c, d } = createAffineMatrix(affineEditOperations);
      pipeline = pipeline.affine([
        [a, b],
        [c, d],
      ]);
    }

    return pipeline;
  }

  async generateThumbnail(input: string | Buffer, options: GenerateThumbnailOptions, output: string): Promise<void> {
    await this.getImageDecodingPipeline(input, options)
      .toFormat(options.format, {
        quality: options.quality,
        // this is default in libvips (except the threshold is 90), but we need to set it manually in sharp
        chromaSubsampling: options.quality >= 80 ? '4:4:4' : '4:2:0',
        progressive: options.progressive,
      })
      .toFile(output);
  }

  /**
   * FL-163: the copy of a photo that may leave this server for Frameleaf Cloud. The preview is decoded and
   * written again as a JPEG; sharp keeps no EXIF, XMP or IPTC unless asked to (`keepExif`,
   * `withMetadata`), so the capture location, camera, dates and every other tag stay here. Only the
   * sRGB colour profile is kept, so colours read the same.
   */
  async writeCloudUpload(input: string, output: string): Promise<void> {
    await sharp(input, { failOn: 'error', limitInputPixels: false })
      .rotate()
      .withIccProfile('srgb')
      .jpeg({ quality: 90, chromaSubsampling: '4:4:4', progressive: false })
      .toFile(output);
  }

  /**
   * Compose a set of input images into a single JPEG grid (left-to-right,
   * top-to-bottom). Cells are letterboxed to a fixed size on a black canvas
   * to keep aspect ratios intact. Used to feed multiple video frames through
   * the single-image describeImage() ML endpoint.
   */
  async composeImageGrid(
    inputs: string[],
    options: { cols: number; rows: number; cellSize: number; output: string },
  ): Promise<void> {
    const { cols, rows, cellSize, output } = options;
    const canvasWidth = cols * cellSize;
    const canvasHeight = rows * cellSize;

    const cells = await Promise.all(
      inputs.slice(0, cols * rows).map((path) =>
        sharp(path, { limitInputPixels: false })
          .rotate()
          .resize(cellSize, cellSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
          .toFormat('jpeg')
          .toBuffer(),
      ),
    );

    const composites = cells.map((buffer, index) => ({
      input: buffer,
      left: (index % cols) * cellSize,
      top: Math.floor(index / cols) * cellSize,
    }));

    await sharp({
      create: { width: canvasWidth, height: canvasHeight, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite(composites)
      .jpeg({ quality: 85, chromaSubsampling: '4:2:0', progressive: false })
      .toFile(output);
  }

  private getImageDecodingPipeline(input: string | Buffer, options: DecodeToBufferOptions) {
    let pipeline = sharp(input, {
      // some invalid images can still be processed by sharp, but we want to fail on them by default to avoid crashes
      failOn: options.processInvalidImages ? 'none' : 'error',
      limitInputChannels: false,
      limitInputPixels: false,
      raw: options.raw,
      unlimited: true,
    })
      .pipelineColorspace(options.colorspace === Colorspace.Srgb ? 'srgb' : 'rgb16')
      .withIccProfile(options.colorspace);

    if (!options.raw) {
      const { angle, flip, flop } = options.orientation ? ORIENTATION_TO_SHARP_ROTATION[options.orientation] : {};
      pipeline = pipeline.rotate(angle);
      if (flip) {
        pipeline = pipeline.flip();
      }

      if (flop) {
        pipeline = pipeline.flop();
      }
    }

    if (options.edits && options.edits.length > 0) {
      pipeline = this.applyEdits(pipeline, options.edits);
    }

    if (options.size !== undefined) {
      pipeline = pipeline.resize(options.size, options.size, { fit: 'outside', withoutEnlargement: true });
    }
    return pipeline;
  }

  /**
   * Still-image develop geometry (FL-113): quarter turns and flips, then an arbitrary
   * straighten with the frame scaled back to cover its own bounds, then the recipe crop.
   * Runs as staged pipelines because sharp allows one rotation and two extracts per pipeline.
   * Input and output are 8-bit interleaved raw buffers; the original file is only ever read.
   */
  async renderDevelopGeometry(
    input: Buffer,
    raw: RawImageInfo,
    plan: DevelopGeometryPlan,
  ): Promise<{ data: Buffer; info: RawImageInfo }> {
    let current = await sharp(input, { raw, limitInputPixels: false, unlimited: true })
      .rotate(plan.rotation)
      .flop(plan.flipHorizontal)
      .flip(plan.flipVertical)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = plan.oriented;
    if (plan.straighten !== 0) {
      const theta = (Math.abs(plan.straighten) * Math.PI) / 180;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      // The rotated bitmap grows to these bounds; the centre window of the original size divided
      // by the cover scale, resized back up, is the straightened frame the client previews.
      const scale = Math.max((width * cos + height * sin) / width, (width * sin + height * cos) / height);
      const windowWidth = Math.max(1, Math.round(width / scale));
      const windowHeight = Math.max(1, Math.round(height / scale));
      const rotated = await sharp(current.data, {
        raw: this.toRawInfo(current.info),
        limitInputPixels: false,
        unlimited: true,
      })
        .rotate(plan.straighten, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
        .raw()
        .toBuffer({ resolveWithObject: true });
      current = await sharp(rotated.data, {
        raw: this.toRawInfo(rotated.info),
        limitInputPixels: false,
        unlimited: true,
      })
        .extract({
          left: Math.max(0, Math.round((rotated.info.width - windowWidth) / 2)),
          top: Math.max(0, Math.round((rotated.info.height - windowHeight) / 2)),
          width: Math.min(windowWidth, rotated.info.width),
          height: Math.min(windowHeight, rotated.info.height),
        })
        .resize(width, height, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    }

    const { extract } = plan;
    if (extract.left !== 0 || extract.top !== 0 || extract.width !== width || extract.height !== height) {
      current = await sharp(current.data, {
        raw: this.toRawInfo(current.info),
        limitInputPixels: false,
        unlimited: true,
      })
        .extract({
          left: Math.min(extract.left, Math.max(0, current.info.width - 1)),
          top: Math.min(extract.top, Math.max(0, current.info.height - 1)),
          width: Math.min(extract.width, current.info.width - extract.left),
          height: Math.min(extract.height, current.info.height - extract.top),
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
    }

    return { data: current.data, info: this.toRawInfo(current.info) };
  }

  /**
   * Detail stages after the tone pass (noise reduction, clarity, sharpening) and encoding of
   * one develop output. `size` bounds the longest edge for a preview and is omitted for the
   * edited master, which keeps the source resolution. Writes to `output` when given, otherwise
   * returns the encoded bytes.
   */
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
    let data = input;
    let info = raw;
    const open = () => sharp(data, { raw: info, limitInputPixels: false, unlimited: true });
    const { detail } = options;
    if (detail.median > 0 || detail.clarity) {
      let pipeline = open();
      if (detail.median > 0) {
        pipeline = pipeline.median(detail.median);
      }
      if (detail.clarity) {
        pipeline = pipeline.sharpen(detail.clarity);
      }
      const result = await pipeline.raw().toBuffer({ resolveWithObject: true });
      data = result.data;
      info = this.toRawInfo(result.info);
    }
    let pipeline = open();
    if (detail.sharpen) {
      pipeline = pipeline.sharpen(detail.sharpen);
    }
    if (options.size !== undefined) {
      pipeline = pipeline.resize(options.size, options.size, { fit: 'inside', withoutEnlargement: true });
    }
    pipeline = pipeline.withIccProfile(options.colorspace).toFormat(options.format, {
      quality: options.quality,
      chromaSubsampling: options.quality >= 80 ? '4:4:4' : '4:2:0',
      progressive: options.progressive ?? false,
    });
    if (output) {
      await pipeline.toFile(output);
      return;
    }
    return pipeline.toBuffer();
  }

  private toRawInfo(info: { width: number; height: number; channels: number }): RawImageInfo {
    return { width: info.width, height: info.height, channels: info.channels as RawImageInfo['channels'] };
  }

  async generateThumbhash(input: string | Buffer, options: GenerateThumbhashOptions): Promise<Buffer> {
    const { rgbaToThumbHash } = await import('thumbhash');

    const { data, info } = await this.getImageDecodingPipeline(input, {
      colorspace: options.colorspace,
      processInvalidImages: options.processInvalidImages,
      raw: options.raw,
      edits: options.edits,
    })
      .resize(100, 100, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    return Buffer.from(rgbaToThumbHash(info.width, info.height, data));
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
          channelLayout: stream.channel_layout ?? null,
          sampleRate: this.parseOptionalInt(stream.sample_rate),
        })),
    };
  }

  /**
   * Needed for accurate segments, especially when remuxing, seeking and/or VFR is involved.
   * Scanning packets for keyframes in JS is much faster than -skip_frame nokey since it avoids decoding the video.
   */
  probePackets(input: string, streamIndex: number): Promise<VideoPacketInfo | null> {
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
    const parseLine = (line: string) => {
      if (!line) {
        return;
      }
      const [ptsStr, durationStr, flags] = line.split(',', 3);
      const pts = Number.parseInt(ptsStr);
      const duration = Number.parseInt(durationStr);
      if (Number.isNaN(pts) || Number.isNaN(duration) || !flags) {
        return;
      }
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
    ffprobe.stderr.on('data', (chunk: string) => (stderr += chunk));
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
      ffprobe.on('error', reject);
      ffprobe.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`ffprobe exited with code ${code}: ${stderr.trim()}`));
        }
        parseLine(remainder);
        if (postDiscard.length === 0) {
          return resolve(null);
        }

        resolve({
          totalDuration,
          packetCount: postDiscard.length,
          outputFrames: this.cfrOutputFrames(postDiscard, postDiscard.length / totalDuration),
          keyframePts,
          keyframeAccDuration,
          keyframeOwnDuration,
          startPts: startPts ?? 0,
          variableFrameRate,
        });
      });
    });
  }

  transcode(input: string, output: string | Writable, options: TranscodeCommand): Promise<void> {
    if (!options.twoPass) {
      return new Promise((resolve, reject) => {
        this.configureFfmpegCall(input, output, options)
          .on('error', reject)
          .on('end', () => resolve())
          .run();
      });
    }

    if (typeof output !== 'string') {
      throw new TypeError('Two-pass transcoding does not support writing to a stream');
    }

    // two-pass allows for precise control of bitrate at the cost of running twice
    // recommended for vp9 for better quality and compression
    return new Promise((resolve, reject) => {
      // first pass output is not saved as only the .log file is needed
      this.configureFfmpegCall(input, '/dev/null', options)
        .addOptions('-pass', '1')
        .addOptions('-passlogfile', output)
        .addOptions('-f null')
        .on('error', reject)
        .on('end', () => {
          // second pass
          this.configureFfmpegCall(input, output, options)
            .addOptions('-pass', '2')
            .addOptions('-passlogfile', output)
            .on('error', reject)
            .on('end', () => handlePromiseError(fs.unlink(`${output}-0.log`), this.logger))
            .on('end', () => handlePromiseError(fs.rm(`${output}-0.log.mbtree`, { force: true }), this.logger))
            .on('end', () => resolve())
            .run();
        })
        .run();
    });
  }

  async getImageMetadata(input: string | Buffer): Promise<ImageDimensions & { isTransparent: boolean }> {
    const { width = 0, height = 0, hasAlpha = false } = await sharp(input, { unlimited: true }).metadata();
    return { width, height, isTransparent: hasAlpha };
  }

  /** Width and height as the image is displayed, after its EXIF orientation (FL-64 imported versions). */
  async getOrientedSize(input: string): Promise<ImageDimensions> {
    const { width = 0, height = 0, orientation } = await sharp(input, { unlimited: true }).metadata();
    return orientation && orientation >= 5 ? { width: height, height: width } : { width, height };
  }

  async scoreThumbnailCandidate(input: string): Promise<number> {
    const stats = await sharp(input).stats();
    const channels = stats.channels.slice(0, 3);
    const mean = channels.reduce((sum, channel) => sum + channel.mean, 0) / channels.length;
    const contrast = channels.reduce((sum, channel) => sum + channel.stdev, 0) / channels.length;
    const { entropy = 0, sharpness = 0 } = stats as typeof stats & { entropy?: number; sharpness?: number };

    const exposureScore = 40 - Math.abs(mean - 128) / 4;
    const blackFramePenalty = mean < 18 ? (18 - mean) * 12 : 0;
    const blownFramePenalty = mean > 245 ? (mean - 245) * 6 : 0;
    const flatFramePenalty = contrast < 4 ? (4 - contrast) * 12 : 0;
    const logoLikePenalty = entropy < 1.2 && contrast < 12 ? 35 : 0;

    return (
      exposureScore +
      contrast * 1.5 +
      entropy * 14 +
      sharpness * 0.1 -
      blackFramePenalty -
      blownFramePenalty -
      flatFramePenalty -
      logoLikePenalty
    );
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
