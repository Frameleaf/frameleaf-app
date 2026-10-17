/**
 * One reading of when a database backup was made, for every place that shows it: the Overview
 * tile, the Backups & restore list and its restore dialog. The server names each backup after its
 * own clock (`…-<yyyyMMdd'T'HHmmss>-…`) and reports the zone that clock was in, so the stamp is read
 * in that zone and shown in the viewer's local time, in one style everywhere.
 */
import { DateTime } from 'luxon';

export type BackupTime = {
  /** The moment the backup was made, in the viewer's zone. */
  at: DateTime;
  /** The clock time, e.g. "02:00". */
  time: string;
  /** The day, e.g. "19 Sep"; the year is added when it is not this year. */
  date: string;
  /** Day and time on one line, e.g. "19 Sep, 02:00". */
  label: string;
};

const STAMP = /\d{8}T\d{6}/;

/** The time stamp in a backup's file name, for sorting; undefined when the name carries none. */
export const backupStamp = (filename: string) => filename.match(STAMP)?.[0];

export const backupTime = (
  filename: string,
  { timezone, locale, now = DateTime.now() }: { timezone?: string; locale?: string; now?: DateTime } = {},
): BackupTime | undefined => {
  const stamp = backupStamp(filename);
  if (!stamp) {
    return;
  }
  const format = "yyyyMMdd'T'HHmmss";
  let parsed = timezone ? DateTime.fromFormat(stamp, format, { zone: timezone }) : DateTime.invalid('no zone');
  if (!parsed.isValid) {
    // No zone reported, or one this browser does not know: read the clock as the viewer's own.
    parsed = DateTime.fromFormat(stamp, format);
  }
  if (!parsed.isValid) {
    return;
  }
  const at = locale ? parsed.toLocal().setLocale(locale) : parsed.toLocal();
  const dateOptions: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: at.year === now.year ? undefined : 'numeric',
  };
  const timeOptions: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  return {
    at,
    time: at.toLocaleString(timeOptions),
    date: at.toLocaleString(dateOptions),
    label: at.toLocaleString({ ...dateOptions, ...timeOptions }),
  };
};
