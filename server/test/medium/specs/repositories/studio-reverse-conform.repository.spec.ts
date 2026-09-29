import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ColorMatrix, ColorPrimaries, ColorTransfer } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StudioReverseConformRepository } from 'src/repositories/studio-reverse-conform.repository.js';
import {
  checkStudioReverseOutput,
  checkStudioReversePreview,
  checkStudioReverseSource,
} from 'src/utils/studio-reverse-conform.js';

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
    const metadata = join(folder, 'chapters.ffmeta');
    await writeFile(metadata, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=333\ntitle=Forward opening\n');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=32x32:rate=3:duration=1',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=0.1*sin(2*PI*100*t)|0.2*sin(2*PI*200*t):s=48000:d=1',
      '-f',
      'ffmetadata',
      '-i',
      metadata,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-map_chapters',
      '2',
      // Encoder flags alone do not stamp the lavfi frames' primaries/transfer into FFV1.
      '-vf',
      'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-c:v',
      'ffv1',
      '-level',
      '3',
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
    const info = await media.probe(input);
    expect(info.videoStreams[0]).toMatchObject({
      colorPrimaries: ColorPrimaries.Bt709,
      colorTransfer: ColorTransfer.Bt709,
      colorMatrix: ColorMatrix.Bt709,
      colorRange: 'tv',
    });
    const source = checkStudioReverseSource(
      info,
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

    const masterChecksum = createHash('sha256')
      .update(await readFile(output))
      .digest('hex');
    const preview = join(folder, 'preview.mp4');
    await renderer.preview(output, preview, source, new AbortController().signal, () => {});
    checkStudioReversePreview(
      source,
      await media.probe(preview, { countFrames: true }),
      await renderer.probeGeometry(preview, 0),
      await renderer.previewPackets(preview, new AbortController().signal),
    );
    expect(
      createHash('sha256')
        .update(await readFile(output))
        .digest('hex'),
    ).toBe(masterChecksum);
    // Forward chapter timestamps must not label a different picture in either reversed output.
    // Probe the original too, so an absent fixture chapter cannot make this regression pass.
    for (const path of [input, output, preview]) {
      const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', path]);
      const { chapters } = JSON.parse(stdout);
      if (path === input) {
        expect(chapters).toEqual([
          expect.objectContaining({ start_time: '0.000000', end_time: '0.333000', tags: { title: 'Forward opening' } }),
        ]);
      } else {
        expect(chapters).toEqual([]);
      }
    }
    // Compression may change pixels, but each decoded preview frame must still match its reversed master frame.
    const videoPreview = (
      await ffmpeg(['-i', preview, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'])
    ).stdout;
    expect(videoPreview.length).toBe(videoOut.length);
    for (let frame = 0; frame < source.frames; frame++) {
      let error = 0;
      for (let index = frame * frameBytes; index < (frame + 1) * frameBytes; index++) {
        error += Math.abs(videoPreview[index] - videoOut[index]);
      }
      expect(error / frameBytes).toBeLessThan(5);
    }
    const audioPreview = (await ffmpeg(['-i', preview, '-map', '0:a:0', '-f', 'f32le', 'pipe:1'])).stdout;
    // Raw AAC decoding may expose up to one padding packet; MP4 duration/edit-list checks above
    // bound the presented interval. Priming must be removed and both channels remain aligned.
    expect(audioPreview.length).toBeGreaterThanOrEqual(audioOut.length);
    expect(audioPreview.length - audioOut.length).toBeLessThanOrEqual(1024 * 2 * 4);
    for (let channel = 0; channel < 2; channel++) {
      let error = 0;
      for (let offset = channel * 4; offset < audioOut.length; offset += 8) {
        error += (audioPreview.readFloatLE(offset) - audioOut.readFloatLE(offset)) ** 2;
      }
      expect(Math.sqrt(error / (audioOut.length / 8))).toBeLessThan(0.02);
    }
  });

  it('keeps exact NTSC packet cadence in a silent preview without duplicating or dropping frames', async () => {
    const master = join(folder, 'ntsc.mkv');
    const preview = join(folder, 'ntsc.mp4');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=32x32:rate=30000/1001:duration=1.001',
      '-vf',
      'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-c:v',
      'ffv1',
      '-level',
      '3',
      master,
    ]);
    const media = new MediaRepository(LoggingRepository.create());
    const renderer = new StudioReverseConformRepository();
    const source = {
      width: 32,
      height: 32,
      frames: 30,
      frameRate: { num: 30_000, den: 1001 },
      duration: 1.001,
      videoIndex: 0,
      audioIndex: null,
      channels: null,
      sampleRate: null,
    };
    await renderer.preview(master, preview, source, new AbortController().signal, () => {});
    const info = await media.probe(preview, { countFrames: true });
    expect(info.audioStreams).toHaveLength(0);
    checkStudioReversePreview(
      source,
      info,
      await renderer.probeGeometry(preview, 0),
      await renderer.previewPackets(preview, new AbortController().signal),
    );
    const pictures = (await ffmpeg(['-i', preview, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']))
      .stdout;
    expect(pictures.length).toBe((30 * 32 * 32 * 3) / 2);
  });

  it('refuses anamorphic coded pixels hidden behind a display width inside the limit', async () => {
    const input = join(folder, 'anamorphic.mkv');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x32:rate=3:duration=1',
      '-vf',
      'setsar=1/2,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-c:v',
      'ffv1',
      '-level',
      '3',
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
