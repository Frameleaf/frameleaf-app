import { DateTime, Duration } from 'luxon';

export type ZoneOption = {
  /**
   * Timezone name with offset
   *
   * e.g. Asia/Jerusalem (+03:00)
   */
  label: string;

  /**
   * Timezone name
   *
   * e.g. Asia/Jerusalem
   */
  value: string;

  /**
   * Timezone offset in minutes
   *
   * e.g. 300
   */
  offsetMinutes: number;

  /**
   * True iff the date is valid
   *
   * Dates may be invalid for various reasons, for example setting a day that does not exist (30 Feb 2024).
   * Due to daylight saving time, 2:30am is invalid for Europe/Berlin on Mar 31 2024.The two following local times
   * are one second apart:
   *
   * - Mar 31 2024 01:59:59 (GMT+0100, unix timestamp 1725058799)
   * - Mar 31 2024 03:00:00 (GMT+0200, unix timestamp 1711846800)
   *
   * Mar 31 2024 02:30:00 does not exist in Europe/Berlin, this is an invalid date/time/time zone combination.
   */
  valid: boolean;
};

const userTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
const knownTimezones = Intl.supportedValuesOf('timeZone');

export function getTimezones(selectedDate: string) {
  // Browser inputs omit seconds and trim milliseconds; compare at their actual precision.
  const withoutMillis = selectedDate.replace(/\.\d+/, '');
  const compareFormat = /T\d{2}:\d{2}:\d{2}$/.test(withoutMillis) ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd'T'HH:mm";
  const currentYear = DateTime.now().year;
  const options: ZoneOption[] = [];

  for (const zone of knownTimezones) {
    const date = DateTime.fromISO(selectedDate, { zone });
    // Luxon advances missing DST times, so validity also requires an exact wall-clock match.
    if (!date.isValid || date.toFormat(compareFormat) !== withoutMillis) {
      continue;
    }
    // Keep historical-date admission, but display offsets under the current year's rules.
    const modernDate = date.set({ year: currentYear });
    options.push({
      value: zone,
      offsetMinutes: modernDate.offset,
      label: zone + ' (' + modernDate.toFormat('ZZ') + ')',
      valid: true,
    });
  }

  return options.sort(sortTwoZones);
}

export function getModernOffsetForZoneAndDate(
  zone: string,
  dateString: string,
): { offsetMinutes: number; offsetFormat: string } {
  const modernDate = DateTime.fromISO(dateString, { zone }).set({ year: DateTime.now().year });
  return { offsetMinutes: modernDate.offset, offsetFormat: modernDate.toFormat('ZZ') };
}

function sortTwoZones(zoneA: ZoneOption, zoneB: ZoneOption) {
  const offsetDifference = zoneA.offsetMinutes - zoneB.offsetMinutes;
  if (offsetDifference !== 0) {
    return offsetDifference;
  }
  return zoneA.value.localeCompare(zoneB.value, undefined, { sensitivity: 'base' });
}

/*
 * If the time zone is not given, find the timezone to select for a given time, date, and offset (e.g. +02:00).
 *
 * This is done so that the list shown to the user includes more helpful names like "Europe/Berlin (+02:00)"
 * instead of just the raw offset or something like "UTC+02:00".
 *
 * The provided information (initialDate, from some asset) includes the offset (e.g. +02:00), but no information about
 * the actual time zone. As several countries/regions may share the same offset, for example Berlin (Germany) and
 * Blantyre (Malawi) sharing +02:00 in summer, we have to guess and somehow pick a suitable time zone.
 *
 * If the time zone configured by the user (in the browser) provides the same offset for the given date (accounting
 * for daylight saving time and other weirdness), we prefer to show it. This way, for German users, we might be able
 * to show "Europe/Berlin" instead of the lexicographically first entry "Africa/Blantyre".
 */
export function getPreferredTimeZone(
  date: DateTime,
  initialTimeZone: string | undefined,
  timezones: ZoneOption[],
  selectedOption?: ZoneOption,
) {
  const offset = date.offset;
  const previousSelection = timezones.find((item) => item.value === selectedOption?.value);
  const fromInitialTimeZone = timezones.find((item) => item.value === initialTimeZone);
  const sameAsUserTimeZone = timezones.find((item) => item.offsetMinutes === offset && item.value === userTimeZone);
  const firstWithSameOffset = timezones.find((item) => item.offsetMinutes === offset);
  const utcFallback = {
    label: 'UTC (+00:00)',
    offsetMinutes: 0,
    value: 'UTC',
    valid: true,
  };
  return previousSelection ?? fromInitialTimeZone ?? sameAsUserTimeZone ?? firstWithSameOffset ?? utcFallback;
}

export function toDatetime(selectedDate: string, selectedZone: ZoneOption) {
  const dtComponents = DateTime.fromISO(selectedDate, { zone: 'utc' });

  // Determine the modern, DST-aware offset for the selected IANA zone
  const { offsetMinutes } = getModernOffsetForZoneAndDate(selectedZone.value, selectedDate);

  // Construct the final ISO string with a fixed-offset zone.
  const fixedOffsetZone = `UTC${offsetMinutes >= 0 ? '+' : ''}${Duration.fromObject({ minutes: offsetMinutes }).toFormat('hh:mm')}`;

  // Create a DateTime object in this fixed-offset zone, preserving the local time.
  return DateTime.fromObject(dtComponents.toObject(), { zone: fixedOffsetZone });
}

export function toIsoDate(selectedDate: string, selectedZone: ZoneOption) {
  return toDatetime(selectedDate, selectedZone).toISO({ includeOffset: true })!;
}

export const calcNewDate = (timestamp: DateTime, selectedDuration: number, timezone?: string) => {
  let newDateTime = timestamp.plus({ minutes: selectedDuration });
  if (timezone) {
    newDateTime = newDateTime.setZone(timezone);
  }
  return newDateTime.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS");
};
