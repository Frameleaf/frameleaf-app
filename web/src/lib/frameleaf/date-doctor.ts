/**
 * FL-943: the Date & Time Doctor page's words and groups. The findings (FL-912) come a shoot (camera and day) at a
 * time; the page shows one card per thing that went wrong, so a camera that was 7 hours behind for a whole trip is
 * one card, not one per day. Applying and undoing are FL-930's endpoints.
 */
import {
  DateFindingCause,
  type DateDoctorBatchDto,
  type DateDoctorFindingDto,
  type DateDoctorGroupDto,
  type DateDoctorTimeDto,
} from '@frameleaf/sdk';
import { DateTime, Duration } from 'luxon';

/** A fix can be undone for this many days (FL-930). */
export const UNDO_DAYS = 30;
/** How many photos a card shows before and after. */
export const STRIP_SIZE = 6;

/** The causes where the photos' clock time is right and their zone is not: the card offers a zone. */
const ZONE_CAUSES = new Set<DateFindingCause>([
  DateFindingCause.OffsetMismatch,
  DateFindingCause.GpsZoneMismatch,
  DateFindingCause.MissingZone,
]);

export type DateFixCard = {
  key: string;
  cause: DateFindingCause;
  camera: string | null;
  /** The local days its photos are from, oldest first (YYYY-MM-DD). */
  days: string[];
  findings: DateDoctorFindingDto[];
  /** For a camera clock: how far every photo moves, in minutes (later is positive). */
  shiftMinutes: number | null;
  /** The zone the Doctor proposes, when every photo of the card has the same one. */
  zone: string | null;
  /** The card offers a choice of zone. */
  zoneChoice: boolean;
  /** Keep the clock time when the zone changes (else keep the moment, as a phone's GPS-placed photo does). */
  keepWallTime: boolean;
  /** Every photo has something to change to; else the Doctor can only say the date is wrong. */
  fixable: boolean;
};

const shiftOf = (finding: DateDoctorFindingDto) =>
  finding.proposedDate
    ? Math.round((Date.parse(finding.proposedDate) - Date.parse(finding.currentDate)) / 60_000)
    : null;

/** The findings as cards: one per cause and camera, and per clock shift or proposed zone. Biggest first. */
export const dateFixCards = (groups: DateDoctorGroupDto[]): DateFixCard[] => {
  const cards = new Map<string, DateFixCard>();
  for (const group of groups) {
    for (const finding of group.findings) {
      const shift = finding.cause === DateFindingCause.BurstDrift ? shiftOf(finding) : null;
      const zoneChoice = ZONE_CAUSES.has(finding.cause);
      // a photo the Doctor can't propose anything for never takes Fix away from one it can
      const fixable = !!finding.proposedDate || !!finding.proposedZone;
      const key = [
        fixable ? 'fix' : 'none',
        finding.cause,
        group.camera ?? '',
        shift ?? '',
        zoneChoice ? (finding.proposedZone ?? '') : '',
      ].join('|');
      let card = cards.get(key);
      if (!card) {
        card = {
          key,
          cause: finding.cause,
          camera: group.camera,
          days: [],
          findings: [],
          shiftMinutes: shift,
          zone: finding.proposedZone,
          zoneChoice,
          keepWallTime: finding.cause !== DateFindingCause.GpsZoneMismatch,
          fixable,
        };
        cards.set(key, card);
      }
      card.findings.push(finding);
      if (!card.days.includes(group.day)) {
        card.days.push(group.day);
      }
      if (card.zone !== finding.proposedZone) {
        card.zone = null;
      }
    }
  }
  const sorted = [...cards.values()].map((card) => ({
    ...card,
    days: [...card.days].sort((a, b) => a.localeCompare(b)),
  }));
  return sorted.sort((a, b) => b.findings.length - a.findings.length || a.key.localeCompare(b.key));
};

/** How many photos the findings are about: a photo can be wrong in two ways at once. */
export const photoCount = (findings: { assetId: string }[]) => new Set(findings.map(({ assetId }) => assetId)).size;

/** "3 hours", "1 hour, 30 minutes", in the page's language. */
export const shiftWords = (minutes: number, locale: string) => {
  const whole = Math.abs(minutes);
  const parts = { days: Math.floor(whole / 1440), hours: Math.floor((whole % 1440) / 60), minutes: whole % 60 };
  const shown = Object.fromEntries(Object.entries(parts).filter(([, value]) => value > 0));
  return Duration.fromObject(shown, { locale }).toHuman({ unitDisplay: 'long' });
};

/** "12 May 2024", or "12 – 15 May 2024" for a card over several days. */
export const dayWords = (days: string[], locale: string) => {
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const first = new Date(`${days[0]}T00:00:00Z`);
  const last = new Date(`${days.at(-1) ?? days[0]}T00:00:00Z`);
  return days.length > 1 ? format.formatRange(first, last) : format.format(first);
};

/** The i18n key and values of a card's sentence ("Camera clock was 3 hours behind on 12 May 2024"). */
export const cardTitle = (card: DateFixCard, locale: string) => {
  const day = dayWords(card.days, locale);
  const camera = card.camera ?? '';
  const count = card.findings.length;
  switch (card.cause) {
    case DateFindingCause.BurstDrift: {
      const shift = card.shiftMinutes ?? 0;
      return {
        key: shift > 0 ? 'frameleaf_date_doctor_cause_behind' : 'frameleaf_date_doctor_cause_ahead',
        values: { amount: shiftWords(shift, locale), day, camera, named: camera ? 'yes' : 'no' },
      } as const;
    }
    case DateFindingCause.GpsZoneMismatch: {
      return { key: 'frameleaf_date_doctor_cause_place_zone', values: { day } } as const;
    }
    case DateFindingCause.OffsetMismatch: {
      return { key: 'frameleaf_date_doctor_cause_wrong_zone', values: { day } } as const;
    }
    case DateFindingCause.MissingZone: {
      return { key: 'frameleaf_date_doctor_cause_no_zone', values: { count, day } } as const;
    }
    case DateFindingCause.FilenameDate: {
      return { key: 'frameleaf_date_doctor_cause_file_name', values: { count } } as const;
    }
    case DateFindingCause.FutureDate: {
      return { key: 'frameleaf_date_doctor_cause_future', values: { count } } as const;
    }
    case DateFindingCause.EpochDate: {
      return { key: 'frameleaf_date_doctor_cause_reset', values: { count } } as const;
    }
  }
};

/** The second line of a card: why Frameleaf thinks so, and what the fix does. */
export const cardBodyKey = (card: DateFixCard) => {
  if (!card.fixable) {
    return 'frameleaf_date_doctor_body_unknown' as const;
  }
  return (
    {
      [DateFindingCause.BurstDrift]: 'frameleaf_date_doctor_body_behind',
      [DateFindingCause.GpsZoneMismatch]: 'frameleaf_date_doctor_body_place_zone',
      [DateFindingCause.OffsetMismatch]: 'frameleaf_date_doctor_body_wrong_zone',
      [DateFindingCause.MissingZone]: 'frameleaf_date_doctor_body_no_zone',
      [DateFindingCause.FilenameDate]: 'frameleaf_date_doctor_body_file_name',
      [DateFindingCause.FutureDate]: 'frameleaf_date_doctor_body_from_name',
      [DateFindingCause.EpochDate]: 'frameleaf_date_doctor_body_from_name',
    } as const
  )[card.cause];
};

/**
 * A time as the strip shows it: the clock time where it was, and that zone's short name on that day ("Aug 12,
 * 9:40 PM MDT"), so a fix across a daylight-saving change reads the right abbreviation on each side. The clock time
 * is the server's (`local`); the zone's name is read for the moment itself.
 */
export const stripTime = (time: DateDoctorTimeDto, locale: string) => {
  const wall = DateTime.fromISO(time.local, { zone: 'utc', locale });
  const shown = wall.toLocaleString({
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  if (!time.zone) {
    return shown;
  }
  const moment = DateTime.fromISO(time.date, { zone: time.zone, locale });
  return moment.isValid ? `${shown} ${moment.offsetNameShort ?? ''}`.trim() : shown;
};

/** A recent fix can still be undone. */
export const canUndo = (batch: DateDoctorBatchDto, now = Date.now()) =>
  !batch.undoneAt && Date.parse(batch.expiresAt) > now;
