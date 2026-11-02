import { describe, expect, it } from 'vitest';
import {
  type TripPhoto,
  cosineDistance,
  describeTrip,
  estimateDate,
  matchOutfit,
  matchTripCandidate,
  suspiciousDate,
  torsoBox,
  utcOffset,
} from 'src/utils/album-suggestions.js';

const at = (iso: string) => new Date(iso);
// Lake Louise, Banff (55 km away) and Calgary (180 km away).
const LAKE = { latitude: 51.4254, longitude: -116.1773 };
const BANFF = { latitude: 51.1784, longitude: -115.5708 };
const CALGARY = { latitude: 51.0447, longitude: -114.0719 };

const photo = (id: string, iso: string, place: { latitude: number; longitude: number } | null = LAKE): TripPhoto => ({
  id,
  takenAt: at(`${iso}Z`),
  // Mountain time, UTC-6 in August.
  localDateTime: new Date(at(`${iso}Z`).getTime() - 6 * 3_600_000),
  latitude: place?.latitude ?? null,
  longitude: place?.longitude ?? null,
  make: 'Apple',
  model: 'iPhone 16 Pro',
});

const rockies = [
  photo('a1', '2026-08-11T18:00:00'),
  photo('a2', '2026-08-12T16:00:00'),
  photo('a3', '2026-08-13T20:00:00', BANFF),
  photo('a4', '2026-08-14T17:00:00'),
  photo('a5', '2026-08-16T10:00:00'),
];

describe('describeTrip', () => {
  it('splits an album into trips at long gaps and pads each one', () => {
    const trip = describeTrip([
      ...rockies,
      photo('b1', '2027-02-01T12:00:00'),
      photo('b2', '2027-02-01T13:00:00'),
      photo('b3', '2027-02-02T09:00:00'),
    ])!;
    expect(trip.segments).toHaveLength(2);
    expect(trip.segments[0].from).toEqual(at('2026-08-11T06:00:00Z'));
    expect(trip.segments[0].to).toEqual(at('2026-08-16T22:00:00Z'));
    expect(trip.cameras.has('Apple\0iPhone 16 Pro')).toBe(true);
  });

  it('ignores everyday albums and stray photos', () => {
    const everyday = Array.from({ length: 40 }, (_, day) =>
      photo(`e${day}`, `2026-0${day < 30 ? 6 : 7}-${String((day % 30) + 1).padStart(2, '0')}T12:00:00`),
    );
    expect(describeTrip(everyday)).toBeUndefined();
    expect(describeTrip([photo('x', '2026-08-11T18:00:00')])).toBeUndefined();
  });
});

describe('matchTripCandidate', () => {
  const trip = describeTrip(rockies)!;
  const candidate = {
    id: 'c',
    takenAt: at('2026-08-14T15:00:00Z'),
    localDateTime: at('2026-08-14T09:00:00Z'),
    ...LAKE,
    place: 'Lake Louise',
    make: 'Google',
    model: 'Pixel 9',
  };

  it('is very likely when taken during the trip at its places', () => {
    expect(matchTripCandidate(trip, candidate)).toEqual({
      likely: true,
      reasons: [
        { kind: 'during-trip', date: '2026-08-14' },
        { kind: 'place', place: 'Lake Louise' },
      ],
    });
  });

  it('leaves out photos taken during the trip somewhere else, or outside it', () => {
    expect(matchTripCandidate(trip, { ...candidate, ...CALGARY })).toBeUndefined();
    expect(matchTripCandidate(trip, { ...candidate, takenAt: at('2026-08-20T15:00:00Z') })).toBeUndefined();
  });

  it('needs a second signal for photos without a location', () => {
    const unlocated = { ...candidate, latitude: null, longitude: null, place: null };
    expect(matchTripCandidate(trip, unlocated)).toBeUndefined();
    expect(matchTripCandidate(trip, { ...unlocated, make: 'Apple', model: 'iPhone 16 Pro' })).toEqual({
      likely: false,
      reasons: [{ kind: 'during-trip', date: '2026-08-14' }, { kind: 'same-camera' }],
    });
    expect(matchTripCandidate(trip, { ...unlocated, visualDistance: 0.2 })?.reasons).toContainEqual({
      kind: 'looks-like',
    });
  });
});

describe('suspiciousDate', () => {
  it('reads when a photo was saved or received from its name', () => {
    expect(suspiciousDate('FB_IMG_1725468812000.jpg', false)).toEqual({
      source: 'facebook',
      savedAt: at('2024-09-04T16:53:32Z'),
    });
    expect(suspiciousDate('IMG-20260921-WA0007.jpg', false)).toEqual({
      source: 'whatsapp',
      savedAt: at('2026-09-21T23:59:59Z'),
    });
    expect(suspiciousDate('received_10158823.jpeg', true)).toEqual({ source: 'messenger' });
  });

  it('trusts camera photos and flags files with no capture details', () => {
    expect(suspiciousDate('IMG_4821.HEIC', true)).toBeUndefined();
    expect(suspiciousDate('scan_0042.jpg', false)).toEqual({ source: 'none' });
  });
});

describe('estimateDate', () => {
  const trip = describeTrip(rockies)!;
  const neighbour = (assetId: string, distance: number, iso = '2026-08-14T02:41:00') => ({
    assetId,
    distance,
    takenAt: at(`${iso}Z`),
    localDateTime: new Date(at(`${iso}Z`).getTime() - 6 * 3_600_000),
  });

  it('dates a near-identical copy to the moment', () => {
    expect(
      estimateDate(trip, {
        neighbours: [neighbour('a3', 0.03), neighbour('a4', 0.05)],
        people: [],
        place: null,
      }),
    ).toEqual({
      precision: 'moment',
      localDateTime: '2026-08-13T20:41:00',
      datedBy: { takenAt: at('2026-08-14T02:41:00Z'), localDateTime: at('2026-08-13T20:41:00Z') },
      reasons: [{ kind: 'near-identical', assetId: 'a3', date: '2026-08-13' }],
    });
  });

  it('needs two independent signals', () => {
    expect(estimateDate(trip, { neighbours: [neighbour('a3', 0.03)], people: [], place: null })).toBeUndefined();
    expect(estimateDate(trip, { neighbours: [neighbour('a3', 0.2)], people: ['Emma'], place: null })).toMatchObject({
      precision: 'trip',
      localDateTime: '2026-08-11T12:00:00',
    });
    expect(
      estimateDate(trip, { neighbours: [neighbour('a3', 0.1)], people: ['Emma'], place: 'Lake Louise' }),
    ).toMatchObject({ precision: 'day', localDateTime: '2026-08-13T12:00:00' });
  });

  it('never dates a photo after the moment it was received', () => {
    // Received on the 13th (late UTC), but it matches photos taken on the 14th.
    expect(
      estimateDate(trip, {
        neighbours: [neighbour('a4', 0.03, '2026-08-14T17:00:00'), neighbour('a2', 0.04, '2026-08-14T17:00:00')],
        people: [],
        place: null,
        savedAt: at('2026-08-13T23:59:59Z'),
      }),
    ).toBeUndefined();
  });

  it('never dates a photo after it was saved', () => {
    expect(
      estimateDate(trip, {
        neighbours: [neighbour('a3', 0.03), neighbour('a4', 0.04)],
        people: [],
        place: null,
        savedAt: at('2026-08-01T00:00:00Z'),
      }),
    ).toBeUndefined();
  });
});

describe('outfits', () => {
  const trip = describeTrip(rockies)!;
  const jacket = [1, 0, 0];
  const nearlyJacket = [0.99, 0.1, 0];
  const swimsuit = [0, 1, 0];
  const worn = (assetId: string, iso: string, embedding: number[], personId = 'emma') => ({
    assetId,
    personId,
    name: personId === 'emma' ? 'Emma' : 'Sam',
    embedding,
    takenAt: at(`${iso}Z`),
    localDateTime: new Date(at(`${iso}Z`).getTime() - 6 * 3_600_000),
  });
  const emma = (embedding: number[]) => [{ personId: 'emma', name: 'Emma', embedding }];

  it('crops the torso under a face, clamped to the image', () => {
    expect(torsoBox({ x1: 100, y1: 50, x2: 140, y2: 100 }, { width: 400, height: 300 })).toEqual({
      x: 60,
      y: 100,
      width: 120,
      height: 150,
    });
    expect(torsoBox({ x1: 0, y1: 0, x2: 40, y2: 50 }, { width: 400, height: 300 })).toEqual({
      x: 0,
      y: 50,
      width: 80,
      height: 150,
    });
    // A face at the bottom of the frame has no clothes under it.
    expect(torsoBox({ x1: 100, y1: 250, x2: 140, y2: 290 }, { width: 400, height: 300 })).toBeUndefined();
    expect(torsoBox({ x1: 100, y1: 50, x2: 100, y2: 100 }, { width: 400, height: 300 })).toBeUndefined();
  });

  it('measures cosine distance and refuses vectors of another size', () => {
    expect(cosineDistance([1, 0], [1, 0])).toBeCloseTo(0);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
    expect(cosineDistance([1, 0], [1, 0, 0])).toBe(Infinity);
    expect(cosineDistance([0, 0], [1, 0])).toBe(Infinity);
  });

  it('finds the one trip day the same person wore the same clothes', () => {
    expect(
      matchOutfit(emma(nearlyJacket), [
        worn('a2', '2026-08-12T16:00:00', swimsuit),
        worn('a4', '2026-08-14T17:00:00', jacket),
        worn('a5', '2026-08-14T18:00:00', jacket, 'sam'),
      ]),
    ).toMatchObject({ name: 'Emma', assetId: 'a4' });
  });

  it('tells no day when the clothes were worn on several days, or by someone else', () => {
    expect(
      matchOutfit(emma(jacket), [worn('a2', '2026-08-12T16:00:00', jacket), worn('a4', '2026-08-14T17:00:00', jacket)]),
    ).toBeUndefined();
    expect(matchOutfit(emma(jacket), [worn('a4', '2026-08-14T17:00:00', jacket, 'sam')])).toBeUndefined();
    expect(matchOutfit(emma(jacket), [worn('a4', '2026-08-14T17:00:00', swimsuit)])).toBeUndefined();
  });

  it('counts a same outfit as a signal and dates the photo to that day', () => {
    const outfit = matchOutfit(emma(jacket), [worn('a4', '2026-08-14T17:00:00', jacket)])!;
    expect(estimateDate(trip, { neighbours: [], people: ['Emma'], place: null, outfit })).toEqual({
      precision: 'day',
      localDateTime: '2026-08-14T12:00:00',
      datedBy: { takenAt: at('2026-08-14T17:00:00Z'), localDateTime: at('2026-08-14T11:00:00Z') },
      reasons: [
        { kind: 'people', names: ['Emma'] },
        { kind: 'same-outfit', names: ['Emma'], assetId: 'a4', date: '2026-08-14' },
      ],
    });
    // An outfit alone is one signal.
    expect(estimateDate(trip, { neighbours: [], people: [], place: null, outfit })).toBeUndefined();
  });

  it('ignores an outfit from another day than the scene it shows', () => {
    const outfit = matchOutfit(emma(jacket), [worn('a4', '2026-08-14T17:00:00', jacket)])!;
    const scene = {
      assetId: 'a3',
      distance: 0.1,
      takenAt: at('2026-08-13T20:00:00Z'),
      localDateTime: at('2026-08-13T14:00:00Z'),
    };
    expect(estimateDate(trip, { neighbours: [scene], people: [], place: null, outfit })).toBeUndefined();
    expect(estimateDate(trip, { neighbours: [scene], people: ['Emma'], place: null, outfit })).toEqual(
      expect.objectContaining({
        localDateTime: '2026-08-13T12:00:00',
        reasons: expect.not.arrayContaining([expect.objectContaining({ kind: 'same-outfit' })]),
      }),
    );
  });

  it("checks the save date against the outfit's trip, not a later look-alike's", () => {
    const twoTrips = describeTrip([
      ...rockies,
      photo('b1', '2027-02-01T12:00:00'),
      photo('b2', '2027-02-01T13:00:00'),
      photo('b3', '2027-02-02T09:00:00'),
    ])!;
    const outfit = matchOutfit(emma(jacket), [worn('a4', '2026-08-14T17:00:00', jacket)])!;
    const lookAlike = {
      assetId: 'b2',
      distance: 0.2,
      takenAt: at('2027-02-01T13:00:00Z'),
      localDateTime: at('2027-02-01T07:00:00Z'),
    };
    // Saved between the two trips: it can be from August, not February.
    expect(
      estimateDate(twoTrips, {
        neighbours: [lookAlike],
        people: [],
        place: null,
        outfit,
        savedAt: at('2026-12-01T00:00:00Z'),
      }),
    ).toMatchObject({ precision: 'day', localDateTime: '2026-08-14T12:00:00' });
  });
});

describe('utcOffset', () => {
  it('formats the local offset', () => {
    expect(utcOffset(at('2026-08-14T15:00:00Z'), at('2026-08-14T09:00:00Z'))).toBe('-06:00');
    expect(utcOffset(at('2026-08-14T15:00:00Z'), at('2026-08-15T00:30:00Z'))).toBe('+09:30');
  });
});
