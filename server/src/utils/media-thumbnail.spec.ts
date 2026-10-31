import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from 'src/dtos/config.dto.js';
import { ColorMatrix, ColorPrimaries, ColorTransfer, TranscodeTarget } from 'src/enum.js';
import { ThumbnailConfig } from 'src/utils/media.js';
import { videoInfoStub } from 'test/fixtures/media.stub.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    if (process.env.CI) {
      throw new Error('ffmpeg and ffprobe are required for thumbnail regression tests on CI');
    }
    return false;
  }
})();

const video = {
  ...videoInfoStub.videoStreamH264.videoStreams[0],
  width: 96,
  height: 54,
  frameCount: 360,
  frameRate: 24,
};
const config = { ...defaults.ffmpeg, targetResolution: '36' };

describe('video thumbnail sampling', () => {
  it('seeks before decoding nonzero samples, even when the frame count is unknown', () => {
    const command = ThumbnailConfig.create(config, 12.5).getCommand(TranscodeTarget.Video, { ...video, frameCount: 0 });
    expect(command.inputOptions).toContain('-ss');
    expect(command.inputOptions[command.inputOptions.indexOf('-ss') + 1]).toBe('12.5');
    expect(command.inputOptions).not.toContain('-skip_frame');
    expect(command.outputOptions.at(-1)).toContain('fps=12:start_time=0:');
  });

  it('keeps keyframe-only decoding for the default sample', () => {
    const command = ThumbnailConfig.create(config).getCommand(TranscodeTarget.Video, video);
    expect(command.inputOptions).toContain('-skip_frame');
    expect(command.inputOptions).not.toContain('-ss');
  });

  it.each([0, 12.5])('keeps MPEG-TS decoding all frames at %s seconds', (timestamp) => {
    const command = ThumbnailConfig.create(config, timestamp).getCommand(TranscodeTarget.Video, video, undefined, {
      ...videoInfoStub.videoStreamH264.format,
      formatName: 'mpegts',
    });
    expect(command.inputOptions).not.toContain('-skip_frame');
  });

  it('preserves reserved color metadata corrections when seeking', () => {
    const command = ThumbnailConfig.create(config, 12.5).getCommand(TranscodeTarget.Video, {
      ...video,
      colorPrimaries: ColorPrimaries.Reserved,
      colorMatrix: ColorMatrix.Reserved,
      colorTransfer: ColorTransfer.Reserved,
    });
    expect(command.inputOptions).toEqual([
      '-ss',
      '12.5',
      '-sws_flags',
      'accurate_rnd+full_chroma_int',
      '-bsf:0',
      'h264_metadata=colour_primaries=1:matrix_coefficients=1:transfer_characteristics=1',
    ]);
  });

  it.skipIf(!hasFfmpeg)('extracts full-range JPEGs after the last keyframe of a multi-GOP clip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frameleaf-thumbnail-'));
    try {
      const input = join(dir, 'source.mp4');
      // 360 frames, keyframes at 0 and 10.417s; both requested samples fall after the last keyframe.
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=red:size=96x54:rate=24:duration=15',
        '-vf',
        "drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,12)'",
        '-c:v',
        'libx264',
        '-g',
        '250',
        '-sc_threshold',
        '0',
        '-pix_fmt',
        'yuv420p',
        input,
      ]);
      for (const timestamp of [12, 12.5]) {
        const output = join(dir, `${timestamp}.jpeg`);
        const command = ThumbnailConfig.create(config, timestamp).getCommand(TranscodeTarget.Video, video);
        execFileSync('ffmpeg', [...command.inputOptions, '-i', input, ...command.outputOptions, output], {
          stdio: 'pipe',
        });
        const probe = JSON.parse(
          execFileSync(
            'ffprobe',
            ['-v', 'error', '-show_entries', 'stream=width,height,color_range,codec_name', '-of', 'json', output],
            { encoding: 'utf8' },
          ),
        );
        expect(probe.streams).toEqual([
          expect.objectContaining({ codec_name: 'mjpeg', width: 64, height: 36, color_range: 'pc' }),
        ]);
        const rgb = execFileSync('ffmpeg', [
          '-v',
          'error',
          '-i',
          output,
          '-vf',
          'scale=1:1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-',
        ]);
        expect(rgb[0]).toBeLessThan(50);
        expect(rgb[2]).toBeGreaterThan(200);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
