/**
 * Overview (FL-363) in plain words: the rules of the page, kept apart from the drawing so they can be
 * tested on their own.
 */
import type { AnalyticsBucketDto } from '@frameleaf/sdk';

/**
 * How soon a need wants the person: today, or when they have a moment. An optional feature that is
 * not set up (Studio exports without a graphics card) is listed, but is not something wrong.
 */
export type NeedLevel = 'now' | 'look' | 'optional';

/** The answer the page opens on, from what needs the person; optional features never raise it. */
export const overviewLevel = (levels: NeedLevel[]): 'urgent' | 'attention' | 'ok' =>
  levels.includes('now') ? 'urgent' : levels.includes('look') ? 'attention' : 'ok';

/** Most urgent first; within a level, in the order they were found. */
export const byUrgency = <T extends { level: NeedLevel }>(needs: T[]): T[] => [
  ...needs.filter((need) => need.level === 'now'),
  ...needs.filter((need) => need.level === 'look'),
  ...needs.filter((need) => need.level === 'optional'),
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

/**
 * Which of the status sentence's phrases are said (UI review 2026-10-30 #17). While something needs
 * the person, only the problems: "Frameleaf is up to date" is not a need, and the checks that are
 * fine stay in "What was checked" below. With nothing wrong, what is fine is the whole answer.
 */
export const statusPhrases = (phrases: readonly { wrong: boolean; text: string }[]): string[] => {
  const wrong = phrases.filter((phrase) => phrase.wrong);
  return (wrong.length > 0 ? wrong : phrases).map((phrase) => phrase.text);
};
