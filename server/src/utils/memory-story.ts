import { DateTime } from 'luxon';

/**
 * Event-story grouping (FL-62).
 *
 * Everything here is pure so the timezone, diversity and duplicate-suppression rules can be
 * tested without a database. The one rule that matters most: an asset's `localDateTime` is
 * the wall-clock time where the photograph was taken, stored as a UTC instant. Grouping,
 * day counting and the story's date range are therefore all computed in the fixed `utc`
 * zone — never in the server's zone and never in the viewer's. A trip that crosses a
 * timezone or the international date line still reads as the days the owner lived through.
 */

/** a gap longer than this between consecutive captures ends an event */
export const EVENT_GAP_HOURS = 20;

/** a shorter gap still ends an event when the place changed, so a same-day flight splits */
export const PLACE_CHANGE_GAP_HOURS = 6;

/** an event has to span at least this many distinct local days to be a story */
export const MIN_EVENT_DAYS = 2;

/** and hold at least this many assets, so a stray pair of photographs is not a trip */
export const MIN_EVENT_ASSETS = 8;

/** the most assets a story keeps; the rest are dropped by the diversity pass */
export const MAX_EVENT_ASSETS = 60;

/** two captures closer together than this are treated as the same moment (burst) */
export const BURST_SECONDS = 20;

export type StoryCandidate = {
  id: string;
  /** the asset's local wall clock, stored as a UTC instant */
  localDateTime: Date;
  city: string | null;
  state: string | null;
  country: string | null;
};

export type StoryPlace = {
  city: string | null;
  state: string | null;
  country: string | null;
};

export type EventStoryGroup = {
  /** inclusive local-date bounds, `yyyy-MM-dd`, in the owner's local capture time */
  startDate: string;
  endDate: string;
  /** the first and last capture instants, so the memory can be sorted and shown */
  startAt: Date;
  endAt: Date;
  /** number of distinct local days the event covers */
  dayCount: number;
  place: StoryPlace | null;
  /** the assets the story keeps, in capture order */
  assetIds: string[];
  /** how many candidates the event held before the diversity pass */
  totalAssets: number;
};

const localDay = (value: Date) => DateTime.fromJSDate(value, { zone: 'utc' }).toFormat('yyyy-MM-dd');

const placeKey = (candidate: StoryCandidate) =>
  [candidate.city, candidate.state, candidate.country].filter(Boolean).join('|');

const hoursBetween = (from: Date, to: Date) => Math.abs(to.getTime() - from.getTime()) / 3_600_000;

/**
 * Removes near-simultaneous captures (bursts and live-photo siblings) so one moment does
 * not dominate a story. The first asset of a burst is the one kept, which keeps the result
 * stable across regenerations.
 */
export const suppressBursts = <T extends { localDateTime: Date }>(candidates: T[]): T[] => {
  const kept: T[] = [];
  let previous: T | undefined;

  for (const candidate of candidates) {
    if (
      previous &&
      Math.abs(candidate.localDateTime.getTime() - previous.localDateTime.getTime()) < BURST_SECONDS * 1000
    ) {
      continue;
    }
    kept.push(candidate);
    previous = candidate;
  }

  return kept;
};

/**
 * Keeps at most `limit` assets, spread evenly across the event's local days by taking one
 * asset per day in rotation. A day with three photographs is therefore not drowned out by a
 * day with three hundred, and the result stays in capture order.
 */
export const diversifyByDay = <T extends { id: string; localDateTime: Date }>(
  candidates: T[],
  limit = MAX_EVENT_ASSETS,
): T[] => diversifyByBucket(candidates, limit, (candidate) => localDay(candidate.localDateTime));

/** The same rotation by local month, for a year-long recap (FL-62). */
export const diversifyByMonth = <T extends { id: string; localDateTime: Date }>(
  candidates: T[],
  limit = MAX_EVENT_ASSETS,
): T[] =>
  diversifyByBucket(candidates, limit, (candidate) =>
    DateTime.fromJSDate(candidate.localDateTime, { zone: 'utc' }).toFormat('yyyy-MM'),
  );

/** The same rotation by local year, for a birthday that spans a person's whole library (FL-62). */
export const diversifyByYear = <T extends { id: string; localDateTime: Date }>(
  candidates: T[],
  limit = MAX_EVENT_ASSETS,
): T[] =>
  diversifyByBucket(candidates, limit, (candidate) =>
    DateTime.fromJSDate(candidate.localDateTime, { zone: 'utc' }).toFormat('yyyy'),
  );

const diversifyByBucket = <T extends { id: string }>(
  candidates: T[],
  limit: number,
  bucketOf: (value: T) => string,
): T[] => {
  if (candidates.length <= limit) {
    return candidates;
  }

  const byDay = new Map<string, T[]>();
  for (const candidate of candidates) {
    const day = bucketOf(candidate);
    const bucket = byDay.get(day);
    if (bucket) {
      bucket.push(candidate);
    } else {
      byDay.set(day, [candidate]);
    }
  }

  const days = byDay.keys().toArray().sort();
  const kept = new Set<string>();
  let round = 0;

  while (kept.size < limit) {
    let added = false;
    for (const day of days) {
      const bucket = byDay.get(day)!;
      if (round >= bucket.length) {
        continue;
      }
      kept.add(bucket[round].id);
      added = true;
      if (kept.size >= limit) {
        break;
      }
    }
    if (!added) {
      break;
    }
    round++;
  }

  return candidates.filter(({ id }) => kept.has(id));
};

/**
 * The calendar day a birthday falls on in `year` (FL-62): the same month and day, except that
 * 29 February is kept on 28 February outside leap years. Returns null for an unreadable date.
 */
export const birthdayOn = (birthDate: string, year: number): string | null => {
  const born = DateTime.fromISO(birthDate.slice(0, 10), { zone: 'utc' });
  if (!born.isValid) {
    return null;
  }
  const leapDay = born.month === 2 && born.day === 29;
  const day = DateTime.utc(year, born.month, leapDay && !DateTime.utc(year).isInLeapYear ? 28 : born.day);
  return day.toFormat('yyyy-MM-dd');
};

/** The age reached on the birthday in `year`, or null when the birth year is not a real one. */
export const birthdayAge = (birthDate: string, year: number): number | null => {
  const born = DateTime.fromISO(birthDate.slice(0, 10), { zone: 'utc' });
  if (!born.isValid || born.year < 1850) {
    return null;
  }
  const age = year - born.year;
  return age >= 0 ? age : null;
};

/**
 * When a memory for one calendar day shows (FL-62): from the moment that day starts anywhere
 * (UTC+14) until it has ended everywhere (UTC-12). Clients then decide "today" from their own
 * local date, so a birthday is today in every time zone on the day itself.
 */
export const calendarDayWindow = (date: string) => ({
  showAt: DateTime.fromISO(date, { zone: 'Etc/GMT-14' }).startOf('day').toUTC().toJSDate(),
  hideAt: DateTime.fromISO(date, { zone: 'Etc/GMT+12' }).endOf('day').toUTC().toJSDate(),
});

/** the place most of the event's assets carry, or null when the event has no location at all */
export const dominantPlace = (candidates: StoryCandidate[]): StoryPlace | null => {
  const counts = new Map<string, { place: StoryPlace; count: number }>();

  for (const candidate of candidates) {
    const key = placeKey(candidate);
    if (!key) {
      continue;
    }
    const entry = counts.get(key);
    if (entry) {
      entry.count++;
    } else {
      counts.set(key, {
        place: { city: candidate.city, state: candidate.state, country: candidate.country },
        count: 1,
      });
    }
  }

  let winner: { place: StoryPlace; count: number } | undefined;
  for (const entry of counts.values()) {
    if (!winner || entry.count > winner.count) {
      winner = entry;
    }
  }

  return winner?.place ?? null;
};

/**
 * Splits a single owner's candidates into multi-day events.
 *
 * `candidates` must be that one owner's assets in ascending `localDateTime` order; the
 * caller owns the access check, because nothing here can tell whose assets these are.
 */
export const groupEventStories = (candidates: StoryCandidate[]): EventStoryGroup[] => {
  if (candidates.length === 0) {
    return [];
  }

  const runs: StoryCandidate[][] = [];
  let run: StoryCandidate[] = [];

  for (const candidate of candidates) {
    const previous = run.at(-1);
    if (!previous) {
      run = [candidate];
      continue;
    }

    const gap = hoursBetween(previous.localDateTime, candidate.localDateTime);
    const movedOn =
      placeKey(previous) !== '' && placeKey(candidate) !== '' && placeKey(previous) !== placeKey(candidate);
    const split = gap > EVENT_GAP_HOURS || (movedOn && gap > PLACE_CHANGE_GAP_HOURS);

    if (split) {
      runs.push(run);
      run = [candidate];
    } else {
      run.push(candidate);
    }
  }
  runs.push(run);

  const stories: EventStoryGroup[] = [];

  for (const entries of runs) {
    const deduplicated = suppressBursts(entries);
    const days = new Set(deduplicated.map(({ localDateTime }) => localDay(localDateTime)));

    if (days.size < MIN_EVENT_DAYS || deduplicated.length < MIN_EVENT_ASSETS) {
      continue;
    }

    const kept = diversifyByDay(deduplicated);
    const first = deduplicated[0];
    const last = deduplicated.at(-1)!;

    stories.push({
      startDate: localDay(first.localDateTime),
      endDate: localDay(last.localDateTime),
      startAt: first.localDateTime,
      endAt: last.localDateTime,
      dayCount: days.size,
      place: dominantPlace(deduplicated),
      assetIds: kept.map(({ id }) => id),
      totalAssets: deduplicated.length,
    });
  }

  return stories;
};

/** the display label for a story's place, or undefined when there is no usable location */
export const placeLabel = (place: StoryPlace | null): string | undefined => {
  if (!place) {
    return undefined;
  }
  const parts = [place.city, place.city ? null : place.state, place.country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
};

/* -------------------------------------------------------------------------------------------- */
/* Pet stories (FL-58)                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** a named pet needs at least this many confirmed photos in a month for a story about it */
export const MIN_PET_STORY_ASSETS = 5;

/** the most photos a pet story keeps, spread across the month's days */
export const MAX_PET_STORY_ASSETS = 40;

export type PetStoryCandidate = {
  petId: string;
  name: string;
  species: string;
  assetId: string;
  /** the asset's local wall clock, stored as a UTC instant */
  localDateTime: Date;
};

export type PetStoryGroup = {
  petId: string;
  name: string;
  species: string;
  /** the owner's local month, 'yyyy-MM' */
  month: string;
  /** confirmed photos of the pet that month, before the diversity pass */
  assetCount: number;
  assetIds: string[];
};

/**
 * One story per named pet per local month with enough confirmed photos. Only the owner's
 * confirmed observations reach this (the query sees nothing else), and a pet without a name has no
 * story: "Moments with" needs someone to be with. Photos are spread across the month's days.
 */
export const groupPetStories = (candidates: PetStoryCandidate[]): PetStoryGroup[] => {
  const byPet = new Map<string, { month: string; rows: PetStoryCandidate[] }>();
  for (const candidate of candidates) {
    if (!candidate.name.trim()) {
      continue;
    }
    const month = DateTime.fromJSDate(candidate.localDateTime, { zone: 'utc' }).toFormat('yyyy-MM');
    const key = `${candidate.petId}:${month}`;
    const entry = byPet.get(key) ?? { month, rows: [] };
    entry.rows.push(candidate);
    byPet.set(key, entry);
  }

  const stories: PetStoryGroup[] = [];
  for (const { month, rows } of byPet.values()) {
    const unique = new Map(rows.map((row) => [row.assetId, row]))
      .values()
      .toArray()
      .sort((a, b) => a.localDateTime.getTime() - b.localDateTime.getTime() || a.assetId.localeCompare(b.assetId));
    if (unique.length < MIN_PET_STORY_ASSETS) {
      continue;
    }
    const kept = diversifyByDay(
      unique.map((row) => ({
        id: row.assetId,
        localDateTime: row.localDateTime,
        city: null,
        state: null,
        country: null,
      })),
      MAX_PET_STORY_ASSETS,
    );
    const [first] = unique;
    stories.push({
      petId: first.petId,
      name: first.name.trim(),
      species: first.species,
      month,
      assetCount: unique.length,
      assetIds: kept.map(({ id }) => id),
    });
  }

  return stories.sort((a, b) => a.month.localeCompare(b.month) || a.petId.localeCompare(b.petId));
};
