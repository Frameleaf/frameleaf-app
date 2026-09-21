import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { TranscodeTarget } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { BaseConfig } from 'src/utils/media.js';
import { getVideoRotationCopyPlan, validateVideoMaster } from 'src/utils/video-edit.js';
import { automock } from 'test/utils.js';

const run = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const packets = (path: string) =>
  JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_packets',
        '-show_data_hash',
        'sha256',
        '-show_entries',
        'packet=stream_index,pts_time,dts_time,duration_time,data_hash',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' },
    ),
  ).packets;
const frameHash = (path: string, filter?: string) =>
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, ...(filter ? ['-vf', filter] : []), '-an', '-f', 'hash', '-hash', 'sha256', '-'],
    { encoding: 'utf8' },
  ).trim();

// Explicit opt-in: media qualification requires real FFmpeg/ffprobe with libx264 and AAC.
describe.skipIf(process.env.FRAMELEAF_FFMPEG_QUALIFY !== '1')('metadata rotation real media', () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fl39-metadata-rotation-'));
  });
  // eslint-disable-next-line no-sparse-arrays
  const media = new MediaRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('preserves 4K video/audio packets and displayed pixels for repeated original-derived rotations', async () => {
    const source = join(directory, '4k.mp4');
    run([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=3840x2160:r=4:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=997:duration=1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      source,
    ]);
    const original = await media.probe(source);
    expect(original.videoStreams[0].hasDisplayMatrix).toBe(false);
    for (const [angle, filter] of [
      [90, 'transpose=1'],
      [180, 'transpose=1,transpose=1'],
      [270, 'transpose=2'],
      [90, 'transpose=1'],
    ] as const) {
      const plan = getVideoRotationCopyPlan([{ action: AssetEditAction.Rotate, parameters: { angle } }], original)!;
      const master = join(directory, `master-${angle}.mp4`);
      await media.transcode(source, master, plan.command);
      const rendered = await media.probe(master);
      const dimensions = angle === 180 ? { width: 3840, height: 2160 } : { width: 2160, height: 3840 };
      validateVideoMaster(original.videoStreams[0], rendered.videoStreams[0], dimensions, plan.rotation);
      expect(packets(master)).toEqual(packets(source));
      expect(frameHash(master)).toBe(frameHash(source, filter));
      // Playback policy remains free to bake rotation and downscale the independent proxy.
      const proxy = join(directory, `proxy-${angle}.mp4`);
      const command = BaseConfig.create(
        { ...defaults.ffmpeg, targetResolution: '480' },
        { dri: [], mali: false },
      ).getCommand(TranscodeTarget.All, rendered.videoStreams[0], rendered.audioStreams[0], rendered.format);
      await media.transcode(master, proxy, command);
      const playback = await media.probe(proxy);
      const preview = playback.videoStreams[0];
      expect(preview.rotation).toBe(0);
      expect(Math.min(preview.width, preview.height)).toBe(480);
      expect(preview.width > preview.height).toBe(dimensions.width > dimensions.height);
    }
  }, 60_000);

  it('copies already-baked portrait sources but leaves inherited display matrices to baked rendering', async () => {
    const portrait = join(directory, 'portrait.mp4');
    run(['-f', 'lavfi', '-i', 'testsrc2=s=300x200:r=5:d=1', '-vf', 'transpose=1', '-c:v', 'libx264', portrait]);
    const original = await media.probe(portrait);
    const plan = getVideoRotationCopyPlan([{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }], original)!;
    const master = join(directory, 'portrait-master.mp4');
    await media.transcode(portrait, master, plan.command);
    const rendered = await media.probe(master);
    validateVideoMaster(original.videoStreams[0], rendered.videoStreams[0], { width: 300, height: 200 }, -90);
    expect(packets(master)).toEqual(packets(portrait));
    expect(frameHash(master)).toBe(frameHash(portrait, 'transpose=1'));
    expect(
      getVideoRotationCopyPlan([{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }], rendered),
    ).toBeUndefined();
  });
});
