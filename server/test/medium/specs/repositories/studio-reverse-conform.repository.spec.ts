import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StudioReverseConformRepository } from 'src/repositories/studio-reverse-conform.repository.js';
import { checkStudioReverseOutput, checkStudioReverseSource } from 'src/utils/studio-reverse-conform.js';

const execute = promisify(execFile);
const ffmpeg = (args: string[]) =>
  execute('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });

describe('local source reverse executor', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'studio-reverse-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('reverses actual decoded pictures and stereo samples without changing their count or cadence', async () => {
    const input = join(folder, 'input.mkv');
    const output = join(folder, 'output.mkv');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=32x32:rate=3:duration=1',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.1*sin(2*PI*100*t)|0.2*sin(2*PI*200*t):s=48000:d=1',
      '-c:v',
      'ffv1',
      '-c:a',
      'pcm_f32le',
      '-pix_fmt',
      'yuv420p',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-color_range',
      'tv',
      input,
    ]);
    const media = new MediaRepository(LoggingRepository.create());
    const renderer = new StudioReverseConformRepository();
    const source = checkStudioReverseSource(
      await media.probe(input),
      await media.probePackets(input, 0),
      await renderer.probeGeometry(input, 0),
    );
    await renderer.reverse(input, output, source, new AbortController().signal, () => {});
    checkStudioReverseOutput(source, await media.probe(output, { countFrames: true }));
    const videoIn = (await ffmpeg(['-i', input, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']))
      .stdout;
    const videoOut = (await ffmpeg(['-i', output, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']))
      .stdout;
    const frameBytes = (32 * 32 * 3) / 2;
    expect(videoIn.length).toBe(3 * frameBytes);
    expect(videoOut).toEqual(
      Buffer.concat([
        videoIn.subarray(2 * frameBytes),
        videoIn.subarray(frameBytes, 2 * frameBytes),
        videoIn.subarray(0, frameBytes),
      ]),
    );
    const audioIn = (await ffmpeg(['-i', input, '-map', '0:a:0', '-f', 'f32le', 'pipe:1'])).stdout;
    const audioOut = (await ffmpeg(['-i', output, '-map', '0:a:0', '-f', 'f32le', 'pipe:1'])).stdout;
    const reversed = Buffer.alloc(audioIn.length);
    for (let offset = 0; offset < audioIn.length; offset += 8) {
      audioIn.copy(reversed, offset, audioIn.length - offset - 8, audioIn.length - offset);
    }
    expect(audioOut).toEqual(reversed);
  });

  it('refuses anamorphic coded pixels hidden behind a display width inside the limit', async () => {
    const input = join(folder, 'anamorphic.mkv');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x32:rate=3:duration=1',
      '-vf',
      'setsar=1/2',
      '-c:v',
      'ffv1',
      '-pix_fmt',
      'yuv420p',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-color_range',
      'tv',
      input,
    ]);
    const media = new MediaRepository(LoggingRepository.create());
    const info = await media.probe(input);
    const packets = await media.probePackets(input, 0);
    const geometry = await new StudioReverseConformRepository().probeGeometry(input, 0);
    expect(info.videoStreams[0].width).toBe(960);
    expect(geometry).toEqual({ width: 1920, height: 32, sampleAspectRatio: '1:2' });
    expect(() => checkStudioReverseSource(info, packets, geometry)).toThrow('square-pixel');
  });
});
