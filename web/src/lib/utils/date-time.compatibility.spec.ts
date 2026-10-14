import { writable } from 'svelte/store';

vi.mock('$lib/stores/preferences.store', () => ({ locale: writable('en') }));

describe('album range formatting', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses native range formatters across album cards without mixing display styles', async () => {
    const { getAlbumDateRange, getShortDateRange } = await import('./date-time');
    const { dateFormats } = await import('$lib/constants');
    const formatter = vi.spyOn(Intl, 'DateTimeFormat');
    for (let index = 0; index < 10; index++) {
      expect(getAlbumDateRange('2022-01-01', '2022-02-01')).toBe('Jan 1 – Feb 1, 2022');
      expect(getShortDateRange('2022-01-01', '2022-02-01')).toBe('Jan – Feb 2022');
    }
    const rangeCalls = formatter.mock.calls.filter(
      ([, options]) => options === dateFormats.album || options === dateFormats.albumShort,
    );
    expect(rangeCalls).toHaveLength(2);
  });

  it('refreshes both styles after a language change', async () => {
    const { locale } = await import('$lib/stores/preferences.store');
    const { getAlbumDateRange, getShortDateRange } = await import('./date-time');
    expect(getAlbumDateRange('2022-01-01', '2022-02-01')).toBe('Jan 1 – Feb 1, 2022');
    expect(getShortDateRange('2022-01-01', '2022-02-01')).toBe('Jan – Feb 2022');
    locale.set('fr');
    expect(getAlbumDateRange('2022-01-01', '2022-02-01')).toBe('1 janv. – 1 févr. 2022');
    expect(getShortDateRange('2022-01-01', '2022-02-01')).toBe('janv.–févr. 2022');
    locale.set('en');
    expect(getAlbumDateRange('2022-01-01', '2022-02-01')).toBe('Jan 1 – Feb 1, 2022');
    expect(getShortDateRange('2022-01-01', '2022-02-01')).toBe('Jan – Feb 2022');
  });

  it('keeps native failures without poisoning the next valid locale', async () => {
    const { locale } = await import('$lib/stores/preferences.store');
    const { getAlbumDateRange, getShortDateRange } = await import('./date-time');
    locale.set('invalid_locale');
    expect(() => getAlbumDateRange('2022-01-01', '2022-02-01')).toThrow(RangeError);
    locale.set('en');
    expect(getAlbumDateRange('2022-01-01', '2022-02-01')).toBe('Jan 1 – Feb 1, 2022');
    expect(() => getAlbumDateRange('invalid', '2022-02-01')).toThrow(RangeError);
    expect(getAlbumDateRange('2022-02-01', '2022-01-01')).toBe('Feb 1 – Jan 1, 2022');
    expect(getShortDateRange('2022-01-31', '2022-01-01')).toBe('January 2022');
  });

  it('retains the UTC zone on invalid input when Luxon uses another default zone', async () => {
    const { Settings } = await import('luxon');
    const { parseUtcDate } = await import('./date-time');
    const previousZone = Settings.defaultZone;
    try {
      Settings.defaultZone = 'America/New_York';
      expect(parseUtcDate('invalid').zone.name).toBe('UTC');
    } finally {
      Settings.defaultZone = previousZone;
    }
  });

  it.each([
    ['2024-07-26T23:59:59-06:00', '2024-07-27T05:59:59.000Z'],
    ['2024-07-27T01:00:00+06:00', '2024-07-26T19:00:00.000Z'],
    ['2024-02-29', '2024-02-29T00:00:00.000Z'],
    ['invalid', null],
  ])('preserves UTC parsing for %s', async (input, expected) => {
    const { parseUtcDate } = await import('./date-time');
    const date = parseUtcDate(input!);
    expect(date.toISO()).toBe(expected);
    expect(date.zoneName).toBe(expected === null ? null : 'UTC');
    expect(date.isValid).toBe(expected !== null);
  });
});
