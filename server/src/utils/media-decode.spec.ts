import { describe, expect, it } from 'vitest';
import type { VideoStreamInfo } from 'src/types.js';
import { defaults } from 'src/dtos/config.dto.js';
import {
  ColorMatrix,
  ColorPrimaries,
  ColorTransfer,
  DvProfile,
  DvSignalCompatibility,
  ToneMapping,
  TranscodeHardwareAcceleration,
} from 'src/enum.js';
import {
  ChromaSubsampling,
  DECODE_MATRIX,
  DecodeRefusal,
  DecodeSupport,
  SourceTransferKind,
  assertDecodeQualified,
  classifySourceTransfer,
  describeDolbyVisionInput,
  parseSourcePixelLayout,
  qualifySourceDecode,
  selectDecodeAcceleration,
} from 'src/utils/media-decode.js';
import { MediaPolicyError, MediaPolicyViolation } from 'src/utils/media-policy.js';

const toneMapping = { tonemap: ToneMapping.Hable };
const noToneMapping = { tonemap: ToneMapping.Disabled };

type Probed = Pick<
  VideoStreamInfo,
  'codecName' | 'pixelFormat' | 'colorTransfer' | 'dvProfile' | 'dvBlSignalCompatibilityId' | 'width' | 'height'
>;

const stream = (overrides: Partial<Probed> = {}): Probed => ({
  codecName: 'h264',
  pixelFormat: 'yuv420p',
  colorTransfer: ColorTransfer.Bt709,
  dvProfile: null,
  dvBlSignalCompatibilityId: null,
  width: 1920,
  height: 1080,
  ...overrides,
});

describe('parseSourcePixelLayout', () => {
  it.each([
    ['yuv420p', { bitDepth: 8, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: false }],
    ['yuvj420p', { bitDepth: 8, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: false }],
    ['yuv420p10le', { bitDepth: 10, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: false }],
    ['yuv422p10le', { bitDepth: 10, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: false }],
    ['yuv444p12le', { bitDepth: 12, chroma: ChromaSubsampling.Yuv444, hasAlpha: false, semiPlanar: false }],
    ['yuva444p10le', { bitDepth: 10, chroma: ChromaSubsampling.Yuv444, hasAlpha: true, semiPlanar: false }],
    ['nv12', { bitDepth: 8, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: true }],
    ['p010le', { bitDepth: 10, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: true }],
    ['p216le', { bitDepth: 16, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: true }],
    ['gbrp12le', { bitDepth: 12, chroma: ChromaSubsampling.Rgb, hasAlpha: false, semiPlanar: false }],
    ['gbrap10le', { bitDepth: 10, chroma: ChromaSubsampling.Rgb, hasAlpha: true, semiPlanar: false }],
    ['gray', { bitDepth: 8, chroma: ChromaSubsampling.Monochrome, hasAlpha: false, semiPlanar: false }],
    ['gray10le', { bitDepth: 10, chroma: ChromaSubsampling.Monochrome, hasAlpha: false, semiPlanar: false }],
    ['rgb24', { bitDepth: 8, chroma: ChromaSubsampling.Rgb, hasAlpha: false, semiPlanar: false }],
    ['rgba64le', { bitDepth: 16, chroma: ChromaSubsampling.Rgb, hasAlpha: true, semiPlanar: false }],
  ])('describes %s', (pixelFormat, expected) => {
    expect(parseSourcePixelLayout(pixelFormat)).toEqual({ ...expected, name: pixelFormat });
  });

  it('is case insensitive', () => {
    expect(parseSourcePixelLayout('YUV420P10LE')?.bitDepth).toBe(10);
  });

  it('returns null rather than guessing at an unknown format', () => {
    expect(parseSourcePixelLayout('not-a-pixel-format')).toBeNull();
    expect(parseSourcePixelLayout('')).toBeNull();
    expect(parseSourcePixelLayout(null)).toBeNull();
  });

  it('does not describe the float intermediate as an integer format', () => {
    expect(parseSourcePixelLayout('gbrpf32le')).toBeNull();
  });
});

describe('classifySourceTransfer', () => {
  it('reads PQ as HDR10 and ARIB STD-B67 as HLG', () => {
    expect(classifySourceTransfer(ColorTransfer.Smpte2084)).toBe(SourceTransferKind.Hdr10);
    expect(classifySourceTransfer(ColorTransfer.AribStdB67)).toBe(SourceTransferKind.Hlg);
  });

  it('treats an untagged or Rec. 709 transfer as SDR', () => {
    expect(classifySourceTransfer(ColorTransfer.Unknown)).toBe(SourceTransferKind.Sdr);
    expect(classifySourceTransfer(ColorTransfer.Bt709)).toBe(SourceTransferKind.Sdr);
  });
});

describe('describeDolbyVisionInput', () => {
  it('resolves profile 8 by its base-layer compatibility id', () => {
    expect(describeDolbyVisionInput(DvProfile.Dvhe08, DvSignalCompatibility.Hdr10)).toMatchObject({
      label: 'profile 8.1',
      baseLayer: SourceTransferKind.Hdr10,
      qualified: true,
    });
    expect(describeDolbyVisionInput(DvProfile.Dvhe08, DvSignalCompatibility.Hlg)).toMatchObject({
      label: 'profile 8.4',
      baseLayer: SourceTransferKind.Hlg,
      qualified: true,
    });
    expect(describeDolbyVisionInput(DvProfile.Dvhe08, DvSignalCompatibility.Sdr709)).toMatchObject({
      label: 'profile 8.2',
      baseLayer: SourceTransferKind.Sdr,
      qualified: true,
    });
  });

  it('refuses profile 8 when the base layer is not identified', () => {
    expect(describeDolbyVisionInput(DvProfile.Dvhe08, null)).toMatchObject({
      qualified: false,
      baseLayer: null,
      refusal: DecodeRefusal.DolbyVisionBaseLayerUnknown,
    });
    expect(describeDolbyVisionInput(DvProfile.Dvhe08, DvSignalCompatibility.None)).toMatchObject({
      qualified: false,
      refusal: DecodeRefusal.DolbyVisionBaseLayerUnknown,
    });
  });

  it('never reports profile 5 as having a usable base layer', () => {
    expect(describeDolbyVisionInput(DvProfile.Dvhe05, null)).toEqual({
      label: 'profile 5',
      profile: DvProfile.Dvhe05,
      blSignalCompatibilityId: null,
      baseLayer: null,
      qualified: false,
      refusal: DecodeRefusal.DolbyVisionProfile5,
    });
  });

  it('refuses the dual-layer and unqualified profiles', () => {
    expect(describeDolbyVisionInput(DvProfile.Dvhe07, null).refusal).toBe(DecodeRefusal.DolbyVisionEnhancementLayer);
    for (const profile of [DvProfile.Dvhe03, DvProfile.Dvhe04, DvProfile.Dvav09, DvProfile.Dav110]) {
      expect(describeDolbyVisionInput(profile, null).refusal).toBe(DecodeRefusal.DolbyVisionProfileUnqualified);
    }
  });
});

describe('qualifySourceDecode', () => {
  it('advertises a matrix that covers SDR, HDR10, HLG, ProRes and Dolby profiles 8.1 and 8.4', () => {
    expect(DECODE_MATRIX.map((row) => row.id)).toEqual([
      'sdr-8bit-420',
      'sdr-10bit-420',
      'hdr10-10bit-420',
      'hlg-10bit-420',
      'prores-sdr',
      'prores-hdr',
      'prores-hlg',
      'dolby-vision-8.1',
      'dolby-vision-8.4',
    ]);
  });

  it('supports ordinary 8-bit SDR', () => {
    const result = qualifySourceDecode(stream(), toneMapping);
    expect(result.support).toBe(DecodeSupport.Supported);
    expect(result.matrixEntry).toBe('sdr-8bit-420');
    expect(result.transfer).toBe(SourceTransferKind.Sdr);
    expect(result.minimumIntermediateBitDepth).toBe(8);
  });

  it('supports portrait geometry without a separate row', () => {
    const result = qualifySourceDecode(stream({ width: 1080, height: 1920 }), toneMapping);
    expect(result.support).toBe(DecodeSupport.Supported);
    expect(result.matrixEntry).toBe('sdr-8bit-420');
  });

  it('tone maps HDR10 when tone mapping is enabled, and carries it through when it is not', () => {
    const hdr10 = stream({ codecName: 'hevc', pixelFormat: 'yuv420p10le', colorTransfer: ColorTransfer.Smpte2084 });

    const mapped = qualifySourceDecode(hdr10, toneMapping);
    expect(mapped.support).toBe(DecodeSupport.ToneMapped);
    expect(mapped.matrixEntry).toBe('hdr10-10bit-420');
    expect(mapped.minimumIntermediateBitDepth).toBe(10);

    const carried = qualifySourceDecode(hdr10, noToneMapping);
    expect(carried.support).toBe(DecodeSupport.Supported);
    expect(carried.transfer).toBe(SourceTransferKind.Hdr10);
  });

  it('recognises HLG', () => {
    const result = qualifySourceDecode(
      stream({ codecName: 'hevc', pixelFormat: 'yuv420p10le', colorTransfer: ColorTransfer.AribStdB67 }),
      noToneMapping,
    );
    expect(result.transfer).toBe(SourceTransferKind.Hlg);
    expect(result.matrixEntry).toBe('hlg-10bit-420');
  });

  it('supports 12-bit 4:4:4 ProRes', () => {
    const result = qualifySourceDecode(
      stream({ codecName: 'prores', pixelFormat: 'yuv444p12le', colorTransfer: ColorTransfer.Bt709 }),
      toneMapping,
    );
    expect(result.support).toBe(DecodeSupport.Supported);
    expect(result.matrixEntry).toBe('prores-sdr');
    expect(result.layout).toMatchObject({ bitDepth: 12, chroma: ChromaSubsampling.Yuv444 });
  });

  it('qualifies Dolby Vision profile 8.1 as its HDR10 base layer', () => {
    const result = qualifySourceDecode(
      stream({
        codecName: 'hevc',
        pixelFormat: 'yuv420p10le',
        colorTransfer: ColorTransfer.Smpte2084,
        dvProfile: DvProfile.Dvhe08,
        dvBlSignalCompatibilityId: DvSignalCompatibility.Hdr10,
      }),
      noToneMapping,
    );
    expect(result.support).toBe(DecodeSupport.Supported);
    expect(result.matrixEntry).toBe('dolby-vision-8.1');
    expect(result.transfer).toBe(SourceTransferKind.Hdr10);
    expect(result.reason).toContain('the RPU is not carried');
  });

  it('qualifies Dolby Vision profile 8.4 as its HLG base layer', () => {
    const result = qualifySourceDecode(
      stream({
        codecName: 'hevc',
        pixelFormat: 'yuv420p10le',
        colorTransfer: ColorTransfer.AribStdB67,
        dvProfile: DvProfile.Dvhe08,
        dvBlSignalCompatibilityId: DvSignalCompatibility.Hlg,
      }),
      noToneMapping,
    );
    expect(result.matrixEntry).toBe('dolby-vision-8.4');
    expect(result.transfer).toBe(SourceTransferKind.Hlg);
  });

  it('takes the base-layer compatibility id over the probed transfer for Dolby Vision', () => {
    // A profile 8.1 stream whose transfer tag says HLG: the configuration record is the authority.
    const result = qualifySourceDecode(
      stream({
        codecName: 'hevc',
        pixelFormat: 'yuv420p10le',
        colorTransfer: ColorTransfer.AribStdB67,
        dvProfile: DvProfile.Dvhe08,
        dvBlSignalCompatibilityId: DvSignalCompatibility.Hdr10,
      }),
      noToneMapping,
    );
    expect(result.transfer).toBe(SourceTransferKind.Hdr10);
  });

  it('refuses Dolby Vision profile 5 rather than treating it as HDR10', () => {
    const result = qualifySourceDecode(
      stream({
        codecName: 'hevc',
        pixelFormat: 'yuv420p10le',
        colorTransfer: ColorTransfer.Smpte2084,
        dvProfile: DvProfile.Dvhe05,
        dvBlSignalCompatibilityId: null,
      }),
      noToneMapping,
    );
    expect(result.support).toBe(DecodeSupport.Refused);
    expect(result.refusal).toBe(DecodeRefusal.DolbyVisionProfile5);
    expect(result.matrixEntry).toBeNull();
    expect(result.reason).toContain('IPT-PQ-C2');
  });

  it('refuses Dolby Vision profile 7 and the unqualified profiles', () => {
    expect(qualifySourceDecode(stream({ codecName: 'hevc', dvProfile: DvProfile.Dvhe07 }), noToneMapping).refusal).toBe(
      DecodeRefusal.DolbyVisionEnhancementLayer,
    );
    expect(qualifySourceDecode(stream({ codecName: 'hevc', dvProfile: DvProfile.Dvav09 }), noToneMapping).refusal).toBe(
      DecodeRefusal.DolbyVisionProfileUnqualified,
    );
    expect(qualifySourceDecode(stream({ codecName: 'hevc', dvProfile: DvProfile.Dvhe08 }), noToneMapping).refusal).toBe(
      DecodeRefusal.DolbyVisionBaseLayerUnknown,
    );
  });

  it('refuses an undescribable pixel format', () => {
    const result = qualifySourceDecode(stream({ pixelFormat: 'something-new' }), toneMapping);
    expect(result.support).toBe(DecodeSupport.Refused);
    expect(result.refusal).toBe(DecodeRefusal.UnknownPixelFormat);
  });

  it('refuses more than 12 bits per component', () => {
    const result = qualifySourceDecode(stream({ codecName: 'hevc', pixelFormat: 'p016le' }), toneMapping);
    expect(result.refusal).toBe(DecodeRefusal.UnsupportedBitDepth);
  });

  it('refuses a stream with no usable geometry', () => {
    expect(qualifySourceDecode(stream({ width: 0 }), toneMapping).refusal).toBe(DecodeRefusal.UnusableGeometry);
    expect(qualifySourceDecode(stream({ height: 0 }), toneMapping).refusal).toBe(DecodeRefusal.UnusableGeometry);
  });

  it('decodes an untested combination but says it is untested', () => {
    const result = qualifySourceDecode(stream({ codecName: 'mpeg2video' }), toneMapping);
    expect(result.support).toBe(DecodeSupport.Supported);
    expect(result.matrixEntry).toBeNull();
    expect(result.reason).toContain('outside the advertised tested matrix');
  });
});

describe('assertDecodeQualified', () => {
  it('throws a media policy error for a refused source', () => {
    const refused = qualifySourceDecode(stream({ codecName: 'hevc', dvProfile: DvProfile.Dvhe05 }), defaults.ffmpeg);
    expect(() => assertDecodeQualified(refused)).toThrowError(MediaPolicyError);
    try {
      assertDecodeQualified(refused);
      expect.unreachable();
    } catch (error) {
      expect((error as MediaPolicyError).code).toBe(MediaPolicyViolation.UnsupportedSource);
    }
  });

  it('does nothing for a supported or tone-mapped source', () => {
    expect(() => assertDecodeQualified(qualifySourceDecode(stream(), defaults.ffmpeg))).not.toThrow();
  });
});

describe('selectDecodeAcceleration', () => {
  const vaapi = { ...defaults.ffmpeg, accel: TranscodeHardwareAcceleration.Vaapi, accelDecode: true };

  it('keeps hardware decoding for an 8-bit 4:2:0 source the decoder implements', () => {
    const decision = selectDecodeAcceleration(vaapi, qualifySourceDecode(stream(), vaapi));
    expect(decision.accelDecode).toBe(true);
    expect(decision.config.accelDecode).toBe(true);
    expect(decision.config.accel).toBe(TranscodeHardwareAcceleration.Vaapi);
  });

  it('keeps 10-bit 4:2:0 on the hardware path', () => {
    const hdr = stream({ codecName: 'hevc', pixelFormat: 'yuv420p10le', colorTransfer: ColorTransfer.Smpte2084 });
    expect(selectDecodeAcceleration(vaapi, qualifySourceDecode(hdr, vaapi)).accelDecode).toBe(true);
  });

  it('falls back to software for a codec the fixed-function decoder lacks', () => {
    const prores = stream({ codecName: 'prores', pixelFormat: 'yuv422p10le' });
    const decision = selectDecodeAcceleration(vaapi, qualifySourceDecode(prores, vaapi));
    expect(decision.accelDecode).toBe(false);
    expect(decision.config.accelDecode).toBe(false);
    expect(decision.config.accel).toBe(TranscodeHardwareAcceleration.Vaapi);
    expect(decision.reason).toContain('fixed-function decoder');
  });

  it('falls back to software rather than let a 4:2:2 source be subsampled by the decoder', () => {
    const source = stream({ codecName: 'hevc', pixelFormat: 'yuv422p10le' });
    const decision = selectDecodeAcceleration(vaapi, qualifySourceDecode(source, vaapi));
    expect(decision.accelDecode).toBe(false);
    expect(decision.reason).toContain('4:2:2');
  });

  it('falls back to software above 10 bits and for an alpha plane', () => {
    const twelveBit = stream({ codecName: 'hevc', pixelFormat: 'yuv420p12le' });
    expect(selectDecodeAcceleration(vaapi, qualifySourceDecode(twelveBit, vaapi)).accelDecode).toBe(false);

    const alpha = stream({ codecName: 'vp9', pixelFormat: 'yuva420p' });
    expect(selectDecodeAcceleration(vaapi, qualifySourceDecode(alpha, vaapi)).accelDecode).toBe(false);
  });

  it('falls back to software for a Dolby Vision base layer', () => {
    const dv = stream({
      codecName: 'hevc',
      pixelFormat: 'yuv420p10le',
      colorTransfer: ColorTransfer.Smpte2084,
      dvProfile: DvProfile.Dvhe08,
      dvBlSignalCompatibilityId: DvSignalCompatibility.Hdr10,
    });
    const decision = selectDecodeAcceleration(vaapi, qualifySourceDecode(dv, vaapi));
    expect(decision.accelDecode).toBe(false);
    expect(decision.reason).toContain('profile 8.1');
  });

  it('leaves the configuration alone when hardware decoding is already off', () => {
    const software = { ...defaults.ffmpeg, accel: TranscodeHardwareAcceleration.Disabled, accelDecode: false };
    const decision = selectDecodeAcceleration(software, qualifySourceDecode(stream(), software));
    expect(decision.config).toBe(software);
    expect(decision.accelDecode).toBe(false);
  });

  it('respects the rkmpp decoder list', () => {
    const rkmpp = { ...defaults.ffmpeg, accel: TranscodeHardwareAcceleration.Rkmpp, accelDecode: true };
    const vp8 = stream({ codecName: 'vp8' });
    expect(selectDecodeAcceleration(rkmpp, qualifySourceDecode(vp8, rkmpp)).accelDecode).toBe(false);
    expect(selectDecodeAcceleration(rkmpp, qualifySourceDecode(stream(), rkmpp)).accelDecode).toBe(true);
  });
});

describe('advertised matrix consistency', () => {
  it('only lists primaries-independent rows, so a tagged or untagged Rec. 709 source matches', () => {
    const tagged = qualifySourceDecode(stream({ colorTransfer: ColorTransfer.Bt709 }), toneMapping);
    const untagged = qualifySourceDecode(stream({ colorTransfer: ColorTransfer.Unknown }), toneMapping);
    expect(tagged.matrixEntry).toBe(untagged.matrixEntry);
  });

  it('keeps the colour enums this module reads in the probed shape', () => {
    // A guard against the probe mapping drifting: these are the values media.repository writes.
    expect(ColorPrimaries.Bt2020).toBeDefined();
    expect(ColorMatrix.Bt2020Nc).toBeDefined();
  });
});
