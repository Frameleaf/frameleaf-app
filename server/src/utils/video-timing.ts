/**
 * The original frame timestamp mapping of a video source (FL-93 / `VID-102`).
 *
 * A container does not store "29.97 fps". It stores a time base — `1/30000` seconds per tick —
 * and one integer presentation timestamp per picture. For a constant-rate source those
 * timestamps happen to be evenly spaced; for a variable-rate one (a phone that dropped its rate
 * in low light, a burst with gaps, a screen recording) they are not, and there is no fps that
 * describes them. There is also no rule that they start at zero: an edit list, a recording that
 * begins mid-stream or a pre-roll gives the stream a nonzero origin, and an export that assumes
 * zero shifts every frame in the file.
 *
 * This module turns what the media repository already probes into that mapping, expressed in
 * exact rational time, and makes the one decision the acceptance criteria say must never be
 * implicit: whether the output keeps the source's own timestamps or is converted to a declared
 * cadence. Coercing a variable-rate source onto a nominal fps is a loss; it is allowed only
 * when a caller asked for it in so many words, and it is reported either way.
 *
 * Nothing here decodes, spawns or reads a file: it is the same framework-free shape as
 * `media-policy.ts`, so the transcode services, the Studio render path and their specs share one
 * mapping instead of each deriving their own.
 */
import type { VideoPacketInfo, VideoStreamInfo } from 'src/types.js';
import {
  type Rational,
  type TimeBase,
  coerceRational,
  equals,
  formatRational,
  rational,
  secondsToTicks,
  ticksToSeconds,
  toTrackTimescale,
} from 'src/utils/rational-time.js';

/** Thrown when a timing decision cannot be made without guessing. */
export class VideoTimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoTimingError';
  }
}

/**
 * One source's original timing, in its own time base. Every field is either something ffprobe
 * reported or something derived from it exactly; nothing here is a nominal stand-in.
 */
export interface VideoTimingMap {
  /** Seconds per tick, exactly as the container declares it. */
  timeBase: TimeBase;
  /** The earliest presentation timestamp in the stream, in ticks. Often, but not always, 0. */
  originTicks: number;
  /**
   * The source's own average cadence, when the container declares one exactly, and `null` when
   * it does not — including when it only reached us as a float, because a float cannot be turned
   * back into `30000/1001` without guessing and guessing is the failure this story exists to
   * prevent. For a variable-rate source this is an *average* and describes no individual frame,
   * so every decision below consults `variableFrameRate` before it consults this.
   */
  cadence: Rational | null;
  /** True when the scanned packets do not all share one duration. */
  variableFrameRate: boolean;
  /** Keyframe presentation timestamps in ticks, in the order the scan found them. */
  keyframeTicks: readonly number[];
  /** Each keyframe's own packet duration in ticks; a VFR source varies here. */
  keyframeDurationTicks: readonly number[];
  /** Summed packet duration in ticks, including discarded pre-roll. */
  totalDurationTicks: number;
  /** Post-discard packet count. */
  packetCount: number;
}

/**
 * The exact source time base. The probe's rational is preferred; the integer `timeBase` that the
 * schema persists is the fallback and means `1/n`, which is what every container the fork has
 * met actually declares.
 */
export const resolveSourceTimeBase = (
  videoStream: Pick<VideoStreamInfo, 'timeBase' | 'timeBaseRational'>,
): TimeBase | null => {
  const exact = coerceRational(videoStream.timeBaseRational);
  if (exact && exact.num > 0) {
    return exact;
  }

  const denominator = videoStream.timeBase;
  if (denominator && Number.isSafeInteger(denominator) && denominator > 0) {
    return rational(1, denominator);
  }

  return null;
};

/**
 * The exact source cadence, or null. Deliberately does *not* fall back to `frameRate`: that
 * field is `30000/1001` already flattened to 29.97002997002997, and rebuilding a fraction from
 * it would be inventing a cadence the container never declared.
 */
export const resolveSourceCadence = (videoStream: Pick<VideoStreamInfo, 'frameRateRational'>): Rational | null => {
  const exact = coerceRational(videoStream.frameRateRational);
  return exact && exact.num > 0 ? exact : null;
};

/**
 * Whether the packet scan found a genuinely variable rate. The recorded flag is authoritative;
 * for a mapping rebuilt from persisted keyframe rows, where the flag was not stored, varying
 * keyframe durations are the evidence that survives.
 */
export const isVariableFrameRate = (packets: Pick<VideoPacketInfo, 'keyframeOwnDuration' | 'variableFrameRate'>) => {
  if (typeof packets.variableFrameRate === 'boolean') {
    return packets.variableFrameRate;
  }

  const durations = packets.keyframeOwnDuration ?? [];
  return durations.some((duration) => duration !== durations[0]);
};

/**
 * The stream's origin in ticks. The recorded minimum is authoritative; packets arrive in decode
 * order, so with B-frames the first line is not necessarily the earliest picture. For a mapping
 * rebuilt from persisted rows, the first keyframe is the origin — the first packet of a video
 * stream is a keyframe, so that row is the same timestamp.
 */
export const resolveOriginTicks = (packets: Pick<VideoPacketInfo, 'keyframePts' | 'startPts'>): number => {
  if (typeof packets.startPts === 'number') {
    return packets.startPts;
  }

  const keyframePts = packets.keyframePts ?? [];
  return keyframePts.length > 0 ? Math.min(...keyframePts) : 0;
};

/**
 * Assemble the mapping. Returns null when the source has no usable time base, which is the same
 * condition the existing thumbnail and HLS paths already refuse on, rather than inventing one.
 */
export const buildVideoTimingMap = ({
  videoStream,
  packets,
}: {
  videoStream: Pick<VideoStreamInfo, 'timeBase' | 'timeBaseRational' | 'frameRateRational'>;
  packets: VideoPacketInfo;
}): VideoTimingMap | null => {
  const timeBase = resolveSourceTimeBase(videoStream);
  if (!timeBase) {
    return null;
  }

  return {
    timeBase,
    originTicks: resolveOriginTicks(packets),
    cadence: resolveSourceCadence(videoStream),
    variableFrameRate: isVariableFrameRate(packets),
    keyframeTicks: packets.keyframePts,
    keyframeDurationTicks: packets.keyframeOwnDuration,
    totalDurationTicks: packets.totalDuration,
    packetCount: packets.packetCount,
  };
};

/** The stream's origin as an exact number of seconds. Zero for an ordinary file. */
export const timingMapOrigin = (map: VideoTimingMap): Rational => ticksToSeconds(map.originTicks, map.timeBase);

/** The stream's total duration as an exact number of seconds. */
export const timingMapDuration = (map: VideoTimingMap): Rational =>
  ticksToSeconds(map.totalDurationTicks, map.timeBase);

/**
 * Keyframe timestamps as exact seconds **relative to the stream origin**, which is what a
 * timeline, a seek and a chunk boundary all mean by "at 3 seconds". Absolute timestamps stay
 * available as `map.keyframeTicks`, because that is what gets muxed.
 */
export const keyframeTimes = (map: VideoTimingMap): Rational[] =>
  map.keyframeTicks.map((ticks) => ticksToSeconds(ticks - map.originTicks, map.timeBase));

/** Seconds relative to the origin, for an absolute source timestamp. */
export const ticksToSourceTime = (map: VideoTimingMap, ticks: number): Rational =>
  ticksToSeconds(ticks - map.originTicks, map.timeBase);

/**
 * The absolute source timestamp for a time on the timeline. The origin is added back, so a trim
 * at 0 lands on the stream's own first frame rather than on tick zero of a file that never had
 * one.
 */
export const sourceTimeToTicks = (map: VideoTimingMap, seconds: Rational): number =>
  secondsToTicks(seconds, map.timeBase) + map.originTicks;

/** The `-video_track_timescale` value that keeps this source's timestamps exact. */
export const timingMapTrackTimescale = (map: VideoTimingMap): number => toTrackTimescale(map.timeBase);

/* ------------------------------------------------------------------ */
/* Output cadence                                                       */
/* ------------------------------------------------------------------ */

export enum OutputCadenceMode {
  /** The source's own presentation timestamps are muxed unchanged. */
  Passthrough = 'passthrough',
  /** Frames are resampled onto a declared constant cadence. A recorded, deliberate loss. */
  Convert = 'convert',
}

export interface OutputCadenceDecision {
  mode: OutputCadenceMode;
  /** The output cadence when converting; null when passing through. */
  cadence: Rational | null;
  /** Why, in words, so the choice can be read back off a job or a lineage sidecar. */
  reason: string;
}

/**
 * Decide the output cadence, and never decide it silently.
 *
 * - One source and nothing declared: passthrough. An unchanged single-source export keeps its
 *   PTS, VFR included, which is the preservation requirement.
 * - One source and a declared cadence that the source already has: still passthrough. Declaring
 *   the rate a constant-rate source already runs at is not a conversion, and resampling it would
 *   only add rounding.
 * - One source and a different declared cadence: convert, recorded as such.
 * - More than one source: a cadence must be declared. Composition has to put every track on one
 *   grid, and picking one on the caller's behalf is exactly the silent coercion this story
 *   forbids, so an undeclared multi-source composition throws instead.
 */
export const resolveOutputCadence = ({
  sources,
  declaredCadence = null,
}: {
  sources: readonly VideoTimingMap[];
  declaredCadence?: Rational | null;
}): OutputCadenceDecision => {
  if (sources.length === 0) {
    throw new VideoTimingError('An output cadence needs at least one source.');
  }

  if (sources.length > 1) {
    if (!declaredCadence) {
      throw new VideoTimingError(
        `Composing ${sources.length} sources needs a declared output cadence; ` +
          'choosing one implicitly would resample every track without a record of it.',
      );
    }

    return {
      mode: OutputCadenceMode.Convert,
      cadence: declaredCadence,
      reason: `Composition of ${sources.length} sources onto the declared cadence ${formatRational(declaredCadence)}.`,
    };
  }

  const [source] = sources;
  if (!declaredCadence) {
    return {
      mode: OutputCadenceMode.Passthrough,
      cadence: null,
      reason: source.variableFrameRate
        ? 'Single variable-frame-rate source; its presentation timestamps are preserved.'
        : 'Single source; its presentation timestamps are preserved.',
    };
  }

  if (!source.variableFrameRate && source.cadence && equals(source.cadence, declaredCadence)) {
    return {
      mode: OutputCadenceMode.Passthrough,
      cadence: null,
      reason: `Declared cadence ${formatRational(declaredCadence)} is the source's own; nothing is resampled.`,
    };
  }

  return {
    mode: OutputCadenceMode.Convert,
    cadence: declaredCadence,
    reason: source.variableFrameRate
      ? `A variable-frame-rate source is resampled onto the declared cadence ${formatRational(declaredCadence)}; ` +
        'the original timing is preserved only in the source file.'
      : `The source cadence is resampled onto the declared cadence ${formatRational(declaredCadence)}.`,
  };
};

/**
 * The cadence every source already shares, or null when they do not share one. A caller uses it
 * to *declare* a composition's cadence deliberately; it is never applied on its own, because a
 * derived value silently applied is the same loss as a guessed one.
 */
export const deriveCommonCadence = (sources: readonly VideoTimingMap[]): Rational | null => {
  if (sources.length === 0) {
    return null;
  }

  const [first, ...rest] = sources;
  if (first.variableFrameRate || !first.cadence) {
    return null;
  }

  const cadence = first.cadence;
  return rest.every((source) => !source.variableFrameRate && source.cadence && equals(source.cadence, cadence))
    ? cadence
    : null;
};
