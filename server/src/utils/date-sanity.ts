/**
 * Dates that cannot be right (FL-1411; the prototype's `src/date-sanity.mjs`): one that has not happened yet,
 * or one of the days a camera falls back to when its clock was never set. Such a date must not stretch a range
 * or decide what an album is. Pure and import-free, so FL-1410 can use the same rule anywhere.
 */
export type DateProblem = 'future' | 'reset';

const DAY_MS = 24 * 60 * 60_000;
const RESET_DAYS = new Set(['1970-01-01', '1980-01-01', '2000-01-01']);

/**
 * `takenAt` is the instant; `localDateTime` is the local wall time held in UTC fields, as the asset table
 * stores it. A day of slack on "future": a clock a little fast, or a wall time read in the wrong zone, is
 * not a wrong date.
 */
export const dateProblem = (
  { takenAt, localDateTime }: { takenAt: Date; localDateTime: Date },
  now: Date = new Date(),
): DateProblem | undefined => {
  if (takenAt.getTime() > now.getTime() + DAY_MS) {
    return 'future';
  }
  return RESET_DAYS.has(localDateTime.toISOString().slice(0, 10)) ? 'reset' : undefined;
};

export const withGoodDates = <T extends { takenAt: Date; localDateTime: Date }>(photos: T[], now: Date = new Date()) =>
  photos.filter((photo) => !dateProblem(photo, now));
