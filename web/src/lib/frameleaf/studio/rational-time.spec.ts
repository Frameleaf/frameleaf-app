import { describe, expect, it } from 'vitest';
import {
  FRAME_RATE_NTSC_24,
  FRAME_RATE_NTSC_30,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  RationalError,
  abs,
  add,
  ceil,
  clamp,
  coerceRational,
  compare,
  divide,
  equals,
  floor,
  formatRational,
  frameDuration,
  frameIndexAt,
  frameStartTime,
  fromInteger,
  fromMilliseconds,
  invert,
  isExactInTimeBase,
  isInteger,
  isRational,
  lessThan,
  max,
  min,
  multiply,
  negate,
  parseRational,
  rational,
  rescaleTicks,
  roundToInteger,
  secondsToTicks,
  sign,
  snapToFrame,
  subtract,
  ticksToSeconds,
  toApproximateNumber,
  toDecimalString,
  toDisplaySeconds,
  toTrackTimescale,
  tryParseRational,
} from './rational-time';

/** The two time bases the fork actually meets: NTSC 1/30000 and the stub's 1/600. */
const NTSC_TIME_BASE = rational(1, 30_000);
const TIME_BASE_600 = rational(1, 600);

describe('rational', () => {
  it('reduces to lowest terms so equality is structural', () => {
    expect(rational(12_500, 1000)).toEqual({ num: 25, den: 2 });
    expect(rational(30_000, 1001)).toEqual({ num: 30_000, den: 1001 });
    expect(rational(60_000, 2002)).toEqual({ num: 30_000, den: 1001 });
  });

  it('keeps the sign on the numerator', () => {
    expect(rational(1, -2)).toEqual({ num: -1, den: 2 });
    expect(rational(-1, -2)).toEqual({ num: 1, den: 2 });
  });

  it('normalises every zero to 0/1', () => {
    expect(rational(0, 1001)).toEqual({ num: 0, den: 1 });
    expect(RATIONAL_ZERO).toEqual({ num: 0, den: 1 });
    expect(RATIONAL_ONE).toEqual({ num: 1, den: 1 });
  });

  it('refuses a zero denominator and non-integers', () => {
    expect(() => rational(1, 0)).toThrowError(RationalError);
    expect(() => rational(1.5, 2)).toThrowError(RationalError);
    expect(() => rational(Number.MAX_SAFE_INTEGER + 2, 1)).toThrowError(RationalError);
  });

  it('recognises only reduced, safe pairs as rationals', () => {
    expect(isRational({ num: 25, den: 2 })).toBe(true);
    expect(isRational({ num: 50, den: 4 })).toBe(false);
    expect(isRational({ num: 1, den: 0 })).toBe(false);
    expect(isRational({ num: 1, den: -2 })).toBe(false);
    expect(isRational(1.5)).toBe(false);
    expect(isRational(null)).toBe(false);
  });

  it('reads milliseconds as an exact fraction of a second', () => {
    expect(fromMilliseconds(12_500)).toEqual({ num: 25, den: 2 });
    expect(fromMilliseconds(1)).toEqual({ num: 1, den: 1000 });
    expect(fromMilliseconds(0)).toEqual({ num: 0, den: 1 });
    expect(fromInteger(7)).toEqual({ num: 7, den: 1 });
  });
});

describe('exact arithmetic', () => {
  it('adds over a least common denominator, not a product', () => {
    expect(add(rational(1, 1001), rational(1, 1001))).toEqual({ num: 2, den: 1001 });
    expect(add(rational(1, 6), rational(1, 10))).toEqual({ num: 4, den: 15 });
    expect(add(rational(1001, 30_000), rational(1001, 30_000))).toEqual({ num: 1001, den: 15_000 });
  });

  it('subtracts and negates exactly', () => {
    expect(subtract(rational(1, 3), rational(1, 3))).toEqual({ num: 0, den: 1 });
    expect(subtract(rational(1, 30_000), rational(1, 24_000))).toEqual({ num: -1, den: 120_000 });
    expect(negate(rational(25, 2))).toEqual({ num: -25, den: 2 });
    expect(abs(rational(-25, 2))).toEqual({ num: 25, den: 2 });
  });

  it('cross-reduces before multiplying so a cadence round trip is exactly one', () => {
    expect(multiply(FRAME_RATE_NTSC_30, frameDuration(FRAME_RATE_NTSC_30))).toEqual({ num: 1, den: 1 });
    expect(multiply(rational(30_000, 1001), rational(1001, 1))).toEqual({ num: 30_000, den: 1 });
    expect(multiply(rational(2, 3), rational(3, 4))).toEqual({ num: 1, den: 2 });
  });

  it('divides and inverts exactly', () => {
    expect(divide(RATIONAL_ONE, FRAME_RATE_NTSC_30)).toEqual({ num: 1001, den: 30_000 });
    expect(invert(FRAME_RATE_NTSC_24)).toEqual({ num: 1001, den: 24_000 });
    expect(() => divide(RATIONAL_ONE, RATIONAL_ZERO)).toThrowError(RationalError);
    expect(() => invert(RATIONAL_ZERO)).toThrowError(RationalError);
  });

  it('does not accumulate drift over an hour of 30000/1001 frames', () => {
    // 107,892 frames is one hour of 29.97 fps. Adding the frame duration that many times must
    // land on exactly 107892 * 1001 / 30000 seconds, which reduces to 8999991/2500.
    const step = frameDuration(FRAME_RATE_NTSC_30);
    let total = RATIONAL_ZERO;
    for (let frame = 0; frame < 107_892; frame++) {
      total = add(total, step);
    }

    expect(total).toEqual({ num: 8_999_991, den: 2500 });
    expect(equals(total, frameStartTime(107_892, FRAME_RATE_NTSC_30))).toBe(true);
    // The float path is already wrong well before the end of the hour.
    expect(total.num / total.den).not.toBe(107_892 * (1001 / 30_000));
  });

  it('does not accumulate drift over an hour of 24000/1001 frames', () => {
    const step = frameDuration(FRAME_RATE_NTSC_24);
    let total = RATIONAL_ZERO;
    for (let frame = 0; frame < 86_313; frame++) {
      total = add(total, step);
    }

    expect(total).toEqual({ num: 28_799_771, den: 8000 });
    expect(equals(total, frameStartTime(86_313, FRAME_RATE_NTSC_24))).toBe(true);
  });

  it('reports overflow instead of silently losing precision', () => {
    const huge = rational(Number.MAX_SAFE_INTEGER, 1);
    expect(() => multiply(huge, rational(3, 1))).toThrowError(RationalError);
  });
});

describe('comparison', () => {
  it('compares exactly where floats tie', () => {
    expect(compare(rational(1, 3), rational(1, 3))).toBe(0);
    expect(compare(rational(30_000, 1001), rational(30, 1))).toBe(-1);
    expect(compare(rational(1, 30_000), rational(1, 30_001))).toBe(1);
    expect(compare(rational(-1, 2), rational(1, 2))).toBe(-1);
  });

  it('exposes sign, min, max and clamp', () => {
    expect(sign(RATIONAL_ZERO)).toBe(0);
    expect(sign(rational(-1, 1000))).toBe(-1);
    expect(sign(rational(1, 1000))).toBe(1);
    expect(min(rational(1, 3), rational(1, 4))).toEqual({ num: 1, den: 4 });
    expect(max(rational(1, 3), rational(1, 4))).toEqual({ num: 1, den: 3 });
    expect(clamp(rational(5, 1), RATIONAL_ZERO, rational(25, 2))).toEqual({ num: 5, den: 1 });
    expect(clamp(rational(50, 1), RATIONAL_ZERO, rational(25, 2))).toEqual({ num: 25, den: 2 });
    expect(clamp(rational(-1, 1), RATIONAL_ZERO, rational(25, 2))).toEqual({ num: 0, den: 1 });
    expect(() => clamp(RATIONAL_ZERO, rational(2, 1), RATIONAL_ONE)).toThrowError(RationalError);
  });
});

describe('roundToInteger', () => {
  it('rounds halves away from zero, on both sides', () => {
    expect(roundToInteger(rational(5, 2))).toBe(3);
    expect(roundToInteger(rational(-5, 2))).toBe(-3);
    expect(roundToInteger(rational(1, 2))).toBe(1);
    expect(roundToInteger(rational(-1, 2))).toBe(-1);
    expect(roundToInteger(rational(3, 2))).toBe(2);
    // Banker's rounding would make this 2; it must not.
    expect(roundToInteger(rational(5, 2))).not.toBe(2);
  });

  it('rounds non-ties to the nearer integer', () => {
    expect(roundToInteger(rational(7, 3))).toBe(2);
    expect(roundToInteger(rational(8, 3))).toBe(3);
    expect(roundToInteger(rational(-7, 3))).toBe(-2);
  });

  it('floors, ceils and truncates with the sign rules each name implies', () => {
    expect(floor(rational(7, 3))).toBe(2);
    expect(floor(rational(-7, 3))).toBe(-3);
    expect(ceil(rational(7, 3))).toBe(3);
    expect(ceil(rational(-7, 3))).toBe(-2);
    expect(roundToInteger(rational(-7, 3), 'trunc')).toBe(-2);
    expect(roundToInteger(rational(7, 3), 'trunc')).toBe(2);
  });

  it('leaves an integer alone under every rule', () => {
    for (const mode of ['nearest', 'floor', 'ceil', 'trunc'] as const) {
      expect(roundToInteger(rational(-4, 1), mode)).toBe(-4);
    }
    expect(isInteger(rational(4, 1))).toBe(true);
    expect(isInteger(rational(4, 3))).toBe(false);
  });
});

describe('ffmpeg time bases', () => {
  it('parses ffprobe rationals, including bare integers', () => {
    expect(parseRational('30000/1001')).toEqual({ num: 30_000, den: 1001 });
    expect(parseRational('1/30000')).toEqual({ num: 1, den: 30_000 });
    expect(parseRational('25')).toEqual({ num: 25, den: 1 });
    expect(parseRational(' 24000/1001 ')).toEqual({ num: 24_000, den: 1001 });
  });

  it('reports ffprobe’s unknown rational rather than reading it as zero', () => {
    expect(() => parseRational('0/0')).toThrowError(RationalError);
    expect(tryParseRational('0/0')).toBeNull();
    expect(tryParseRational(undefined)).toBeNull();
    expect(tryParseRational('')).toBeNull();
    expect(tryParseRational('30000/1001')).toEqual({ num: 30_000, den: 1001 });
  });

  it('round-trips through its canonical spelling', () => {
    expect(formatRational(FRAME_RATE_NTSC_30)).toBe('30000/1001');
    expect(formatRational(rational(1, 30_000))).toBe('1/30000');
    expect(parseRational(formatRational(FRAME_RATE_NTSC_24))).toEqual(FRAME_RATE_NTSC_24);
  });

  it('converts ticks to seconds exactly', () => {
    expect(ticksToSeconds(30_000, NTSC_TIME_BASE)).toEqual({ num: 1, den: 1 });
    expect(ticksToSeconds(1001, NTSC_TIME_BASE)).toEqual({ num: 1001, den: 30_000 });
    expect(ticksToSeconds(0, NTSC_TIME_BASE)).toEqual({ num: 0, den: 1 });
    // A nonzero origin is an ordinary tick count, not a special case.
    expect(ticksToSeconds(90_000, NTSC_TIME_BASE)).toEqual({ num: 3, den: 1 });
    expect(ticksToSeconds(600, TIME_BASE_600)).toEqual({ num: 1, den: 1 });
  });

  it('converts seconds to ticks exactly, and says when it cannot', () => {
    expect(secondsToTicks(rational(1001, 30_000), NTSC_TIME_BASE)).toBe(1001);
    expect(isExactInTimeBase(rational(1001, 30_000), NTSC_TIME_BASE)).toBe(true);
    // One 29.97 frame does not exist on a 1/600 grid.
    expect(isExactInTimeBase(rational(1001, 30_000), TIME_BASE_600)).toBe(false);
    expect(secondsToTicks(rational(1001, 30_000), TIME_BASE_600)).toBe(20);
    expect(secondsToTicks(rational(1001, 30_000), TIME_BASE_600, 'floor')).toBe(20);
    expect(secondsToTicks(rational(1001, 30_000), TIME_BASE_600, 'ceil')).toBe(21);
  });

  it('rescales ticks between bases and flags an inexact instant', () => {
    expect(rescaleTicks(1001, NTSC_TIME_BASE, rational(1, 1000))).toEqual({ ticks: 33, exact: false });
    expect(rescaleTicks(30_000, NTSC_TIME_BASE, rational(1, 1000))).toEqual({ ticks: 1000, exact: true });
    expect(rescaleTicks(1, rational(1, 1000), NTSC_TIME_BASE)).toEqual({ ticks: 30, exact: true });
  });

  it('pins the track timescale to the denominator that represents every tick', () => {
    expect(toTrackTimescale(NTSC_TIME_BASE)).toBe(30_000);
    expect(toTrackTimescale(TIME_BASE_600)).toBe(600);
    // A time base with a numerator keeps an integer timescale rather than 30000/1001.
    expect(toTrackTimescale(rational(1001, 30_000))).toBe(30_000);
    expect(() => toTrackTimescale(rational(-1, 30_000))).toThrowError(RationalError);
  });
});

describe('frames', () => {
  it('gives the exact start of a frame without accumulating', () => {
    expect(frameStartTime(0, FRAME_RATE_NTSC_30)).toEqual({ num: 0, den: 1 });
    expect(frameStartTime(1, FRAME_RATE_NTSC_30)).toEqual({ num: 1001, den: 30_000 });
    expect(frameStartTime(30_000, FRAME_RATE_NTSC_30)).toEqual({ num: 1001, den: 1 });
    expect(frameDuration(FRAME_RATE_NTSC_24)).toEqual({ num: 1001, den: 24_000 });
  });

  it('gives a boundary time to the frame that starts there', () => {
    expect(frameIndexAt(frameStartTime(5, FRAME_RATE_NTSC_30), FRAME_RATE_NTSC_30)).toBe(5);
    // One tick before the boundary is still the previous frame.
    const justBefore = subtract(frameStartTime(5, FRAME_RATE_NTSC_30), rational(1, 30_000));
    expect(frameIndexAt(justBefore, FRAME_RATE_NTSC_30)).toBe(4);
    expect(frameIndexAt(RATIONAL_ZERO, FRAME_RATE_NTSC_30)).toBe(0);
  });

  it('round-trips frame index and time for a long timeline', () => {
    for (const index of [0, 1, 2, 1000, 107_891, 107_892]) {
      expect(frameIndexAt(frameStartTime(index, FRAME_RATE_NTSC_30), FRAME_RATE_NTSC_30)).toBe(index);
      expect(frameIndexAt(frameStartTime(index, FRAME_RATE_NTSC_24), FRAME_RATE_NTSC_24)).toBe(index);
    }
  });

  it('snaps a time back to its frame boundary', () => {
    const inside = add(frameStartTime(7, FRAME_RATE_NTSC_30), rational(1, 90_000));
    expect(snapToFrame(inside, FRAME_RATE_NTSC_30)).toEqual({ num: 7007, den: 30_000 });
    expect(snapToFrame(frameStartTime(7, FRAME_RATE_NTSC_30), FRAME_RATE_NTSC_30)).toEqual({
      num: 7007,
      den: 30_000,
    });
  });
});

/**
 * FL-93 property tests: frame↔time conversion and trim boundaries hold for every cadence and
 * index a deterministic generator produces, not only the hand-picked cases above.
 */
describe('frame and tick properties', () => {
  // Park–Miller: deterministic, so a failure names a reproducible case.
  const generator = (seed: number) => {
    let state = seed;
    return (bound: number) => {
      state = (state * 48_271) % 2_147_483_647;
      return state % bound;
    };
  };
  const cadences = [
    FRAME_RATE_NTSC_30,
    FRAME_RATE_NTSC_24,
    rational(60_000, 1001),
    rational(25),
    rational(50),
    rational(24),
    rational(120),
    rational(15, 2),
  ];

  it('maps every frame start back to its own index and never between frames', () => {
    const next = generator(93);
    for (const frameRate of cadences) {
      for (let sample = 0; sample < 200; sample++) {
        // Up to about 24 hours of frames at the fastest cadence.
        const index = next(10_000_000);
        const start = frameStartTime(index, frameRate);
        expect(frameIndexAt(start, frameRate)).toBe(index);
        expect(snapToFrame(start, frameRate)).toEqual(start);
        const inside = add(start, divide(frameDuration(frameRate), rational(2)));
        expect(frameIndexAt(inside, frameRate)).toBe(index);
        expect(snapToFrame(inside, frameRate)).toEqual(start);
      }
    }
  });

  it('keeps frame starts strictly increasing by exactly one frame duration', () => {
    const next = generator(102);
    for (const frameRate of cadences) {
      for (let sample = 0; sample < 100; sample++) {
        const index = next(5_000_000);
        const gap = subtract(frameStartTime(index + 1, frameRate), frameStartTime(index, frameRate));
        expect(gap).toEqual(frameDuration(frameRate));
      }
    }
  });

  it('gives the same trim boundary however the edit is expressed', () => {
    const next = generator(16);
    for (const frameRate of cadences) {
      for (let sample = 0; sample < 100; sample++) {
        const milliseconds = next(86_400_000);
        const trim = fromMilliseconds(milliseconds);
        const frame = frameIndexAt(trim, frameRate);
        // Deterministic: the boundary never depends on how often it is recomputed.
        expect(frameIndexAt(trim, frameRate)).toBe(frame);
        expect(lessThan(trim, frameStartTime(frame, frameRate))).toBe(false);
        expect(lessThan(trim, frameStartTime(frame + 1, frameRate))).toBe(true);
      }
    }
  });

  it('round-trips ticks through seconds exactly for common time bases', () => {
    const next = generator(39);
    for (const timeBase of [rational(1, 90_000), rational(1, 30_000), rational(1, 600), rational(1001, 24_000)]) {
      for (let sample = 0; sample < 200; sample++) {
        const ticks = next(2_000_000_000);
        expect(secondsToTicks(ticksToSeconds(ticks, timeBase), timeBase)).toBe(ticks);
      }
    }
  });
});

describe('decimal display', () => {
  it('expands exactly, without going through a float', () => {
    expect(toDecimalString(rational(1, 3), 4)).toBe('0.3333');
    expect(toDecimalString(rational(2, 3), 4)).toBe('0.6667');
    expect(toDecimalString(rational(1001, 30_000), 6)).toBe('0.033367');
    expect(toDecimalString(rational(25, 2), 4)).toBe('12.5000');
    expect(toDecimalString(rational(7, 1), 0)).toBe('7');
  });

  it('rounds the half case away from zero, carrying where it must', () => {
    expect(toDecimalString(rational(1, 8), 2)).toBe('0.13');
    expect(toDecimalString(rational(-1, 8), 2)).toBe('-0.13');
    expect(toDecimalString(rational(3, 8), 2)).toBe('0.38');
    // 1.995 carries through both decimals and into the whole part.
    expect(toDecimalString(rational(399, 200), 2)).toBe('2.00');
    expect(toDecimalString(rational(1, 2), 0)).toBe('1');
    expect(toDecimalString(rational(-1, 2), 0)).toBe('-1');
  });

  it('never writes a negative zero', () => {
    expect(toDecimalString(rational(-1, 100_000), 2)).toBe('0.00');
    expect(toDisplaySeconds(rational(-1, 100_000))).toBe('0');
  });

  it('trims trailing zeros for an argument or a label', () => {
    expect(toDisplaySeconds(rational(25, 2))).toBe('12.5');
    expect(toDisplaySeconds(rational(2, 1))).toBe('2');
    expect(toDisplaySeconds(rational(1, 1000))).toBe('0.001');
    expect(toDisplaySeconds(rational(1001, 30_000))).toBe('0.0334');
    expect(toDisplaySeconds(rational(1001, 30_000), 6)).toBe('0.033367');
    expect(toDisplaySeconds(rational(-3, 2))).toBe('-1.5');
  });

  it('matches what the old float path produced for whole milliseconds', () => {
    // The transcode filters have always emitted at most four places; for millisecond inputs
    // the exact expansion and the old `Number(value.toFixed(4)).toString()` agree exactly.
    for (const milliseconds of [0, 1, 250, 1500, 12_500, 3_600_000]) {
      const exact = toDisplaySeconds(fromMilliseconds(milliseconds));
      expect(exact).toBe(Number((milliseconds / 1000).toFixed(4)).toString());
    }
  });

  it('refuses an unsupported precision', () => {
    expect(() => toDecimalString(rational(1, 3), -1)).toThrowError(RationalError);
    expect(() => toDecimalString(rational(1, 3), 16)).toThrowError(RationalError);
  });

  it('keeps the lossy conversion explicit', () => {
    expect(toApproximateNumber(rational(25, 2))).toBe(12.5);
    expect(toApproximateNumber(FRAME_RATE_NTSC_30)).toBeCloseTo(29.97, 3);
  });
});

describe('coerceRational', () => {
  it('rebuilds a pair that arrived over the wire rather than trusting it', () => {
    expect(coerceRational({ num: 50, den: 4 })).toEqual({ num: 25, den: 2 });
    expect(coerceRational({ num: 1, den: -2 })).toEqual({ num: -1, den: 2 });
    expect(coerceRational('30000/1001')).toEqual({ num: 30_000, den: 1001 });
  });

  it('rejects anything that is not a rational', () => {
    expect(coerceRational({ num: 1, den: 0 })).toBeNull();
    expect(coerceRational({ num: 1.5, den: 2 })).toBeNull();
    expect(coerceRational(12.5)).toBeNull();
    expect(coerceRational(null)).toBeNull();
    expect(coerceRational('not a number')).toBeNull();
  });
});
