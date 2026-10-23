/**
 * Overview (FL-363) in plain words: the rules of the page, kept apart from the drawing so they can be
 * tested on their own.
 */
import type { AnalyticsBucketDto } from '@frameleaf/sdk';

/** How soon a need wants the person: today, or when they have a moment. */
export type NeedLevel = 'now' | 'look';

/** The answer the page opens on, from what needs the person. */
export const overviewLevel = (levels: NeedLevel[]): 'urgent' | 'attention' | 'ok' =>
  levels.includes('now') ? 'urgent' : levels.length > 0 ? 'attention' : 'ok';

/** Most urgent first; within a level, in the order they were found. */
export const byUrgency = <T extends { level: NeedLevel }>(needs: T[]): T[] => [
  ...needs.filter((need) => need.level === 'now'),
  ...needs.filter((need) => need.level === 'look'),
];

const DAY_MS = 86_400_000;

/**
 * How fast the photos and videos grow, in bytes a day, from the growth series: the first and the last
 * period that were measured. Null while there is less than a month between them or nothing grew.
 */
export const growthPerDay = (series: Pick<AnalyticsBucketDto, 'through' | 'physicalBytes'>[]): number | null => {
  const measured = series.filter((row) => row.physicalBytes !== null);
  if (measured.length < 2) {
    return null;
  }
  const first = measured[0];
  const last = measured.at(-1)!;
  const days = (new Date(last.through).getTime() - new Date(first.through).getTime()) / DAY_MS;
  const grew = last.physicalBytes! - first.physicalBytes!;
  return days >= 28 && grew > 0 ? grew / days : null;
};

/** How long the free space lasts at that pace, as a unit and a count ("about 4 months"). */
export const roomLeft = (
  freeBytes: number,
  perDay: number | null,
): { unit: 'years' | 'months' | 'weeks' | 'days'; count: number } | null => {
  if (perDay === null || perDay <= 0) {
    return null;
  }
  const days = freeBytes / perDay;
  if (days >= 730) {
    return { unit: 'years', count: Math.floor(days / 365) };
  }
  if (days >= 60) {
    return { unit: 'months', count: Math.floor(days / 30) };
  }
  if (days >= 14) {
    return { unit: 'weeks', count: Math.floor(days / 7) };
  }
  return { unit: 'days', count: Math.max(1, Math.floor(days)) };
};

/** A sentence's first letter in capitals, for a sentence built from phrases. */
export const sentence = (words: string) => (words ? `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}.` : '');

/** FL-518: a phone that has sent nothing for this many days is behind. */
export const PHONE_BEHIND_DAYS = 7;

/** The phones that stopped sending photos, longest quiet first. A phone that never reported is not behind yet. */
export const phonesBehind = <T extends { quietForDays: number | null }>(phones: readonly T[]) =>
  phones
    .filter((phone) => phone.quietForDays !== null && phone.quietForDays >= PHONE_BEHIND_DAYS)
    .sort((a, b) => (b.quietForDays ?? 0) - (a.quietForDays ?? 0));
