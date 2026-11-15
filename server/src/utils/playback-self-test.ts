import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemConfig } from 'src/dtos/config.dto.js';
import type { VideoStreamInfo } from 'src/types.js';
import {
  ColorTransfer,
  DvProfile,
  DvSignalCompatibility,
  SystemMetadataKey,
  TranscodeHardwareAcceleration,
  VideoCodec,
} from 'src/enum.js';

/**
 * FL-977: the kinds of video the playback self-test converts, one reference clip each
 * (`resources/playback-self-test`). They are also what `ffmpeg.softwareFallback` names: a kind listed
 * there is converted on the processor whatever `ffmpeg.accel` says.
 */
export const PLAYBACK_SELF_TEST_CASES = ['sdr-h264', 'hlg-hevc', 'dolby-vision-8.4', 'hdr10-pq', 'hev1-hevc'] as const;
export type PlaybackSelfTestCase = (typeof PLAYBACK_SELF_TEST_CASES)[number];

/** The HDR kinds: what Video playback copies › Speed says "HDR" about. */
export const HDR_PLAYBACK_CASES: readonly PlaybackSelfTestCase[] = ['hlg-hevc', 'dolby-vision-8.4', 'hdr10-pq'];

/** What can be wrong with a playback copy of a reference clip. */
export type PlaybackSelfTestProblem =
  /** The converter stopped with an error. */
  | 'convert-failed'
  /** The copy is not in the format playback copies are made in. */
  | 'codec'
  /** The format is right but its tag is not the one Apple devices play (hev1 instead of hvc1, say). */
  | 'codec-tag'
  /** The colour tags do not say what the picture is, so players show the wrong colours. */
  | 'colour-tags'
  | 'too-dark'
  | 'too-bright'
  /** Clearly brighter or darker than the same clip converted on the processor. */
  | 'brightness-differs';

export type PlaybackSelfTestCaseResult = {
  id: PlaybackSelfTestCase;
  passed: boolean;
  problems: PlaybackSelfTestProblem[];
  /** Whether the copy was made on the graphics card (false when the check ran on the processor). */
  hardware: boolean;
  meanLuma: number | null;
  referenceMeanLuma: number | null;
  codecName: string | null;
  codecTag: string | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  seconds: number | null;
};

export type PlaybackSelfTestReason = 'manual' | 'upgrade' | 'settings';

/**
 * FL-977: the system metadata key of the latest check. It's a plain string, not a `SystemMetadataKey`
 * member: `src/enum.ts` is a schema-catalog source, so adding to it needs a full catalog recapture for
 * what isn't a schema change.
 */
export const PLAYBACK_SELF_TEST_KEY = 'playback-self-test' as SystemMetadataKey;

/** The latest check, stored under {@link PLAYBACK_SELF_TEST_KEY}. */
export type PlaybackSelfTestState = {
  /** `running` while it converts; `done` when every kind was checked; `failed` when the check could not finish. */
  status: 'running' | 'done' | 'failed';
  reason: PlaybackSelfTestReason;
  serverVersion: string;
  startedAt: string;
  finishedAt: string | null;
  accel: TranscodeHardwareAcceleration;
  accelDecode: boolean;
  cases: PlaybackSelfTestCaseResult[];
  /** The kinds this check put on the processor (`ffmpeg.softwareFallback` as it left it). */
  softwareFallback: PlaybackSelfTestCase[];
  error: string | null;
};

/** What `MediaRepository.inspectPlaybackCopy` reads from a copy. */
export type PlaybackCopyFacts = {
  codecName: string | null;
  codecTag: string | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  /** Mean Rec. 709 luma (0–255) of the frame at 0.5 s. */
  meanLuma: number;
};

export type PlaybackSelfTestManifestCase = {
  id: PlaybackSelfTestCase;
  file: string;
  description: string;
  bytes: number;
  source: {
    codecName: string;
    codecTag: string;
    pixelFormat: string;
    colorPrimaries: string;
    colorTransfer: string;
    colorMatrix: string;
    dvProfile?: number;
    dvBlSignalCompatibilityId?: number;
  };
  sourceMeanLuma: number;
  toneMappedLuma: { min: number; max: number } | null;
};

export type PlaybackSelfTestManifest = {
  description: string;
  lumaTolerance: number;
  referenceTolerance: number;
  cases: PlaybackSelfTestManifestCase[];
};

export const PLAYBACK_SELF_TEST_FOLDER = join(import.meta.dirname, '../../resources/playback-self-test');

/** The whole check stops after this long; a kind not reached by then counts as failed. */
export const PLAYBACK_SELF_TEST_DEADLINE_MS = 55_000;

let manifest: PlaybackSelfTestManifest | undefined;
export const readPlaybackSelfTestManifest = (): PlaybackSelfTestManifest => {
  manifest ??= JSON.parse(
    readFileSync(join(PLAYBACK_SELF_TEST_FOLDER, 'manifest.json'), 'utf8'),
  ) as PlaybackSelfTestManifest;
  return manifest;
};

/** Which reference clip a video is like, for `ffmpeg.softwareFallback`. */
export const playbackSelfTestCaseOf = (
  stream: Pick<VideoStreamInfo, 'codecName' | 'colorTransfer' | 'dvProfile' | 'dvBlSignalCompatibilityId'>,
): PlaybackSelfTestCase => {
  if (stream.dvProfile === DvProfile.Dvhe08 && stream.dvBlSignalCompatibilityId === DvSignalCompatibility.Hlg) {
    return 'dolby-vision-8.4';
  }
  if (stream.colorTransfer === ColorTransfer.Smpte2084) {
    return 'hdr10-pq';
  }
  if (stream.colorTransfer === ColorTransfer.AribStdB67) {
    return 'hlg-hevc';
  }
  // The stored stream keeps no sample-entry tag, so every SDR HEVC video goes with the hev1 clip.
  return stream.codecName === 'hevc' ? 'hev1-hevc' : 'sdr-h264';
};

/**
 * FL-977: the settings a playback copy of this video is made with. A kind listed in
 * `ffmpeg.softwareFallback` is converted on the processor; anything else keeps the configured card.
 */
export const withSoftwareFallback = <T extends Pick<SystemConfig['ffmpeg'], 'accel' | 'accelDecode'>>(
  ffmpeg: T & { softwareFallback?: readonly string[] },
  stream: Parameters<typeof playbackSelfTestCaseOf>[0],
): { ffmpeg: T; fallback: PlaybackSelfTestCase | null } => {
  if (ffmpeg.accel === TranscodeHardwareAcceleration.Disabled || !ffmpeg.softwareFallback?.length) {
    return { ffmpeg, fallback: null };
  }
  const kind = playbackSelfTestCaseOf(stream);
  if (!ffmpeg.softwareFallback.includes(kind)) {
    return { ffmpeg, fallback: null };
  }
  return { ffmpeg: { ...ffmpeg, accel: TranscodeHardwareAcceleration.Disabled, accelDecode: false }, fallback: kind };
};

/** The settings whose change makes the self-test run again. */
const CHECKED_SETTINGS = ['accel', 'accelDecode', 'preferredHwDevice', 'tonemap', 'targetVideoCodec'] as const;
export const playbackSettingsChanged = (before: SystemConfig['ffmpeg'], after: SystemConfig['ffmpeg']) =>
  CHECKED_SETTINGS.some((key) => before[key] !== after[key]);

/** The sample-entry tag each target format must carry in an MP4 for Apple devices to play it. */
const CODEC_TAGS: Record<VideoCodec, string> = {
  [VideoCodec.H264]: 'avc1',
  [VideoCodec.Hevc]: 'hvc1',
  [VideoCodec.Av1]: 'av01',
  [VideoCodec.Vp9]: 'vp09',
};
/** ffprobe's name of each target format. */
const CODEC_NAMES: Record<VideoCodec, string> = {
  [VideoCodec.H264]: 'h264',
  [VideoCodec.Hevc]: 'hevc',
  [VideoCodec.Av1]: 'av1',
  [VideoCodec.Vp9]: 'vp9',
};

/**
 * What is wrong with a playback copy of `clip`, judged against the manifest and, for a copy made on the
 * graphics card, against the same clip converted on the processor (`reference`).
 */
export const judgePlaybackCopy = (
  clip: PlaybackSelfTestManifestCase,
  copy: PlaybackCopyFacts,
  options: {
    targetVideoCodec: VideoCodec;
    toneMapped: boolean;
    lumaTolerance: number;
    referenceTolerance: number;
    reference?: PlaybackCopyFacts | null;
  },
): PlaybackSelfTestProblem[] => {
  const problems: PlaybackSelfTestProblem[] = [];
  if (copy.codecName !== CODEC_NAMES[options.targetVideoCodec]) {
    problems.push('codec');
  } else if (copy.codecTag !== CODEC_TAGS[options.targetVideoCodec]) {
    problems.push('codec-tag');
  }

  const hdrSource = clip.toneMappedLuma !== null;
  const toneMapped = hdrSource && options.toneMapped;
  // Tone mapped and SDR copies are BT.709; with tone mapping off an HDR copy keeps its own colours.
  const expected = hdrSource && !toneMapped ? clip.source : { colorPrimaries: 'bt709', colorTransfer: 'bt709' };
  if (copy.colorPrimaries !== expected.colorPrimaries || copy.colorTransfer !== expected.colorTransfer) {
    problems.push('colour-tags');
  }

  if (toneMapped && clip.toneMappedLuma) {
    if (copy.meanLuma < clip.toneMappedLuma.min) {
      problems.push('too-dark');
    } else if (copy.meanLuma > clip.toneMappedLuma.max) {
      problems.push('too-bright');
    }
  } else if (Math.abs(copy.meanLuma - clip.sourceMeanLuma) > options.lumaTolerance) {
    problems.push(copy.meanLuma < clip.sourceMeanLuma ? 'too-dark' : 'too-bright');
  }

  if (options.reference && Math.abs(copy.meanLuma - options.reference.meanLuma) > options.referenceTolerance) {
    problems.push('brightness-differs');
  }
  return problems;
};
