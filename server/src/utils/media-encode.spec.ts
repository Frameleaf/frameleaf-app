import { describe, expect, it } from 'vitest';
import { ColorMatrix, TranscodeHardwareAcceleration, VideoCodec } from 'src/enum.js';
import {
  ChromaSubsampling,
  SourcePixelLayout,
  SourceTransferKind,
  parseSourcePixelLayout,
} from 'src/utils/media-decode.js';
import {
  FLOAT_INTERMEDIATE_PIXEL_FORMAT,
  FLOAT_TO_INTEGER_DITHER,
  applyFloatEncodePixelFormat,
  requiresFloatIntermediate,
  selectEncoderPixelFormat,
} from 'src/utils/media-encode.js';
import { EditedMasterColorPolicy, MediaPolicyError, MediaPolicyViolation } from 'src/utils/media-policy.js';

const layout = (pixelFormat: string): SourcePixelLayout => {
  const parsed = parseSourcePixelLayout(pixelFormat);
  if (!parsed) {
    throw new Error(`fixture pixel format ${pixelFormat} is not describable`);
  }
  return parsed;
};

const sdr8 = layout('yuv420p');
const sdr10 = layout('yuv420p10le');
const prores12 = layout('yuv444p12le');

describe('selectEncoderPixelFormat', () => {
  it('converts float frames to 8-bit 4:2:0 for a software H.264 master', () => {
    const plan = selectEncoderPixelFormat({
      codec: VideoCodec.H264,
      accel: TranscodeHardwareAcceleration.Disabled,
      layout: sdr8,
      policy: EditedMasterColorPolicy.Preserve,
      colorMatrix: ColorMatrix.Bt709,
    });

    expect(plan.pixelFormat).toBe('yuv420p');
    expect(plan.bitDepth).toBe(8);
    expect(plan.filters).toEqual([
      'format=gbrpf32le',
      'scale=out_color_matrix=bt709:out_range=tv:sws_dither=ed',
      'format=yuv420p',
    ]);
    expect(plan.args).toEqual(['-pix_fmt', 'yuv420p']);
    expect(plan.reducedBitDepth).toBe(false);
    expect(plan.reducedChroma).toBe(false);
  });

  it('converts float frames to 10-bit 4:2:0 for a software HEVC master and keeps the source matrix', () => {
    const plan = selectEncoderPixelFormat({
      codec: VideoCodec.Hevc,
      accel: TranscodeHardwareAcceleration.Disabled,
      layout: sdr10,
      policy: EditedMasterColorPolicy.Preserve,
      colorMatrix: ColorMatrix.Bt2020Nc,
    });

    expect(plan.pixelFormat).toBe('yuv420p10le');
    expect(plan.bitDepth).toBe(10);
    expect(plan.filters).toEqual([
      'format=gbrpf32le',
      'scale=out_color_matrix=bt2020nc:out_range=tv:sws_dither=ed',
      'format=yuv420p10le',
    ]);
    expect(plan.args).toEqual(['-pix_fmt', 'yuv420p10le']);
  });

  it('retags a tone-mapped render to Rec. 709 and delivers 8 bits', () => {
    const plan = selectEncoderPixelFormat({
      codec: VideoCodec.Hevc,
      accel: TranscodeHardwareAcceleration.Disabled,
      layout: sdr10,
      policy: EditedMasterColorPolicy.ToneMap,
      colorMatrix: ColorMatrix.Bt2020Nc,
    });

    expect(plan.bitDepth).toBe(8);
    expect(plan.filters).toEqual([
      'format=gbrpf32le',
      'scale=out_color_matrix=bt709:out_range=tv:sws_dither=ed',
      'format=yuv420p',
    ]);
    expect(plan.args).toEqual(['-pix_fmt', 'yuv420p']);
    expect(plan.reducedBitDepth).toBe(true);
  });

  it('omits the matrix option rather than guessing when the source matrix has no name', () => {
    const plan = selectEncoderPixelFormat({
      codec: VideoCodec.Hevc,
      accel: TranscodeHardwareAcceleration.Disabled,
      layout: sdr8,
      policy: EditedMasterColorPolicy.Preserve,
      colorMatrix: ColorMatrix.Unknown,
    });

    expect(plan.filters).toEqual(['format=gbrpf32le', 'scale=out_range=tv:sws_dither=ed', 'format=yuv420p']);
  });

  it('honours an explicit full-range request', () => {
    const plan = selectEncoderPixelFormat({
      codec: VideoCodec.Hevc,
      accel: TranscodeHardwareAcceleration.Disabled,
      layout: sdr8,
      policy: EditedMasterColorPolicy.Preserve,
      colorMatrix: ColorMatrix.Bt709,
      range: 'pc',
    });

    expect(plan.filters[1]).toBe('scale=out_color_matrix=bt709:out_range=pc:sws_dither=ed');
    expect(plan.statedRange).toBe('pc');
  });

  it('records the chroma reduction for a 4:4:4 source instead of hiding it', () => {
    const plan = selectEncoderPixelFormat({
      codec: VideoCodec.Hevc,
      accel: TranscodeHardwareAcceleration.Disabled,
      layout: prores12,
      policy: EditedMasterColorPolicy.Preserve,
      colorMatrix: ColorMatrix.Bt709,
    });

    expect(plan.pixelFormat).toBe('yuv420p10le');
    expect(plan.reducedChroma).toBe(true);
    expect(plan.reducedBitDepth).toBe(true);
    expect(plan.reason).toContain('12-bit source is delivered at 10 bits');
    expect(plan.reason).toContain('4:4:4 source is delivered at 4:2:0');
  });

  it.each([
    [TranscodeHardwareAcceleration.Nvenc, 'p010le'],
    [TranscodeHardwareAcceleration.Qsv, 'p010le'],
    [TranscodeHardwareAcceleration.Vaapi, 'p010le'],
    [TranscodeHardwareAcceleration.Rkmpp, 'p010le'],
  ])('names the %s 10-bit surface format and emits no filters or -pix_fmt', (accel, pixelFormat) => {
    const plan = selectEncoderPixelFormat({
      codec: VideoCodec.Hevc,
      accel,
      layout: sdr10,
      policy: EditedMasterColorPolicy.Preserve,
      colorMatrix: ColorMatrix.Bt2020Nc,
    });

    expect(plan.pixelFormat).toBe(pixelFormat);
    expect(plan.bitDepth).toBe(10);
    expect(plan.filters).toEqual([]);
    expect(plan.args).toEqual([]);
    // The accelerator's own chain decides the range, so the plan claims none (FL-102).
    expect(plan.statedRange).toBeNull();
  });

  it.each([
    [TranscodeHardwareAcceleration.Nvenc],
    [TranscodeHardwareAcceleration.Qsv],
    [TranscodeHardwareAcceleration.Vaapi],
    [TranscodeHardwareAcceleration.Rkmpp],
  ])('names the %s 8-bit surface format', (accel) => {
    const plan = selectEncoderPixelFormat({
      codec: VideoCodec.H264,
      accel,
      layout: sdr8,
      policy: EditedMasterColorPolicy.Preserve,
      colorMatrix: ColorMatrix.Bt709,
    });

    expect(plan.pixelFormat).toBe('nv12');
    expect(plan.args).toEqual([]);
  });

  it('refuses a 10-bit source aimed at H.264 rather than flattening it', () => {
    const request = {
      codec: VideoCodec.H264,
      accel: TranscodeHardwareAcceleration.Disabled,
      layout: sdr10,
      policy: EditedMasterColorPolicy.Preserve,
      colorMatrix: ColorMatrix.Bt709,
    } as const;

    expect(() => selectEncoderPixelFormat(request)).toThrowError(MediaPolicyError);
    try {
      selectEncoderPixelFormat(request);
      expect.unreachable();
    } catch (error) {
      expect((error as MediaPolicyError).code).toBe(MediaPolicyViolation.UnsupportedDelivery);
      expect((error as MediaPolicyError).message).toContain('no qualified 10-bit path');
    }
  });

  it('refuses a codec an accelerator has no encoder for', () => {
    expect(() =>
      selectEncoderPixelFormat({
        codec: VideoCodec.Vp9,
        accel: TranscodeHardwareAcceleration.Rkmpp,
        layout: sdr8,
        policy: EditedMasterColorPolicy.Preserve,
        colorMatrix: ColorMatrix.Bt709,
      }),
    ).toThrowError(/no qualified encoder for codec 'vp9'/);
  });

  it('still tone maps a 10-bit source to 8-bit H.264 when the loss was chosen', () => {
    const plan = selectEncoderPixelFormat({
      codec: VideoCodec.H264,
      accel: TranscodeHardwareAcceleration.Disabled,
      layout: sdr10,
      policy: EditedMasterColorPolicy.ToneMap,
      colorMatrix: ColorMatrix.Bt2020Nc,
    });

    expect(plan.pixelFormat).toBe('yuv420p');
    expect(plan.args).toEqual(['-pix_fmt', 'yuv420p']);
  });
});

describe('applyFloatEncodePixelFormat', () => {
  const softwarePlan = selectEncoderPixelFormat({
    codec: VideoCodec.Hevc,
    accel: TranscodeHardwareAcceleration.Disabled,
    layout: sdr10,
    policy: EditedMasterColorPolicy.Preserve,
    colorMatrix: ColorMatrix.Bt2020Nc,
  });

  it("replaces the shared chain's trailing bare format filter", () => {
    expect(applyFloatEncodePixelFormat(['scale=1920:1080', 'format=yuv420p'], softwarePlan)).toEqual([
      'scale=1920:1080',
      'format=gbrpf32le',
      'scale=out_color_matrix=bt2020nc:out_range=tv:sws_dither=ed',
      'format=yuv420p10le',
    ]);
  });

  it('appends the conversion when the chain has no trailing format filter', () => {
    expect(applyFloatEncodePixelFormat(['scale=1920:1080'], softwarePlan)).toEqual([
      'scale=1920:1080',
      'format=gbrpf32le',
      'scale=out_color_matrix=bt2020nc:out_range=tv:sws_dither=ed',
      'format=yuv420p10le',
    ]);
  });

  it('does not disturb a tone map filter that carries its own output format', () => {
    const chain = ['tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p'];
    expect(applyFloatEncodePixelFormat(chain, softwarePlan)).toEqual([...chain, ...softwarePlan.filters]);
  });

  it('never touches a device format filter', () => {
    const chain = ['scale_vaapi=1920:1080:mode=hq:out_range=pc:format=nv12', 'hwupload', 'format=vaapi'];
    expect(applyFloatEncodePixelFormat(chain, softwarePlan)).toEqual([...chain, ...softwarePlan.filters]);
  });

  it('leaves a chain alone for a hardware plan, which owns its own conversion', () => {
    const hardwarePlan = selectEncoderPixelFormat({
      codec: VideoCodec.Hevc,
      accel: TranscodeHardwareAcceleration.Vaapi,
      layout: sdr10,
      policy: EditedMasterColorPolicy.Preserve,
      colorMatrix: ColorMatrix.Bt2020Nc,
    });
    const chain = ['scale_vaapi=1920:1080:mode=hq:out_range=pc:format=p010le'];
    expect(applyFloatEncodePixelFormat(chain, hardwarePlan)).toEqual(chain);
  });
});

describe('requiresFloatIntermediate', () => {
  it('is true whenever an 8-bit 4:2:0 intermediate would lose something', () => {
    expect(requiresFloatIntermediate(sdr10, SourceTransferKind.Sdr)).toBe(true);
    expect(requiresFloatIntermediate(prores12, SourceTransferKind.Sdr)).toBe(true);
    expect(requiresFloatIntermediate(sdr8, SourceTransferKind.Hdr10)).toBe(true);
    expect(requiresFloatIntermediate(sdr8, SourceTransferKind.Hlg)).toBe(true);
  });

  it('is false for an ordinary 8-bit 4:2:0 SDR source', () => {
    expect(requiresFloatIntermediate(sdr8, SourceTransferKind.Sdr)).toBe(false);
  });
});

describe('float intermediate identity', () => {
  it('names a real planar float format and an explicit dither', () => {
    expect(FLOAT_INTERMEDIATE_PIXEL_FORMAT).toBe('gbrpf32le');
    expect(FLOAT_TO_INTEGER_DITHER).toBe('ed');
    expect(parseSourcePixelLayout(FLOAT_INTERMEDIATE_PIXEL_FORMAT)).toBeNull();
  });

  it('never delivers anything but 4:2:0', () => {
    const plan = selectEncoderPixelFormat({
      codec: VideoCodec.Hevc,
      accel: TranscodeHardwareAcceleration.Disabled,
      layout: prores12,
      policy: EditedMasterColorPolicy.Preserve,
      colorMatrix: ColorMatrix.Bt709,
    });
    expect(plan.chroma).toBe(ChromaSubsampling.Yuv420);
  });
});
