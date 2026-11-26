import {
  type FillPoint,
  ZoneLookup,
  candidateInstants,
  proposeForLocalTime,
  proposeLocation,
} from 'src/utils/location-fill.js';

const point = (time: string, latitude: number, longitude: number): FillPoint => ({
  recordedAt: new Date(time),
  latitude,
  longitude,
});

const MIN = 60;
// Banff Avenue, walking south: about 1.1 km between the two
const north = point('2024-07-01T16:00:00Z', 51.18, -115.57);
const south = point('2024-07-01T16:10:00Z', 51.17, -115.57);

describe('location fill matching', () => {
  it('takes the nearest place within the chosen time', () => {
    const at = new Date('2024-07-01T15:57:00Z');
    expect(proposeLocation(at, null, north, 5 * MIN)).toEqual({
      latitude: 51.18,
      longitude: -115.57,
      method: 'nearest',
      gapSeconds: 180,
    });
    expect(proposeLocation(at, null, north, 2 * MIN)).toBeNull();
    expect(proposeLocation(new Date('2024-07-01T16:14:00Z'), south, null, 5 * MIN)).toMatchObject({
      latitude: 51.17,
      gapSeconds: 240,
    });
    expect(proposeLocation(at, null, null, 60 * MIN)).toBeNull();
    // a place on the wrong side of the moment is not that side's place
    expect(proposeLocation(at, north, null, 60 * MIN)).toBeNull();
  });

  it('puts a photo between two places by time when both are within the gap', () => {
    const proposal = proposeLocation(new Date('2024-07-01T16:04:00Z'), north, south, 15 * MIN)!;
    expect(proposal.method).toBe('interpolated');
    expect(proposal.latitude).toBeCloseTo(51.176, 6);
    expect(proposal.longitude).toBeCloseTo(-115.57, 6);
    expect(proposal.gapSeconds).toBe(240);
    // exactly on a place: that place, not a line through it
    expect(proposeLocation(north.recordedAt, north, south, 15 * MIN)).toEqual({
      latitude: 51.18,
      longitude: -115.57,
      method: 'nearest',
      gapSeconds: 0,
    });
  });

  it('never joins places more than 5 km apart, or one outside the gap', () => {
    // Banff to Canmore in ten minutes: about 20 km
    const canmore = point('2024-07-01T16:10:00Z', 51.089, -115.359);
    expect(proposeLocation(new Date('2024-07-01T16:04:00Z'), north, canmore, 15 * MIN)).toEqual({
      latitude: 51.18,
      longitude: -115.57,
      method: 'nearest',
      gapSeconds: 240,
    });
    expect(proposeLocation(new Date('2024-07-01T16:07:00Z'), north, canmore, 15 * MIN)).toMatchObject({
      latitude: 51.089,
      method: 'nearest',
      gapSeconds: 180,
    });
    // within 5 km, but the earlier place is outside a 5 minute gap
    expect(proposeLocation(new Date('2024-07-01T16:08:00Z'), north, south, 5 * MIN)).toMatchObject({
      latitude: 51.17,
      method: 'nearest',
      gapSeconds: 120,
    });
    // just under 5 km apart is joined
    const near = point('2024-07-01T16:10:00Z', 51.136, -115.57);
    expect(proposeLocation(new Date('2024-07-01T16:05:00Z'), north, near, 15 * MIN)?.method).toBe('interpolated');
  });

  it('goes the short way round the 180th meridian', () => {
    const west = point('2024-07-01T00:00:00Z', -16.5, 179.99);
    const east = point('2024-07-01T00:10:00Z', -16.5, -179.99);
    const proposal = proposeLocation(new Date('2024-07-01T00:05:00Z'), west, east, 15 * MIN)!;
    expect(proposal.method).toBe('interpolated');
    expect(Math.abs(proposal.longitude)).toBeCloseTo(180, 6);
  });

  describe('a clock time with no zone', () => {
    const zones = new ZoneLookup();
    // the owner's morning in Banff (UTC-6 in July), then an evening in Munich (UTC+2) a day later
    const banff = [point('2024-07-01T15:00:00Z', 51.178, -115.571), point('2024-07-01T15:10:00Z', 51.176, -115.57)];
    const munich = [point('2024-07-02T18:00:00Z', 48.137, 11.575)];
    const history = [...banff, ...munich];
    const around = (at: Date) =>
      Promise.resolve({
        before: history.findLast((item) => item.recordedAt <= at) ?? null,
        after: history.find((item) => item.recordedAt >= at) ?? null,
      });
    const nearby = (local: Date) =>
      history.filter((item) => Math.abs(item.recordedAt.getTime() - local.getTime()) <= 14 * 3_600_000);

    it('reads the zone from where the owner was', () => {
      expect(zones.offsetMinutes(banff[0])).toBe(-360);
      expect(zones.offsetMinutes(munich[0])).toBe(120);
      expect(zones.offsetMinutes(point('2024-01-01T00:00:00Z', 51.178, -115.571))).toBe(-420);
      expect(candidateInstants(new Date('2024-07-01T09:05:00Z'), banff, zones)).toEqual([
        { at: new Date('2024-07-01T15:05:00Z'), offsetMinutes: -360 },
      ]);
    });

    it('matches the photo by local time, not by the same digits in UTC', async () => {
      // 09:05 on the camera's clock, in Banff: 15:05 UTC, between the two Banff places
      const local = new Date('2024-07-01T09:05:00Z');
      const proposal = await proposeForLocalTime(local, nearby(local), zones, 15 * MIN, around);
      expect(proposal).toMatchObject({ method: 'interpolated', gapSeconds: 300 });
      expect(proposal!.latitude).toBeCloseTo(51.177, 6);

      // 20:00 on the clock in Munich the next day: 18:00 UTC
      const evening = new Date('2024-07-02T20:00:00Z');
      await expect(proposeForLocalTime(evening, nearby(evening), zones, 5 * MIN, around)).resolves.toMatchObject({
        latitude: 48.137,
        method: 'nearest',
        gapSeconds: 0,
      });
    });

    it('proposes nothing when no place keeps the clock the photo shows', async () => {
      // 15:05 on the clock: the history has places at 15:05 UTC, but they are in Banff, where that is 09:05
      const local = new Date('2024-07-01T15:05:00Z');
      await expect(proposeForLocalTime(local, nearby(local), zones, 15 * MIN, around)).resolves.toBeNull();
      // and nothing when the history is nowhere near that day
      const other = new Date('2023-01-01T12:00:00Z');
      await expect(proposeForLocalTime(other, nearby(other), zones, 60 * MIN, around)).resolves.toBeNull();
    });
  });
});
