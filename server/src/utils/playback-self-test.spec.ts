import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaults } from 'src/dtos/config.dto.js';
import {
  ColorTransfer,
  DvProfile,
  DvSignalCompatibility,
  TranscodeHardwareAcceleration,
  VideoCodec,
} from 'src/enum.js';
import {
  PLAYBACK_SELF_TEST_CASES,
  PLAYBACK_SELF_TEST_FOLDER,
  judgePlaybackCopy,
  playbackSelfTestCaseOf,
  playbackSettingsChanged,
  readPlaybackSelfTestManifest,
  withSoftwareFallback,
} from 'src/utils/playback-self-test.js';

const sdr = { codecName: 'h264', colorTransfer: ColorTransfer.Bt709, dvProfile: null, dvBlSignalCompatibilityId: null };

describe('playback self-test', () => {
  describe('reference clips', () => {
    const manifest = readPlaybackSelfTestManifest();

    it('has one small clip for every kind, in order', () => {
      expect(manifest.cases.map((clip) => clip.id)).toEqual([...PLAYBACK_SELF_TEST_CASES]);
      for (const clip of manifest.cases) {
        const path = join(PLAYBACK_SELF_TEST_FOLDER, clip.file);
        expect(existsSync(path)).toBe(true);
        expect(statSync(path).size).toBe(clip.bytes);
        expect(clip.bytes).toBeLessThan(100_000);
      }
    });

    it('records the tags that make each kind', () => {
      const source = Object.fromEntries(manifest.cases.map((clip) => [clip.id, clip.source]));
      expect(source['sdr-h264']).toEqual(expect.objectContaining({ codecTag: 'avc1', colorTransfer: 'bt709' }));
      expect(source['hlg-hevc']).toEqual(expect.objectContaining({ codecTag: 'hvc1', colorTransfer: 'arib-std-b67' }));
      expect(source['dolby-vision-8.4']).toEqual(
        expect.objectContaining({ colorTransfer: 'arib-std-b67', dvProfile: 8, dvBlSignalCompatibilityId: 4 }),
      );
      expect(source['hdr10-pq']).toEqual(expect.objectContaining({ codecTag: 'hvc1', colorTransfer: 'smpte2084' }));
      expect(source['hev1-hevc']).toEqual(expect.objectContaining({ codecTag: 'hev1', codecName: 'hevc' }));
    });
  });

  describe(playbackSelfTestCaseOf.name, () => {
    it('names the reference clip a video is like', () => {
      expect(playbackSelfTestCaseOf(sdr)).toBe('sdr-h264');
      expect(playbackSelfTestCaseOf({ ...sdr, codecName: 'vp9' })).toBe('sdr-h264');
      expect(playbackSelfTestCaseOf({ ...sdr, codecName: 'hevc' })).toBe('hev1-hevc');
      expect(playbackSelfTestCaseOf({ ...sdr, codecName: 'hevc', colorTransfer: ColorTransfer.AribStdB67 })).toBe(
        'hlg-hevc',
      );
      expect(playbackSelfTestCaseOf({ ...sdr, colorTransfer: ColorTransfer.Smpte2084 })).toBe('hdr10-pq');
      expect(
        playbackSelfTestCaseOf({
          codecName: 'hevc',
          colorTransfer: ColorTransfer.AribStdB67,
          dvProfile: DvProfile.Dvhe08,
          dvBlSignalCompatibilityId: DvSignalCompatibility.Hlg,
        }),
      ).toBe('dolby-vision-8.4');
      // Dolby Vision 8.1 is HDR10 underneath
      expect(
        playbackSelfTestCaseOf({
          codecName: 'hevc',
          colorTransfer: ColorTransfer.Smpte2084,
          dvProfile: DvProfile.Dvhe08,
          dvBlSignalCompatibilityId: DvSignalCompatibility.Hdr10,
        }),
      ).toBe('hdr10-pq');
    });
  });

  describe(withSoftwareFallback.name, () => {
    const nvenc = { ...defaults.ffmpeg, accel: TranscodeHardwareAcceleration.Nvenc, accelDecode: true };

    it('converts a listed kind on the processor', () => {
      const hdr10 = { ...sdr, colorTransfer: ColorTransfer.Smpte2084 };
      const result = withSoftwareFallback({ ...nvenc, softwareFallback: ['hdr10-pq'] }, hdr10);
      expect(result.fallback).toBe('hdr10-pq');
      expect(result.ffmpeg).toEqual(
        expect.objectContaining({ accel: TranscodeHardwareAcceleration.Disabled, accelDecode: false }),
      );
    });

    it('leaves every other kind on the card', () => {
      const result = withSoftwareFallback({ ...nvenc, softwareFallback: ['hdr10-pq'] }, sdr);
      expect(result).toEqual({
        ffmpeg: expect.objectContaining({ accel: TranscodeHardwareAcceleration.Nvenc }),
        fallback: null,
      });
    });

    it('has nothing to do without a card', () => {
      const config = { ...defaults.ffmpeg, softwareFallback: ['sdr-h264' as const] };
      expect(withSoftwareFallback(config, sdr)).toEqual({ ffmpeg: config, fallback: null });
    });
  });

  it('runs again only for the settings that change how a card converts', () => {
    const ffmpeg = defaults.ffmpeg;
    expect(playbackSettingsChanged(ffmpeg, { ...ffmpeg, accel: TranscodeHardwareAcceleration.Qsv })).toBe(true);
    expect(playbackSettingsChanged(ffmpeg, { ...ffmpeg, preferredHwDevice: '/dev/dri/renderD129' })).toBe(true);
    expect(playbackSettingsChanged(ffmpeg, { ...ffmpeg, targetVideoCodec: VideoCodec.Hevc })).toBe(true);
    expect(playbackSettingsChanged(ffmpeg, { ...ffmpeg, crf: 30 })).toBe(false);
    expect(playbackSettingsChanged(ffmpeg, { ...ffmpeg, softwareFallback: ['hdr10-pq'] })).toBe(false);
  });

  describe(judgePlaybackCopy.name, () => {
    const manifest = readPlaybackSelfTestManifest();
    const clip = (id: string) => manifest.cases.find((item) => item.id === id)!;
    const options = { targetVideoCodec: VideoCodec.H264, toneMapped: true, lumaTolerance: 12, referenceTolerance: 20 };
    const good = { codecName: 'h264', codecTag: 'avc1', colorPrimaries: 'bt709', colorTransfer: 'bt709' };

    it('passes a copy that came out right', () => {
      expect(judgePlaybackCopy(clip('hdr10-pq'), { ...good, meanLuma: 110 }, options)).toEqual([]);
      expect(
        judgePlaybackCopy(clip('sdr-h264'), { ...good, meanLuma: clip('sdr-h264').sourceMeanLuma }, options),
      ).toEqual([]);
    });

    it('finds dark HDR, wrong tags and a copy unlike the one made on the processor', () => {
      expect(judgePlaybackCopy(clip('hlg-hevc'), { ...good, meanLuma: 20 }, options)).toEqual(['too-dark']);
      expect(judgePlaybackCopy(clip('hlg-hevc'), { ...good, meanLuma: 240 }, options)).toEqual(['too-bright']);
      expect(
        judgePlaybackCopy(clip('hdr10-pq'), { ...good, colorTransfer: 'smpte2084', meanLuma: 110 }, options),
      ).toEqual(['colour-tags']);
      expect(
        judgePlaybackCopy(
          clip('hdr10-pq'),
          { ...good, meanLuma: 80 },
          {
            ...options,
            reference: { ...good, meanLuma: 130 },
          },
        ),
      ).toEqual(['brightness-differs']);
      expect(
        judgePlaybackCopy(
          clip('hev1-hevc'),
          { ...good, codecName: 'hevc', codecTag: 'hev1', meanLuma: 103 },
          {
            ...options,
            targetVideoCodec: VideoCodec.Hevc,
          },
        ),
      ).toEqual(['codec-tag']);
      expect(judgePlaybackCopy(clip('sdr-h264'), { ...good, codecName: 'hevc', meanLuma: 103 }, options)).toEqual([
        'codec',
      ]);
    });

    it('expects HDR colours and brightness kept when tone mapping is off', () => {
      const hlg = clip('hlg-hevc');
      const kept = { ...good, colorPrimaries: 'bt2020', colorTransfer: 'arib-std-b67', meanLuma: hlg.sourceMeanLuma };
      expect(judgePlaybackCopy(hlg, kept, { ...options, toneMapped: false })).toEqual([]);
      expect(
        judgePlaybackCopy(hlg, { ...good, meanLuma: hlg.sourceMeanLuma }, { ...options, toneMapped: false }),
      ).toEqual(['colour-tags']);
    });
  });
});
