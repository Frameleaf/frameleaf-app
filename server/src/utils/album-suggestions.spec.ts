import { describe, expect, it } from 'vitest';
import {
  type HealPhoto,
  type TripPhoto,
  cosineDistance,
  describeTrip,
  estimateDate,
  healDates,
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
  const now = at('2026-11-11T12:00:00Z');

  it('splits an album into trip segments at long gaps and pads each one', () => {
    const trip = describeTrip(
      [
        ...rockies,
        photo('b1', '2026-08-22T12:00:00'),
        photo('b2', '2026-08-22T13:00:00'),
        photo('b3', '2026-08-23T09:00:00'),
      ],
      now,
    )!;
    expect(trip.segments).toHaveLength(2);
    expect(trip.segments[0].from).toEqual(at('2026-08-11T06:00:00Z'));
    expect(trip.segments[0].to).toEqual(at('2026-08-16T22:00:00Z'));
    expect(trip.cameras.has('Apple\0iPhone 16 Pro')).toBe(true);
  });

  it('ignores everyday albums and stray photos', () => {
    const everyday = Array.from({ length: 40 }, (_, day) =>
      photo(`e${day}`, `2026-0${day < 30 ? 6 : 7}-${String((day % 30) + 1).padStart(2, '0')}T12:00:00`),
    );
    expect(describeTrip(everyday, now)).toBeUndefined();
    expect(describeTrip([photo('x', '2026-08-11T18:00:00')], now)).toBeUndefined();
  });

  // FL-1411 (M11): a catch-all album got "1,000 more photos look like they're from this trip".
  it('is a trip when the whole album fits in three weeks', () => {
    const threeWeeks = Array.from({ length: 22 }, (_, day) =>
      photo(`t${day}`, `2026-08-${String(day + 1).padStart(2, '0')}T12:00:00`),
    );
    expect(describeTrip(threeWeeks, now)?.photoIds).toHaveLength(22);
    expect(describeTrip([...threeWeeks, photo('late', '2026-08-23T12:00:00')], now)).toBeUndefined();
  });

  it('is no trip when the album spans twenty years, however busy its weeks are', () => {
    const catchAll = Array.from({ length: 20 }, (_, year) => [
      photo(`y${year}a`, `${2006 + year}-07-01T12:00:00`),
      photo(`y${year}b`, `${2006 + year}-07-02T12:00:00`),
      photo(`y${year}c`, `${2006 + year}-07-03T12:00:00`),
    ]).flat();
    expect(describeTrip(catchAll, now)).toBeUndefined();
  });

  it('leaves out dates that cannot be right before it measures the album', () => {
    const trip = describeTrip(
      [
        ...rockies,
        // A camera whose clock was never set, and one set to a year still to come.
        { ...photo('reset', '1970-01-01T06:00:00'), localDateTime: at('1970-01-01T00:00:00Z') },
        photo('y2k', '2000-01-01T10:00:00'),
        photo('future1', '2031-03-01T12:00:00'),
        photo('future2', '2031-03-01T13:00:00'),
        photo('future3', '2031-03-02T12:00:00'),
      ],
      now,
    )!;
    expect(trip.photoIds).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(trip.segments).toHaveLength(1);
    // A photo taken later today is not a wrong date.
    expect(
      describeTrip([...rockies, photo('today', '2026-08-16T20:00:00')], at('2026-08-16T12:00:00Z'))?.photoIds,
    ).toContain('today');
  });

  it('keeps a reset date somebody set by hand, as the timeline does', () => {
    const scans = ['1999-12-31T20:00:00', '1999-12-31T23:00:00', '2000-01-01T00:30:00', '2000-01-01T02:00:00'].map(
      (iso, index) => ({ ...photo(`scan${index}`, iso), localDateTime: at(`${iso}Z`), dateSetByHand: true }),
    );
    expect(describeTrip(scans, now)?.photoIds).toEqual(['scan0', 'scan1', 'scan2', 'scan3']);
    expect(
      describeTrip(
        scans.map((scan) => ({ ...scan, dateSetByHand: false })),
        now,
      )?.photoIds,
    ).toBeUndefined();
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
      photo('b1', '2026-08-22T12:00:00'),
      photo('b2', '2026-08-22T13:00:00'),
      photo('b3', '2026-08-23T09:00:00'),
    ])!;
    const outfit = matchOutfit(emma(jacket), [worn('a4', '2026-08-14T17:00:00', jacket)])!;
    const lookAlike = {
      assetId: 'b2',
      distance: 0.2,
      takenAt: at('2026-08-22T13:00:00Z'),
      localDateTime: at('2026-08-22T07:00:00Z'),
    };
    // Saved between the two parts of the trip: it can be from the first, not the second.
    expect(
      estimateDate(twoTrips, {
        neighbours: [lookAlike],
        people: [],
        place: null,
        outfit,
        savedAt: at('2026-08-19T00:00:00Z'),
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

/** FL-1299, ported from the mock's `healDates` tests (prototype `album-cleanup.test.mjs`). */
describe('healDates', () => {
  const start = '2019-07-03';
  const lostOn = '2023-02-14';
  const dayAfter = (from: string, days: number) =>
    new Date(new Date(`${from}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

  const heal = (fileName: string, day: string, overrides: Partial<HealPhoto> = {}): HealPhoto => ({
    id: `id-${fileName}`,
    fileName,
    takenAt: new Date(`${day}T12:00:00Z`),
    localDateTime: new Date(`${day}T12:00:00Z`),
    camera: true,
    estimated: false,
    dateSet: false,
    mine: true,
    ...overrides,
  });
  /** `count` photos a day apart, numbered every `step`, so that lost photos can sit between them. */
  const dated = (count: number, first = start, stem = 'IMG_', step = 2) =>
    Array.from({ length: count }, (_, index) => heal(`${stem}${1000 + index * step}.JPG`, dayAfter(first, index)));
  const lost = (fileName: string, day = lostOn, overrides: Partial<HealPhoto> = {}) =>
    heal(fileName, day, { camera: false, ...overrides });

  it('heals a lost date from the album around it', () => {
    const { eligible, suggestions, from, to } = healDates([...dated(6), lost('IMG_1003.JPG'), lost('Takeout_9.jpg')]);
    expect(eligible).toBe(true);
    expect([from, to]).toEqual([start, dayAfter(start, 5)]);
    expect(suggestions[0]).toMatchObject({
      assetId: 'id-IMG_1003.JPG',
      precision: 'exact',
      day: dayAfter(start, 1),
      shownDay: lostOn,
      between: { before: 'IMG_1002.JPG', after: 'IMG_1004.JPG' },
    });
    expect(suggestions[1]).toMatchObject({ precision: 'around', between: null });
  });

  it('skips an album with too few dated photos', () => {
    expect(healDates([...dated(3), lost('x.jpg')])).toEqual({ eligible: false, reason: 'few', suggestions: [] });
    expect(healDates([])).toEqual({ eligible: false, reason: 'few', suggestions: [] });
  });

  it('skips a wide album, such as ten years of one friend', () => {
    const wide = Array.from({ length: 8 }, (_, index) => heal(`a${index}.jpg`, dayAfter(start, index * 200)));
    expect(healDates([...wide, lost('x.jpg')])).toEqual({ eligible: false, reason: 'wide', suggestions: [] });
  });

  it('leaves a real throwback with camera details alone', () => {
    expect(healDates([...dated(8), heal('old.jpg', '2001-01-01')]).suggestions).toEqual([]);
  });

  it('leaves a photo already inside the album stretch alone, with a day either side', () => {
    const photos = dated(8);
    const [first, last] = [dayAfter(start, 0), dayAfter(start, 7)];
    expect(
      healDates([
        ...photos,
        lost('a.jpg', dayAfter(start, 2)),
        lost('b.jpg', dayAfter(first, -1)),
        lost('c.jpg', dayAfter(last, 1)),
      ]).suggestions,
    ).toEqual([]);
    const outside = healDates([...photos, lost('d.jpg', dayAfter(first, -2)), lost('e.jpg', dayAfter(last, 2))]);
    expect(outside.suggestions.map(({ fileName }) => fileName)).toEqual(['d.jpg', 'e.jpg']);
  });

  it('needs 80% of the dated photos inside one 14-day window', () => {
    const exactlyEighty = [...dated(8), heal('stray1.jpg', '2010-01-01'), heal('stray2.jpg', '2011-01-01')];
    expect(healDates([...exactlyEighty, lost('x.jpg')]).eligible).toBe(true);
    const under = [...dated(7), heal('stray1.jpg', '2010-01-01'), heal('stray2.jpg', '2011-01-01')];
    expect(healDates([...under, lost('x.jpg')])).toMatchObject({ eligible: false, reason: 'wide' });
  });

  it('never counts an estimated date as evidence, however much camera detail it has', () => {
    const estimated = dated(4, '2015-01-01', 'OLD_').map((photo) => ({ ...photo, estimated: true }));
    expect(healDates([...dated(4), ...estimated, lost('x.jpg')])).toMatchObject({ eligible: false, reason: 'few' });

    const window = healDates([...dated(5), ...dated(5, '2015-01-01', 'OLD_').map((p) => ({ ...p, estimated: true }))]);
    expect([window.from, window.to]).toEqual([start, dayAfter(start, 4)]);
  });

  it('does not offer a date someone set, or one already healed', () => {
    const { suggestions } = healDates([
      ...dated(6),
      lost('scan.jpg', '1962-05-01', { dateSet: true }),
      lost('healed.jpg', '2015-01-01', { dateSet: true, estimated: true }),
    ]);
    expect(suggestions).toEqual([]);
  });

  it('counts other members photos as evidence but never offers to change them', () => {
    const others = dated(6).map((photo) => ({ ...photo, mine: false }));
    const { eligible, suggestions } = healDates([
      ...others,
      lost('theirs.jpg', lostOn, { mine: false }),
      lost('mine.jpg'),
    ]);
    expect(eligible).toBe(true);
    expect(suggestions.map(({ fileName }) => fileName)).toEqual(['mine.jpg']);
  });

  describe('exact', () => {
    it('needs both neighbours in the same numbered sequence', () => {
      const photos = [...dated(3), ...dated(3, dayAfter(start, 3), 'DSC_', 2)];
      expect(healDates([...photos, lost('DSC_1001.JPG')]).suggestions[0].precision).toBe('exact');
      expect(healDates([...photos, lost('PXL_1001.JPG')]).suggestions[0].precision).toBe('around');
    });

    it('needs a dated photo on each side', () => {
      expect(healDates([...dated(6), lost('IMG_0500.JPG')]).suggestions[0].precision).toBe('around');
      expect(healDates([...dated(6), lost('IMG_2000.JPG')]).suggestions[0].precision).toBe('around');
    });

    it('needs the neighbours at most a day apart, whichever way the numbers run', () => {
      const apart = [
        heal('IMG_1000.JPG', dayAfter(start, 0)),
        heal('IMG_1002.JPG', dayAfter(start, 2)),
        heal('a.jpg', dayAfter(start, 1)),
        heal('b.jpg', dayAfter(start, 1)),
        heal('c.jpg', dayAfter(start, 1)),
      ];
      expect(healDates([...apart, lost('IMG_1001.JPG')]).suggestions[0].precision).toBe('around');

      const backwards = [
        heal('IMG_1000.JPG', dayAfter(start, 5)),
        heal('IMG_1002.JPG', dayAfter(start, 0)),
        heal('a.jpg', dayAfter(start, 1)),
        heal('b.jpg', dayAfter(start, 1)),
        heal('c.jpg', dayAfter(start, 1)),
      ];
      expect(healDates([...backwards, lost('IMG_1001.JPG')]).suggestions[0].precision).toBe('around');
    });

    it('takes the earlier neighbour, with its time of day and offset', () => {
      const neighbours = [
        heal('IMG_1002.JPG', start, {
          takenAt: at('2019-07-03T15:20:10Z'),
          localDateTime: at('2019-07-03T09:20:10Z'),
        }),
        heal('IMG_1004.JPG', start, {
          takenAt: at('2019-07-03T15:40:00Z'),
          localDateTime: at('2019-07-03T09:40:00Z'),
        }),
      ];
      const { suggestions } = healDates([...neighbours, ...dated(4, dayAfter(start, 1), 'A_'), lost('IMG_1003.JPG')]);
      expect(suggestions[0]).toMatchObject({ precision: 'exact', dateTimeOriginal: '2019-07-03T09:20:10-06:00' });
    });

    it('is not fooled by another run of numbers earlier in the name', () => {
      const photos = [
        heal('IMG_20190703_1002.jpg', start),
        heal('IMG_20190703_1004.jpg', start),
        heal('a.jpg', dayAfter(start, 1)),
        heal('b.jpg', dayAfter(start, 1)),
        heal('c.jpg', dayAfter(start, 1)),
      ];
      expect(healDates([...photos, lost('IMG_20190703_1003.jpg')]).suggestions[0].precision).toBe('exact');
    });
  });

  it('dates an "around" photo at noon on the middle photo\'s day, in that photo\'s offset', () => {
    const photos = Array.from({ length: 5 }, (_, index) => {
      const day = dayAfter(start, index);
      return heal(`${index}.jpg`, day, {
        takenAt: at(`${day}T18:00:00Z`),
        localDateTime: at(`${day}T11:00:00Z`),
      });
    });
    const { suggestions } = healDates([...photos, lost('x.jpg')]);
    expect(suggestions[0]).toMatchObject({
      precision: 'around',
      day: dayAfter(start, 2),
      dateTimeOriginal: `${dayAfter(start, 2)}T12:00:00-07:00`,
    });
  });
});
