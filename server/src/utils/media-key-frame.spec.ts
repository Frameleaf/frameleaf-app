import type { VideoStreamInfo } from 'src/types.js';
import { defaults } from 'src/dtos/config.dto.js';
import { ColorTransfer, ToneMapping } from 'src/enum.js';
import { getKeyframeCommand } from 'src/utils/media.js';

const stream = (overrides: Partial<VideoStreamInfo> = {}) =>
  ({
    index: 1,
    height: 1440,
    width: 1920,
    codecName: 'hevc',
    frameCount: 90,
    isHDR: false,
    bitrate: 0,
    pixelFormat: 'yuv420p',
    rotation: 90,
    colorPrimaries: 1,
    colorTransfer: ColorTransfer.Bt709,
    colorMatrix: 1,
    ...overrides,
  }) as VideoStreamInfo;

describe('getKeyframeCommand (Live and Motion Photo key frames)', () => {
  it('seeks to the key frame and writes one unscaled PNG frame of the video stream', () => {
    const command = getKeyframeCommand(defaults.ffmpeg, stream(), 1234);
    expect(command.inputOptions).toEqual(['-ss', '1.234']);
    expect(command.outputOptions).toEqual([
      '-map',
      '0:1',
      '-map_metadata',
      '-1',
      '-an',
      '-frames:v',
      '1',
      '-update',
      '1',
      '-c:v',
      'png',
    ]);
    expect(command.twoPass).toBe(false);
  });

  it('tone maps an HDR clip like video thumbnails do', () => {
    const command = getKeyframeCommand(
      { ...defaults.ffmpeg, tonemap: ToneMapping.Hable },
      stream({ colorTransfer: ColorTransfer.AribStdB67 }),
      0,
    );
    expect(command.inputOptions).toEqual(['-ss', '0.000']);
    const filter = command.outputOptions.at(-1)!;
    expect(command.outputOptions.at(-2)).toBe('-vf');
    expect(filter).toMatch(/^tonemapx=tonemap=hable/);
  });
});
