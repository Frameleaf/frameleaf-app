import geotz from 'geo-tz';
import { DateTime } from 'luxon';
import { dateProblem } from 'src/utils/date-sanity.js';

/**
 * FL-912: the Date & Time Doctor's detector. It reads what the library already holds (no file is opened) and
 * proposes a date or zone with a reason. Applying a proposal is FL-930; the page is FL-943.
 *
 * Every time here is one of two kinds, as the asset table stores them: an instant (`takenAt`, the photo's
 * `fileCreatedAt`) and a local wall time held in UTC fields (`localDateTime`).
 *
 * `future-date` and `epoch-date` are not a rule of their own: they are the photos `hasDateToCheck` picks
 * (`date-sanity.ts`), passed in as `toCheck`, so a photo is in the timeline's "Dates to check" exactly when it has
 * one of these two findings.
 *
 * A date or zone somebody set by hand (`dateTimeOriginal` / `timeZone` in `lockedProperties`) is never proposed.
 */
export enum DateFindingCause {
  OffsetMismatch = 'offset-mismatch',
  GpsZoneMismatch = 'gps-zone-mismatch',
  MissingZone = 'missing-zone',
  BurstDrift = 'burst-drift',
  FilenameDate = 'filename-date',
  FutureDate = 'future-date',
  EpochDate = 'epoch-date',
}

export type DateScanRow = {
  id: string;
  originalFileName: string;
  takenAt: Date;
  localDateTime: Date;
  timeZone: string | null;
  latitude: number | null;
  longitude: number | null;
  make: string | null;
  model: string | null;
  offsetTimeOriginal: string | null;
  offsetTime: string | null;
  dateLocked: boolean;
  zoneLocked: boolean;
  /** `hasDateToCheck` answered in SQL: the timeline keeps this photo in "Dates to check". */
  toCheck: boolean;
};

export type DateFinding = {
  assetId: string;
  cause: DateFindingCause;
  currentDate: Date;
  currentZone: string | null;
  /** The instant the photo should have; null when the Doctor can only say the date is wrong. */
  proposedDate: Date | null;
  proposedZone: string | null;
  confidence: number;
  groupKey: string;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Photos this close in local time are one outing: their zones are evidence for each other. */
const NEIGHBOUR_WINDOW = 3 * HOUR;
/** A name's date and time this far from the stored one: the stored date is a file date, not the camera's. */
const FILENAME_SLACK = 36 * HOUR;
/** Clock drift: how far one camera's clock may be off, how close a match must be, and the smallest shift worth proposing. */
const DRIFT_MAX = 12 * HOUR;
const DRIFT_MATCH = 2 * MINUTE;
const DRIFT_MIN = 5 * MINUTE;
/** Photos further apart than this are separate moments of a shoot; a drift must line up at least two of them. */
const DRIFT_MOMENT_GAP = 30 * MINUTE;

// ---- file names ------------------------------------------------------------------------------------------------

const NAME_PATTERNS: RegExp[] = [
  // IMG_20230512_134501, PXL_20230512_134501123, VID_20230512_134501, 20230512_134501, Screenshot_20230512-134501
  /(?<!\d)(?<y>(?:19|20)\d{2})(?<m>\d{2})(?<d>\d{2})[_-](?<H>\d{2})(?<M>\d{2})(?<S>\d{2})/,
  // Screenshot 2023-05-12 at 13.45.01, Screen Shot 2023-05-12 at 1.45.01 PM, 2023-05-12 13.45.01
  /(?<!\d)(?<y>(?:19|20)\d{2})-(?<m>\d{2})-(?<d>\d{2})(?: at |[ _T])(?<H>\d{1,2})[.:](?<M>\d{2})[.:](?<S>\d{2})(?:\s?(?<ap>[AP]M))?/i,
  // WhatsApp: IMG-20230512-WA0001 (a day, no time)
  /(?:IMG|VID)-(?<y>(?:19|20)\d{2})(?<m>\d{2})(?<d>\d{2})-WA\d+/i,
];

/** A Pixel names its files by the moment in UTC, not by the clock time where it was. */
const UTC_NAMES = /^PXL_/i;

export type NamedDate = {
  /** The date and time in the name, in UTC fields. */
  wall: Date;
  /** False for names that carry only a day (WhatsApp). */
  hasTime: boolean;
  /** `wall` is the moment in UTC (Pixel), not a local clock time. */
  utc: boolean;
};

/**
 * The capture date a camera, phone or app wrote into the file name. Undefined when the name holds no believable date.
 */
export const dateFromFileName = (fileName: string, now: Date = new Date()): NamedDate | undefined => {
  for (const pattern of NAME_PATTERNS) {
    const groups = pattern.exec(fileName)?.groups;
    if (!groups) {
      continue;
    }
    let hour = Number(groups.H ?? 0);
    const ap = groups.ap?.toUpperCase();
    if (ap && (hour < 1 || hour > 12)) {
      return undefined;
    }
    if (ap) {
      hour = (hour % 12) + (ap === 'PM' ? 12 : 0);
    }
    const wall = DateTime.fromObject(
      {
        year: Number(groups.y),
        month: Number(groups.m),
        day: Number(groups.d),
        hour,
        minute: Number(groups.M ?? 0),
        second: Number(groups.S ?? 0),
      },
      { zone: 'UTC' },
    );
    // A name a day ahead of now is a counter or an ID, not a date.
    if (!wall.isValid || wall.year < 1990 || wall.toMillis() > now.getTime() + 24 * HOUR) {
      return undefined;
    }
    return { wall: wall.toJSDate(), hasTime: groups.H !== undefined, utc: UTC_NAMES.test(fileName) };
  }
  return undefined;
};

/** A wall time (UTC fields) read in `zone` (null: as UTC, which is how a photo without a zone is stored). */
export const wallToInstant = (wall: Date, zone: string | null): Date => {
  const local = DateTime.fromJSDate(wall, { zone: 'UTC' });
  const zoned = zone ? local.setZone(zone, { keepLocalTime: true }) : local;
  return (zoned.isValid ? zoned : local).toJSDate();
};

/**
 * A name's date as the asset table holds dates, for a photo in `zone` (null: none): the moment (`instant`) and the
 * local clock time in UTC fields (`local`). A day without a time is noon that day.
 */
export const namedDate = ({ wall, hasTime, utc }: NamedDate, zone: string | null): { instant: Date; local: Date } => {
  if (utc) {
    const zoned = zone ? DateTime.fromJSDate(wall, { zone }) : undefined;
    const local = zoned?.isValid ? zoned.setZone('UTC', { keepLocalTime: true }).toJSDate() : wall;
    return { instant: wall, local };
  }
  const local = hasTime ? wall : new Date(wall.getTime() + 12 * HOUR);
  return { instant: wallToInstant(local, zone), local };
};

// ---- zones -----------------------------------------------------------------------------------------------------

/** Minutes east of UTC that `zone` was at `instant`; undefined for a zone luxon cannot read. */
const offsetAt = (zone: string, instant: Date): number | undefined => {
  const dt = DateTime.fromJSDate(instant, { zone });
  return dt.isValid ? dt.offset : undefined;
};

/** An EXIF offset ("+02:00", "-05:30") as a zone luxon reads ("UTC+2", "UTC-5:30"). */
export const offsetZone = (offset: string): string | undefined => {
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim());
  if (!match) {
    return undefined;
  }
  const [, sign, hours, minutes] = match;
  return `UTC${sign}${Number(hours)}${minutes === '00' ? '' : `:${minutes}`}`;
};

const gpsZones = new Map<string, string[]>();
/**
 * The zones at a place, from the bundled time zone map, remembered per ~1 km. Some places have more than one
 * (`Asia/Shanghai` and `Asia/Urumqi` in Ürümqi): any of them is right there.
 */
const zonesAt = (latitude: number, longitude: number): string[] => {
  const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
  if (!gpsZones.has(key)) {
    // ponytail: unbounded memo; a library spans few distinct ~1 km cells. Bound it if one ever does not.
    // eslint-disable-next-line import-x/no-named-as-default-member
    gpsZones.set(key, geotz.find(latitude, longitude));
  }
  return gpsZones.get(key)!;
};

/** A real position: within range (the map throws on anything else), and not the 0,0 of a missing fix. */
const hasGps = (row: DateScanRow) =>
  Number.isFinite(row.latitude) &&
  Number.isFinite(row.longitude) &&
  Math.abs(row.latitude!) <= 90 &&
  Math.abs(row.longitude!) <= 180 &&
  (row.latitude !== 0 || row.longitude !== 0);

/** The camera's two EXIF offsets disagree (`OffsetTimeOriginal` vs `OffsetTime`). */
const offsetsDisagree = (row: DateScanRow) =>
  !!row.offsetTimeOriginal && !!row.offsetTime && offsetZone(row.offsetTimeOriginal) !== offsetZone(row.offsetTime);

/**
 * The zone a photo can vouch for to its neighbours: where its GPS puts it, else its stored zone unless its own
 * offsets disagree. A photo that is itself in doubt is no evidence.
 */
const trustedZone = (row: DateScanRow): string | undefined => {
  if (hasGps(row)) {
    // a place with two zones vouches only for one it is sure of
    const zones = zonesAt(row.latitude!, row.longitude!);
    return zones.length === 1 ? zones[0] : undefined;
  }
  return row.timeZone && !offsetsDisagree(row) ? row.timeZone : undefined;
};

const cameraKey = (row: DateScanRow) => [row.make, row.model].filter(Boolean).join(' ').trim();

/** Findings are grouped by camera and local day, so a whole shoot is reviewed (and later fixed) at once. */
export const groupKeyOf = (row: DateScanRow) =>
  `${cameraKey(row) || 'unknown'}|${row.localDateTime.toISOString().slice(0, 10)}`;

// ---- the scan --------------------------------------------------------------------------------------------------

type Majority = { zone: string; offset: number; share: number; count: number };

/** The zone most of the trusted photos within `NEIGHBOUR_WINDOW` of `index` were in, by offset at the time. */
const neighbourZone = (rows: DateScanRow[], trusted: (string | undefined)[], index: number): Majority | undefined => {
  const at = rows[index].localDateTime.getTime();
  const byOffset = new Map<number, Map<string, number>>();
  let total = 0;
  for (const step of [-1, 1]) {
    for (let i = index + step; i >= 0 && i < rows.length; i += step) {
      if (Math.abs(rows[i].localDateTime.getTime() - at) > NEIGHBOUR_WINDOW) {
        break;
      }
      const zone = trusted[i];
      const offset = zone === undefined ? undefined : offsetAt(zone, rows[i].takenAt);
      if (zone === undefined || offset === undefined) {
        continue;
      }
      const zones = byOffset.get(offset) ?? new Map<string, number>();
      zones.set(zone, (zones.get(zone) ?? 0) + 1);
      byOffset.set(offset, zones);
      total++;
    }
  }
  let best: Majority | undefined;
  for (const [offset, zones] of byOffset) {
    let count = 0;
    let zone = '';
    let most = 0;
    for (const [name, n] of zones) {
      count += n;
      if (n > most) {
        zone = name;
        most = n;
      }
    }
    if (!best || count > best.count) {
      best = { zone, offset, count, share: 0 };
    }
  }
  if (!best) {
    return undefined;
  }
  best.share = best.count / total;
  // Two photos that agree, and few that do not, before a zone is proposed for a third.
  return best.count >= 2 && best.share >= 0.75 ? best : undefined;
};

/**
 * Camera clock drift: a camera without GPS whose photos of a day line up with the GPS-anchored photos of another
 * camera (a phone) only once shifted by one constant amount. The shift must line up most of its shots, with at least
 * three different anchors, in at least two separate moments of the day, and do so much better than no shift at all.
 * A shot is a minute: a burst of twelve photos is one piece of evidence, not twelve.
 *
 * ponytail: votes over every shot × anchor pair within `DRIFT_MAX`; a day of thousands of both is slow.
 * Bucket the anchors by minute if that ever shows up in a scan's time.
 */
const findDrift = (
  group: DateScanRow[],
  anchorRows: DateScanRow[],
): { shift: number; confidence: number } | undefined => {
  const minutes = (rows: DateScanRow[]) =>
    [...new Set(rows.map((row) => Math.round(row.localDateTime.getTime() / MINUTE) * MINUTE))].toSorted(
      (a, b) => a - b,
    );
  const shots = minutes(group);
  const anchors = minutes(anchorRows);
  if (shots.length < 5 || anchors.length < 3) {
    return undefined;
  }
  /** The shots a shift puts on an anchor, and the anchors they land on. */
  const matchesAt = (shift: number) => {
    const used = new Set<number>();
    const matched = shots.filter((shot) => {
      const anchor = anchors.find((at) => Math.abs(at - (shot + shift)) <= DRIFT_MATCH);
      if (anchor !== undefined) {
        used.add(anchor);
      }
      return anchor !== undefined;
    });
    return { matched, anchors: used.size };
  };
  // Every shot votes once for each minute that would put it on an anchor.
  const votes = new Map<number, Set<number>>();
  for (const shot of shots) {
    for (const anchor of anchors) {
      const delta = anchor - shot;
      if (Math.abs(delta) <= DRIFT_MAX) {
        const voters = votes.get(delta) ?? new Set<number>();
        voters.add(shot);
        votes.set(delta, voters);
      }
    }
  }
  let shift = 0;
  let best = 0;
  for (const [delta, voters] of votes) {
    if (voters.size > best || (voters.size === best && Math.abs(delta) < Math.abs(shift))) {
      shift = delta;
      best = voters.size;
    }
  }
  if (Math.abs(shift) < DRIFT_MIN) {
    return undefined;
  }
  // The exact shift: the median, over the shots near the best minute, of the photos' own offset to their anchor.
  const exact: number[] = [];
  for (const photo of group) {
    for (const anchor of anchorRows) {
      const delta = anchor.localDateTime.getTime() - photo.localDateTime.getTime();
      if (Math.abs(delta - shift) <= MINUTE) {
        exact.push(delta);
      }
    }
  }
  exact.sort((a, b) => a - b);
  shift = exact.length > 0 ? exact[Math.floor(exact.length / 2)] : shift;
  const { matched, anchors: used } = matchesAt(shift);
  const unshifted = matchesAt(0).matched.length;
  if (matched.length < Math.max(3, shots.length * 0.6) || matched.length < 2 * unshifted || used < 3) {
    return undefined;
  }
  const moments = 1 + matched.slice(1).filter((shot, i) => shot - matched[i] > DRIFT_MOMENT_GAP).length;
  if (moments < 2) {
    return undefined;
  }
  return { shift, confidence: matched.length / shots.length };
};

const finding = (
  row: DateScanRow,
  cause: DateFindingCause,
  proposedDate: Date | null,
  proposedZone: string | null,
  confidence: number,
): DateFinding => ({
  assetId: row.id,
  cause,
  currentDate: row.takenAt,
  currentZone: row.timeZone,
  proposedDate,
  proposedZone,
  confidence: Math.round(confidence * 100) / 100,
  groupKey: groupKeyOf(row),
});

/** What the Doctor finds in one owner's photos. `rows` may come in any order. */
export const detectDateFindings = (input: DateScanRow[], now: Date = new Date()): DateFinding[] => {
  const rows = input.toSorted((a, b) => a.localDateTime.getTime() - b.localDateTime.getTime());
  const trusted = rows.map((row) => trustedZone(row));
  const findings: DateFinding[] = [];

  for (const [index, row] of rows.entries()) {
    const named = dateFromFileName(row.originalFileName, now);
    const fromNameDate = named ? namedDate(named, row.timeZone) : null;

    // (f) the timeline's own rule; the only proposal is the name's date
    if (row.toCheck) {
      const problem = dateProblem({ takenAt: row.takenAt, localDateTime: row.localDateTime }, now);
      const future = problem ? problem === 'future' : row.takenAt.getTime() > now.getTime();
      const fromName =
        fromNameDate && !dateProblem({ takenAt: fromNameDate.instant, localDateTime: fromNameDate.local }, now);
      findings.push(
        finding(
          row,
          future ? DateFindingCause.FutureDate : DateFindingCause.EpochDate,
          fromName ? fromNameDate.instant : null,
          fromName ? row.timeZone : null,
          fromName ? 0.8 : 0.5,
        ),
      );
    }

    if (row.dateLocked || row.zoneLocked) {
      continue;
    }

    // (e) the name holds a date far from the stored one: the stored one is a file date
    if (named && fromNameDate && !row.toCheck) {
      const away = Math.abs(row.localDateTime.getTime() - fromNameDate.local.getTime());
      // a day without a time is noon: the stored date may be anywhere in that day
      if (away > FILENAME_SLACK + (named.hasTime ? 0 : 12 * HOUR)) {
        findings.push(
          finding(row, DateFindingCause.FilenameDate, fromNameDate.instant, row.timeZone, named.hasTime ? 0.9 : 0.6),
        );
      }
    }

    // (b) GPS puts the photo in a zone whose offset differs from the stored one: same instant, the place's zone
    if (hasGps(row) && row.timeZone) {
      const places = zonesAt(row.latitude!, row.longitude!);
      const stored = offsetAt(row.timeZone, row.takenAt);
      // wrong only when no zone of the place has the stored offset
      if (places.length > 0 && stored !== undefined && places.every((zone) => offsetAt(zone, row.takenAt) !== stored)) {
        findings.push(finding(row, DateFindingCause.GpsZoneMismatch, row.takenAt, places[0], 0.85));
      }
      continue;
    }
    if (hasGps(row)) {
      continue;
    }

    // (a) the offsets disagree, and the photos around it side with `OffsetTime`: same wall time, their zone
    if (offsetsDisagree(row)) {
      const around = neighbourZone(rows, trusted, index);
      const original = offsetZone(row.offsetTimeOriginal!);
      const modified = offsetZone(row.offsetTime!);
      const sides = (zone: string | undefined) => !!zone && offsetAt(zone, row.takenAt) === around?.offset;
      if (around && sides(modified) && !sides(original)) {
        findings.push(
          finding(
            row,
            DateFindingCause.OffsetMismatch,
            wallToInstant(row.localDateTime, around.zone),
            around.zone,
            around.share * 0.9,
          ),
        );
      }
      continue;
    }

    // (c) no zone and no GPS: the zone of the photos around it
    if (!row.timeZone) {
      const around = neighbourZone(rows, trusted, index);
      if (around) {
        findings.push(
          finding(
            row,
            DateFindingCause.MissingZone,
            wallToInstant(row.localDateTime, around.zone),
            around.zone,
            around.share * 0.8,
          ),
        );
      }
    }
  }

  // (d) clock drift, per camera without GPS and local day, against the other cameras' GPS-anchored photos
  const anchors = rows.filter((row) => hasGps(row) && row.timeZone && !row.toCheck);
  const groups = new Map<string, DateScanRow[]>();
  for (const row of rows) {
    if (!hasGps(row) && cameraKey(row) && !row.toCheck && !row.dateLocked && !row.zoneLocked) {
      const key = groupKeyOf(row);
      const group = groups.get(key);
      if (group) {
        group.push(row);
      } else {
        groups.set(key, [row]);
      }
    }
  }
  for (const group of groups.values()) {
    const camera = cameraKey(group[0]);
    const from = group[0].localDateTime.getTime() - DRIFT_MAX;
    const to = group.at(-1)!.localDateTime.getTime() + DRIFT_MAX;
    const near = anchors.filter((anchor) => {
      const at = anchor.localDateTime.getTime();
      return cameraKey(anchor) !== camera && at >= from && at <= to;
    });
    const drift = findDrift(group, near);
    if (drift) {
      for (const row of group) {
        findings.push(
          finding(
            row,
            DateFindingCause.BurstDrift,
            new Date(row.takenAt.getTime() + drift.shift),
            row.timeZone,
            drift.confidence,
          ),
        );
      }
    }
  }
  return findings;
};
