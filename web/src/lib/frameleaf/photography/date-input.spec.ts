import { Settings } from 'luxon';
import { endOfLocalDayIso, localDateInput } from './date-input';

describe('photography date inputs', () => {
  const previousZone = Settings.defaultZone;
  afterEach(() => {
    Settings.defaultZone = previousZone;
  });

  it('keeps the picked day west of UTC, where end of day is the next UTC date', () => {
    Settings.defaultZone = 'America/Los_Angeles';
    const saved = endOfLocalDayIso('2026-11-20');
    expect(saved).toBe('2026-11-21T07:59:59.000Z');
    expect(localDateInput(saved)).toBe('2026-11-20');
  });

  it('does not drift across repeated saves', () => {
    Settings.defaultZone = 'America/New_York';
    let value = '2026-03-08';
    for (let index = 0; index < 3; index++) {
      value = localDateInput(endOfLocalDayIso(value));
    }
    expect(value).toBe('2026-03-08');
  });

  it('keeps the picked day east of UTC', () => {
    Settings.defaultZone = 'Asia/Tokyo';
    const saved = endOfLocalDayIso('2026-11-20');
    expect(saved).toBe('2026-11-20T14:59:59.000Z');
    expect(localDateInput(saved)).toBe('2026-11-20');
  });

  it('treats blank and invalid values as no date', () => {
    expect(endOfLocalDayIso('')).toBeNull();
    expect(localDateInput(null)).toBe('');
    expect(localDateInput(undefined)).toBe('');
    expect(localDateInput('not a date')).toBe('');
  });
});
