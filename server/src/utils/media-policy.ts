/**
 * Frameleaf edited-master and playback-proxy policy (FL-39 / VID-101, FL-16 / VID-100).
 *
 * This module is the single source of truth for the rules that every render path must obey,
 * whether it is driven by the quick editor, a Studio project or a background job. It is
 * deliberately framework-free — no NestJS, no repositories, no filesystem access — so the
 * quick editor, Studio and the transcode services can all import the same rules and the same
 * types instead of restating them.
 *
 * The rules are:
 *
 * 1. An edit never overwrites the original. Every render writes to a derived path, and
 *    {@link assertOriginalPreserved} throws before the encoder is invoked when it would not.
 * 2. An edited master is a *new* file with recorded lineage: the source asset, the recipe
 *    revision and the renderer version. See {@link buildEditedMasterLineage}.
 * 3. A playback proxy is derived, replaceable and never the master. It is never used as the
 *    source of a new render — see {@link assertRenderSourceIsOriginal}.
 * 4. Master quality is not capped by the general playback transcode settings. See
 *    {@link getEditedMasterFfmpegConfig}.
 * 5. Rational timing and VFR mappings survive the render. See {@link getEditedMasterTimingArgs}.
 * 6. The audio channel layout survives the render. See {@link applyEditedMasterAudioPolicy}.
 * 7. A preservation path that cannot be honoured fails *before* a valid existing version is
 *    replaced. See {@link resolveEditedMasterColorPolicy}.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AudioStreamInfo, VideoColorRange, VideoFormat, VideoStreamInfo } from 'src/types.js';
import { ConfigFFmpegDto } from 'src/dtos/config.dto.js';
import { AssetEditAction, AssetEditActionItem, VideoTrimMode } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  ColorMatrix,
  ColorPrimaries,
  ColorTransfer,
  DvProfile,
  ToneMapping,
  VideoCodec,
} from 'src/enum.js';
import { formatRational, toTrackTimescale } from 'src/utils/rational-time.js';
import { type OutputCadenceDecision, OutputCadenceMode, resolveSourceTimeBase } from 'src/utils/video-timing.js';

/**
 * Identity of the render implementation that produced an edited master. Bump the revision
 * whenever a change to the filter graph, the encoder settings or these policies would make a
 * previously rendered master non-reproducible. Lineage records it so a stale master can be
 * recognised and re-rendered from the original.
 */
export const FRAMELEAF_RENDERER = 'frameleaf-ffmpeg';
// 1.1.0 (FL-113): the develop adjustment model, anchored and shadowed text, ranges over a whole-clip
// speed, stream-copied fast trims and the opt-in straighten fill, stabilize edge crop and gain limit.
export const FRAMELEAF_RENDERER_VERSION = '1.1.0';

/** Version of the lineage document itself, so future fields can be added compatibly. */
export const EDITED_MASTER_LINEAGE_SCHEMA_VERSION = 1;

/** Suffix used for the lineage sidecar written next to an edited master. */
export const EDITED_MASTER_LINEAGE_SUFFIX = '.lineage.json';

/**
 * Quality ceiling for an edited master. The general playback CRF (23 by default, and an
 * administrator may set it higher) describes a *proxy*, not a master, so the master render
 * clamps to at least this quality. This is a high-quality lossy target, not mathematically
 * lossless — see the risk recorded on FL-16.
 */
export const EDITED_MASTER_MAX_CRF = 18;

/** Audio codecs that can be stream-copied into the `.mp4` edited-master container. */
const MP4_STREAM_COPYABLE_AUDIO_CODECS = new Set(['aac', 'ac3', 'eac3', 'mp3', 'alac']);

/**
 * Pixel formats that carry more than 8 bits per component. The planar families spell the depth
 * after the plane marker (`yuv420p10le`); the semi-planar families used by hardware decoders
 * spell it in the format name itself (`p010le`), so both are recognised.
 */
const HIGH_BIT_DEPTH_SUFFIX = /p(9|1[0-6])(le|be)?$/;
const HIGH_BIT_DEPTH_PIXEL_FORMATS = new Set([
  'p010',
  'p010le',
  'p010be',
  'p012le',
  'p012be',
  'p016le',
  'p016be',
  'p210le',
  'p210be',
  'p216le',
  'p216be',
  'p410le',
  'p416le',
  'nv20le',
  'xv30le',
  'y210le',
]);

/** The 10-bit planar format an edited master falls back to when the source is high bit depth. */
export const EDITED_MASTER_HIGH_BIT_DEPTH_FORMAT = 'yuv420p10le';

/**
 * ITU-T H.273 code points mapped to the names ffmpeg's `-color_primaries`, `-color_trc` and
 * `-colorspace` options accept. Only the code points a consumer camera or a delivery encoder
 * actually emits are listed; anything else is left untagged rather than guessed at.
 */
const FFMPEG_COLOR_PRIMARIES: Partial<Record<ColorPrimaries, string>> = {
  [ColorPrimaries.Bt709]: 'bt709',
  [ColorPrimaries.Bt470M]: 'bt470m',
  [ColorPrimaries.Bt470Bg]: 'bt470bg',
  [ColorPrimaries.Smpte170M]: 'smpte170m',
  [ColorPrimaries.Smpte240M]: 'smpte240m',
  [ColorPrimaries.Film]: 'film',
  [ColorPrimaries.Bt2020]: 'bt2020',
  [ColorPrimaries.Smpte428]: 'smpte428',
  [ColorPrimaries.Smpte431]: 'smpte431',
  [ColorPrimaries.Smpte432]: 'smpte432',
};

const FFMPEG_COLOR_TRANSFER: Partial<Record<ColorTransfer, string>> = {
  [ColorTransfer.Bt709]: 'bt709',
  [ColorTransfer.Bt470M]: 'bt470m',
  [ColorTransfer.Bt470Bg]: 'bt470bg',
  [ColorTransfer.Smpte170M]: 'smpte170m',
  [ColorTransfer.Smpte240M]: 'smpte240m',
  [ColorTransfer.Linear]: 'linear',
  [ColorTransfer.Iec6196624]: 'iec61966-2-4',
  [ColorTransfer.Iec6196621]: 'iec61966-2-1',
  [ColorTransfer.Bt202010]: 'bt2020-10',
  [ColorTransfer.Bt202012]: 'bt2020-12',
  [ColorTransfer.Smpte2084]: 'smpte2084',
  [ColorTransfer.Smpte428]: 'smpte428',
  [ColorTransfer.AribStdB67]: 'arib-std-b67',
};

const FFMPEG_COLOR_MATRIX: Partial<Record<ColorMatrix, string>> = {
  [ColorMatrix.Gbr]: 'gbr',
  [ColorMatrix.Bt709]: 'bt709',
  [ColorMatrix.Fcc]: 'fcc',
  [ColorMatrix.Bt470Bg]: 'bt470bg',
  [ColorMatrix.Smpte170M]: 'smpte170m',
  [ColorMatrix.Smpte240M]: 'smpte240m',
  [ColorMatrix.Ycgco]: 'ycgco',
  [ColorMatrix.Bt2020Nc]: 'bt2020nc',
  [ColorMatrix.Bt2020C]: 'bt2020c',
  [ColorMatrix.Smpte2085]: 'smpte2085',
  [ColorMatrix.ChromaDerivedNc]: 'chroma-derived-nc',
  [ColorMatrix.ChromaDerivedC]: 'chroma-derived-c',
  [ColorMatrix.Ictcp]: 'ictcp',
};

/**
 * The name ffmpeg's `-colorspace` option and the `scale` filter's `out_color_matrix` option
 * accept for a probed matrix code point, or null when the code point has no name and the
 * render should leave the matrix alone rather than guess at one.
 */
export const getFfmpegColorMatrixName = (colorMatrix: ColorMatrix): string | null =>
  FFMPEG_COLOR_MATRIX[colorMatrix] ?? null;

/** Asset file types that are playback proxies or previews — derived, replaceable, never a master. */
const PLAYBACK_PROXY_FILE_TYPES = new Set<AssetFileType>([
  AssetFileType.EncodedVideo,
  AssetFileType.Preview,
  AssetFileType.Thumbnail,
]);

/** Thrown when a render would break one of the policies above. */
export class MediaPolicyError extends Error {
  constructor(
    readonly code: MediaPolicyViolation,
    message: string,
  ) {
    super(message);
    this.name = 'MediaPolicyError';
  }
}

export enum MediaPolicyViolation {
  /** The render output path is the original file. */
  OriginalWouldBeOverwritten = 'originalWouldBeOverwritten',
  /** The render input is a proxy or a previously rendered master rather than the original. */
  DerivedSourceForNewMaster = 'derivedSourceForNewMaster',
  /** The source cannot be preserved by this renderer at all. */
  UnsupportedPreservation = 'unsupportedPreservation',
  /**
   * FL-101: the probed source is outside the qualified decoding matrix — an unqualified Dolby
   * Vision profile, an undescribable pixel format or a bit depth this renderer cannot deliver.
   * See `qualifySourceDecode` in `media-decode.ts`.
   */
  UnsupportedSource = 'unsupportedSource',
  /**
   * FL-102: the chosen encoder has no qualified path for the delivery the source requires, and
   * flattening it silently is not an option. See `selectEncoderPixelFormat` in `media-encode.ts`.
   */
  UnsupportedDelivery = 'unsupportedDelivery',
  /**
   * FL-39: the probed edited master does not match what its recipe and colour decision promised
   * (display raster, orientation, precision or colour intent). It is never published.
   */
  MasterValidationFailed = 'masterValidationFailed',
}

/** How a render treats the source's colour volume. Recorded in lineage; never implicit. */
export enum EditedMasterColorPolicy {
  /** The source is SDR, or HDR that the renderer carries through unchanged. */
  Preserve = 'preserve',
  /** The source is HDR and the renderer tone maps it. A deliberate, recorded loss. */
  ToneMap = 'toneMap',
}

export type EditedMasterColorDecision = {
  policy: EditedMasterColorPolicy;
  /** Human-readable justification, stored in lineage so the loss is never silent. */
  reason: string;
};

export type EditedMasterLineage = {
  schemaVersion: typeof EDITED_MASTER_LINEAGE_SCHEMA_VERSION;
  /** The asset whose original was rendered. */
  sourceAssetId: string;
  /** The original file the render read. Never the render's own output. */
  sourceOriginalPath: string;
  /** Checksum of the original at render time, when the caller knows it. */
  sourceChecksum: string | null;
  /** Stable digest of the ordered recipe that produced this master. */
  recipeRevision: string;
  /** The ordered recipe actions, for a human reading the sidecar. */
  recipeActions: string[];
  renderer: typeof FRAMELEAF_RENDERER;
  rendererVersion: string;
  color: EditedMasterColorDecision;
  createdAt: string;
};

/** Audio stream information enriched with the layout fields the master policy needs. */
export type MasterAudioStreamInfo = AudioStreamInfo & {
  channels?: number | null;
  channelLayout?: string | null;
  sampleRate?: number | null;
};

/**
 * The recipe revision is a stable digest of the ordered edit actions and their parameters.
 * Two recipes that render identically produce the same revision; reordering or changing any
 * parameter produces a different one. Object keys are sorted so that serialisation order in
 * the database or over the wire cannot change the digest.
 */
export const computeRecipeRevision = (edits: AssetEditActionItem[]): string => {
  const canonical = edits.map((edit) => [edit.action, canonicalize(edit.parameters)]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }

  return value;
};

/** A playback proxy is derived and replaceable. It is never an edited master. */
export const isPlaybackProxyFileType = (type: AssetFileType): boolean => PLAYBACK_PROXY_FILE_TYPES.has(type);

/**
 * Rule 1. An edit never overwrites the original. Call this immediately before invoking the
 * encoder, with the exact paths that will be passed to it.
 */
export const assertOriginalPreserved = ({
  originalPath,
  outputPath,
}: {
  originalPath: string;
  outputPath: string;
}): void => {
  if (path.resolve(originalPath) === path.resolve(outputPath)) {
    throw new MediaPolicyError(
      MediaPolicyViolation.OriginalWouldBeOverwritten,
      `Refusing to render over the original file ${originalPath}: an edit never replaces the original.`,
    );
  }
};

/**
 * Rule 3. A new master is rendered from the original plus its recipe, never from a playback
 * proxy or from a previously rendered — and therefore already lossy — master.
 */
export const assertRenderSourceIsOriginal = ({
  originalPath,
  sourcePath,
  derivedPaths = [],
}: {
  originalPath: string;
  sourcePath: string;
  derivedPaths?: string[];
}): void => {
  const source = path.resolve(sourcePath);
  if (source === path.resolve(originalPath)) {
    return;
  }

  throw new MediaPolicyError(
    MediaPolicyViolation.DerivedSourceForNewMaster,
    derivedPaths.some((derived) => path.resolve(derived) === source)
      ? `Refusing to render a new master from the derived file ${sourcePath}: renders read the original.`
      : `Refusing to render a new master from ${sourcePath}, which is not the original ${originalPath}.`,
  );
};

/**
 * Rule 4. The general playback transcode settings describe a proxy and must not cap a master.
 *
 * - `targetResolution` is forced to `original`, so the master keeps the source geometry and
 *   only the recipe may change it.
 * - `crf` is clamped to at most {@link EDITED_MASTER_MAX_CRF}; a coarser playback CRF is ignored.
 * - `maxBitrate` is cleared, so an administrator's playback bitrate ceiling cannot truncate the
 *   master, and two-pass rate control (which only exists to hit that ceiling) is turned off.
 * - The target codec is promoted from H.264 to HEVC when the source carries more than 8 bits
 *   per component, so the playback codec choice cannot silently flatten bit depth.
 *
 * `preset` is deliberately left alone: at a fixed CRF it trades encoding time for file size,
 * not for the quality target.
 */
export const getEditedMasterFfmpegConfig = (
  config: ConfigFFmpegDto,
  videoStream: Pick<VideoStreamInfo, 'pixelFormat'>,
): ConfigFFmpegDto => {
  const targetVideoCodec =
    config.targetVideoCodec === VideoCodec.H264 && isHighBitDepth(videoStream)
      ? VideoCodec.Hevc
      : config.targetVideoCodec;

  return {
    ...config,
    targetResolution: 'original',
    crf: Math.min(config.crf, EDITED_MASTER_MAX_CRF),
    maxBitrate: '0',
    twoPass: false,
    targetVideoCodec,
  };
};

export const isHighBitDepth = ({ pixelFormat }: Pick<VideoStreamInfo, 'pixelFormat'>): boolean => {
  const format = (pixelFormat ?? '').toLowerCase();
  return HIGH_BIT_DEPTH_PIXEL_FORMATS.has(format) || HIGH_BIT_DEPTH_SUFFIX.test(format);
};

/**
 * The shared playback filter chain appends `format=yuv420p` to anything that is not already
 * 8-bit 4:2:0, which would quietly flatten a 10-bit source. When the master is preserving the
 * source colour volume, that conversion is rewritten to the 10-bit equivalent instead. When the
 * render is tone mapping, the tone map filter already produces 8-bit 4:2:0 deliberately and the
 * chain is left alone.
 */
export const applyEditedMasterPixelFormatPolicy = (
  filters: string[],
  videoStream: Pick<VideoStreamInfo, 'pixelFormat'>,
  decision: EditedMasterColorDecision,
): string[] => {
  if (decision.policy !== EditedMasterColorPolicy.Preserve || !isHighBitDepth(videoStream)) {
    return filters;
  }

  return filters.map((filter) =>
    filter === 'format=yuv420p' ? `format=${EDITED_MASTER_HIGH_BIT_DEPTH_FORMAT}` : filter,
  );
};

export const isHdrTransfer = ({ colorTransfer }: Pick<VideoStreamInfo, 'colorTransfer'>): boolean =>
  colorTransfer === ColorTransfer.Smpte2084 || colorTransfer === ColorTransfer.AribStdB67;

/**
 * Rule 7. Decide — explicitly — what happens to the source colour volume, and refuse outright
 * when nothing honest can be done.
 *
 * Dolby Vision profile 5 carries no usable base layer: treating it as ordinary HDR produces
 * wrong colour, and copying the original RPU onto edited pictures is not preservation. There is
 * no qualified path for it in this renderer (it belongs to FL-17 / VID-200), so we fail here,
 * before an existing valid master could be replaced, and the original is preserved by rule 1.
 */
export const resolveEditedMasterColorPolicy = (
  videoStream: Pick<VideoStreamInfo, 'colorTransfer' | 'dvProfile' | 'pixelFormat'>,
  config: Pick<ConfigFFmpegDto, 'tonemap'>,
): EditedMasterColorDecision => {
  if (videoStream.dvProfile === DvProfile.Dvhe05) {
    throw new MediaPolicyError(
      MediaPolicyViolation.UnsupportedPreservation,
      'Dolby Vision profile 5 has no qualified edited-master path in this renderer; ' +
        'the original is preserved unchanged.',
    );
  }

  if (!isHdrTransfer(videoStream)) {
    return { policy: EditedMasterColorPolicy.Preserve, reason: 'Source is SDR.' };
  }

  if (config.tonemap === ToneMapping.Disabled) {
    return {
      policy: EditedMasterColorPolicy.Preserve,
      reason: `Source transfer ${videoStream.colorTransfer} is carried through; tone mapping is disabled.`,
    };
  }

  return {
    policy: EditedMasterColorPolicy.ToneMap,
    reason:
      `Source transfer ${videoStream.colorTransfer} is tone mapped with '${config.tonemap}'; ` +
      'the HDR original is preserved and remains the reference.',
  };
};

/**
 * Rule 5. Rational timing and VFR mappings survive the render.
 *
 * `-fps_mode passthrough` is set explicitly rather than left to the encoder's per-stream
 * default, so a variable-frame-rate source is never silently resampled to a constant rate — the
 * existing per-frame presentation timestamps, including the ones a speed recipe deliberately
 * remaps, are the ones that are muxed. `-video_track_timescale` pins the output timescale to the
 * source time base so those timestamps stay exactly representable instead of being rounded into
 * the muxer's default 1/1000 grid.
 *
 * FL-93: the timescale is now derived from the source's *rational* time base rather than from
 * the persisted integer denominator, so a container that declares a time base with a numerator
 * still gets a grid every one of its ticks lands on exactly. `toTrackTimescale` is where that
 * choice is proved; the answer for the ordinary `1/30000` source is unchanged.
 *
 * A cadence decision is optional and is only ever made by a caller that asked for one. Without
 * it the master passes the source timing through; with a `convert` decision the requested
 * cadence is written as an exact rational (`-r 30000/1001`, never 29.97) and `-fps_mode cfr`
 * says out loud that frames are being resampled.
 */
export const getEditedMasterTimingArgs = (
  videoStream: Pick<VideoStreamInfo, 'timeBase' | 'timeBaseRational'>,
  cadence?: OutputCadenceDecision | null,
): string[] => {
  const args =
    cadence?.mode === OutputCadenceMode.Convert && cadence.cadence
      ? ['-fps_mode', 'cfr', '-r', formatRational(cadence.cadence)]
      : ['-fps_mode', 'passthrough'];

  const timeBase = resolveSourceTimeBase(videoStream);
  if (timeBase) {
    args.push('-video_track_timescale', String(toTrackTimescale(timeBase)));
  }

  return args;
};

/**
 * Colour tags are written explicitly so a decoder is never left guessing at the master's
 * intent. When the render tone maps, the tags describe the tone-mapped result (Rec. 709),
 * which is what the pixels actually are.
 */
export const getEditedMasterColorArgs = (
  videoStream: Pick<VideoStreamInfo, 'colorPrimaries' | 'colorMatrix' | 'colorTransfer'>,
  decision: EditedMasterColorDecision,
  statedRange: VideoColorRange | null = null,
): string[] => {
  if (decision.policy === EditedMasterColorPolicy.ToneMap) {
    return ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
  }

  const args: string[] = [];
  const primaries = FFMPEG_COLOR_PRIMARIES[videoStream.colorPrimaries];
  if (primaries) {
    args.push('-color_primaries', primaries);
  }
  const transfer = FFMPEG_COLOR_TRANSFER[videoStream.colorTransfer];
  if (transfer) {
    args.push('-color_trc', transfer);
  }
  const matrix = FFMPEG_COLOR_MATRIX[videoStream.colorMatrix];
  if (matrix) {
    args.push('-colorspace', matrix);
  }
  // FL-102: the range is tagged only when the render's filter graph converted the pixels to it
  // (`statedRange`, from the encode plan's `out_range`). On any other path — the plain 8-bit chain,
  // a hardware scaler with its own `out_range`, ffmpeg's automatic format conversion — the range
  // the pixels end up in is not one this code chose, and a tag could contradict them.
  if (statedRange) {
    args.push('-color_range', statedRange);
  }
  return args;
};

/**
 * ffprobe's `color_range`, as the range ffmpeg's filters and `-color_range` accept (FL-102).
 * Older builds say `mpeg`/`jpeg` for the same two ranges; anything else is not stated.
 */
export const parseFfprobeColorRange = (value: string | undefined): VideoColorRange | null => {
  switch (value) {
    case 'tv':
    case 'mpeg': {
      return 'tv';
    }
    case 'pc':
    case 'jpeg': {
      return 'pc';
    }
    default: {
      return null;
    }
  }
};

/**
 * The signal range an edited master is delivered in (FL-102).
 *
 * A preserving render keeps the source's range: a full-range (`pc`) phone or screen recording
 * squeezed into limited range loses its shadow and highlight steps, and a decoder told the wrong
 * range washes the picture out or crushes it. A tone-mapped render is consumer Rec. 709 delivery,
 * which is limited range, and so is a source that does not state its range.
 */
export const getEditedMasterColorRange = (
  videoStream: Pick<VideoStreamInfo, 'colorRange'>,
  decision: EditedMasterColorDecision,
): VideoColorRange =>
  decision.policy === EditedMasterColorPolicy.Preserve && videoStream.colorRange ? videoStream.colorRange : 'tv';

export type EditedMasterAudioPolicy = {
  /** True when the source track is muxed through untouched. */
  streamCopy: boolean;
  /** Arguments appended after the base output options. */
  args: string[];
};

/**
 * What a target asks of an audio track's channel layout. FL-102: a downmix happens because a
 * target asked for one, never because nobody said anything.
 */
export enum AudioChannelPolicy {
  /** Keep the source's channel count, layout and sample rate. */
  Preserve = 'preserve',
  /** Fold to stereo, because this target explicitly asks for a stereo deliverable. */
  DownmixStereo = 'downmixStereo',
}

/**
 * FL-102. The channel arguments for a delivery, from the persisted stream facts.
 *
 * Preserving emits `-ac`, `-channel_layout` and `-ar` from what was probed and stored, and
 * emits *nothing at all* for a fact that is not known — an absent `-ac` leaves ffmpeg with the
 * source layout, which is the honest outcome, whereas a guessed one is a silent remix. A
 * stereo downmix is a single explicit `-ac 2`.
 */
export const getDeliveryAudioChannelArgs = (
  audioStream: Pick<MasterAudioStreamInfo, 'channels' | 'channelLayout' | 'sampleRate'> | undefined,
  policy: AudioChannelPolicy,
): string[] => {
  if (policy === AudioChannelPolicy.DownmixStereo) {
    return ['-ac', '2'];
  }

  if (!audioStream) {
    return [];
  }

  const args: string[] = [];
  if (audioStream.channels && audioStream.channels > 0) {
    args.push('-ac', String(audioStream.channels));
  }
  if (audioStream.channelLayout) {
    args.push('-channel_layout', audioStream.channelLayout);
  }
  if (audioStream.sampleRate && audioStream.sampleRate > 0) {
    args.push('-ar', String(audioStream.sampleRate));
  }
  return args;
};

/**
 * Rule 6. The audio channel layout survives the render.
 *
 * The shared playback output options force `-ac 2`, because a playback proxy is allowed to be
 * stereo. A master is not. This removes that downmix and then either:
 *
 * - stream-copies the source track, when the recipe does not touch audio and the codec is
 *   muxable into the `.mp4` master — the layout, sample rate and sample data are then bit-exact; or
 * - re-encodes while pinning the known channel count, layout and sample rate, and, when those
 *   are not known, emits no channel argument at all so ffmpeg keeps the source layout.
 *
 * A downmix is only ever produced by an explicit recipe, never by this policy.
 */
export const applyEditedMasterAudioPolicy = (
  outputOptions: string[],
  {
    audioStream,
    hasAudioFilters,
    muted,
  }: { audioStream?: MasterAudioStreamInfo; hasAudioFilters: boolean; muted: boolean },
): EditedMasterAudioPolicy => {
  removeArgPair(outputOptions, '-ac');

  if (!audioStream || muted) {
    return { streamCopy: false, args: [] };
  }

  const canStreamCopy =
    !hasAudioFilters && MP4_STREAM_COPYABLE_AUDIO_CODECS.has((audioStream.codecName ?? '').toLowerCase());

  if (canStreamCopy) {
    setArgValue(outputOptions, '-c:a', 'copy');
    return { streamCopy: true, args: [] };
  }

  return { streamCopy: false, args: getDeliveryAudioChannelArgs(audioStream, AudioChannelPolicy.Preserve) };
};

/** Removes a `--flag value` pair from an ffmpeg argument array, in place. */
const removeArgPair = (args: string[], flag: string): void => {
  for (let index = args.length - 2; index >= 0; index--) {
    if (args[index] === flag) {
      args.splice(index, 2);
    }
  }
};

/** Replaces the value of a `--flag value` pair in an ffmpeg argument array, in place. */
const setArgValue = (args: string[], flag: string, value: string): void => {
  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length) {
    args[index + 1] = value;
  }
};

/** Video codecs whose packets can be remuxed unchanged into the `.mp4` edited-master container. */
const MP4_STREAM_COPYABLE_VIDEO_CODECS = new Set(['h264', 'hevc', 'av1']);

/** Container format names whose packets can be remuxed into `.mp4` without re-encoding. */
const MP4_REMUXABLE_FORMATS = new Set(['mp4', 'mov', 'm4a', '3gp', '3g2']);

/**
 * A recipe that only turns the picture by a right angle does not need the pixels re-encoded: the
 * container's display matrix carries the rotation and every packet is preserved byte for byte.
 * This is the highest-fidelity master a quarter-turn recipe can have, so it is preferred whenever
 * it qualifies — and it qualifies only under conditions this renderer can honour:
 *
 * - the recipe is exactly one right-angle rotation and nothing else;
 * - the source carries no display matrix of its own, so there is no rotation to compose with;
 * - the video packets, and the audio packets if any, can be remuxed into the master container.
 *
 * Anything else falls back to the ordinary rendered master. The two paths are never confused for
 * one another: a failure to qualify changes the fidelity of the result, never its semantics.
 */
export const qualifyMetadataOnlyRotation = ({
  edits,
  videoStream,
  audioStream,
  format,
}: {
  edits: AssetEditActionItem[];
  videoStream: Pick<VideoStreamInfo, 'codecName' | 'rotation'>;
  audioStream?: Pick<AudioStreamInfo, 'codecName'>;
  format: Pick<VideoFormat, 'formatName'>;
}): { angle: number; displayRotation: number } | null => {
  if (edits.length !== 1) {
    return null;
  }

  const [edit] = edits;
  if (edit.action !== AssetEditAction.Rotate) {
    return null;
  }

  const angle = edit.parameters.angle;
  if (angle !== 90 && angle !== 180 && angle !== 270) {
    return null;
  }

  if (videoStream.rotation !== 0) {
    return null;
  }

  if (!MP4_STREAM_COPYABLE_VIDEO_CODECS.has((videoStream.codecName ?? '').toLowerCase())) {
    return null;
  }

  if (audioStream && !MP4_STREAM_COPYABLE_AUDIO_CODECS.has((audioStream.codecName ?? '').toLowerCase())) {
    return null;
  }

  const formatNames = (format.formatName ?? '').toLowerCase().split(',');
  if (formatNames.every((name) => !MP4_REMUXABLE_FORMATS.has(name.trim()))) {
    return null;
  }

  return { angle, displayRotation: getDisplayRotationDegrees(angle) };
};

/**
 * FL-113 (`Editor.jsx` Trim, "Fast · keyframes"): a recipe that is only a fast trim needs no
 * re-encode. The cut snaps to the keyframe at or before the in point, and every packet between is
 * copied, so it finishes in seconds and loses nothing. It qualifies under the same remux rules as
 * the metadata-only rotation; anything else, including a fast trim next to any other edit, renders
 * the ordinary frame-accurate master.
 */
export const qualifyStreamCopyTrim = ({
  edits,
  videoStream,
  audioStream,
  format,
}: {
  edits: AssetEditActionItem[];
  videoStream: Pick<VideoStreamInfo, 'codecName'>;
  audioStream?: Pick<AudioStreamInfo, 'codecName'>;
  format: Pick<VideoFormat, 'formatName'>;
}): { startMs: number; endMs: number } | null => {
  if (edits.length !== 1) {
    return null;
  }

  const [edit] = edits;
  if (edit.action !== AssetEditAction.Trim || edit.parameters.mode !== VideoTrimMode.Fast) {
    return null;
  }

  if (!MP4_STREAM_COPYABLE_VIDEO_CODECS.has((videoStream.codecName ?? '').toLowerCase())) {
    return null;
  }

  if (audioStream && !MP4_STREAM_COPYABLE_AUDIO_CODECS.has((audioStream.codecName ?? '').toLowerCase())) {
    return null;
  }

  const formatNames = (format.formatName ?? '').toLowerCase().split(',');
  if (formatNames.every((name) => !MP4_REMUXABLE_FORMATS.has(name.trim()))) {
    return null;
  }

  return { startMs: edit.parameters.startMs, endMs: edit.parameters.endMs };
};

/**
 * ffmpeg's `-display_rotation` is the rotation, in degrees **counter-clockwise**, that a player
 * should apply before displaying the picture. The recipe's angle is clockwise, so the sign flips;
 * the result is normalised into (-180, 180].
 */
export const getDisplayRotationDegrees = (angle: number): number => {
  const counterClockwise = -angle;
  return counterClockwise <= -180 ? counterClockwise + 360 : counterClockwise;
};

/** Rule 2. Lineage recorded for every edited master, still or moving. */
export const buildEditedMasterLineage = ({
  sourceAssetId,
  sourceOriginalPath,
  sourceChecksum = null,
  edits,
  color,
  rendererVersion = FRAMELEAF_RENDERER_VERSION,
  createdAt = new Date(),
}: {
  sourceAssetId: string;
  sourceOriginalPath: string;
  sourceChecksum?: string | null;
  edits: AssetEditActionItem[];
  color: EditedMasterColorDecision;
  rendererVersion?: string;
  createdAt?: Date;
}): EditedMasterLineage => ({
  schemaVersion: EDITED_MASTER_LINEAGE_SCHEMA_VERSION,
  sourceAssetId,
  sourceOriginalPath,
  sourceChecksum,
  recipeRevision: computeRecipeRevision(edits),
  recipeActions: edits.map((edit) => edit.action),
  renderer: FRAMELEAF_RENDERER,
  rendererVersion,
  color,
  createdAt: createdAt.toISOString(),
});

/**
 * FL-39: probe-backed validation of a rendered edited master, before anything references it.
 *
 * - The displayed raster (after any display matrix) must be the one the recipe produces, and the
 *   stored rotation must be exactly the one the plan wrote: zero for a baked render, the display
 *   rotation for a packet-preserving quarter turn.
 * - A packet copy must carry the source's pixel format and colour tags unchanged.
 * - A preserving render must not lose bit depth and must keep every colour tag the source
 *   declared. A tone-mapped render must no longer be HDR.
 */
export const validateVideoMaster = ({
  source,
  output,
  dimensions,
  expectedRotation = 0,
  colorDecision,
  packetCopy = false,
}: {
  source: Pick<VideoStreamInfo, 'pixelFormat' | 'colorPrimaries' | 'colorMatrix' | 'colorTransfer'>;
  output?: Pick<
    VideoStreamInfo,
    'width' | 'height' | 'rotation' | 'pixelFormat' | 'colorPrimaries' | 'colorMatrix' | 'colorTransfer'
  >;
  dimensions: { width: number; height: number };
  expectedRotation?: number;
  colorDecision: EditedMasterColorDecision;
  packetCopy?: boolean;
}): void => {
  const fail = (message: string) => {
    throw new MediaPolicyError(MediaPolicyViolation.MasterValidationFailed, message);
  };
  const quarterTurn = !!output && Math.abs(output.rotation) % 180 === 90;
  if (
    !output ||
    (quarterTurn ? output.height : output.width) !== dimensions.width ||
    (quarterTurn ? output.width : output.height) !== dimensions.height ||
    (output.rotation - expectedRotation) % 360 !== 0
  ) {
    fail('Edited-master display dimensions do not match the recipe');
    return;
  }

  const tags = ['colorPrimaries', 'colorMatrix', 'colorTransfer'] as const;
  const unknown = {
    colorPrimaries: ColorPrimaries.Unknown,
    colorMatrix: ColorMatrix.Unknown,
    colorTransfer: ColorTransfer.Unknown,
  } as const;
  if (packetCopy) {
    if (output.pixelFormat !== source.pixelFormat || tags.some((tag) => output[tag] !== source[tag])) {
      fail('Edited-master packet copy changed the source pixel format or colour intent');
    }
    return;
  }

  if (colorDecision.policy === EditedMasterColorPolicy.ToneMap) {
    if (isHdrTransfer(output)) {
      fail('Tone-mapped edited master is still tagged as HDR');
    }
    return;
  }

  if (isHighBitDepth(source) && !isHighBitDepth(output)) {
    fail('Edited-master pixel format does not preserve source precision');
  }
  if (tags.some((tag) => source[tag] !== unknown[tag] && output[tag] !== source[tag])) {
    fail('Edited-master color intent does not match the source');
  }
};

/** The sidecar that carries an edited master's lineage, beside the master itself. */
export const getEditedMasterLineagePath = (masterPath: string): string =>
  `${masterPath}${EDITED_MASTER_LINEAGE_SUFFIX}`;

export const serializeEditedMasterLineage = (lineage: EditedMasterLineage): Buffer =>
  Buffer.from(`${JSON.stringify(lineage, null, 2)}\n`, 'utf8');
