import { DateTime } from 'luxon';
import { type DateFinding, DateFindingCause, type DateScanRow } from 'src/utils/date-doctor.js';
import { dateProblem } from 'src/utils/date-sanity.js';

/**
 * FL-912 acceptance fixture: 500 photos with a known wrong date or zone (each cause in its own stretch of time, so
 * one scenario is never evidence for another) and the clean photos around them, plus clean scenarios built to tempt
 * the detector (a camera shooting hours away from the phone, edited files whose offsets differ, matching names).
 *
 * Built deterministically, as scan rows. The medium spec inserts the same photos into a real database.
 */
export type FixturePhoto = DateScanRow & {
  /** What the Doctor should find; undefined for a clean photo. */
  expect?: { cause: DateFindingCause; proposedDate: Date | null; proposedZone: string | null };
};

export const FIXTURE_NOW = new Date('2026-06-01T12:00:00Z');

const PLACES = {
  paris: { lat: 48.8566, lon: 2.3522, zone: 'Europe/Paris' },
  tokyo: { lat: 35.6762, lon: 139.6503, zone: 'Asia/Tokyo' },
  newYork: { lat: 40.7128, lon: -74.006, zone: 'America/New_York' },
  calgary: { lat: 51.0447, lon: -114.0719, zone: 'America/Edmonton' },
  sydney: { lat: -33.8688, lon: 151.2093, zone: 'Australia/Sydney' },
};
type Place = (typeof PLACES)[keyof typeof PLACES];

let seed = 912;
const random = () => {
  // mulberry32
  seed = Math.trunc(seed + 0x6d_2b_79_f5);
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
let counter = 0;
const nextId = () => {
  counter++;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
};

const name = (prefix: string, wall: DateTime) => `${prefix}_${wall.toFormat('yyyyMMdd_HHmmss')}.jpg`;

/** A photo whose wall time `wall` (in the zone it was taken) is right. */
const photo = (
  wall: DateTime,
  {
    zone,
    place,
    camera,
    fileName,
  }: { zone: string | null; place?: Place; camera: [string, string]; fileName?: string },
): FixturePhoto => {
  const local = DateTime.fromObject(wall.toObject(), { zone: 'UTC' });
  const takenAt = zone ? DateTime.fromObject(wall.toObject(), { zone }) : local;
  return {
    id: nextId(),
    originalFileName: fileName ?? `DSC${counter.toString().padStart(5, '0')}.JPG`,
    takenAt: takenAt.toJSDate(),
    localDateTime: local.toJSDate(),
    timeZone: zone,
    latitude: place?.lat ?? null,
    longitude: place?.lon ?? null,
    make: camera[0],
    model: camera[1],
    offsetTimeOriginal: null,
    offsetTime: null,
    dateLocked: false,
    zoneLocked: false,
    toCheck: false,
  };
};

const PHONE: [string, string] = ['Google', 'Pixel 8'];
const DSLR: [string, string] = ['Canon', 'EOS R6'];
const OLD_CAMERA: [string, string] = ['Nikon', 'D90'];

/** A Pixel names its files by the moment in UTC. */
const phoneAt = (wall: DateTime, place: Place) =>
  photo(wall, {
    zone: place.zone,
    place,
    camera: PHONE,
    fileName: name('PXL', DateTime.fromObject(wall.toObject(), { zone: place.zone }).setZone('UTC')),
  });

/** A day out: phone photos with GPS through the day, in two moments. */
const phoneDay = (day: DateTime, place: Place, count = 12) =>
  Array.from({ length: count }, (_, i) =>
    phoneAt(day.plus({ hours: i < count / 2 ? 10 : 15, minutes: (i % (count / 2)) * 7 }), place),
  );

const wall = (iso: string) => DateTime.fromISO(iso, { zone: 'UTC' });
const instant = (localWall: DateTime, zone: string) => DateTime.fromObject(localWall.toObject(), { zone }).toJSDate();

export const buildDateDoctorFixture = (): FixturePhoto[] => {
  seed = 912;
  counter = 0;
  const photos: FixturePhoto[] = [];
  const add = (...items: FixturePhoto[]) => {
    photos.push(...items);
  };

  // ---- (f) future dates: a camera clock set years ahead; half carry their real date in the name (40)
  for (let i = 0; i < 40; i++) {
    const real = wall('2018-03-01T09:00').plus({ days: i, minutes: Math.floor(random() * 600) });
    const wrong = wall('2031-06-01T09:00').plus({ days: i });
    const item = photo(wrong, {
      zone: 'America/Edmonton',
      camera: OLD_CAMERA,
      fileName: i % 2 === 0 ? name('IMG', real) : undefined,
    });
    item.toCheck = true;
    item.expect = {
      cause: DateFindingCause.FutureDate,
      proposedDate: i % 2 === 0 ? instant(real, 'America/Edmonton') : null,
      proposedZone: i % 2 === 0 ? 'America/Edmonton' : null,
    };
    add(item);
  }

  // ---- (f) reset dates: 1970-01-01 and 2000-01-01, half named (40)
  for (let i = 0; i < 40; i++) {
    const real = wall('2017-05-01T09:00').plus({ days: i, minutes: Math.floor(random() * 600) });
    const wrong = wall(i % 4 < 2 ? '1970-01-01T00:00' : '2000-01-01T00:00').plus({ minutes: i * 3 });
    const item = photo(wrong, {
      zone: null,
      camera: OLD_CAMERA,
      fileName: i % 2 === 0 ? name('IMG', real) : undefined,
    });
    item.toCheck = true;
    item.expect = {
      cause: DateFindingCause.EpochDate,
      proposedDate: i % 2 === 0 ? real.toJSDate() : null,
      proposedZone: null,
    };
    add(item);
  }

  // ---- (e) the stored date is when the file was copied; the name holds the real one (80)
  for (let i = 0; i < 80; i++) {
    const real = wall('2019-01-05T08:00').plus({ days: i * 3, minutes: Math.floor(random() * 700) });
    const copied = real.plus({ days: 3 + Math.floor(random() * 50), hours: Math.floor(random() * 10) });
    const whatsApp = i % 2 === 1;
    const fileName = whatsApp
      ? `IMG-${real.toFormat('yyyyMMdd')}-WA${String(i).padStart(4, '0')}.jpg`
      : name('IMG', real);
    const item = photo(copied, { zone: 'America/Edmonton', camera: ['', ''], fileName });
    item.make = null;
    item.model = null;
    const proposedWall = whatsApp ? real.startOf('day').plus({ hours: 12 }) : real;
    item.expect = {
      cause: DateFindingCause.FilenameDate,
      proposedDate: instant(proposedWall, 'America/Edmonton'),
      proposedZone: 'America/Edmonton',
    };
    add(item);
  }

  // ---- (b) a trip to Tokyo with the camera's zone left at home (80), among phone photos that are right
  for (let day = 0; day < 8; day++) {
    const date = wall('2021-04-01').plus({ days: day * 2 });
    add(...phoneDay(date, PLACES.tokyo, 6));
    for (let i = 0; i < 10; i++) {
      const realWall = date.plus({ hours: 11, minutes: i * 9 });
      const at = DateTime.fromObject(realWall.toObject(), { zone: 'Asia/Tokyo' });
      // the camera wrote Calgary's wall time for the same instant
      const homeWall = at.setZone('America/Edmonton');
      const item = photo(homeWall, { zone: 'America/Edmonton', place: PLACES.tokyo, camera: ['Sony', 'RX100 VII'] });
      item.expect = {
        cause: DateFindingCause.GpsZoneMismatch,
        proposedDate: at.toJSDate(),
        proposedZone: 'Asia/Tokyo',
      };
      add(item);
    }
  }

  // ---- (c) a camera that records no zone, out with a phone in Paris (80)
  for (let day = 0; day < 8; day++) {
    const date = wall('2022-07-01').plus({ days: day * 2 });
    add(...phoneDay(date, PLACES.paris, 12));
    for (let i = 0; i < 10; i++) {
      const realWall = date.plus({ hours: 10, minutes: i * 8 + 3 });
      const item = photo(realWall, { zone: null, camera: OLD_CAMERA });
      item.expect = {
        cause: DateFindingCause.MissingZone,
        proposedDate: instant(realWall, 'Europe/Paris'),
        proposedZone: 'Europe/Paris',
      };
      add(item);
    }
  }

  // ---- (d) a camera clock 47 minutes fast, at a wedding with a phone (100)
  for (let day = 0; day < 5; day++) {
    const date = wall('2023-09-02').plus({ days: day * 7 });
    for (let i = 0; i < 20; i++) {
      const realWall = date.plus({ hours: i < 10 ? 13 : 18, minutes: (i % 10) * 6 });
      add(phoneAt(realWall.plus({ seconds: Math.floor(random() * 50) - 25 }), PLACES.newYork));
      const shown = realWall.plus({ minutes: 47 });
      const item = photo(shown, { zone: 'America/New_York', camera: DSLR });
      item.expect = {
        cause: DateFindingCause.BurstDrift,
        proposedDate: instant(realWall, 'America/New_York'),
        proposedZone: 'America/New_York',
      };
      add(item);
    }
  }

  // ---- (a) the camera kept winter's offset in summer; its own OffsetTime and the phone say +02:00 (80)
  for (let day = 0; day < 8; day++) {
    const date = wall('2024-06-03').plus({ days: day * 2 });
    add(...phoneDay(date, PLACES.paris, 12));
    for (let i = 0; i < 10; i++) {
      const realWall = date.plus({ hours: 15, minutes: i * 6 + 2 });
      const item = photo(realWall, { zone: 'UTC+1', camera: ['Fujifilm', 'X-T4'] });
      item.offsetTimeOriginal = '+01:00';
      item.offsetTime = '+02:00';
      item.expect = {
        cause: DateFindingCause.OffsetMismatch,
        proposedDate: instant(realWall, 'Europe/Paris'),
        proposedZone: 'Europe/Paris',
      };
      add(item);
    }
  }

  // ---- clean scenarios that must find nothing
  // a camera and a phone, both right, in Sydney
  for (let day = 0; day < 6; day++) {
    const date = wall('2020-02-03').plus({ days: day * 3 });
    for (let i = 0; i < 12; i++) {
      const at = date.plus({ hours: i < 6 ? 9 : 16, minutes: (i % 6) * 5 });
      add(phoneAt(at.plus({ seconds: 20 }), PLACES.sydney));
      add(photo(at, { zone: 'Australia/Sydney', camera: DSLR }));
    }
  }
  // a camera shooting in the morning, the phone only in the evening: one moment, so no drift is proposed
  for (let day = 0; day < 4; day++) {
    const date = wall('2020-06-10').plus({ days: day * 3 });
    for (let i = 0; i < 10; i++) {
      add(photo(date.plus({ hours: 9, minutes: i * 3 }), { zone: 'America/Edmonton', camera: DSLR }));
      add(phoneAt(date.plus({ hours: 19, minutes: i * 3 }), PLACES.calgary));
    }
  }
  // a burst of twelve in one minute that one phone photo happens to line up with: one shot, not twelve, so no drift
  for (let day = 0; day < 3; day++) {
    const date = wall('2020-08-11').plus({ days: day * 2 });
    const iphone: [string, string] = ['Apple', 'iPhone 13 Pro'];
    for (let i = 0; i < 12; i++) {
      add(photo(date.plus({ hours: 11, minutes: 26, seconds: i * 2 }), { zone: 'America/Edmonton', camera: iphone }));
    }
    for (const at of ['09:30', '17:56', '19:33', '21:22']) {
      add(
        photo(date.plus({ hours: Number(at.slice(0, 2)), minutes: Number(at.slice(3)) }), {
          zone: 'America/Edmonton',
          camera: iphone,
        }),
      );
    }
    for (const at of ['08:35', '12:49', '15:07', '16:03', '17:02']) {
      add(phoneAt(date.plus({ hours: Number(at.slice(0, 2)), minutes: Number(at.slice(3)) }), PLACES.calgary));
    }
  }
  // edited later in another zone: OffsetTime moved, OffsetTimeOriginal is right and the phone agrees
  for (let day = 0; day < 3; day++) {
    const date = wall('2020-09-07').plus({ days: day * 2 });
    add(...phoneDay(date, PLACES.paris, 12));
    for (let i = 0; i < 10; i++) {
      const item = photo(date.plus({ hours: 10, minutes: i * 5 + 1 }), { zone: 'UTC+2', camera: ['Fujifilm', 'X-T4'] });
      item.offsetTimeOriginal = '+02:00';
      item.offsetTime = '-04:00';
      add(item);
    }
  }
  // names that match their dates: phone files, screenshots, WhatsApp received the same day
  for (let i = 0; i < 40; i++) {
    const at = wall('2020-11-02T08:00').plus({ days: i, minutes: Math.floor(random() * 600) });
    add(
      photo(at, {
        zone: 'America/Edmonton',
        camera: ['', ''],
        fileName: `Screenshot ${at.toFormat('yyyy-MM-dd')} at ${at.toFormat('HH.mm.ss')}.png`,
      }),
    );
    add(
      photo(at.plus({ hours: 2 }), {
        zone: 'America/Edmonton',
        camera: ['', ''],
        fileName: `IMG-${at.toFormat('yyyyMMdd')}-WA${String(i).padStart(4, '0')}.jpg`,
      }),
    );
  }
  // dates somebody set by hand: a scan of an old print dated 1970-01-01, and a zone chosen by hand
  for (let i = 0; i < 10; i++) {
    const item = photo(wall('1970-01-01T00:00').plus({ minutes: i }), { zone: null, camera: ['Epson', 'V600'] });
    item.dateLocked = true;
    add(item);
    const zoned = photo(wall('2020-12-20T10:00').plus({ minutes: i * 9 }), {
      zone: 'America/Edmonton',
      place: PLACES.tokyo,
      camera: ['Sony', 'RX100 VII'],
    });
    zoned.zoneLocked = true;
    add(zoned);
  }

  // the timeline's own rule decides `toCheck`, as the scan's SQL does
  for (const item of photos) {
    item.toCheck = !!dateProblem({ ...item, dateSetByHand: item.dateLocked }, FIXTURE_NOW);
  }
  return photos;
};

const TWO_MINUTES = 2 * 60_000;
const offsetOf = (zone: string, at: Date) => DateTime.fromJSDate(at, { zone }).offset;

/** Whether a finding proposes what the fixture expects: the cause, the instant within two minutes, the zone's offset. */
export const proposesExpected = (photo: FixturePhoto, finding: DateFinding) => {
  const expected = photo.expect!;
  if (finding.cause !== expected.cause) {
    return false;
  }
  if (expected.proposedDate === null || finding.proposedDate === null) {
    return expected.proposedDate === finding.proposedDate;
  }
  if (Math.abs(new Date(finding.proposedDate).getTime() - expected.proposedDate.getTime()) > TWO_MINUTES) {
    return false;
  }
  if (expected.proposedZone === null || finding.proposedZone === null) {
    return expected.proposedZone === finding.proposedZone;
  }
  return (
    offsetOf(expected.proposedZone, expected.proposedDate) === offsetOf(finding.proposedZone, expected.proposedDate)
  );
};

/** The acceptance numbers: found (with the right proposal) among the 500, and false positives among the clean. */
export const scoreFindings = (photos: FixturePhoto[], findings: DateFinding[]) => {
  const byAsset = new Map<string, DateFinding[]>();
  for (const finding of findings) {
    byAsset.set(finding.assetId, [...(byAsset.get(finding.assetId) ?? []), finding]);
  }
  const wrong = photos.filter((photo) => photo.expect);
  const clean = photos.filter((photo) => !photo.expect);
  const found = wrong.filter((photo) =>
    (byAsset.get(photo.id) ?? []).some((finding) => proposesExpected(photo, finding)),
  );
  const falsePositives = clean.filter((photo) => byAsset.has(photo.id));
  return {
    wrong: wrong.length,
    clean: clean.length,
    found: found.length,
    falsePositives: falsePositives.length,
    missed: wrong.filter((photo) => !found.includes(photo)),
    falselyFlagged: falsePositives,
  };
};
