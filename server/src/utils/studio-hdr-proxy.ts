/**
 * FL-97: the Studio HDR intermediate.
 *
 * The playback transcode of an HDR video is tone mapped to 8-bit SDR for every client, and a
 * browser hands HEVC decoded in hardware back as opaque frames, so the editor's float graph can
 * read neither. This intermediate keeps the source's BT.2020 PQ or HLG signal in 10-bit AV1, which
 * every browser decodes in software into readable 10-bit planes. It is derived and replaceable,
 * carries no metadata (so no location), and is made only for HDR videos a Studio project places.
 */
import type { TranscodeCommand } from 'src/types.js';
import { ColorPrimaries, ColorTransfer } from 'src/enum.js';

export const STUDIO_HDR_PROXY_LONG_EDGE = 3840;
export const STUDIO_HDR_PROXY_SHORT_EDGE = 2160;

export type StudioHdrProxyStream = {
  index: number;
  colorPrimaries: number | null;
  colorTransfer: number | null;
  frameCount?: number | null;
  frameRate?: number | null;
};

export type StudioHdrProxyPlan =
  { eligible: true; transfer: 'smpte2084' | 'arib-std-b67' } | { eligible: false; reason: string };

/** Whether this picture stream gets an intermediate: HDR (PQ or HLG) in BT.2020 primaries only. */
export const planStudioHdrProxy = (stream: StudioHdrProxyStream): StudioHdrProxyPlan => {
  const transfer =
    stream.colorTransfer === ColorTransfer.Smpte2084
      ? 'smpte2084'
      : stream.colorTransfer === ColorTransfer.AribStdB67
        ? 'arib-std-b67'
        : null;
  if (!transfer) {
    return { eligible: false, reason: 'the video is not HDR (PQ or HLG)' };
  }
  if (stream.colorPrimaries !== ColorPrimaries.Bt2020) {
    return { eligible: false, reason: 'the HDR video does not use BT.2020 primaries' };
  }
  return { eligible: true, transfer };
};

/** Downscale factor, as an ffmpeg expression on the (auto-rotated) input size. Never upscales. */
const FIT = `min(1,min(${STUDIO_HDR_PROXY_LONG_EDGE}/max(iw,ih),${STUDIO_HDR_PROXY_SHORT_EDGE}/min(iw,ih)))`;

/**
 * The ffmpeg command. The signal is carried, not converted: BT.2020 non-constant-luminance matrix,
 * limited range and the source transfer, tagged explicitly; only the picture size may shrink.
 * Timestamps pass through, so frame timing matches the source's own cadence (including VFR).
 */
export const getStudioHdrProxyCommand = (
  stream: StudioHdrProxyStream,
  transfer: 'smpte2084' | 'arib-std-b67',
  /** The admin's ffmpeg thread limit (`ffmpeg.threads`); 0 lets the encoder choose. */
  threads = 0,
): TranscodeCommand => {
  const limit = threads > 0 ? Math.round(threads) : 0;
  const gop = Math.max(1, Math.round(stream.frameRate && stream.frameRate > 0 ? stream.frameRate : 30));
  return {
    inputOptions: [],
    outputOptions: [
      '-map',
      `0:${stream.index}`,
      '-an',
      '-sn',
      '-dn',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-fps_mode',
      'passthrough',
      '-vf',
      // setparams tags the frames too, so no stage can fall back to an unspecified colour description
      `scale=w='trunc(iw*${FIT}/2)*2':h='trunc(ih*${FIT}/2)*2':out_range=tv,format=yuv420p10le,` +
        `setparams=color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc:range=tv`,
      '-c:v',
      'libsvtav1',
      '-preset',
      '10',
      '-crf',
      '23',
      // the AV1 sequence header's own colour description (ITU-T H.273 code points)
      '-svtav1-params',
      `color-primaries=9:transfer-characteristics=${transfer === 'smpte2084' ? 16 : 18}:matrix-coefficients=9:color-range=0` +
        (limit > 0 ? `:lp=${limit}` : ''),
      ...(limit > 0 ? ['-threads', String(limit)] : []),
      // about one keyframe a second, so the editor can seek without decoding long runs
      '-g',
      String(gop),
      '-pix_fmt',
      'yuv420p10le',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      transfer,
      '-colorspace',
      'bt2020nc',
      '-color_range',
      'tv',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
    ],
    twoPass: false,
    progress: { frameCount: stream.frameCount ?? 0, percentInterval: 5 },
  };
};
