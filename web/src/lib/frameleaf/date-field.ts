/**
 * FL-1814: between the one date field (`DateField.svelte`) and what the server stores. A photo keeps its year
 * as `dateAccuracy` (`year` or `decade`) and says more in `dateDetail` (`month`, `about`); a person's date keeps
 * how sure it is in `birthDatePrecision` / `deathDatePrecision` (`month`, `year`, `about`). Either way the date is
 * the start of its period.
 */
import { dateFieldStart, type DateFieldValue, type DateSure } from '$lib/components/frameleaf/DateField.svelte';

const parts = (iso: string | null | undefined, fallback: Date) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso ?? '');
  return match
    ? {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        time: match[4] ? `${match[4]}:${match[5]}` : undefined,
      }
    : { year: fallback.getFullYear(), month: fallback.getMonth() + 1, day: fallback.getDate(), time: undefined };
};

/** A photo's date as the field shows it. `localDateTime` is the photo's own clock. */
export const photoDateField = (
  localDateTime: string | null | undefined,
  dateAccuracy: string | null | undefined,
  dateDetail: string | null | undefined,
  fallback = new Date(),
): DateFieldValue => {
  const sure: DateSure =
    dateAccuracy === 'decade'
      ? 'decade'
      : dateAccuracy === 'year'
        ? dateDetail === 'month'
          ? 'month'
          : dateDetail === 'about'
            ? 'about'
            : 'year'
        : 'day';
  return { sure, ...parts(localDateTime, fallback) };
};

/** What an approximate photo date is saved as. An exact day goes through the dialog's own time and zone. */
export const photoDateUpdate = (value: DateFieldValue) => ({
  dateTimeOriginal: `${dateFieldStart(value)}T00:00:00.000Z`,
  dateAccuracy: (value.sure === 'decade' ? 'decade' : 'year') as 'year' | 'decade',
  dateDetail: value.sure === 'month' || value.sure === 'about' ? value.sure : null,
});

/** A person's date of birth or passing as the field shows it. */
export const lifeDateField = (
  date: string | null | undefined,
  precision: string | null | undefined,
): DateFieldValue => ({
  sure: precision === 'month' || precision === 'year' || precision === 'about' ? precision : 'day',
  ...parts(date, new Date()),
});

/** What a person's date is saved as: the ISO day and how sure it is (null for the exact day). */
export const lifeDateUpdate = (value: DateFieldValue) => ({
  date: dateFieldStart(value),
  precision: value.sure === 'day' || value.sure === 'decade' ? null : value.sure,
});
