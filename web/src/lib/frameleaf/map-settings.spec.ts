import { DateTime } from 'luxon';
import { formatMapArea, mapDateWindow, parseMapArea } from '$lib/frameleaf/map-settings';

describe('mapDateWindow', () => {
  const now = DateTime.fromISO('2026-09-23T15:00:00', { zone: 'utc' });

  it('asks for everything by default', () => {
    expect(mapDateWindow({ datePreset: 'all', dateAfter: '', dateBefore: '' }, now)).toEqual({});
  });

  it('starts the last 30 days at the start of that day', () => {
    expect(mapDateWindow({ datePreset: '30d', dateAfter: '', dateBefore: '' }, now)).toEqual({
      fileCreatedAfter: '2026-08-24T00:00:00.000Z',
    });
  });

  it('starts this year on January 1', () => {
    expect(mapDateWindow({ datePreset: 'year', dateAfter: '', dateBefore: '' }, now)).toEqual({
      fileCreatedAfter: '2026-01-01T00:00:00.000Z',
    });
  });

  it('keeps both days of a custom range and ignores a half-typed date', () => {
    const range = mapDateWindow({ datePreset: 'custom', dateAfter: '2026-02-01', dateBefore: '2026-02' }, now);
    expect(range.fileCreatedAfter).toBeDefined();
    expect(range.fileCreatedBefore).toBeUndefined();

    const full = mapDateWindow({ datePreset: 'custom', dateAfter: '2026-02-01', dateBefore: '2026-02-03' }, now);
    expect(DateTime.fromISO(full.fileCreatedBefore!) > DateTime.fromISO(full.fileCreatedAfter!)).toBe(true);
  });
});

describe('map areas', () => {
  it('rounds outwards so edge items stay inside', () => {
    expect(formatMapArea({ west: -114.123456, south: 51.000001, east: -113.999991, north: 51.5 })).toBe(
      '-114.12346,51,-113.99999,51.5',
    );
  });

  it('reads a written area back', () => {
    expect(parseMapArea('-114.1,51,-113.9,51.5')).toEqual({ west: -114.1, south: 51, east: -113.9, north: 51.5 });
  });

  it('refuses anything that is not four ordered coordinates', () => {
    expect(parseMapArea(null)).toBeNull();
    expect(parseMapArea('1,2,3')).toBeNull();
    expect(parseMapArea('a,b,c,d')).toBeNull();
    expect(parseMapArea('0,50,1,40')).toBeNull();
    expect(parseMapArea('0,-95,1,40')).toBeNull();
  });
});
