import { DateTime } from 'luxon';

/**
 * When a database backup was made, in the viewer's own time zone. The file name carries the
 * server's wall clock (`20261007T020000`) and the listing says which zone that clock was in, so
 * Overview and Backups & restore read the same moment the same way. Undefined when the name has no
 * stamp; callers then say the date is unknown and never show the file name as the headline.
 */
export const backupMoment = (filename: string, timezone?: string): DateTime | undefined => {
  const stamp = filename.match(/\d{8}T\d{6}/);
  if (!stamp) {
    return;
  }
  const at = DateTime.fromFormat(stamp[0], "yyyyMMdd'T'HHmmss", { zone: timezone }).toLocal();
  return at.isValid ? at : undefined;
};
