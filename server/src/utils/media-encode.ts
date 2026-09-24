/**
 * Frameleaf float-frame to native encoding (FL-102 / VID-104).
 *
 * The render graph processes in floating point. This module is the one place that decides how
 * those float frames become integer planes an encoder will accept, and it does so explicitly:
 * a named intermediate format, a stated colour matrix and range, a stated dither, and a target
 * pixel format chosen per encoder rather than assumed. Where the target cannot carry what the
 * source had, that is either recorded on the plan or refused outright — never silent.
 *
 * Division of labour with the rest of the transcode stack:
 *
 * - {@link file://./media-decode.ts} says what the source *is* (bit depth, chroma, transfer).
 * - {@link file://./media-policy.ts} says what the render is *allowed* to do to it.
 * - this module says what the encoder is *handed*.
 * - the `*Config` classes in {@link file://./media.ts} still own the scaler and the device
 *   plumbing (`scale_vaapi`, `hwupload`, `hwmap`, …). This module never emits those, so a
 *   hardware plan states the surface format the accelerator must reach and emits no filters
 *   and no `-pix_fmt` of its own — only the refusal, which applies either way.
 */
import type { VideoColorRange } from 'src/types.js';
import { ColorMatrix, TranscodeHardwareAcceleration, VideoCodec } from 'src/enum.js';
import { ChromaSubsampling, SourcePixelLayout, SourceTransferKind } from 'src/utils/media-decode.js';
import {
  EditedMasterColorPolicy,
  MediaPolicyError,
  MediaPolicyViolation,
  getFfmpegColorMatrixName,
} from 'src/utils/media-policy.js';

/**
 * The floating-point intermediate the render graph works in: planar GBR, 32-bit float per
 * component. Naming it here means a filter chain can assert that it never dropped to an 8-bit
 * canvas somewhere in the middle, which is exactly the failure FL-101 and FL-102 exist to
 * prevent.
 */
export const FLOAT_INTERMEDIATE_PIXEL_FORMAT = 'gbrpf32le';

/**
 * Quantising float to integer always loses something. Error-diffusion dither spends that loss
 * as noise instead of as banding, which is what a gradient test measures. `sws_dither` is a
 * swscale option the `scale` filter accepts per invocation; `ed` is its error-diffusion value
 * (ffmpeg rejects the spelled-out `error_diffusion` and the whole render with it).
 */
export const FLOAT_TO_INTEGER_DITHER = 'ed';

/** The delivery bit depth used for any source that carries more than 8 bits per component. */
export const HIGH_BIT_DEPTH_DELIVERY = 10;

/**
 * Per-encoder input pixel formats, by delivery bit depth.
 *
 * Software encoders take planar YUV directly. The hardware encoders in this fork all take a
 * device surface, and the format that is uploaded into that surface is semi-planar: `nv12` at
 * 8 bits, `p010le` at 10. `null` means the encoder has no qualified path at that depth.
 *
 * VideoToolbox is deliberately absent: `TranscodeHardwareAcceleration` in this fork is
 * `nvenc | qsv | vaapi | rkmpp | disabled`, so there is no VideoToolbox configuration to
 * select and nothing honest to advertise for it. Add a row here when that enum gains one.
 */
const ENCODER_PIXEL_FORMATS: Record<
  TranscodeHardwareAcceleration,
  Partial<Record<VideoCodec, Record<number, string | null>>>
> = {
  [TranscodeHardwareAcceleration.Disabled]: {
    // libx264. High 10 exists, but it is not a qualified delivery profile here and FL-39
    // already promotes a high-bit-depth master from H.264 to HEVC before reaching this point.
    [VideoCodec.H264]: { 8: 'yuv420p', 10: null },
    // libx265.
    [VideoCodec.Hevc]: { 8: 'yuv420p', 10: 'yuv420p10le' },
    // libvpx-vp9, profile 2 for 10-bit.
    [VideoCodec.Vp9]: { 8: 'yuv420p', 10: 'yuv420p10le' },
    // libsvtav1.
    [VideoCodec.Av1]: { 8: 'yuv420p', 10: 'yuv420p10le' },
  },
  [TranscodeHardwareAcceleration.Nvenc]: {
    [VideoCodec.H264]: { 8: 'nv12', 10: null },
    [VideoCodec.Hevc]: { 8: 'nv12', 10: 'p010le' },
    [VideoCodec.Av1]: { 8: 'nv12', 10: 'p010le' },
  },
  [TranscodeHardwareAcceleration.Qsv]: {
    [VideoCodec.H264]: { 8: 'nv12', 10: null },
    [VideoCodec.Hevc]: { 8: 'nv12', 10: 'p010le' },
    [VideoCodec.Vp9]: { 8: 'nv12', 10: 'p010le' },
    [VideoCodec.Av1]: { 8: 'nv12', 10: 'p010le' },
  },
  [TranscodeHardwareAcceleration.Vaapi]: {
    [VideoCodec.H264]: { 8: 'nv12', 10: null },
    [VideoCodec.Hevc]: { 8: 'nv12', 10: 'p010le' },
    [VideoCodec.Vp9]: { 8: 'nv12', 10: 'p010le' },
    [VideoCodec.Av1]: { 8: 'nv12', 10: 'p010le' },
  },
  [TranscodeHardwareAcceleration.Rkmpp]: {
    [VideoCodec.H264]: { 8: 'nv12', 10: null },
    [VideoCodec.Hevc]: { 8: 'nv12', 10: 'p010le' },
  },
};

export type EncoderPixelFormatRequest = {
  codec: VideoCodec;
  accel: TranscodeHardwareAcceleration;
  /** The source's planes, from `qualifySourceDecode`. */
  layout: SourcePixelLayout;
  /** Whether the render preserves the source colour volume or tone maps it. */
  policy: EditedMasterColorPolicy;
  /** The source colour matrix, used as the conversion target when preserving. */
  colorMatrix: ColorMatrix;
  /** Output signal range. Consumer delivery is limited range unless the caller says otherwise. */
  range?: VideoColorRange;
};

export type EncoderPixelFormatPlan = {
  /** The pixel format the encoder (or its device upload) is handed. */
  pixelFormat: string;
  bitDepth: number;
  chroma: ChromaSubsampling;
  /**
   * The ordered filter chain from the float intermediate to {@link pixelFormat}, for a software
   * encoder. Empty for a hardware one, whose own chain performs the conversion.
   */
  filters: string[];
  /**
   * Output options. `-pix_fmt` for a software encoder; deliberately empty for a hardware one,
   * whose encoder input is a device surface rather than a pixel format.
   */
  args: string[];
  /** True when the source carried more bits per component than the delivery format does. */
  reducedBitDepth: boolean;
  /** True when the source carried more chroma resolution than the delivery format does. */
  reducedChroma: boolean;
  /** Stated justification, recorded with the render rather than inferred from the command. */
  reason: string;
  /**
   * The signal range {@link filters} convert to (`out_range`), or null when the plan emits no
   * conversion of its own. Only a range the filter graph actually states may be tagged on the
   * output: a tag the pixels were never converted to makes a decoder stretch or squeeze them.
   */
  statedRange: VideoColorRange | null;
};

/**
 * Chooses the pixel format the encoder is handed, and the explicit conversion that gets the
 * float frames there.
 *
 * - A tone-mapped render always delivers 8-bit: the tone map is the point at which the wider
 *   volume was deliberately given up, and pretending otherwise with 10-bit output would claim
 *   a precision the pixels no longer have.
 * - A preserving render delivers 10-bit whenever the source carried more than 8, and refuses
 *   when the chosen encoder has no qualified 10-bit path rather than quietly flattening it.
 * - Delivery chroma is 4:2:0. A 4:2:2 or 4:4:4 source is converted, and `reducedChroma` says
 *   so on the plan; the archival path for those sources is the preserved original.
 *
 * @throws MediaPolicyError with {@link MediaPolicyViolation.UnsupportedDelivery} when the
 * requested encoder cannot deliver the required bit depth.
 */
export const selectEncoderPixelFormat = ({
  codec,
  accel,
  layout,
  policy,
  colorMatrix,
  range = 'tv',
}: EncoderPixelFormatRequest): EncoderPixelFormatPlan => {
  const toneMapped = policy === EditedMasterColorPolicy.ToneMap;
  const bitDepth = toneMapped || layout.bitDepth <= 8 ? 8 : HIGH_BIT_DEPTH_DELIVERY;

  const encoderName = accel === TranscodeHardwareAcceleration.Disabled ? 'the software encoder' : accel.toUpperCase();

  const byCodec = ENCODER_PIXEL_FORMATS[accel][codec];
  if (!byCodec) {
    throw new MediaPolicyError(
      MediaPolicyViolation.UnsupportedDelivery,
      `${encoderName} has no qualified encoder for codec '${codec}'.`,
    );
  }

  const pixelFormat = byCodec[bitDepth];
  if (!pixelFormat) {
    throw new MediaPolicyError(
      MediaPolicyViolation.UnsupportedDelivery,
      `Codec '${codec}' on ${encoderName} has no qualified ${bitDepth}-bit path, and the ` +
        `${layout.bitDepth}-bit source must not be flattened silently. Choose HEVC or AV1 for this ` +
        'source, or accept an explicit tone map.',
    );
  }

  const matrix = toneMapped ? 'bt709' : getFfmpegColorMatrixName(colorMatrix);
  const scaleOptions = [
    ...(matrix ? [`out_color_matrix=${matrix}`] : []),
    `out_range=${range}`,
    `sws_dither=${FLOAT_TO_INTEGER_DITHER}`,
  ];

  const reducedBitDepth = layout.bitDepth > bitDepth;
  const reducedChroma = layout.chroma !== ChromaSubsampling.Yuv420;
  const software = accel === TranscodeHardwareAcceleration.Disabled;
  const loss =
    (reducedBitDepth ? `; the ${layout.bitDepth}-bit source is delivered at ${bitDepth} bits` : '') +
    (reducedChroma ? `; the ${layout.chroma} source is delivered at 4:2:0` : '');

  return {
    pixelFormat,
    bitDepth,
    chroma: ChromaSubsampling.Yuv420,
    // On a hardware plan the conversion and the device upload belong to the accelerator's own
    // filter chain in `media.ts` (`scale_vaapi=…:format=nv12`, `hwupload`, `hwmap`, …). Emitting
    // a second, software conversion here would break that chain, so the plan states what the
    // surface format must be and leaves the chain alone. The bit-depth refusal above still
    // applies, which is the part that has to happen no matter who does the conversion.
    filters: software
      ? [`format=${FLOAT_INTERMEDIATE_PIXEL_FORMAT}`, `scale=${scaleOptions.join(':')}`, `format=${pixelFormat}`]
      : [],
    // `-pix_fmt` describes the encoder's input. A hardware encoder's input is a device surface,
    // not `nv12`, so setting it there would be wrong.
    args: software ? ['-pix_fmt', pixelFormat] : [],
    reducedBitDepth,
    reducedChroma,
    statedRange: software ? range : null,
    reason: software
      ? `Float frames (${FLOAT_INTERMEDIATE_PIXEL_FORMAT}) are converted to ${pixelFormat} with ` +
        `${matrix ? `matrix ${matrix}, ` : ''}range ${range} and ${FLOAT_TO_INTEGER_DITHER} dither${loss}.`
      : `${accel.toUpperCase()} encodes from a ${pixelFormat} surface prepared by its own filter chain${loss}.`,
  };
};

/**
 * Software pixel formats a bare `format=` filter may name. Device formats (`vaapi`, `qsv`,
 * `cuda`, `drm_prime`, `opencl`, `d3d11`) are deliberately absent: a `format=vaapi` in a
 * hardware chain is part of the device plumbing, not a picture conversion, and must survive.
 */
const REPLACEABLE_FORMAT_FILTER = /^format=(?:yuv|gbr|gray|nv\d|p0\d|rgb|bgr)[\w]*$/;

/**
 * Replaces the shared filter chain's trailing bare `format=…` with this plan's explicit
 * float-to-integer conversion, and appends the conversion when the chain has none.
 *
 * The shared chain ends with a bare `format=yuv420p`, which is exactly the hidden 8-bit step
 * these stories remove: the conversion has to state its matrix, range and dither rather than
 * inherit swscale's defaults. Only the *last* filter is considered, and only when it names a
 * software pixel format, so nothing earlier in a chain — a scaler, a tone map, a device
 * upload — is disturbed. A plan with no filters of its own (any hardware accelerator) leaves
 * the chain exactly as it was.
 */
export const applyFloatEncodePixelFormat = (filters: string[], plan: EncoderPixelFormatPlan): string[] => {
  if (plan.filters.length === 0) {
    return filters;
  }

  const last = filters.at(-1);
  const kept = last && REPLACEABLE_FORMAT_FILTER.test(last) ? filters.slice(0, -1) : filters;
  return [...kept, ...plan.filters];
};

/**
 * True when the source carries something an 8-bit 4:2:0 intermediate would lose, so the render
 * must keep the float chain rather than let any filter flatten it on the way to the encoder.
 * An HDR source counts even when the delivery is 8-bit: the tone map reads the high-precision
 * input, and running it after a flattening step would be tone mapping a picture that had
 * already lost its highlights.
 */
export const requiresFloatIntermediate = (layout: SourcePixelLayout, transfer: SourceTransferKind): boolean =>
  layout.bitDepth > 8 || layout.chroma !== ChromaSubsampling.Yuv420 || transfer !== SourceTransferKind.Sdr;
