/**
 * Exact rational time (FL-93 / `VID-102`).
 *
 * Video time is rational, not decimal. NTSC cadences are 30000/1001 and 24000/1001, an
 * ffmpeg time base is 1/30000 or 1/90000, and a container stores integer ticks of that base.
 * Every one of those is exactly representable as a pair of integers and none of them is
 * exactly representable as a binary float: `1/30000` alone is already wrong in the 17th
 * digit, and an hour-long timeline adds that error 108,000 times. So this module never
 * converts to a float except where a float is the answer being asked for, and it says so in
 * the name when it does.
 *
 * The module is deliberately framework-free and dependency-free — no NestJS, no repositories,
 * no `Duration`, no BigInt — so the transcode services, the Studio host and the React editor
 * can all import the *same* arithmetic instead of each restating it. It is mirrored verbatim
 * at `web/src/lib/frameleaf/studio/rational-time.ts`; see the note at the bottom of this file.
 *
 * Representation invariants, enforced by {@link rational} and relied on by everything else:
 *
 * - `num` and `den` are safe integers and `den > 0`; the sign lives on `num`.
 * - The pair is fully reduced, so `equals` is structural and `formatRational` is canonical.
 * - Zero is exactly `{ num: 0, den: 1 }`.
 *
 * Overflow is an error, never a silent loss: every product is checked and
 * {@link RationalError} is thrown rather than letting a value drift past 2^53.
 */

/** An exact rational number. Reduced, with a positive denominator. */
export interface Rational {
  readonly num: number;
  readonly den: number;
}

/**
 * A time base: the duration of one tick, in seconds, as a rational. ffmpeg spells it the same
 * way (`1/30000`), and a stream's presentation timestamps are integer multiples of it.
 */
export type TimeBase = Rational;

/** Thrown when an operation cannot be carried out exactly. */
export class RationalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RationalError';
  }
}

/** How a non-integral rational is collapsed onto an integer. Always named, never implied. */
export type RationalRounding =
  /** Half away from zero: 0.5 → 1, -0.5 → -1. The default everywhere in this module. */
  | 'nearest'
  /** Towards negative infinity. */
  | 'floor'
  /** Towards positive infinity. */
  | 'ceil'
  /** Towards zero. */
  | 'trunc';

const gcd = (a: number, b: number): number => {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
};

const checkSafe = (value: number, what: string): number => {
  if (!Number.isSafeInteger(value)) {
    throw new RationalError(`${what} is not exactly representable (${value}); the rational overflowed.`);
  }
  return value;
};

const product = (a: number, b: number, what: string): number => checkSafe(a * b, what);

/**
 * Build a reduced rational. This is the only constructor; nothing else in the module (or
 * outside it) should assemble a `{ num, den }` literal, because the invariants above are what
 * make comparison and formatting exact.
 */
export const rational = (num: number, den: number = 1): Rational => {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
    throw new RationalError(`A rational needs safe integers, got ${num}/${den}.`);
  }
  if (den === 0) {
    throw new RationalError('A rational cannot have a zero denominator.');
  }

  const sign = den < 0 ? -1 : 1;
  const signedNum = num * sign;
  const positiveDen = den * sign;
  const divisor = gcd(signedNum, positiveDen) || 1;
  return { num: signedNum / divisor, den: positiveDen / divisor };
};

export const RATIONAL_ZERO: Rational = { num: 0, den: 1 };
export const RATIONAL_ONE: Rational = { num: 1, den: 1 };

/** The two NTSC cadences the acceptance criteria name, spelled exactly. */
export const FRAME_RATE_NTSC_30: Rational = { num: 30_000, den: 1001 };
export const FRAME_RATE_NTSC_24: Rational = { num: 24_000, den: 1001 };

export const isRational = (value: unknown): value is Rational => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { num?: unknown; den?: unknown };
  return (
    Number.isSafeInteger(candidate.num) &&
    Number.isSafeInteger(candidate.den) &&
    (candidate.den as number) > 0 &&
    gcd(candidate.num as number, candidate.den as number) === 1
  );
};

export const fromInteger = (value: number): Rational => rational(value, 1);

/**
 * Milliseconds — the unit the asset DTO carries — as an exact rational number of seconds.
 * 12500 ms is 25/2 s, not 12.5 rounded into a float.
 */
export const fromMilliseconds = (milliseconds: number): Rational => rational(milliseconds, 1000);

export const isZero = (value: Rational): boolean => value.num === 0;
export const isNegative = (value: Rational): boolean => value.num < 0;
export const sign = (value: Rational): -1 | 0 | 1 => (value.num === 0 ? 0 : value.num < 0 ? -1 : 1);

export const negate = (value: Rational): Rational => ({ num: -value.num, den: value.den });
export const abs = (value: Rational): Rational => (value.num < 0 ? negate(value) : value);

export const invert = (value: Rational): Rational => {
  if (value.num === 0) {
    throw new RationalError('Cannot invert zero.');
  }
  return rational(value.den, value.num);
};

/**
 * Exact addition. The denominators are brought to their least common multiple rather than to
 * their product, which is what keeps `1/1001 + 1/1001` from needing a million-fold denominator
 * and keeps an hour of 1/30000 ticks inside the safe integer range.
 */
export const add = (a: Rational, b: Rational): Rational => {
  const divisor = gcd(a.den, b.den);
  const bScale = b.den / divisor;
  const aScale = a.den / divisor;
  const den = product(a.den, bScale, 'A common denominator');
  const num = checkSafe(product(a.num, bScale, 'A sum term') + product(b.num, aScale, 'A sum term'), 'A sum');
  return rational(num, den);
};

export const subtract = (a: Rational, b: Rational): Rational => add(a, negate(b));

/**
 * Exact multiplication. Each numerator is cross-reduced against the *other* denominator before
 * the products are formed, so `(30000/1001) * (1001/30000)` is 1 with no intermediate anywhere
 * near 3 × 10^7, and repeated scaling of a timeline does not creep towards the safe-integer
 * ceiling.
 */
export const multiply = (a: Rational, b: Rational): Rational => {
  const left = gcd(a.num, b.den) || 1;
  const right = gcd(b.num, a.den) || 1;
  const num = product(a.num / left, b.num / right, 'A product');
  const den = product(a.den / right, b.den / left, 'A product denominator');
  return rational(num, den);
};

export const divide = (a: Rational, b: Rational): Rational => {
  if (b.num === 0) {
    throw new RationalError('Cannot divide by zero.');
  }
  return multiply(a, invert(b));
};

/** -1, 0 or 1. Exact: it subtracts rather than comparing two floats. */
export const compare = (a: Rational, b: Rational): -1 | 0 | 1 => sign(subtract(a, b));

export const equals = (a: Rational, b: Rational): boolean => a.num === b.num && a.den === b.den;
export const lessThan = (a: Rational, b: Rational): boolean => compare(a, b) < 0;
export const greaterThan = (a: Rational, b: Rational): boolean => compare(a, b) > 0;
export const min = (a: Rational, b: Rational): Rational => (compare(a, b) <= 0 ? a : b);
export const max = (a: Rational, b: Rational): Rational => (compare(a, b) >= 0 ? a : b);

export const clamp = (value: Rational, lower: Rational, upper: Rational): Rational => {
  if (compare(lower, upper) > 0) {
    throw new RationalError('Clamp bounds are inverted.');
  }
  return min(max(value, lower), upper);
};

export const isInteger = (value: Rational): boolean => value.den === 1;

/** Floor division of a signed numerator by a positive denominator, with its remainder. */
const floorDivide = (num: number, den: number): { quotient: number; remainder: number } => {
  let quotient = Math.floor(num / den);
  let remainder = num - quotient * den;
  // `num / den` is a float, so at the top of the safe-integer range it can land one off.
  while (remainder < 0) {
    quotient -= 1;
    remainder += den;
  }
  while (remainder >= den) {
    quotient += 1;
    remainder -= den;
  }
  return { quotient, remainder };
};

/**
 * Collapse a rational onto an integer with an explicitly named rule. `nearest` is half **away
 * from zero**, which is the rule pinned for every conversion in this module and in the specs:
 * 5/2 → 3, -5/2 → -3, 1/2 → 1. Banker's rounding is deliberately not used, because a timeline
 * boundary that lands exactly between two ticks should move consistently rather than
 * alternate.
 */
export const roundToInteger = (value: Rational, mode: RationalRounding = 'nearest'): number => {
  if (value.den === 1) {
    return value.num;
  }

  const { quotient, remainder } = floorDivide(value.num, value.den);
  switch (mode) {
    case 'floor': {
      return quotient;
    }
    case 'ceil': {
      return remainder === 0 ? quotient : quotient + 1;
    }
    case 'trunc': {
      return value.num < 0 ? quotient + 1 : quotient;
    }
    case 'nearest': {
      // Decide on the magnitude so the tie moves away from zero on both sides.
      const magnitude = Math.abs(value.num);
      const { quotient: wholeMagnitude, remainder: magnitudeRemainder } = floorDivide(magnitude, value.den);
      const rounded =
        product(magnitudeRemainder, 2, 'A rounding comparison') >= value.den ? wholeMagnitude + 1 : wholeMagnitude;
      return value.num < 0 ? -rounded : rounded;
    }
  }
};

export const floor = (value: Rational): number => roundToInteger(value, 'floor');
export const ceil = (value: Rational): number => roundToInteger(value, 'ceil');

/* ------------------------------------------------------------------ */
/* Time bases and ticks                                                 */
/* ------------------------------------------------------------------ */

/**
 * Parse ffmpeg's rational spelling: `30000/1001`, `1/30000`, or a bare integer `25`. ffprobe
 * writes `0/0` for "unknown", which is not a number and is reported as such rather than as
 * zero.
 */
export const parseRational = (value: string): Rational => {
  const text = value.trim();
  const [numText, denText = '1'] = text.split('/', 2);
  const num = Number(numText);
  const den = Number(denText);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den === 0) {
    throw new RationalError(`'${value}' is not a rational number.`);
  }
  return rational(num, den);
};

/** Like {@link parseRational} but returns null instead of throwing, for probe output. */
export const tryParseRational = (value: string | null | undefined): Rational | null => {
  if (!value) {
    return null;
  }
  try {
    return parseRational(value);
  } catch {
    return null;
  }
};

/** The canonical `num/den` spelling. Round-trips through {@link parseRational}. */
export const formatRational = (value: Rational): string => `${value.num}/${value.den}`;

/** Seconds for a whole number of ticks of a time base. Exact. */
export const ticksToSeconds = (ticks: number, timeBase: TimeBase): Rational => multiply(fromInteger(ticks), timeBase);

/**
 * Ticks of a time base for a duration in seconds. Exact whenever the duration is a multiple of
 * the time base; otherwise the named rounding rule applies and {@link isExactInTimeBase} is the
 * way to find out beforehand.
 */
export const secondsToTicks = (seconds: Rational, timeBase: TimeBase, mode: RationalRounding = 'nearest'): number =>
  roundToInteger(divide(seconds, timeBase), mode);

export const isExactInTimeBase = (seconds: Rational, timeBase: TimeBase): boolean =>
  isInteger(divide(seconds, timeBase));

/**
 * Convert a tick count from one time base to another, exactly where possible.
 *
 * `exact` is false when the source instant simply does not exist on the target grid — a
 * 1/30000 tick expressed in 1/1000, for example. Callers that must not resample check it
 * instead of discovering the loss later in a muxed file.
 */
export const rescaleTicks = (
  ticks: number,
  from: TimeBase,
  to: TimeBase,
  mode: RationalRounding = 'nearest',
): { ticks: number; exact: boolean } => {
  const seconds = ticksToSeconds(ticks, from);
  const scaled = divide(seconds, to);
  return { ticks: roundToInteger(scaled, mode), exact: isInteger(scaled) };
};

/**
 * The integer timescale (`-video_track_timescale`, an MP4 `mdhd` timescale) that represents
 * every instant of a time base exactly.
 *
 * A timescale `T` means a grid of `1/T` seconds. A tick of the reduced time base `num/den` is
 * an exact multiple of `1/T` when `T·num/den` is an integer; since the pair is reduced,
 * `gcd(num, den) = 1`, so that holds exactly when `den` divides `T`. The smallest such `T` is
 * therefore `den` — which for the ordinary `1/30000` case is 30000, and for a time base with a
 * numerator, such as `1001/30000`, is still 30000 rather than the non-integral `30000/1001`.
 */
export const toTrackTimescale = (timeBase: TimeBase): number => {
  if (timeBase.num <= 0) {
    throw new RationalError(`A time base must be positive, got ${formatRational(timeBase)}.`);
  }
  return timeBase.den;
};

/* ------------------------------------------------------------------ */
/* Frames                                                               */
/* ------------------------------------------------------------------ */

/** The nominal duration of one frame at a frame rate. 30000/1001 fps → 1001/30000 s. */
export const frameDuration = (frameRate: Rational): Rational => invert(frameRate);

/** The exact start time of frame `index` at a constant cadence. No accumulated addition. */
export const frameStartTime = (index: number, frameRate: Rational): Rational => divide(fromInteger(index), frameRate);

/**
 * The index of the frame being shown at `time` on a constant cadence: the number of whole
 * frame durations that have elapsed, so a time exactly on a boundary belongs to the frame that
 * starts there. `floor`, never `round` — rounding would make the first half of a frame belong
 * to the frame before it.
 */
export const frameIndexAt = (time: Rational, frameRate: Rational): number =>
  roundToInteger(multiply(time, frameRate), 'floor');

/** Snap a time back to the start of the frame that contains it. */
export const snapToFrame = (time: Rational, frameRate: Rational): Rational =>
  frameStartTime(frameIndexAt(time, frameRate), frameRate);

/* ------------------------------------------------------------------ */
/* Display                                                              */
/* ------------------------------------------------------------------ */

/**
 * A fixed-point decimal string with exactly `decimals` places, produced by long division on the
 * integers — never by `toFixed`, which rounds a float that is already wrong. The half case goes
 * away from zero, matching {@link roundToInteger}.
 *
 * `toDecimalString(rational(1, 3), 4)` is `'0.3333'`; `toDecimalString(rational(1, 8), 2)` is
 * `'0.13'` (1/8 = 0.125, the tie rounds up); `toDecimalString(rational(-1, 8), 2)` is `'-0.13'`.
 */
export const toDecimalString = (value: Rational, decimals: number): string => {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 15) {
    throw new RationalError(`Decimal places must be an integer in 0..15, got ${decimals}.`);
  }

  const negative = value.num < 0;
  const magnitude = Math.abs(value.num);
  const { quotient, remainder } = floorDivide(magnitude, value.den);

  let whole = quotient;
  let rest = remainder;
  const digits: number[] = [];
  for (let place = 0; place < decimals; place++) {
    const scaled = product(rest, 10, 'A decimal expansion');
    const digit = Math.floor(scaled / value.den);
    digits.push(digit);
    rest = scaled - digit * value.den;
  }

  // Half away from zero: the magnitude is what is being rounded, so `>=` is enough.
  if (product(rest, 2, 'A rounding comparison') >= value.den) {
    let carry = 1;
    for (let place = digits.length - 1; place >= 0 && carry > 0; place--) {
      const next = digits[place] + carry;
      digits[place] = next % 10;
      carry = next >= 10 ? 1 : 0;
    }
    whole += carry;
  }

  const fraction = decimals > 0 ? `.${digits.join('')}` : '';
  const text = `${whole}${fraction}`;
  return negative && (whole !== 0 || digits.some((digit) => digit !== 0)) ? `-${text}` : text;
};

/**
 * Seconds for display or for an ffmpeg argument: the same pinned decimal expansion as
 * {@link toDecimalString}, with trailing zeros removed so `3/2` is `'1.5'` rather than
 * `'1.5000'` and `2/1` is `'2'`. Four places is the default because that is the precision the
 * transcode filter arguments have always used.
 */
export const toDisplaySeconds = (value: Rational, decimals: number = 4): string => {
  const text = toDecimalString(value, decimals);
  if (!text.includes('.')) {
    return text;
  }
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
};

/**
 * The lossy conversion, named so it can never happen by accident. Use it for a CSS width or a
 * `currentTime` assignment on a media element — never for arithmetic that feeds an encoder.
 */
export const toApproximateNumber = (value: Rational): number => value.num / value.den;

/* ------------------------------------------------------------------ */
/* Transport                                                            */
/* ------------------------------------------------------------------ */

/**
 * Accept a rational that arrived over the wire or out of a stored graph. Plain objects survive
 * JSON, but an unreduced or unsafe pair must not be trusted into the invariants above, so this
 * rebuilds it through {@link rational} rather than casting.
 */
export const coerceRational = (value: unknown): Rational | null => {
  if (typeof value === 'string') {
    return tryParseRational(value);
  }
  if (value && typeof value === 'object') {
    const candidate = value as { num?: unknown; den?: unknown };
    if (Number.isSafeInteger(candidate.num) && Number.isSafeInteger(candidate.den) && candidate.den !== 0) {
      return rational(candidate.num as number, candidate.den as number);
    }
  }
  return null;
};

/*
 * MIRROR NOTE (FL-93)
 * ------------------
 * This file is duplicated verbatim at `web/src/lib/frameleaf/studio/rational-time.ts`.
 *
 * A shared import was considered and rejected: `server` and `web` are separate packages with
 * separate `tsconfig` roots, separate builds and no path alias between them, and the only thing
 * they already share is `@immich/sdk`, which is *generated* from the OpenAPI document and
 * therefore cannot carry hand-written arithmetic. Introducing a third published package for two
 * hundred lines of integer maths would add a build step, a version to keep in step and a
 * publish gate to every change here — a larger and more fragile contract than the file itself.
 *
 * The copy is byte-identical on purpose, so `diff` is the conformance check: the two files must
 * not diverge, and both specs assert the same expected fractions.
 */
