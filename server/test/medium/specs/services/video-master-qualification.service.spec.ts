import { Kysely, sql } from 'kysely';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { AssetEditAction, AssetEditActionItem } from 'src/dtos/editing.dto.js';
import { AssetType, JobStatus, TranscodeHardwareAcceleration } from 'src/enum.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BASE_SERVICE_DEPENDENCIES } from 'src/services/base.service.js';
import { MediaService } from 'src/services/media.service.js';
import { resolveEditedMasterColorPolicy } from 'src/utils/media-policy.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

// Hosted-only qualification of existing production paths. These readers do not use the
// application's probe, dimension, timing or audio-validation helpers as their oracle.
const native = (binary: string, args: string[]) =>
  execFileSync(binary, args, { maxBuffer: 128 * 1024 * 1024, timeout: 60_000 });
const ffmpeg = (...args: string[]) =>
  native('ffmpeg', ['-v', 'error', '-y', '-threads', '1', ...args.slice(0, -1), '-threads', '1', args.at(-1)!]);
type Probe = {
  streams: Array<{
    codec_type: string;
    width: number;
    height: number;
    channels: number;
    channel_layout: string;
    sample_rate: string;
  }>;
  frames: Array<{ best_effort_timestamp_time: string }>;
  packets: Array<{ data_hash: string }>;
};
const inspect = <T = Probe>(file: string, ...args: string[]): T =>
  JSON.parse(native('ffprobe', ['-v', 'error', '-of', 'json', ...args, file]).toString());
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const frequencies = [233, 349, 467, 73, 587, 719]; // FL, FR, FC, LFE, BL, BR; none are shared.
const colors = [
  [200, 40, 40],
  [40, 180, 40],
  [40, 40, 200],
  [180, 180, 40],
];
const fullCrop = (width: number, height: number): AssetEditActionItem => ({
  action: AssetEditAction.Crop,
  parameters: { x: 0, y: 0, width, height },
});

/** Authored quadrant identities and a central grey frame-number patch, not an encoder-derived expectation. */
const fixture = (folder: string, width: number, height: number, frameCount = 6, audioTracks = 0, vfr = false) => {
  const raw = join(folder, 'authored.rgb');
  writeFileSync(raw, Buffer.alloc(0));
  for (let frame = 0; frame < frameCount; frame++) {
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const color = colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)];
        const marker = Math.abs(x - width / 2) < width / 16 && Math.abs(y - height / 2) < height / 16;
        for (let channel = 0; channel < 3; channel++) {
          pixels[(y * width + x) * 3 + channel] = marker ? 32 + (frame % 12) * 16 : color[channel];
        }
      }
    }
    appendFileSync(raw, pixels);
  }
  const output = join(folder, 'original.mp4');
  const args = [
    '-f',
    'rawvideo',
    '-pixel_format',
    'rgb24',
    '-video_size',
    `${width}x${height}`,
    '-framerate',
    '30',
    '-i',
    raw,
  ];
  for (let track = 0; track < audioTracks; track++) {
    const tones = frequencies.map((frequency) => `0.12*sin(2*PI*${frequency}*t)`).join('|');
    args.push('-f', 'lavfi', '-i', `aevalsrc=${tones}:s=48000:d=${frameCount / 30}:c=5.1`);
  }
  args.push('-map', '0:v:0');
  for (let track = 0; track < audioTracks; track++) {
    args.push('-map', `${track + 1}:a:0`);
  }
  if (vfr) {
    args.push('-vf', String.raw`select=eq(n\,0)+eq(n\,1)+eq(n\,3)+eq(n\,4)+eq(n\,8)+eq(n\,10)`);
  }
  ffmpeg(
    ...args,
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '10',
    '-bf',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-video_track_timescale',
    '90000',
    '-c:a',
    'aac',
    output,
  );
  console.info('FL16 owned fixture', { sha256: digest(output), width, height, frameCount, audioTracks, vfr });
  return output;
};

const frameTimes = (file: string) => {
  const result = inspect(
    file,
    '-select_streams',
    'v:0',
    '-show_frames',
    '-show_entries',
    'frame=best_effort_timestamp_time',
  );
  return result.frames.map((frame) => Number(frame.best_effort_timestamp_time));
};
const decoded = (file: string) => {
  const video = inspect(file, '-select_streams', 'v:0', '-show_streams').streams[0];
  const rgb = ffmpeg(
    '-i',
    file,
    '-map',
    '0:v:0',
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  );
  const stride = video.width * video.height * 3;
  expect(rgb.length % stride).toBe(0);
  const sample = (frame: number, x: number, y: number) => {
    const offset = frame * stride + (Math.floor(y * video.height) * video.width + Math.floor(x * video.width)) * 3;
    return [...rgb.subarray(offset, offset + 3)];
  };
  return { width: video.width, height: video.height, count: rgb.length / stride, sample };
};
const expectColor = (actual: number[], expected: number[]) => {
  // CRF18 is lossy: interior colour samples allow 20/255, not byte-equality.
  for (const [channel, value] of actual.entries()) expect(Math.abs(value - expected[channel])).toBeLessThanOrEqual(20);
};
const frameIds = (file: string, x = 0.5, y = 0.5) => {
  const frames = decoded(file);
  return Array.from({ length: frames.count }, (_, index) => {
    const grey = frames.sample(index, x, y);
    expect(Math.max(...grey) - Math.min(...grey)).toBeLessThanOrEqual(6);
    const identity = Math.round((grey[0] - 32) / 16);
    expect(Math.abs(grey[0] - (32 + identity * 16))).toBeLessThanOrEqual(6);
    // Lossy grey noise can round to -0; the authored zero frame ID has no sign.
    return identity === 0 ? 0 : identity;
  });
};
const audioPackets = (file: string) =>
  inspect(
    file,
    '-select_streams',
    'a:0',
    '-show_packets',
    '-show_data_hash',
    'sha256',
    '-show_entries',
    'packet=data_hash',
  ).packets.map((packet) => packet.data_hash);
const pcm = (file: string) => {
  const audio = inspect(file, '-select_streams', 'a:0', '-show_streams').streams[0];
  expect(audio.channels).toBe(6);
  expect(audio.channel_layout).toBe('5.1');
  expect(Number(audio.sample_rate)).toBe(48_000);
  return ffmpeg('-i', file, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1');
};

type PresentationProbe = {
  streams: Array<{
    codec_name: string;
    profile: string;
    time_base: string;
    sample_rate: string;
    channels: number;
    channel_layout: string;
  }>;
  frames: Array<{ best_effort_timestamp: number; duration: number; nb_samples: number }>;
  packets: Array<{
    pts: number;
    duration: number;
    side_data_list?: Array<{ skip_samples?: number; discard_padding?: number }>;
  }>;
};
const audioTick = 1 / 48_000;
const videoTick = 1 / 90_000;
const clockTolerance = 2 * (audioTick + videoTick);
// These owned AAC-LC fixtures encode 1024 samples per access unit. An encoder may add
// at most one trailing unit, but priming never grants an audio start-offset allowance.
const aacTailTolerance = 1024 * audioTick + clockTolerance;
const presentation = (file: string) => {
  const audio = inspect<PresentationProbe>(file, '-select_streams', 'a:0', '-show_streams', '-show_packets');
  const audioFrames = inspect<PresentationProbe>(file, '-select_streams', 'a:0', '-show_frames').frames;
  const video = inspect<PresentationProbe>(file, '-select_streams', 'v:0', '-show_streams', '-show_frames');
  expect(audio.streams[0]).toMatchObject({
    codec_name: 'aac',
    profile: 'LC',
    time_base: '1/48000',
    sample_rate: '48000',
    channels: 6,
    channel_layout: '5.1',
  });
  expect(video.streams[0].time_base).toBe('1/90000');
  expect(audioFrames.length).toBeGreaterThan(0);
  expect(video.frames.length).toBeGreaterThan(0);

  // libavcodec/packet.h AV_PKT_DATA_SKIP_SAMPLES defines leading skip and trailing
  // discard counts. Ignore fully skipped priming packets; retain partial packet windows.
  // Packet duration also bounds a final AAC unit shorter than its decoded padding.
  const retained = audio.packets.flatMap((packet) => {
    expect(Number.isSafeInteger(packet.pts)).toBe(true);
    expect(Number.isSafeInteger(packet.duration)).toBe(true);
    expect(packet.duration).toBeGreaterThan(0);
    expect(packet.duration).toBeLessThanOrEqual(1024);
    const skip = packet.side_data_list?.reduce((sum, side) => sum + (side.skip_samples ?? 0), 0) ?? 0;
    const padding = packet.side_data_list?.reduce((sum, side) => sum + (side.discard_padding ?? 0), 0) ?? 0;
    expect(Number.isSafeInteger(skip)).toBe(true);
    expect(Number.isSafeInteger(padding)).toBe(true);
    expect(skip).toBeGreaterThanOrEqual(0);
    expect(padding).toBeGreaterThanOrEqual(0);
    expect(skip + padding).toBeLessThanOrEqual(1024);
    const start = packet.pts + skip;
    // A demuxer may shorten the final packet duration and also signal padding;
    // intersect these bounds rather than removing the same padding twice.
    const end = packet.pts + Math.min(packet.duration, 1024 - padding);
    return start >= end ? [] : [{ start: start * audioTick, end: end * audioTick }];
  });
  expect(retained.length).toBeGreaterThan(0);
  for (const [index, window] of retained.entries()) {
    if (index > 0) {
      expect(Math.abs(window.start - retained[index - 1].end)).toBeLessThanOrEqual(audioTick);
    }
  }
  for (const frame of audioFrames) {
    expect(Number.isSafeInteger(frame.best_effort_timestamp)).toBe(true);
    expect(Number.isSafeInteger(frame.nb_samples)).toBe(true);
    expect(frame.nb_samples).toBeGreaterThan(0);
  }
  for (const frame of video.frames) {
    expect(Number.isSafeInteger(frame.best_effort_timestamp)).toBe(true);
    expect(Number.isSafeInteger(frame.duration)).toBe(true);
    expect(frame.duration).toBeGreaterThan(0);
  }
  const firstAudio = audioFrames[0];
  const lastAudio = audioFrames.at(-1)!;
  const firstVideo = video.frames[0];
  const lastVideo = video.frames.at(-1)!;
  // ffprobe's decoded frame timestamps already account for skip samples (decode.c).
  // Intersect them with retained packet windows so decoded tail padding is not presented.
  return {
    audioStart: Math.max(retained[0].start, firstAudio.best_effort_timestamp * audioTick),
    audioEnd: Math.min(retained.at(-1)!.end, (lastAudio.best_effort_timestamp + lastAudio.nb_samples) * audioTick),
    videoStart: firstVideo.best_effort_timestamp * videoTick,
    videoEnd: (lastVideo.best_effort_timestamp + lastVideo.duration) * videoTick,
  };
};
const assertAVPresentation = (actual: ReturnType<typeof presentation>, source?: ReturnType<typeof presentation>) => {
  expect(Math.abs(actual.audioStart - actual.videoStart)).toBeLessThanOrEqual(clockTolerance);
  expect(Math.abs(actual.audioEnd - actual.videoEnd)).toBeLessThanOrEqual(aacTailTolerance);
  if (source) {
    expect(Math.abs(actual.videoStart - source.videoStart)).toBeLessThanOrEqual(clockTolerance);
    expect(Math.abs(actual.videoEnd - source.videoEnd)).toBeLessThanOrEqual(clockTolerance);
    expect(Math.abs(actual.audioStart - source.audioStart)).toBeLessThanOrEqual(clockTolerance);
    expect(Math.abs(actual.audioEnd - source.audioEnd)).toBeLessThanOrEqual(aacTailTolerance);
  }
};
const channelAmplitudes = (file: string) => {
  const samples = pcm(file);
  // Exclude AAC's priming/tail. Independent correlation measures each authored tone in every lane.
  const start = 12_000;
  const count = 24_000;
  expect(samples.length / (6 * 4)).toBeGreaterThan(start + count);
  return frequencies.map((_, channel) =>
    frequencies.map((frequency) => {
      let sine = 0;
      let cosine = 0;
      for (let sample = 0; sample < count; sample++) {
        const value = samples.readFloatLE(((start + sample) * 6 + channel) * 4);
        const angle = (2 * Math.PI * frequency * sample) / 48_000;
        sine += value * Math.sin(angle);
        cosine += value * Math.cos(angle);
      }
      return (2 * Math.hypot(sine, cosine)) / count;
    }),
  );
};
const assertChannelIdentity = (amplitudes: number[][]) => {
  for (const [channel, lane] of amplitudes.entries()) {
    expect(lane[channel]).toBeGreaterThan(0.03);
    for (const [tone, amplitude] of lane.entries()) {
      if (tone !== channel) {
        expect(amplitude).toBeLessThan(lane[channel] / 3);
      }
    }
  }
};

describe.sequential('VID-100 production master qualification (FL-16)', () => {
  let db: Kysely<DB>;
  let folder: string;
  let originalRoot: string | undefined;
  let previousConfig: SystemConfig;
  let setup: ReturnType<typeof newMediumService<typeof MediaService>>;
  const real: Array<(typeof BASE_SERVICE_DEPENDENCIES)[number]> = [
    AssetEditRepository,
    AssetJobRepository,
    AssetRepository,
    ConfigRepository,
    AssetChecksumRepository,
    MediaRepository,
    StorageRepository,
    SystemMetadataRepository,
    UserRepository,
  ];

  beforeAll(async () => {
    // Missing native tooling is a failed qualification, never a skipped green check.
    console.info('FL16 native tools', {
      ffmpeg: native('ffmpeg', ['-version']).toString().split('\n', 1)[0],
      ffprobe: native('ffprobe', ['-version']).toString().split('\n', 1)[0],
    });
    expect(native('ffmpeg', ['-v', 'error', '-encoders']).toString()).toContain('libx264');
    db = await getKyselyDB();
  });
  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), 'fl16-master-'));
    try {
      originalRoot = StorageCore.getMediaLocation();
    } catch {
      originalRoot = undefined; // Preserve the harness's uninitialised root as well as an existing root.
    }
    StorageCore.setMediaLocation(folder);
    setup = newMediumService(MediaService, {
      database: db,
      real,
      // The medium factory leaves unused dependencies unset; its mock registry is explicit.
      mock: [JobRepository, LoggingRepository],
    });
    // Direct-render qualification has no queue attempt, but still executes the canonical source guard.
    const jobs = new JobRepository(
      {} as never,
      setup.ctx.get(ConfigRepository),
      {} as never,
      LoggingRepository.create(),
      db,
    );
    setup.ctx.getMock(JobRepository).guardAssetSource.mockImplementation((id) => jobs.guardAssetSource(id));
    previousConfig = await setup.ctx.getConfig({ withCache: false });
    const config = structuredClone(previousConfig);
    Object.assign(config.ffmpeg, {
      accel: TranscodeHardwareAcceleration.Disabled,
      accelDecode: false,
      threads: 1,
      preset: 'ultrafast',
      crf: 30,
      targetResolution: '144',
      maxBitrate: '100k',
    });
    await setup.ctx.updateConfig(config);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (previousConfig) {
        await setup.ctx.updateConfig(previousConfig);
      }
    } finally {
      // The public setter has no optional overload; restoring undefined keeps its original runtime state.
      StorageCore.setMediaLocation(originalRoot as string);
      rmSync(folder, { recursive: true, force: true });
    }
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const master = async (source: string, edits: AssetEditActionItem[], label: string) => {
    const media = setup.ctx.get(MediaRepository);
    const info = await media.probe(source);
    const config = await setup.sut.getConfig({ withCache: true });
    const output = join(folder, `${label}.master.mp4`);
    const rendered = await setup.sut['transcodeEditedMaster']({
      assetId: 'owned-native-fixture',
      input: source,
      output,
      config: config.ffmpeg,
      edits,
      videoStream: info.videoStreams[0],
      audioStream: info.audioStreams[0],
      format: info.format,
      colorDecision: resolveEditedMasterColorPolicy(info.videoStreams[0], config.ffmpeg),
    });
    expect(rendered).toBe(true);
    return output;
  };
  const seed = async (source: string) => {
    const { ctx } = setup;
    const info = await ctx.get(MediaRepository).probe(source);
    const video = info.videoStreams[0];
    const audio = info.audioStreams[0];
    const { formatName, formatLongName } = info.format;
    if (!formatName || !formatLongName) {
      throw new Error('Native qualification fixture is missing required container format metadata');
    }
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Video,
      originalPath: source,
      checksum: Buffer.from(digest(source), 'hex'),
      duration: Math.round(info.format.duration * 1000),
    });
    await ctx.get(AssetRepository).upsertExif({
      exif: {
        assetId: asset.id,
        exifImageWidth: video.width,
        exifImageHeight: video.height,
        orientation: '1',
        fps: video.frameRate,
      },
      video: {
        assetId: asset.id,
        bitrate: video.bitrate,
        frameCount: video.frameCount,
        timeBase: video.timeBase!,
        index: video.index,
        profile: video.profile,
        level: video.level,
        colorPrimaries: video.colorPrimaries,
        colorTransfer: video.colorTransfer,
        colorMatrix: video.colorMatrix,
        dvProfile: video.dvProfile,
        dvLevel: video.dvLevel,
        dvBlSignalCompatibilityId: video.dvBlSignalCompatibilityId,
        codecName: video.codecName!,
        formatName,
        formatLongName,
        pixelFormat: video.pixelFormat,
      },
      audio: audio
        ? {
            assetId: asset.id,
            bitrate: audio.bitrate,
            index: audio.index,
            profile: audio.profile,
            codecName: audio.codecName!,
            channels: audio.channels ?? null,
            channelLayout: audio.channelLayout ?? null,
            sampleRate: audio.sampleRate ?? null,
          }
        : undefined,
      lockedPropertiesBehavior: 'override',
    });
    return asset;
  };
  const requested = async (assetId: string, edits: AssetEditActionItem[]) => {
    const repository = setup.ctx.get(AssetEditRepository);
    await repository.replaceAll(assetId, edits);
    return (await repository.getRequestedVideoVersion(assetId))!;
  };
  const render = (id: string, versionId: string) => setup.sut.handleAssetVideoEditGeneration({ id, versionId });
  type Selection = { currentVersionId: string | null; requestedVersionId: string };
  const selection = async (assetId: string) =>
    (
      await sql<Selection>`SELECT "currentVersionId","requestedVersionId"
        FROM public.video_edit_selection WHERE "assetId"=${assetId}::uuid`.execute(db)
    ).rows[0];

  it('keeps real 4K frames and authored geometry despite low-resolution proxy policy', async () => {
    const source = fixture(folder, 3840, 2160, 3);
    const before = digest(source);
    const output = await master(source, [fullCrop(3840, 2160)], '4k');
    const frames = decoded(output);
    expect([frames.width, frames.height, frames.count]).toEqual([3840, 2160, 3]);
    for (const [quadrant, [x, y]] of [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ].entries())
      expectColor(frames.sample(0, x, y), colors[quadrant]);
    expect(frameIds(output)).toEqual([0, 1, 2]);
    expect(digest(source)).toBe(before);
  }, 120_000);

  it('renders portrait crop and clockwise rotation with independently identified quadrants', async () => {
    const source = fixture(folder, 480, 800);
    const output = await master(
      source,
      [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 400, height: 600 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ],
      'portrait',
    );
    const frames = decoded(output);
    expect([frames.width, frames.height, frames.count]).toEqual([600, 400, 6]);
    // Clockwise: bottom-left→top-left; top-left→top-right; bottom-right→bottom-left.
    for (const [index, quadrant] of [2, 0, 3, 1].entries())
      expectColor(frames.sample(0, index % 2 ? 0.75 : 0.25, index >= 2 ? 0.75 : 0.25), colors[quadrant]);
    expect(frameIds(output, 1 / 3, 0.6)).toEqual([0, 1, 2, 3, 4, 5]);
  }, 120_000);

  it('retains irregular source PTS and frame identities, including a global speed edit', async () => {
    const source = fixture(folder, 320, 240, 12, 0, true);
    const authored = [0, 1, 3, 4, 8, 10];
    const sourceTimes = frameTimes(source);
    expect(frameIds(source)).toEqual(authored);
    expect(sourceTimes).toHaveLength(authored.length);
    for (const [index, time] of sourceTimes.entries())
      expect(Math.abs(time - authored[index] / 30)).toBeLessThan(0.00002);
    for (const rate of [1, 2]) {
      const edits: AssetEditActionItem[] = [fullCrop(320, 240)];
      if (rate === 2) {
        edits.push({ action: AssetEditAction.Speed, parameters: { rate: 2 } });
      }
      const output = await master(source, edits, `vfr-${rate}`);
      expect(frameIds(output)).toEqual(authored);
      const times = frameTimes(output);
      expect(times).toHaveLength(authored.length);
      for (const [index, time] of times.entries())
        expect(Math.abs(time - authored[index] / (30 * rate))).toBeLessThan(0.00002);
    }
  }, 120_000);

  it('preserves 5.1 lane identities and untouched packets, including filtered volume', async () => {
    const source = fixture(folder, 320, 240, 36, 1);
    const baseline = channelAmplitudes(source);
    assertChannelIdentity(baseline);
    const sourcePresentation = presentation(source);
    assertAVPresentation(sourcePresentation);
    const unchanged = await master(source, [fullCrop(320, 240)], 'audio-copy');
    expect(audioPackets(unchanged)).toEqual(audioPackets(source));
    expect(pcm(unchanged)).toEqual(pcm(source));
    const unchangedPresentation = presentation(unchanged);
    assertAVPresentation(unchangedPresentation, sourcePresentation);
    expect(Math.abs(unchangedPresentation.audioEnd - sourcePresentation.audioEnd)).toBeLessThanOrEqual(clockTolerance);
    const filtered = await master(
      source,
      [fullCrop(320, 240), { action: AssetEditAction.Audio, parameters: { volume: 0.5 } }],
      'audio-volume',
    );
    const actual = channelAmplitudes(filtered);
    assertChannelIdentity(actual);
    assertAVPresentation(presentation(filtered), sourcePresentation);
    for (const [channel, lane] of actual.entries()) {
      const ratio = lane[channel] / baseline[channel][channel];
      expect(ratio).toBeGreaterThan(0.35);
      expect(ratio).toBeLessThan(0.65);
    }
    // Genuine native negative controls prove this oracle detects swaps, duplication and a missing lane.
    for (const [name, filter] of [
      ['swap', 'pan=5.1|FL=FR|FR=FL|FC=FC|LFE=LFE|BL=BL|BR=BR'],
      ['duplicate', 'pan=5.1|FL=FL|FR=FL|FC=FC|LFE=LFE|BL=BL|BR=BR'],
      ['mute', 'pan=5.1|FL=FL|FR=FR|FC=0*FC|LFE=LFE|BL=BL|BR=BR'],
    ]) {
      const bad = join(folder, `${name}.m4a`);
      ffmpeg('-i', source, '-vn', '-af', filter, '-c:a', 'aac', bad);
      expect(() => assertChannelIdentity(channelAmplitudes(bad))).toThrow();
    }
    // Stream copy only: unchanged audio payloads must not hide a 250 ms A/V delay.
    const shifted = join(folder, 'timestamp-only-audio-shift.mp4');
    ffmpeg(
      '-copyts',
      '-i',
      unchanged,
      '-itsoffset',
      '0.25',
      '-i',
      unchanged,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      '-avoid_negative_ts',
      'disabled',
      '-video_track_timescale',
      '90000',
      shifted,
    );
    expect(audioPackets(shifted)).toEqual(audioPackets(unchanged));
    expect(frameTimes(shifted)).toEqual(frameTimes(unchanged));
    const shiftedPresentation = presentation(shifted);
    expect(shiftedPresentation.audioStart - unchangedPresentation.audioStart).toBeGreaterThan(0.2);
    expect(() => assertAVPresentation(shiftedPresentation, sourcePresentation)).toThrow();
  }, 120_000);

  it('publishes repeated original-derived masters through the real version transaction', async () => {
    const source = fixture(folder, 320, 240, 36, 1);
    const before = digest(source);
    const asset = await seed(source);
    const media = setup.ctx.get(MediaRepository);
    const transcode = media.transcode.bind(media);
    const masterInputs: string[] = [];
    vi.spyOn(media, 'transcode').mockImplementation(async (input, output, command) => {
      if (typeof output === 'string' && output.endsWith('.master.mp4')) {
        masterInputs.push(input);
      }
      await transcode(input, output, command);
    });
    const first = await requested(asset.id, [
      fullCrop(320, 240),
      { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
    ]);
    expect(await render(asset.id, first.id)).toBe(JobStatus.Success);
    const retained = (await setup.ctx.get(AssetEditRepository).getVideoVersion(asset.id, first.id))!;
    const firstHash = digest(retained.masterPath!);
    const second = await requested(asset.id, [
      fullCrop(320, 240),
      { action: AssetEditAction.Rotate, parameters: { angle: 180 } },
    ]);
    expect(await render(asset.id, second.id)).toBe(JobStatus.Success);
    const latest = (await setup.ctx.get(AssetEditRepository).getVideoVersion(asset.id, second.id))!;
    expect(masterInputs).toEqual([source, source]);
    expect(latest.masterPath).not.toBe(retained.masterPath);
    expect((await selection(asset.id)).currentVersionId).toBe(second.id);
    const frames = decoded(latest.masterPath!);
    expect([frames.width, frames.height, frames.count]).toEqual([320, 240, 36]);
    const times = frameTimes(latest.masterPath!);
    expect(times).toHaveLength(36);
    for (const [index, time] of times.entries()) expect(Math.abs(time - index / 30)).toBeLessThan(0.00002);
    for (const [index, quadrant] of [3, 2, 1, 0].entries())
      expectColor(frames.sample(0, index % 2 ? 0.75 : 0.25, index >= 2 ? 0.75 : 0.25), colors[quadrant]);
    assertChannelIdentity(channelAmplitudes(latest.masterPath!));
    expect(digest(retained.masterPath!)).toBe(firstHash);
    expect(digest(source)).toBe(before);
    const history = await setup.ctx.get(AssetEditRepository).listVideoVersions(asset.id, asset.ownerId);
    expect(history.filter((version) => version.status === 'ready')).toHaveLength(2);
  }, 120_000);

  it('refuses an obsolete in-flight render before changing the current real master', async () => {
    const source = fixture(folder, 320, 240, 6);
    const asset = await seed(source);
    const originalHash = digest(source);
    const initial = await requested(asset.id, [fullCrop(320, 240)]);
    expect(await render(asset.id, initial.id)).toBe(JobStatus.Success);
    const current = (await setup.ctx.get(AssetEditRepository).getVideoVersion(asset.id, initial.id))!;
    const currentHash = digest(current.masterPath!);
    const old = await requested(asset.id, [
      fullCrop(320, 240),
      { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
    ]);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const media = setup.ctx.get(MediaRepository);
    const transcode = media.transcode.bind(media);
    const candidates: string[] = [];
    vi.spyOn(media, 'transcode').mockImplementation(async (input, output, command) => {
      await transcode(input, output, command);
      if (typeof output === 'string' && output.includes(old.id)) {
        candidates.push(output);
        if (output.endsWith('.master.mp4')) {
          started.resolve();
          await release.promise;
        }
      }
    });
    const obsolete = render(asset.id, old.id);
    try {
      await Promise.race([
        started.promise,
        obsolete.then(() => {
          throw new Error('Render ended before the native barrier');
        }),
      ]);
      const newer = await requested(asset.id, [
        fullCrop(320, 240),
        { action: AssetEditAction.Rotate, parameters: { angle: 180 } },
      ]);
      release.resolve();
      expect(await obsolete).toBe(JobStatus.Skipped);
      expect((await selection(asset.id)).currentVersionId).toBe(initial.id);
      expect((await selection(asset.id)).requestedVersionId).toBe(newer.id);
      expect(digest(current.masterPath!)).toBe(currentHash);
      expect(candidates.length).toBeGreaterThan(1);
      for (const candidate of candidates) expect(existsSync(candidate)).toBe(false);
      expect(digest(source)).toBe(originalHash);
      expect(await render(asset.id, newer.id)).toBe(JobStatus.Success);
      expect((await selection(asset.id)).currentVersionId).toBe(newer.id);
    } finally {
      release.resolve();
      await obsolete;
    }
  }, 120_000);

  it('refuses a real downmixed candidate before replacing a valid version', async () => {
    const source = fixture(folder, 320, 240, 36, 1);
    const before = digest(source);
    const asset = await seed(source);
    const initial = await requested(asset.id, [fullCrop(320, 240)]);
    expect(await render(asset.id, initial.id)).toBe(JobStatus.Success);
    const current = (await setup.ctx.get(AssetEditRepository).getVideoVersion(asset.id, initial.id))!;
    const currentHash = digest(current.masterPath!);
    const failed = await requested(asset.id, [
      fullCrop(320, 240),
      { action: AssetEditAction.Audio, parameters: { volume: 0.5 } },
    ]);
    const media = setup.ctx.get(MediaRepository);
    const transcode = media.transcode.bind(media);
    let candidate = '';
    let nativeCompleted = false;
    let actualProbeChannels = 0;
    const probe = media.probe.bind(media);
    vi.spyOn(media, 'probe').mockImplementation(async (...args) => {
      const result = await probe(...args);
      if (args[0] === candidate) {
        actualProbeChannels = result.audioStreams[0].channels!;
      }
      return result;
    });
    vi.spyOn(media, 'transcode').mockImplementation(async (input, output, command) => {
      await transcode(input, output, command); // First execute the real production command.
      if (typeof output === 'string' && output.includes(failed.id) && output.endsWith('.master.mp4')) {
        candidate = output;
        nativeCompleted = true;
        const downmixed = join(folder, 'injected-native-downmix.mp4');
        ffmpeg('-i', output, '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', downmixed);
        // Only this unpublished candidate is changed, before the real production probe runs.
        writeFileSync(output, readFileSync(downmixed));
      }
    });
    expect(await render(asset.id, failed.id)).toBe(JobStatus.Failed);
    expect(nativeCompleted).toBe(true);
    expect(actualProbeChannels).toBe(2);
    expect((await selection(asset.id)).currentVersionId).toBe(initial.id);
    expect((await setup.ctx.get(AssetEditRepository).getVideoVersion(asset.id, failed.id))!.status).toBe('failed');
    expect(existsSync(candidate)).toBe(false);
    expect(digest(current.masterPath!)).toBe(currentHash);
    expect(digest(source)).toBe(before);
  }, 120_000);

  it.each(['silent', 'muted', 'irregular', 'reordered-nonzero'] as const)(
    'publishes a measured complete %s clip with its independently decoded frames and clock',
    async (mode) => {
      let source = fixture(folder, 320, 240, 12, mode === 'muted' ? 1 : 0, mode === 'irregular');
      if (mode === 'reordered-nonzero') {
        const reordered = join(folder, 'nonzero-bframes.mp4');
        ffmpeg(
          '-i',
          source,
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '10',
          '-bf',
          '2',
          '-video_track_timescale',
          '90000',
          '-output_ts_offset',
          '5',
          reordered,
        );
        source = reordered;
        const observed = inspect<{ packets: Array<{ pts: number }> }>(
          source,
          '-select_streams',
          'v:0',
          '-show_packets',
          '-show_entries',
          'packet=pts',
        ).packets.map((packet) => packet.pts);
        expect(Math.min(...observed)).toBeGreaterThan(0);
        expect(observed.some((pts, index) => index > 0 && pts < observed[index - 1])).toBe(true);
      }
      const before = digest(source);
      const sourceIds = frameIds(source);
      const sourceClock = frameTimes(source);
      const asset = await seed(source);
      const edits: AssetEditActionItem[] = [fullCrop(320, 240)];
      if (mode === 'muted') {
        edits.push({ action: AssetEditAction.Audio, parameters: { muted: true } });
      }
      const version = await requested(asset.id, edits);
      expect(await render(asset.id, version.id)).toBe(JobStatus.Success);
      const current = (await setup.ctx.get(AssetEditRepository).getVideoVersion(asset.id, version.id))!;
      expect((await selection(asset.id)).currentVersionId).toBe(version.id);
      expect(frameIds(current.masterPath!)).toEqual(sourceIds);
      const actualClock = frameTimes(current.masterPath!);
      expect(actualClock).toHaveLength(sourceClock.length);
      for (const [index, pts] of actualClock.entries()) {
        // Independent decoded PTS oracle at the fixture's measured 90 kHz clock.
        expect(Math.abs(pts - actualClock[0] - (sourceClock[index] - sourceClock[0]))).toBeLessThanOrEqual(2 / 90_000);
      }
      expect(inspect(current.masterPath!, '-select_streams', 'a', '-show_streams').streams).toHaveLength(0);
      expect(digest(source)).toBe(before);
    },
    120_000,
  );

  it.each(['silent', 'muted'] as const)(
    'refuses a genuinely truncated unpublished %s clip and retains the current master',
    async (mode) => {
      const source = fixture(folder, 320, 240, 36, mode === 'muted' ? 1 : 0);
      const before = digest(source);
      const asset = await seed(source);
      const edits: AssetEditActionItem[] = [fullCrop(320, 240)];
      if (mode === 'muted') {
        edits.push({ action: AssetEditAction.Audio, parameters: { muted: true } });
      }
      const initial = await requested(asset.id, edits);
      expect(await render(asset.id, initial.id)).toBe(JobStatus.Success);
      const current = (await setup.ctx.get(AssetEditRepository).getVideoVersion(asset.id, initial.id))!;
      const currentHash = digest(current.masterPath!);
      const failed = await requested(asset.id, [
        ...edits,
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);
      expect(failed.id).not.toBe(initial.id);
      const media = setup.ctx.get(MediaRepository);
      const transcode = media.transcode.bind(media);
      let candidate = '';
      let decodedCandidateCount = 0;
      vi.spyOn(media, 'transcode').mockImplementation(async (input, output, command) => {
        await transcode(input, output, command);
        if (typeof output === 'string' && output.includes(failed.id) && output.endsWith('.master.mp4')) {
          candidate = output;
          const truncated = join(folder, 'injected-native-truncation.mp4');
          ffmpeg('-i', output, '-map', '0:v:0', '-an', '-c:v', 'copy', '-frames:v', '18', truncated);
          writeFileSync(output, readFileSync(truncated));
          decodedCandidateCount = frameTimes(output).length;
        }
      });
      expect(await render(asset.id, failed.id)).toBe(JobStatus.Failed);
      expect(candidate).not.toBe('');
      expect(decodedCandidateCount).toBeGreaterThan(0);
      expect(decodedCandidateCount).toBeLessThan(frameTimes(source).length);
      expect((await selection(asset.id)).currentVersionId).toBe(initial.id);
      expect((await setup.ctx.get(AssetEditRepository).getVideoVersion(asset.id, failed.id))!.status).toBe('failed');
      expect(existsSync(candidate)).toBe(false);
      expect(existsSync(`${candidate}.lineage.json`)).toBe(false);
      expect(existsSync(candidate.replace('.master.mp4', '.proxy.mp4'))).toBe(false);
      expect(digest(current.masterPath!)).toBe(currentHash);
      expect(digest(source)).toBe(before);
    },
    120_000,
  );

  it('refuses a genuine multiple-audio-track original before any transcode or publication', async () => {
    const source = fixture(folder, 320, 240, 36, 2);
    expect(inspect(source, '-select_streams', 'a', '-show_streams').streams).toHaveLength(2);
    const before = digest(source);
    const asset = await seed(source);
    const version = await requested(asset.id, [fullCrop(320, 240)]);
    const transcode = vi.spyOn(setup.ctx.get(MediaRepository), 'transcode');
    expect(await render(asset.id, version.id)).toBe(JobStatus.Failed);
    expect(transcode).not.toHaveBeenCalled();
    expect((await selection(asset.id)).currentVersionId).toBeNull();
    expect((await setup.ctx.get(AssetEditRepository).getVideoVersion(asset.id, version.id))!.status).toBe('failed');
    expect(digest(source)).toBe(before);
  }, 120_000);
});
