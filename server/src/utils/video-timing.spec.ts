import { describe, expect, it } from 'vitest';
import type { VideoPacketInfo, VideoStreamInfo } from 'src/types.js';
import { FRAME_RATE_NTSC_24, FRAME_RATE_NTSC_30 } from 'src/utils/rational-time.js';
import {
  OutputCadenceMode,
  VideoTimingError,
  buildVideoTimingMap,
  deriveCommonCadence,
  isVariableFrameRate,
  keyframeTimes,
  resolveOriginTicks,
  resolveOutputCadence,
  resolveSourceCadence,
  resolveSourceTimeBase,
  sourceTimeToTicks,
  ticksToSourceTime,
  timingMapDuration,
  timingMapOrigin,
  timingMapTrackTimescale,
} from 'src/utils/video-timing.js';

type Stream = Pick<VideoStreamInfo, 'timeBase' | 'timeBaseRational' | 'frameRateRational'>;

const ntscStream: Stream = {
  timeBase: 30_000,
  timeBaseRational: { num: 1, den: 30_000 },
  frameRateRational: { num: 30_000, den: 1001 },
};

/** One second of 29.97 fps, keyframes every 30 frames, starting at tick 0. */
const cfrPackets = (overrides: Partial<VideoPacketInfo> = {}): VideoPacketInfo => ({
  totalDuration: 30_030,
  packetCount: 30,
  outputFrames: 30,
  keyframePts: [0, 30_030],
  keyframeAccDuration: [1001, 31_031],
  keyframeOwnDuration: [1001, 1001],
  startPts: 0,
  variableFrameRate: false,
  ...overrides,
});

describe('resolveSourceTimeBase', () => {
  it('prefers the exact rational the probe reported', () => {
    expect(resolveSourceTimeBase(ntscStream)).toEqual({ num: 1, den: 30_000 });
  });

  it('keeps a time base that carries a numerator instead of flattening it', () => {
    expect(resolveSourceTimeBase({ timeBase: 30_000, timeBaseRational: { num: 1001, den: 30_000 } })).toEqual({
      num: 1001,
      den: 30_000,
    });
  });

  it('falls back to the persisted denominator as 1/n', () => {
    expect(resolveSourceTimeBase({ timeBase: 600 })).toEqual({ num: 1, den: 600 });
    expect(resolveSourceTimeBase({ timeBase: 90_000, timeBaseRational: null })).toEqual({ num: 1, den: 90_000 });
  });

  it('reduces an unreduced pair that arrived from storage', () => {
    expect(resolveSourceTimeBase({ timeBase: 600, timeBaseRational: { num: 2, den: 1200 } })).toEqual({
      num: 1,
      den: 600,
    });
  });

  it('reports no time base rather than inventing one', () => {
    expect(resolveSourceTimeBase({ timeBase: null })).toBeNull();
    expect(resolveSourceTimeBase({ timeBase: 0 })).toBeNull();
    expect(resolveSourceTimeBase({ timeBase: null, timeBaseRational: { num: 0, den: 1 } })).toBeNull();
  });
});

describe('resolveSourceCadence', () => {
  it('returns the declared cadence exactly', () => {
    expect(resolveSourceCadence({ frameRateRational: { num: 30_000, den: 1001 } })).toEqual({
      num: 30_000,
      den: 1001,
    });
  });

  it('refuses to rebuild a cadence that only survives as a float', () => {
    // `frameRate` is deliberately not consulted: 29.97002997002997 is not 30000/1001, and
    // guessing which standard cadence it meant is the coercion this story forbids.
    expect(resolveSourceCadence({ frameRateRational: null })).toBeNull();
    expect(resolveSourceCadence({})).toBeNull();
  });
});

describe('variable frame rate and origin', () => {
  it('trusts the recorded flag', () => {
    expect(isVariableFrameRate(cfrPackets())).toBe(false);
    expect(isVariableFrameRate(cfrPackets({ variableFrameRate: true }))).toBe(true);
  });

  it('falls back to varying keyframe durations for a mapping rebuilt from storage', () => {
    expect(isVariableFrameRate({ keyframeOwnDuration: [1001, 1001] })).toBe(false);
    expect(isVariableFrameRate({ keyframeOwnDuration: [1001, 2002, 1001] })).toBe(true);
    expect(isVariableFrameRate({ keyframeOwnDuration: [] })).toBe(false);
  });

  it('takes the recorded minimum timestamp as the origin', () => {
    expect(resolveOriginTicks(cfrPackets({ startPts: 90_000, keyframePts: [90_000] }))).toBe(90_000);
  });

  it('uses the first keyframe when the origin was not recorded, B-frames included', () => {
    expect(resolveOriginTicks({ keyframePts: [90_000, 120_030] })).toBe(90_000);
    // Decode order can put a later timestamp first; the minimum is still the origin.
    expect(resolveOriginTicks({ keyframePts: [120_030, 90_000] })).toBe(90_000);
    expect(resolveOriginTicks({ keyframePts: [] })).toBe(0);
  });
});

describe('buildVideoTimingMap', () => {
  it('assembles the source mapping from what was already probed', () => {
    expect(buildVideoTimingMap({ videoStream: ntscStream, packets: cfrPackets() })).toEqual({
      timeBase: { num: 1, den: 30_000 },
      originTicks: 0,
      cadence: { num: 30_000, den: 1001 },
      variableFrameRate: false,
      keyframeTicks: [0, 30_030],
      keyframeDurationTicks: [1001, 1001],
      totalDurationTicks: 30_030,
      packetCount: 30,
    });
  });

  it('refuses a source with no usable time base', () => {
    expect(buildVideoTimingMap({ videoStream: { timeBase: null }, packets: cfrPackets() })).toBeNull();
  });

  it('converts ticks to exact seconds, including a nonzero origin', () => {
    const map = buildVideoTimingMap({
      videoStream: ntscStream,
      // A stream that starts three seconds in: 90000 ticks of 1/30000.
      packets: cfrPackets({ startPts: 90_000, keyframePts: [90_000, 120_030] }),
    })!;

    expect(timingMapOrigin(map)).toEqual({ num: 3, den: 1 });
    expect(timingMapDuration(map)).toEqual({ num: 1001, den: 1000 });
    expect(timingMapTrackTimescale(map)).toBe(30_000);
    // Keyframe times are relative to the origin, so the first one is zero rather than three.
    expect(keyframeTimes(map)).toEqual([
      { num: 0, den: 1 },
      { num: 1001, den: 1000 },
    ]);
  });

  it('round-trips a timeline time through the source timestamp, origin included', () => {
    const map = buildVideoTimingMap({
      videoStream: ntscStream,
      packets: cfrPackets({ startPts: 90_000, keyframePts: [90_000] }),
    })!;

    // One 29.97 frame into the timeline is tick 1001 past the origin, absolutely 91001.
    expect(sourceTimeToTicks(map, { num: 1001, den: 30_000 })).toBe(91_001);
    expect(ticksToSourceTime(map, 91_001)).toEqual({ num: 1001, den: 30_000 });
    // Timeline zero is the stream's own first frame, not tick zero of a file that has none.
    expect(sourceTimeToTicks(map, { num: 0, den: 1 })).toBe(90_000);
  });

  it('keeps a variable-frame-rate source variable', () => {
    const map = buildVideoTimingMap({
      videoStream: ntscStream,
      packets: cfrPackets({ variableFrameRate: true, keyframeOwnDuration: [1001, 3003] }),
    })!;

    expect(map.variableFrameRate).toBe(true);
    expect(map.keyframeDurationTicks).toEqual([1001, 3003]);
  });
});

describe('resolveOutputCadence', () => {
  const cfr = buildVideoTimingMap({ videoStream: ntscStream, packets: cfrPackets() })!;
  const vfr = buildVideoTimingMap({
    videoStream: { ...ntscStream, frameRateRational: null },
    packets: cfrPackets({ variableFrameRate: true, keyframeOwnDuration: [1001, 3003] }),
  })!;
  const film = buildVideoTimingMap({
    videoStream: { ...ntscStream, frameRateRational: { num: 24_000, den: 1001 } },
    packets: cfrPackets(),
  })!;

  it('passes a single source through untouched', () => {
    const decision = resolveOutputCadence({ sources: [cfr] });

    expect(decision.mode).toBe(OutputCadenceMode.Passthrough);
    expect(decision.cadence).toBeNull();
  });

  it('preserves the presentation timestamps of an unchanged single VFR source', () => {
    const decision = resolveOutputCadence({ sources: [vfr] });

    expect(decision.mode).toBe(OutputCadenceMode.Passthrough);
    expect(decision.reason).toContain('variable-frame-rate');
  });

  it('does not resample a source onto the cadence it already runs at', () => {
    const decision = resolveOutputCadence({ sources: [cfr], declaredCadence: FRAME_RATE_NTSC_30 });

    expect(decision.mode).toBe(OutputCadenceMode.Passthrough);
    expect(decision.cadence).toBeNull();
  });

  it('records a requested conversion rather than performing it quietly', () => {
    const decision = resolveOutputCadence({ sources: [cfr], declaredCadence: FRAME_RATE_NTSC_24 });

    expect(decision.mode).toBe(OutputCadenceMode.Convert);
    expect(decision.cadence).toEqual({ num: 24_000, den: 1001 });
    expect(decision.reason).toContain('24000/1001');
  });

  it('says out loud when a VFR source is being flattened', () => {
    const decision = resolveOutputCadence({ sources: [vfr], declaredCadence: FRAME_RATE_NTSC_30 });

    expect(decision.mode).toBe(OutputCadenceMode.Convert);
    expect(decision.reason).toContain('variable-frame-rate');
    expect(decision.reason).toContain('30000/1001');
  });

  it('refuses to pick a cadence for a composition on the caller’s behalf', () => {
    expect(() => resolveOutputCadence({ sources: [cfr, film] })).toThrowError(VideoTimingError);
  });

  it('accepts a composition once its cadence is declared', () => {
    const decision = resolveOutputCadence({ sources: [cfr, film], declaredCadence: FRAME_RATE_NTSC_30 });

    expect(decision.mode).toBe(OutputCadenceMode.Convert);
    expect(decision.cadence).toEqual({ num: 30_000, den: 1001 });
  });

  it('needs at least one source', () => {
    expect(() => resolveOutputCadence({ sources: [] })).toThrowError(VideoTimingError);
  });
});

describe('deriveCommonCadence', () => {
  const cfr = buildVideoTimingMap({ videoStream: ntscStream, packets: cfrPackets() })!;
  const film = buildVideoTimingMap({
    videoStream: { ...ntscStream, frameRateRational: { num: 24_000, den: 1001 } },
    packets: cfrPackets(),
  })!;
  const vfr = buildVideoTimingMap({
    videoStream: ntscStream,
    packets: cfrPackets({ variableFrameRate: true }),
  })!;

  it('offers the cadence every source already shares', () => {
    expect(deriveCommonCadence([cfr, cfr])).toEqual({ num: 30_000, den: 1001 });
  });

  it('offers nothing when the sources disagree or any of them is variable', () => {
    expect(deriveCommonCadence([cfr, film])).toBeNull();
    expect(deriveCommonCadence([cfr, vfr])).toBeNull();
    expect(deriveCommonCadence([vfr])).toBeNull();
    expect(deriveCommonCadence([])).toBeNull();
  });
});
