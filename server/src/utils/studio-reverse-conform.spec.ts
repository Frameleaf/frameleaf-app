import { ColorPrimaries, ColorTransfer } from 'src/enum.js';
import { checkStudioReverseOutput, checkStudioReverseSource } from 'src/utils/studio-reverse-conform.js';
import { reversePackets, reverseVideoInfo } from 'test/fixtures/studio-reverse-conform.stub.js';

describe('local source reversal contract', () => {
  it.each([
    { width: 1920, height: 32, sampleAspectRatio: '1:2' },
    { width: 32, height: 32, sampleAspectRatio: '2:1' },
    { width: 32, height: 32, sampleAspectRatio: undefined },
    { width: 32, height: 1080, sampleAspectRatio: '1:1' },
  ])('refuses unsafe or unknown coded geometry %j', (geometry) => {
    expect(() => checkStudioReverseSource(reverseVideoInfo(), reversePackets(), geometry)).toThrow('square-pixel');
  });

  it('retains the exact source cadence and checks the actual output frame count', () => {
    const source = checkStudioReverseSource(reverseVideoInfo(), reversePackets(), {
      width: 32,
      height: 32,
      sampleAspectRatio: '1:1',
    });
    expect(source.frameRate).toEqual({ num: 3, den: 1 });
    expect(() => checkStudioReverseOutput(source, reverseVideoInfo())).not.toThrow();
    const partial = reverseVideoInfo();
    partial.videoStreams[0].frameCount = 2;
    expect(() => checkStudioReverseOutput(source, partial)).toThrow('output does not match');
  });

  it.each(['primaries', 'transfer'])('continues to refuse unknown input color %s', (field) => {
    const info = reverseVideoInfo();
    if (field === 'primaries') {
      info.videoStreams[0].colorPrimaries = ColorPrimaries.Unknown;
    } else {
      info.videoStreams[0].colorTransfer = ColorTransfer.Unknown;
    }
    expect(() =>
      checkStudioReverseSource(info, reversePackets(), {
        width: 32,
        height: 32,
        sampleAspectRatio: '1:1',
      }),
    ).toThrow('Local source reversal currently requires');
  });
  it.each(['vfr', 'packet-gaps', 'hdr', 'too-long', 'rotated', 'unaligned-audio', 'unknown-origin'])(
    'refuses %s instead of silently changing the source',
    (caseName) => {
      const info = reverseVideoInfo();
      const packets = reversePackets();
      if (caseName === 'vfr') {
        packets.variableFrameRate = true;
      } else if (caseName === 'packet-gaps') {
        packets.outputFrames = 4;
      } else if (caseName === 'hdr') {
        info.videoStreams[0].colorTransfer = ColorTransfer.Smpte2084;
      } else if (caseName === 'too-long') {
        info.format.duration = 11;
      } else if (caseName === 'rotated') {
        info.videoStreams[0].rotation = 90;
      } else if (caseName === 'unknown-origin') {
        info.videoStreams[0].startTime = null;
      } else if (caseName === 'unaligned-audio') {
        info.audioStreams = [
          {
            index: 1,
            codecName: 'pcm_f32le',
            profile: null,
            bitrate: 1000,
            channels: 2,
            sampleRate: 48_000,
            duration: 1,
            startTime: 0.5,
          },
        ];
      }
      expect(() =>
        checkStudioReverseSource(info, packets, {
          width: 32,
          height: 32,
          sampleAspectRatio: '1:1',
        }),
      ).toThrow('Local source reversal currently requires');
    },
  );
});
