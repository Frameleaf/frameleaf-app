import { sql } from 'kysely';

/**
 * Dates that cannot be right (FL-1411, FL-1410; the prototype's `src/date-sanity.mjs`): one that has not
 * happened yet, or one of the days a camera falls back to when its clock was never set. Such a date must not
 * lead a timeline, stretch a range or decide what an album is.
 *
 * A date somebody set by hand is never one of them: a scanned photo deliberately dated 1 January 1970 is
 * right because a person said so. The server records that as `dateTimeOriginal` in the photo's
 * `asset_exif.lockedProperties`, which every date edit adds and reading the file again never removes.
 *
 * The rule is written twice, for rows in memory (`dateProblem`) and for rows in the database
 * (`hasDateToCheck`), from the same two constants; `test/medium/specs/utils/date-sanity.spec.ts` holds the
 * two to the same answers.
 */
export type DateProblem = 'future' | 'reset';

/**
 * What a timeline request does with the photos whose date cannot be right. A request that does not say
 * gets every photo, as before.
 */
export enum TimelineDatesToCheck {
  Exclude = 'exclude',
  Only = 'only',
}

/** A clock a little fast, or a wall time read in the wrong zone, is not a wrong date. */
export const FUTURE_SLACK_HOURS = 24;
/** The local days a camera's clock starts from when it was never set. */
export const RESET_DAYS = ['1970-01-01', '1980-01-01', '2000-01-01'];

const resetDays = new Set(RESET_DAYS);

/**
 * `takenAt` is the instant; `localDateTime` is the local wall time held in UTC fields, as the asset table
 * stores it. `dateSetByHand`: the date was chosen by a person (see above), where the caller knows.
 */
export const dateProblem = (
  { takenAt, localDateTime, dateSetByHand }: { takenAt: Date; localDateTime: Date; dateSetByHand?: boolean },
  now: Date = new Date(),
): DateProblem | undefined => {
  if (dateSetByHand) {
    return undefined;
  }
  if (takenAt.getTime() > now.getTime() + FUTURE_SLACK_HOURS * 60 * 60_000) {
    return 'future';
  }
  return resetDays.has(localDateTime.toISOString().slice(0, 10)) ? 'reset' : undefined;
};

export const withGoodDates = <T extends { takenAt: Date; localDateTime: Date; dateSetByHand?: boolean }>(
  photos: T[],
  now: Date = new Date(),
) => photos.filter((photo) => !dateProblem(photo, now));

/**
 * The date half of the rule in SQL, for the asset table under `alias`. Both arms can be answered from an
 * index (`fileCreatedAt`, and `asset_localDateTime_idx` on the local day), so asking for only these photos
 * never reads the whole table.
 */
const dateLooksWrong = (alias: string) => sql<boolean>`(
  ${sql.ref(`${alias}.fileCreatedAt`)} > now() + interval ${sql.lit(`${FUTURE_SLACK_HOURS} hours`)}
  or (${sql.ref(`${alias}.localDateTime`)} at time zone 'UTC')::date = any(${sql.lit(`{${RESET_DAYS.join(',')}}`)}::date[])
)`;

/**
 * A scalar subquery on the EXIF row's key, not a join or `exists`: it is only run for the rare row whose
 * date looks wrong, and the planner cannot turn it into a hash of every edited photo.
 */
const dateSetByHand = (alias: string) => sql<boolean>`coalesce((
  select 'dateTimeOriginal' = any(date_check_exif."lockedProperties")
  from asset_exif date_check_exif
  where date_check_exif."assetId" = ${sql.ref(`${alias}.id`)}
), false)`;

/** The rule in SQL: this photo's date cannot be right. For `where` clauses that want only those photos. */
export const hasDateToCheck = (alias = 'asset') =>
  sql<boolean>`(${dateLooksWrong(alias)} and not ${dateSetByHand(alias)})`;

/**
 * Its opposite, written so the cheap date test comes first: on a timeline's hot path every photo pays for
 * two comparisons, and only one whose date looks wrong pays for the EXIF lookup.
 */
export const hasGoodDate = (alias = 'asset') => sql<boolean>`(not ${dateLooksWrong(alias)} or ${dateSetByHand(alias)})`;
