import { AacProfile, ColorPrimaries, ColorTransfer } from 'src/enum.js';
import {
  checkStudioReverseOutput,
  checkStudioReversePreview,
  checkStudioReverseSource,
} from 'src/utils/studio-reverse-conform.js';
import {
  reversePackets,
  reversePreviewInfo,
  reversePreviewPackets,
  reverseVideoInfo,
} from 'test/fixtures/studio-reverse-conform.stub.js';

describe('local source reversal contract', () => {
  it.each([
    { width: 1920, height: 32, sampleAspectRatio: '1:2' },
    { width: 32, height: 32, sampleAspectRatio: '2:1' },
    { width: 32, height: 32, sampleAspectRatio: undefined },
    { width: 32, height: 1080, sampleAspectRatio: '1:1' },
  ])('refuses unsafe or unknown coded geometry %j', (geometry) => {
    expect(() => checkStudioReverseSource(reverseVideoInfo(), reversePackets(), geometry)).toThrow('square-pixel');
  });

  it('refuses odd coded dimensions before enqueueing a source that H.264 cannot encode', () => {
    const info = reverseVideoInfo();
    info.videoStreams[0].width = 33;
    expect(() =>
      checkStudioReverseSource(info, reversePackets(), {
        width: 33,
        height: 32,
        sampleAspectRatio: '1:1',
      }),
    ).toThrow('Local source reversal currently requires');
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
      switch (caseName) {
        case 'vfr': {
          packets.variableFrameRate = true;
          break;
        }
        case 'packet-gaps': {
          packets.outputFrames = 4;
          break;
        }
        case 'hdr': {
          info.videoStreams[0].colorTransfer = ColorTransfer.Smpte2084;
          break;
        }
        case 'too-long': {
          info.format.duration = 11;
          break;
        }
        case 'rotated': {
          info.videoStreams[0].rotation = 90;
          break;
        }
        case 'unknown-origin': {
          info.videoStreams[0].startTime = null;
          break;
        }
        case 'unaligned-audio': {
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
          break;
        }
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

describe('reverse browser preview contract', () => {
  const geometry = { width: 32, height: 32, sampleAspectRatio: '1:1' };
  const source = checkStudioReverseSource(reverseVideoInfo(), reversePackets(), geometry);
  it('accepts zero-origin, exact-cadence H.264 MP4 without invented audio', () => {
    expect(() =>
      checkStudioReversePreview(source, reversePreviewInfo(), geometry, reversePreviewPackets()),
    ).not.toThrow();
  });
  it.each([
    'missing-frame',
    'gap',
    'reordered',
    'packet-duration',
    'sar',
    'container',
    'duration',
    'cadence',
    'extra-audio',
    'colour',
  ])('refuses a malformed preview: %s', (failure) => {
    const info = reversePreviewInfo();
    const coded = { ...geometry };
    const packets = reversePreviewPackets();
    switch (failure) {
      case 'missing-frame': {
        packets.pop();
        break;
      }
      case 'gap': {
        packets[1].pts = 2;
        break;
      }
      case 'reordered': {
        packets[1].dts = 0;
        break;
      }
      case 'packet-duration': {
        packets[2].duration = 2;
        break;
      }
      case 'sar': {
        coded.sampleAspectRatio = '2:1';
        break;
      }
      case 'container': {
        info.format.formatName = 'matroska';
        break;
      }
      case 'duration': {
        info.format.duration = 1.1;
        break;
      }
      case 'cadence': {
        info.videoStreams[0].timeBaseRational = { num: 1, den: 4 };
        break;
      }
      case 'extra-audio': {
        info.audioStreams = [{ index: 1, codecName: 'aac', profile: AacProfile.Lc, bitrate: 192_000 }];
        break;
      }
      case 'colour': {
        info.videoStreams[0].colorTransfer = ColorTransfer.Unknown;
        break;
      }
    }
    expect(() => checkStudioReversePreview(source, info, coded, packets)).toThrow('browser media contract');
  });
  it.each(['aligned', 'shifted', 'resampled', 'padded', 'downmixed'])(
    'checks AAC presentation alignment: %s',
    (failure) => {
      const info = reversePreviewInfo();
      info.audioStreams = [
        {
          index: 1,
          codecName: 'aac',
          profile: AacProfile.Lc,
          bitrate: 192_000,
          channels: 2,
          sampleRate: 48_000,
          duration: 1,
          startTime: 0,
        },
      ];
      const audio = info.audioStreams[0];
      switch (failure) {
        case 'shifted': {
          audio.startTime = 0.021;
          break;
        }
        case 'resampled': {
          audio.sampleRate = 44_100;
          break;
        }
        case 'padded': {
          audio.duration = 1.021;
          break;
        }
        case 'downmixed': {
          audio.channels = 1;
          break;
        }
      }
      const check = () =>
        checkStudioReversePreview(
          { ...source, audioIndex: 1, channels: 2, sampleRate: 48_000 },
          info,
          geometry,
          reversePreviewPackets(),
        );
      if (failure === 'aligned') {
        expect(check).not.toThrow();
      } else {
        expect(check).toThrow('browser media contract');
      }
    },
  );
});
