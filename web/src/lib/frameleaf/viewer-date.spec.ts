import { joinDateTime, splitDateTime, timezoneChoices, timezoneOffsetLabel } from '$lib/frameleaf/viewer-date';

describe('viewer date dialog (V-23)', () => {
  it('splits a stored capture time into its wall-clock date and time', () => {
    expect(splitDateTime('2026-09-24T18:05:12.000+02:00')).toEqual({ date: '2026-09-24', time: '18:05' });
    expect(splitDateTime('2026-09-24')).toEqual({ date: '2026-09-24', time: '00:00' });
    expect(splitDateTime(null)).toEqual({ date: '', time: '' });
  });

  it('joins a date and time, refusing incomplete or impossible ones', () => {
    expect(joinDateTime('2026-09-24', '18:05')).toBe('2026-09-24T18:05:00');
    expect(joinDateTime('2026-02-31', '10:00')).toBeNull();
    expect(joinDateTime('2026-09-24', '')).toBeNull();
    expect(joinDateTime('', '10:00')).toBeNull();
  });

  it('labels a zone with its offset', () => {
    expect(timezoneOffsetLabel('UTC', new Date('2026-01-01T00:00:00Z'))).toBe('UTC+00:00');
    expect(timezoneOffsetLabel('Asia/Tokyo', new Date('2026-01-01T00:00:00Z'))).toBe('UTC+09:00');
    expect(timezoneOffsetLabel('Not/AZone')).toBeNull();
  });

  it("offers the common zones with the item's own first, then every other zone", () => {
    const { common, more } = timezoneChoices('Asia/Kathmandu', new Date('2026-01-01T00:00:00Z'), [
      'Asia/Kathmandu',
      'Asia/Tokyo',
      'Europe/Oslo',
    ]);
    expect(common[0]).toEqual({ value: 'Asia/Kathmandu', label: 'UTC+05:45 · Asia/Kathmandu' });
    expect(common.map((option) => option.value)).toContain('America/New_York');
    expect(more.map((option) => option.value)).toEqual(['Europe/Oslo']);
  });
});
