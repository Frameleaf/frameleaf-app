import { DateTime } from 'luxon';
import { cleanClass, getHeatmapRange, isDefined } from '$lib';

describe('cleanClass', () => {
  it('should return a string of class names', () => {
    expect(cleanClass('class1', 'class2', 'class3')).toBe('class1 class2 class3');
  });

  it('should filter out undefined, null, and false values', () => {
    expect(cleanClass('class1', undefined, 'class2', null, 'class3', false)).toBe('class1 class2 class3');
  });

  it('should unnest arrays', () => {
    expect(cleanClass('class1', ['class2', 'class3'])).toBe('class1 class2 class3');
  });

  it('should unnest doubly nested arrays', () => {
    expect(cleanClass('class1', [['class2a', 'class2b'], 'class3'])).toBe('class1 class2a class2b class3');
  });

  it('keeps nested order and Tailwind conflict resolution without mutating input', () => {
    const input = Object.freeze(['p-2', Object.freeze(['text-red-500', false, Object.freeze(['p-4'])])]);
    expect(cleanClass(input, 'font-bold', 'text-blue-500')).toBe('p-4 font-bold text-blue-500');
    expect(input[0]).toBe('p-2');
  });

  it('ignores non-string leaves without coercing them', () => {
    const stringify = vi.fn(() => 'p-20');
    expect(
      cleanClass(
        '',
        0,
        4,
        NaN,
        true,
        false,
        null,
        undefined,
        1n,
        Symbol('class'),
        { toString: stringify },
        { 0: 'p-8', length: 1 },
        'p-2',
      ),
    ).toBe('p-2');
    expect(stringify).not.toHaveBeenCalled();
    expect(cleanClass()).toBe('');
    expect(cleanClass([[], [false, null]])).toBe('');
  });

  it('skips holes, visits inherited array entries and ignores custom iterators', () => {
    const values: unknown[] = [];
    values.length = 3;
    values[2] = 'p-4';
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, '1', { value: 'font-bold' });
    Object.setPrototypeOf(values, prototype);
    values[Symbol.iterator] = () => ['p-20'].values();
    expect(cleanClass(values)).toBe('font-bold p-4');
  });

  it('captures each array length and reads each existing leaf once', () => {
    const values: unknown[] = ['p-2'];
    const read = vi.fn(() => {
      values.push('p-20');
      return 'p-4';
    });
    Object.defineProperty(values, '1', { get: read, enumerable: true });
    expect(cleanClass(values)).toBe('p-4');
    expect(read).toHaveBeenCalledTimes(1);
    expect(values).toHaveLength(3);
  });

  it('propagates nested getter failures', () => {
    const failure = new Error('class unavailable');
    const values: unknown[] = [];
    Object.defineProperty(values, '0', {
      get() {
        throw failure;
      },
    });
    expect(() => cleanClass(['font-bold', values])).toThrow(failure);
  });
});

describe('isDefined', () => {
  it('should return false for null', () => {
    expect(isDefined(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isDefined(undefined)).toBe(false);
  });

  it('should return true for everything else', () => {
    for (const value of [0, 1, 2, true, false, {}, 'foo', 'bar', []]) {
      expect(isDefined(value)).toBe(true);
    }
  });
});

describe('getHeatmapRange', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    '2024-01-01T00:05:00Z',
    '2024-02-29T23:59:00Z',
    '2024-03-10T09:30:00Z',
    '2024-11-03T07:30:00Z',
    '2025-01-05T00:00:00Z',
  ])('retains UTC calendar boundaries at %s', (now) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    const range = getHeatmapRange();
    const from = DateTime.fromISO(range.$from, { zone: 'UTC' });
    const to = DateTime.fromISO(range.to, { zone: 'UTC' });
    expect(Object.keys(range)).toEqual(['$from', 'to']);
    expect(to.toISODate()).toBe(now.slice(0, 10));
    expect(from.weekday).toBe(7);
    expect(to.diff(from, 'days').days).toBeGreaterThanOrEqual(356);
    expect(to.diff(from, 'days').days).toBeLessThanOrEqual(362);
  });
});
