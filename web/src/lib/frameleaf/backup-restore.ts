/** Backup › Restore (FL-362): the dates a library can go back to, from the backups each place holds. */
import { BACKUP_PLACE_IDS, type BackupPlaceId } from '$lib/frameleaf/backup-overview';

export type RestoreDate = {
  /** The calendar day, in the viewer's time zone (`yyyy-m-d`). */
  day: string;
  /** The newest backup made that day. */
  newest: Date;
  /** The places holding a backup from that day, in the pages' order. */
  places: BackupPlaceId[];
};

/**
 * One row per day that has a finished backup, newest first: several places usually back up within
 * minutes of each other, and "go back to Tuesday" is the choice a person makes. At most `limit` days.
 */
export const restoreDates = (points: readonly { place: BackupPlaceId; at: Date }[], limit: number): RestoreDate[] => {
  const days = new Map<string, RestoreDate>();
  for (const { place, at } of points) {
    if (Number.isNaN(at.getTime())) {
      continue;
    }
    const day = `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
    const row = days.get(day) ?? { day, newest: at, places: [] };
    if (at > row.newest) {
      row.newest = at;
    }
    if (!row.places.includes(place)) {
      row.places.push(place);
    }
    days.set(day, row);
  }
  return [...days.values()]
    .map((row) => ({ ...row, places: BACKUP_PLACE_IDS.filter((id) => row.places.includes(id)) }))
    .sort((a, b) => b.newest.getTime() - a.newest.getTime())
    .slice(0, limit);
};
