/**
 * The Studio timeline's one timing mapping (FL-93 / `VID-102`).
 *
 * A Studio project is edited on a grid of whole frames at the project's cadence, and every clip on
 * it reads its own source, which has a time base, an origin and — for a phone, a burst or a screen
 * recording — no constant cadence at all. Preview, audio and the encoder each have to answer the
 * same question: *which source instant does timeline frame N show?* When each answers it with its
 * own arithmetic, a 29.97 project drifts against its 30000/1001 source, a variable-rate clip is
 * stretched onto a nominal grid, and a render split into chunks disagrees with its own preview at
 * every boundary. So they answer it here, once:
 *
 * - The project cadence is exact. A graph stores it as `metadata.frameRate` (`{ num, den }`);
 *   Freecut's own `metadata.fps` stays beside it as the engine's float. A legacy graph with only
 *   `fps` is read exactly when that number is an integer or one of the broadcast `x/1001` rates,
 *   and refused otherwise rather than approximated.
 * - A timeline frame's time is `frame / cadence`, never an accumulated sum.
 * - A clip's source instant is its source start plus the clip-local time times its speed (or, when
 *   reversed, back from its source end), all in exact rationals.
 * - The picture a source presents at an instant is the last one whose timestamp is not after it:
 *   `origin + floor(t / timeBase)` ticks. A variable-rate source is never placed on a grid.
 * - The audio sample at an instant is `floor(t · sampleRate)`.
 *
 * The file is mirrored at `web/src/lib/frameleaf/studio/studio-timing.ts`, identical apart from the
 * import path of `rational-time`; the server spec asserts it.
 */
import {
  type Rational,
  add,
  coerceRational,
  divide,
  floor,
  frameDuration,
  frameStartTime,
  fromInteger,
  invert,
  isInteger,
  max,
  multiply,
  rational,
  roundToInteger,
  subtract,
  tryParseRational,
} from './rational-time';

export class StudioTimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioTimingError';
  }
}

/** Broadcast rates a legacy graph could only spell as a rounded decimal. */
const NTSC_NUMERATORS = [24_000, 30_000, 48_000, 60_000, 120_000];

/**
 * The exact cadence a stored `fps` number stands for, or null when it stands for none.
 *
 * An integer is itself. `29.97`, `23.976`, `59.94` — and the float `30000 / 1001` itself — are the
 * NTSC rates they have always meant: the decimal is the rounded spelling of `x/1001` to three
 * places, and nothing else a person picks rounds to it. Any other fraction is not guessed at.
 */
export const cadenceFromDecimal = (fps: unknown): Rational | null => {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    return null;
  }
  if (Number.isSafeInteger(fps)) {
    return rational(fps, 1);
  }
  for (const numerator of NTSC_NUMERATORS) {
    const exact = numerator / 1001;
    if (Math.abs(fps - exact) < 1e-9 || Math.round(exact * 1000) / 1000 === fps) {
      return rational(numerator, 1001);
    }
  }
  return null;
};

/** A positive rational read from a stored graph, or null. */
const positiveRational = (value: unknown): Rational | null => {
  const parsed = coerceRational(value);
  return parsed && parsed.num > 0 ? parsed : null;
};

/**
 * The project cadence a stored graph's `metadata` declares.
 *
 * `frameRate` is authoritative while it still describes the engine's `fps`: when a person changes
 * the rate in the editor, Freecut writes only `fps`, and the rational that no longer matches it is
 * stale, so the new `fps` is read instead.
 */
export const projectCadenceOf = (metadata: unknown): Rational | null => {
  const record = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const stored = positiveRational(record.frameRate);
  const fps = typeof record.fps === 'number' ? record.fps : null;
  if (stored && (fps === null || Math.abs(stored.num / stored.den - fps) < 1e-9)) {
    return stored;
  }
  return cadenceFromDecimal(fps);
};

/**
 * `metadata` with its exact cadence written down: `frameRate` as the rational and `fps` as the
 * engine's float of that same rational. Other fields are left alone. Throws for a legacy rate that
 * has no exact reading, rather than storing an approximation as if it were exact.
 */
export const withProjectCadence = <T extends object>(metadata: T): T & { fps: number; frameRate: Rational } => {
  const cadence = projectCadenceOf(metadata);
  if (!cadence) {
    const fps = (metadata as { fps?: unknown }).fps;
    throw new StudioTimingError(`The project frame rate ${String(fps)} has no exact reading.`);
  }
  return { ...metadata, fps: cadence.num / cadence.den, frameRate: { num: cadence.num, den: cadence.den } };
};

/* ------------------------------------------------------------------ */
/* Timeline frames                                                      */
/* ------------------------------------------------------------------ */

/** The exact start of timeline frame `frame`. */
export const timelineFrameTime = (frame: number, cadence: Rational): Rational => frameStartTime(frame, cadence);

/** The timeline frame nearest to an exact time; halves round away from zero. */
export const nearestTimelineFrame = (time: Rational, cadence: Rational): number =>
  roundToInteger(multiply(time, cadence), 'nearest');

/**
 * A playback speed as an exact rational. Freecut stores speed as a decimal with at most a few
 * places (0.25, 1.5, 2); four places reads every value the editor can produce exactly.
 */
export const speedOf = (speed: unknown): Rational => {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) {
    return rational(1, 1);
  }
  return rational(Math.round(speed * 10_000), 10_000);
};

/* ------------------------------------------------------------------ */
/* Sources                                                              */
/* ------------------------------------------------------------------ */

/**
 * One source's timing as a render job carries it: everything needed to find the picture and the
 * sample a timeline instant shows. Strings are `num/den`, as ffmpeg spells them.
 */
export type StudioSourceTiming = {
  /** The manifest key of the source (`library-asset:<id>`). */
  key: string;
  assetId: string;
  /** Seconds per tick of the source's video stream, exactly as the container declares it. */
  timeBase: string;
  /** The earliest presentation timestamp, in ticks. Often, but not always, 0. */
  originTicks: number;
  /** The source's own constant cadence, or null for a variable-rate source or one not stated. */
  cadence: string | null;
  variableFrameRate: boolean;
  /** The MP4 track timescale that keeps this source's timestamps exact. */
  trackTimescale: number;
  /** The source's audio, when it has any. */
  audio: { sampleRate: number | null; channels: number | null; channelLayout: string | null } | null;
};

/** A clip as the mapping needs it, in the units Freecut stores. */
export type StudioClipTiming = {
  /** The clip's first timeline frame. */
  from: number;
  /** Source start, in frames of `sourceCadence`. */
  sourceStart?: number;
  /** Source end, in frames of `sourceCadence`; needed for a reversed clip. */
  sourceEnd?: number;
  /** The cadence the clip's `source*` frame fields are counted in. */
  sourceCadence: Rational;
  speed?: number;
  reversed?: boolean;
};

/**
 * The source instant, relative to the source origin, that timeline frame `frame` of `clip` shows.
 *
 * Forward: `sourceStart + (frame − from) / cadence · speed`. Reversed, the clip walks back from its
 * source end, and frame 0 shows the picture presented just before that end.
 */
export const clipSourceTime = (clip: StudioClipTiming, frame: number, projectCadence: Rational): Rational => {
  const speed = speedOf(clip.speed);
  const local = multiply(timelineFrameTime(frame - clip.from, projectCadence), speed);
  const start = frameStartTime(clip.sourceStart ?? 0, clip.sourceCadence);
  if (!clip.reversed) {
    return add(start, local);
  }
  if (clip.sourceEnd === undefined) {
    throw new StudioTimingError('A reversed clip needs its source end.');
  }
  const end = frameStartTime(clip.sourceEnd, clip.sourceCadence);
  const back = subtract(end, add(local, multiply(frameDuration(projectCadence), speed)));
  return max(start, back);
};

const sourceTimeBase = (source: Pick<StudioSourceTiming, 'timeBase'>): Rational => {
  const timeBase = tryParseRational(source.timeBase);
  if (!timeBase || timeBase.num <= 0) {
    throw new StudioTimingError(`Source time base '${source.timeBase}' is not usable.`);
  }
  return timeBase;
};

/**
 * The absolute presentation timestamp, in the source's own ticks, of the picture shown at a source
 * instant: the last one that starts at or before it. For a variable-rate source this is the real
 * picture, not a slot on a nominal grid.
 */
export const sourcePresentationTicks = (
  source: Pick<StudioSourceTiming, 'timeBase' | 'originTicks'>,
  time: Rational,
): number => source.originTicks + floor(divide(time, sourceTimeBase(source)));

/** The index of the audio sample playing at a source instant. */
export const audioSampleAt = (time: Rational, sampleRate: number): number =>
  floor(multiply(time, fromInteger(sampleRate)));

/* ------------------------------------------------------------------ */
/* Output grid                                                          */
/* ------------------------------------------------------------------ */

/**
 * The output tick grid a job's chunks are planned on, in seconds per tick. A composition converted
 * to the declared cadence ticks once per frame (`1001/30000`); a single source passed through keeps
 * its own time base, so its timestamps are muxed unchanged.
 */
export const outputTimeBase = (
  decision: { mode: 'passthrough' | 'convert'; cadence: string | null },
  sources: readonly Pick<StudioSourceTiming, 'timeBase'>[],
): Rational => {
  if (decision.mode === 'convert') {
    const cadence = tryParseRational(decision.cadence ?? '');
    if (!cadence || cadence.num <= 0) {
      throw new StudioTimingError('A converted output needs its declared cadence.');
    }
    return invert(cadence);
  }
  if (sources.length !== 1) {
    throw new StudioTimingError('Only a single source can pass its timestamps through.');
  }
  return sourceTimeBase(sources[0]!);
};

/** The output tick at which timeline frame `frame` starts, when that instant is on the grid. */
export const timelineFrameTicks = (frame: number, cadence: Rational, timeBase: Rational): number | null => {
  const ticks = divide(timelineFrameTime(frame, cadence), timeBase);
  return isInteger(ticks) ? ticks.num : null;
};

/** True when a chunk boundary, in ticks of `timeBase`, is the start of a whole timeline frame. */
export const isFrameBoundary = (ticks: number, cadence: Rational, timeBase: Rational): boolean =>
  isInteger(multiply(multiply(fromInteger(ticks), timeBase), cadence));
