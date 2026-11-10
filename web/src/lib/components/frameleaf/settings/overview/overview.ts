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

/** FL-1338: how long ago Frameleaf's file fixes were made, in the words the Overview uses. */
export type FixedWhen = 'last_night' | 'today' | 'week';

/**
 * "last night" when the first and the newest fix of the week were both made during the last overnight run,
 * "today" when both were made on today's date where the reader is, else "this week" (the server counts seven days).
 */
export const fixedWhen = (
  since: string,
  latest: string,
  night: { startedAt: string; finishedAt: string } | undefined,
  now: Date,
): FixedWhen => {
  const times = [since, latest].map((iso) => new Date(iso));
  if (night) {
    const from = new Date(night.startedAt).getTime();
    const to = new Date(night.finishedAt).getTime();
    if (times.every((time) => time.getTime() >= from && time.getTime() <= to)) {
      return 'last_night';
    }
  }
  // The reader's own calendar day: the browser's time zone, as the rest of the Overview reads dates.
  const day = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  return times.every((time) => day(time) === day(now)) ? 'today' : 'week';
};

const DISMISSED_FIXES = 'fileproblems:';

/** What a dismissal of the Done-for-you row is kept under: the newest fix it covered (lower case, as the server requires). */
export const fileProblemsDismissalId = (latest: string) => `${DISMISSED_FIXES}${new Date(latest).getTime()}`;

/**
 * The Done-for-you dismissals a new one makes redundant: only the newest counts, so the older ones are taken back
 * rather than crowding the server's short list of dismissals (it keeps the last 32) and pushing out others.
 * None when `id` is not a Done-for-you dismissal.
 */
export const olderFileProblemsDismissals = (dismissed: Iterable<string>, id: string) =>
  id.startsWith(DISMISSED_FIXES)
    ? [...dismissed].filter((other) => other.startsWith(DISMISSED_FIXES) && other !== id)
    : [];

/** Whether the row is dismissed: no fix is newer than the newest one dismissed, however the week rolls. */
export const fileProblemsDismissed = (dismissed: Iterable<string>, latest: string) => {
  const at = new Date(latest).getTime();
  return [...dismissed].some((id) => {
    if (!id.startsWith(DISMISSED_FIXES)) {
      return false;
    }
    const covered = Number(id.slice(DISMISSED_FIXES.length));
    return Number.isFinite(covered) && at <= covered;
  });
};
