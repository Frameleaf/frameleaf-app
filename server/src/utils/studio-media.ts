import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import type { ConfigFFmpegDto } from 'src/dtos/config.dto.js';
import type { AudioStreamInfo, TranscodeCommand, VideoStreamInfo } from 'src/types.js';
import { ThumbnailConfig } from 'src/utils/media.js';

/**
 * Studio timeline media for the native iPad and Android Studio apps: filmstrip sprite sheets and
 * audio waveform peaks, both derived on demand from the rendition `/assets/{id}/video/playback`
 * serves and cached beside the asset's thumbnails. Pure planning and encoding lives here; the
 * service owns access, caching and ffmpeg.
 */

/** Bumped whenever the cached bytes would change for the same source, so old caches are dropped. */
export const STUDIO_MEDIA_CACHE_VERSION = 1;

export const FILMSTRIP_COUNT = { min: 1, max: 120, default: 20 } as const;
export const FILMSTRIP_HEIGHT = { min: 32, max: 240, default: 90 } as const;
/** Sprites stay within a width every mobile GPU accepts as one texture. */
export const FILMSTRIP_MAX_SPRITE_WIDTH = 4096;
/** Extreme aspect ratios (panoramic video) are cover-cropped to this. */
export const FILMSTRIP_MAX_ASPECT = 3;
export const FILMSTRIP_QUALITY = 75;

export const WAVEFORM_BUCKETS = { min: 1, max: 10_000, default: 1000 } as const;
/** The decode rate for peaks; plenty for drawing, cheap to decode. */
export const WAVEFORM_SAMPLE_RATE = 8000;
/** The cached resolution: 100 buckets a second until the cap below. */
export const WAVEFORM_BASE_SAMPLES_PER_BUCKET = WAVEFORM_SAMPLE_RATE / 100;
/** The cache is halved in resolution whenever it would grow past this many buckets. */
export const WAVEFORM_MAX_BASE_BUCKETS = 1 << 18;
export const WAVEFORM_MAX_CHANNELS = 8;

export type FilmstripFormat = 'jpeg' | 'webp';
export type WaveformChannelMode = 'mono' | 'all';

/** A short, stable key for one source file as it is on disk now. */
export const studioMediaFingerprint = (source: { path: string; size: number; mtimeMs: number }) =>
  createHash('sha256')
    .update(`${STUDIO_MEDIA_CACHE_VERSION}|${source.path}|${source.size}|${Math.trunc(source.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16);

export type FilmstripPlan = {
  timesMs: number[];
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  spriteWidth: number;
  spriteHeight: number;
};

/**
 * Where to sample and how to lay out `count` frames `tileHeight` pixels high: frames at the centre
 * of `count` equal slices of the video, in tiles as wide as the displayed aspect ratio (after
 * rotation) allows, wrapped into rows no wider than `FILMSTRIP_MAX_SPRITE_WIDTH`.
 */
export const planFilmstrip = (input: {
  durationMs: number;
  width: number;
  height: number;
  rotation: number;
  count: number;
  tileHeight: number;
}): FilmstripPlan => {
  const { durationMs, count, tileHeight } = input;
  const quarterTurn = Math.abs(input.rotation) % 180 === 90;
  const [width, height] = quarterTurn ? [input.height, input.width] : [input.width, input.height];
  const aspect =
    width > 0 && height > 0
      ? Math.min(Math.max(width / height, 1 / FILMSTRIP_MAX_ASPECT), FILMSTRIP_MAX_ASPECT)
      : 16 / 9;
  const tileWidth = Math.max(2, Math.round((tileHeight * aspect) / 2) * 2);
  const columns = Math.max(1, Math.min(count, Math.floor(FILMSTRIP_MAX_SPRITE_WIDTH / tileWidth)));
  const rows = Math.ceil(count / columns);
  const duration = Math.max(0, durationMs);
  const timesMs = Array.from({ length: count }, (_, index) =>
    Math.max(0, Math.min(Math.max(0, duration - 1), Math.round((duration * (index + 0.5)) / count))),
  );
  return {
    timesMs,
    tileWidth,
    tileHeight,
    columns,
    rows,
    spriteWidth: columns * tileWidth,
    spriteHeight: rows * tileHeight,
  };
};

/**
 * One frame at `timeMs`, `height` pixels high, as a JPEG. Input seeking decodes up to the exact
 * frame; ffmpeg's autorotate orients it; HDR is tone mapped the way video thumbnails are.
 */
export const getFilmstripFrameCommand = (
  config: ConfigFFmpegDto,
  video: VideoStreamInfo,
  timeMs: number,
  height: number,
): TranscodeCommand => {
  const tonemap = new ThumbnailConfig({ ...config, targetResolution: 'original' }).getToneMapping(video);
  return {
    inputOptions: ['-ss', (Math.max(0, timeMs) / 1000).toFixed(3)],
    outputOptions: [
      '-map',
      `0:${video.index}`,
      '-map_metadata',
      '-1',
      '-an',
      '-sn',
      '-dn',
      '-frames:v',
      '1',
      '-update',
      '1',
      '-vf',
      [...tonemap, `scale=-2:${height}:flags=bilinear`].join(','),
      '-pix_fmt',
      'yuvj420p',
      '-c:v',
      'mjpeg',
      '-q:v',
      '3',
      '-f',
      'image2',
    ],
    twoPass: false,
    progress: { frameCount: 1, percentInterval: 100 },
  };
};

/** The channel count a waveform is decoded at. */
export const waveformChannelCount = (audio: AudioStreamInfo, mode: WaveformChannelMode) =>
  mode === 'mono' ? 1 : Math.max(1, Math.min(WAVEFORM_MAX_CHANNELS, audio.channels ?? 2));

/** The audio stream decoded to interleaved signed 16-bit PCM on stdout. */
export const getWaveformCommand = (audio: AudioStreamInfo, channels: number): TranscodeCommand => ({
  inputOptions: [],
  outputOptions: [
    '-map',
    `0:${audio.index}`,
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-ac',
    String(channels),
    '-ar',
    String(WAVEFORM_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    '-f',
    's16le',
  ],
  twoPass: false,
  progress: { frameCount: 0, percentInterval: 100 },
});

export type WaveformPeaks = {
  channels: number;
  sampleRate: number;
  samplesPerBucket: number;
  bucketCount: number;
  /** the PCM frames (samples per channel) decoded */
  frameCount: number;
  /** bucket-major: `[bucket][channel][min, max]`, in 16-bit sample units */
  peaks: Int16Array;
};

/**
 * Folds interleaved s16le PCM into per-bucket minimum and maximum samples, one bucket per
 * `samplesPerBucket` frames. Memory is bounded: past `maxBuckets` the resolution is halved.
 */
export class PeakAccumulator {
  private mins: number[][];
  private maxs: number[][];
  private currentMin: number[];
  private currentMax: number[];
  private filled = 0;
  private frameCount = 0;
  private channel = 0;
  private carry: number | null = null;

  constructor(
    private readonly channels: number,
    private samplesPerBucket = WAVEFORM_BASE_SAMPLES_PER_BUCKET,
    private readonly maxBuckets = WAVEFORM_MAX_BASE_BUCKETS,
    private readonly sampleRate = WAVEFORM_SAMPLE_RATE,
  ) {
    this.mins = Array.from({ length: channels }, () => []);
    this.maxs = Array.from({ length: channels }, () => []);
    this.currentMin = Array.from({ length: channels }, () => 32_767);
    this.currentMax = Array.from({ length: channels }, () => -32_768);
  }

  write(chunk: Buffer) {
    let offset = 0;
    if (this.carry !== null && chunk.length > 0) {
      this.push(Buffer.from([this.carry, chunk[0]]).readInt16LE(0));
      this.carry = null;
      offset = 1;
    }
    for (; offset + 1 < chunk.length; offset += 2) {
      this.push(chunk.readInt16LE(offset));
    }
    if (offset < chunk.length) {
      this.carry = chunk[offset];
    }
  }

  /** A `Writable` to hand to ffmpeg as its output. */
  writable() {
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.write(chunk);
        callback();
      },
    });
  }

  finish(): WaveformPeaks {
    if (this.filled > 0) {
      this.closeBucket();
    }
    const bucketCount = this.mins[0]?.length ?? 0;
    const peaks = new Int16Array(bucketCount * this.channels * 2);
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      for (let channel = 0; channel < this.channels; channel++) {
        const at = (bucket * this.channels + channel) * 2;
        peaks[at] = this.mins[channel][bucket];
        peaks[at + 1] = this.maxs[channel][bucket];
      }
    }
    return {
      channels: this.channels,
      sampleRate: this.sampleRate,
      samplesPerBucket: this.samplesPerBucket,
      bucketCount,
      frameCount: this.frameCount,
      peaks,
    };
  }

  private push(sample: number) {
    const channel = this.channel;
    if (sample < this.currentMin[channel]) {
      this.currentMin[channel] = sample;
    }
    if (sample > this.currentMax[channel]) {
      this.currentMax[channel] = sample;
    }
    this.channel = (channel + 1) % this.channels;
    if (this.channel === 0) {
      this.frameCount++;
    }
    if (this.channel === 0 && ++this.filled >= this.samplesPerBucket) {
      this.closeBucket();
    }
  }

  private closeBucket() {
    for (let channel = 0; channel < this.channels; channel++) {
      this.mins[channel].push(this.currentMin[channel]);
      this.maxs[channel].push(this.currentMax[channel]);
      this.currentMin[channel] = 32_767;
      this.currentMax[channel] = -32_768;
    }
    this.filled = 0;
    if (this.mins[0].length >= this.maxBuckets) {
      this.halve();
    }
  }

  private halve() {
    for (let channel = 0; channel < this.channels; channel++) {
      const mins = this.mins[channel];
      const maxs = this.maxs[channel];
      const nextMins: number[] = [];
      const nextMaxs: number[] = [];
      for (let index = 0; index < mins.length; index += 2) {
        nextMins.push(Math.min(mins[index], mins[index + 1] ?? mins[index]));
        nextMaxs.push(Math.max(maxs[index], maxs[index + 1] ?? maxs[index]));
      }
      this.mins[channel] = nextMins;
      this.maxs[channel] = nextMaxs;
    }
    this.samplesPerBucket *= 2;
  }
}

const WAVEFORM_MAGIC = 0x46_4c_57_46; // 'FLWF'
const WAVEFORM_HEADER_BYTES = 24;

export const encodeWaveformPeaks = (peaks: WaveformPeaks): Buffer => {
  const buffer = Buffer.alloc(WAVEFORM_HEADER_BYTES + peaks.peaks.length * 2);
  buffer.writeUInt32LE(WAVEFORM_MAGIC, 0);
  buffer.writeUInt32LE(peaks.channels, 4);
  buffer.writeUInt32LE(peaks.sampleRate, 8);
  buffer.writeUInt32LE(peaks.samplesPerBucket, 12);
  buffer.writeUInt32LE(peaks.bucketCount, 16);
  buffer.writeUInt32LE(peaks.frameCount, 20);
  for (const [index, value] of peaks.peaks.entries()) {
    buffer.writeInt16LE(value, WAVEFORM_HEADER_BYTES + index * 2);
  }
  return buffer;
};

/** The cached peaks, or `null` when the bytes are not a complete cache file. */
export const decodeWaveformPeaks = (buffer: Buffer): WaveformPeaks | null => {
  if (buffer.length < WAVEFORM_HEADER_BYTES || buffer.readUInt32LE(0) !== WAVEFORM_MAGIC) {
    return null;
  }
  const channels = buffer.readUInt32LE(4);
  const sampleRate = buffer.readUInt32LE(8);
  const samplesPerBucket = buffer.readUInt32LE(12);
  const bucketCount = buffer.readUInt32LE(16);
  const frameCount = buffer.readUInt32LE(20);
  const values = bucketCount * channels * 2;
  if ((channels < 1 && bucketCount > 0) || sampleRate < 1 || buffer.length !== WAVEFORM_HEADER_BYTES + values * 2) {
    return null;
  }
  const peaks = new Int16Array(values);
  for (let index = 0; index < values; index++) {
    peaks[index] = buffer.readInt16LE(WAVEFORM_HEADER_BYTES + index * 2);
  }
  return { channels, sampleRate, samplesPerBucket, bucketCount, frameCount, peaks };
};

const normalize = (value: number) => Math.round((value / 32_768) * 10_000) / 10_000;

/**
 * `buckets` evenly spaced min/max pairs per channel, normalized to -1..1. Never more buckets than
 * were cached; each output bucket covers whole cached buckets.
 */
export const resampleWaveformPeaks = (peaks: WaveformPeaks, buckets: number) => {
  const count = Math.min(Math.max(1, buckets), peaks.bucketCount);
  const channels = Array.from({ length: peaks.channels }, () => ({ min: [] as number[], max: [] as number[] }));
  for (let bucket = 0; bucket < count; bucket++) {
    const start = Math.floor((bucket * peaks.bucketCount) / count);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * peaks.bucketCount) / count));
    for (let channel = 0; channel < peaks.channels; channel++) {
      let min = 32_767;
      let max = -32_768;
      for (let source = start; source < end; source++) {
        const at = (source * peaks.channels + channel) * 2;
        min = Math.min(min, peaks.peaks[at]);
        max = Math.max(max, peaks.peaks[at + 1]);
      }
      channels[channel].min.push(normalize(min));
      channels[channel].max.push(normalize(max));
    }
  }
  const durationMs = Math.round((peaks.frameCount * 1000) / peaks.sampleRate);
  return { bucketCount: count, durationMs, bucketDurationMs: count > 0 ? durationMs / count : 0, channels };
};
