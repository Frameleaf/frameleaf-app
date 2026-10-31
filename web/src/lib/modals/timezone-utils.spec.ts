import { DateTime, Settings } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModernOffsetForZoneAndDate, getPreferredTimeZone, getTimezones, toIsoDate } from './timezone-utils';

describe('timezone selection', () => {
  const originalNow = Settings.now;

  beforeEach(() => {
    Settings.now = () => Date.UTC(2026, 5, 15, 12);
    Settings.resetCaches();
  });

  afterEach(() => {
    Settings.now = originalNow;
    Settings.resetCaches();
    vi.restoreAllMocks();
  });

  it('parses each zone once when building the selection list', () => {
    const parse = vi.spyOn(DateTime, 'fromISO');
    const zones = getTimezones('2024-01-15T12:34');
    expect(zones.length).toBeGreaterThan(0);
    expect(parse).toHaveBeenCalledTimes(Intl.supportedValuesOf('timeZone').length);
  });

  it.each(['2024-01-15T12:34', '2024-01-15T12:34:56', '2024-01-15T12:34:56.123'])(
    'accepts datetime-local precision: %s',
    (date) => {
      const berlin = getTimezones(date).find((option) => option.value === 'Europe/Berlin');
      expect(berlin).toEqual({
        value: 'Europe/Berlin',
        offsetMinutes: 60,
        label: 'Europe/Berlin (+01:00)',
        valid: true,
      });
    },
  );

  it('rejects a historical daylight-saving gap while retaining the neighboring times', () => {
    expect(getTimezones('2024-03-31T02:30').some((option) => option.value === 'Europe/Berlin')).toBe(false);
    expect(getTimezones('2024-03-31T01:59:59').some((option) => option.value === 'Europe/Berlin')).toBe(true);
    expect(getTimezones('2024-03-31T03:00').some((option) => option.value === 'Europe/Berlin')).toBe(true);
  });

  it.each(['2024-02-30T12:00', 'not a date', '2024-01-15T12:34:00Z', ''])(
    'does not offer zones for an invalid local timestamp: %s',
    (date) => {
      expect(getTimezones(date)).toEqual([]);
    },
  );

  it.each([
    ['Asia/Kolkata', '1890-07-15T12:00', 330, '+05:30'],
    ['Asia/Kathmandu', '1890-07-15T12:00', 345, '+05:45'],
    ['Europe/Berlin', '1890-07-15T12:00', 120, '+02:00'],
    ['Australia/Lord_Howe', '1890-01-15T12:00', 660, '+11:00'],
    ['Australia/Lord_Howe', '1890-07-15T12:00', 630, '+10:30'],
  ])('uses current-year rules for %s on %s', (zone, date, offsetMinutes, offsetFormat) => {
    expect(getModernOffsetForZoneAndDate(zone, date)).toEqual({ offsetMinutes, offsetFormat });
  });

  it('keeps offset ordering and alphabetical ordering within equal offsets', () => {
    const zones = getTimezones('2024-07-15T12:00');
    expect(zones.every((option) => option.valid)).toBe(true);
    for (let i = 1; i < zones.length; i++) {
      expect(zones[i].offsetMinutes).toBeGreaterThanOrEqual(zones[i - 1].offsetMinutes);
      if (zones[i].offsetMinutes === zones[i - 1].offsetMinutes) {
        expect(
          zones[i - 1].value.localeCompare(zones[i].value, undefined, { sensitivity: 'base' }),
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  it('rechecks the current year on a later list build', () => {
    const before = getTimezones('2020-03-28T12:00').find((option) => option.value === 'Europe/Berlin');
    Settings.now = () => Date.UTC(2027, 5, 15, 12);
    const after = getTimezones('2020-03-28T12:00').find((option) => option.value === 'Europe/Berlin');
    expect(before?.offsetMinutes).toBe(60);
    expect(after?.offsetMinutes).toBe(120);
  });

  it('retains the selected option reference and writes the same ISO capture-time field', () => {
    const date = '1890-07-15T12:34:56.123';
    const zones = getTimezones(date);
    const selected = zones.find((option) => option.value === 'America/Vancouver')!;
    expect(getPreferredTimeZone(DateTime.fromISO(date), 'Europe/Berlin', zones, selected)).toBe(selected);
    expect(toIsoDate(date, selected)).toBe('1890-07-15T12:34:56.123-07:00');
  });

  it('keeps selection precedence independently of list order and permits explicitly named offsets', () => {
    const date = DateTime.fromISO('2024-07-15T12:00:00+02:00', { setZone: true });
    const userZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const fallback = { value: 'fallback', label: 'fallback', offsetMinutes: 120, valid: true };
    const initial = { value: 'initial', label: 'initial', offsetMinutes: 60, valid: true };
    const selected = { value: 'selected', label: 'selected', offsetMinutes: 0, valid: true };
    const user = { value: userZone, label: userZone, offsetMinutes: 120, valid: true };
    const zones = [fallback, user, initial, selected];
    expect(getPreferredTimeZone(date, initial.value, zones, { ...selected })).toBe(selected);
    expect(getPreferredTimeZone(date, initial.value, zones, { ...selected, value: 'absent' })).toBe(initial);
    expect(getPreferredTimeZone(date, undefined, zones)).toBe(user);
    expect(getPreferredTimeZone(date, undefined, [fallback, initial])).toBe(fallback);
    expect(getPreferredTimeZone(date, undefined, [initial])).toEqual({
      value: 'UTC',
      label: 'UTC (+00:00)',
      offsetMinutes: 0,
      valid: true,
    });
  });

  it('uses the first option when multiple entries match the same preference', () => {
    const date = DateTime.fromISO('2024-07-15T12:00:00+02:00', { setZone: true });
    const first = { value: 'explicit', label: 'first', offsetMinutes: 60, valid: true };
    const second = { ...first, label: 'second' };
    expect(getPreferredTimeZone(date, 'explicit', [first, second])).toBe(first);
    expect(getPreferredTimeZone(date, undefined, [first, second], second)).toBe(first);
  });
});
