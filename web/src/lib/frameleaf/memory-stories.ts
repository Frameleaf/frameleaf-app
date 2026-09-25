import {
  MemoryExportStatus,
  MemoryShowLessKind,
  MemoryType,
  Subject,
  type BirthdayMemoryDto,
  type EventStoryDto,
  type MemoryExportResponseDto,
  type MemoryResponseDto,
  type MemoryShowLessDto,
  type MemoryShowLessResponseDto,
  type OnThisDayDto,
  type PersonRecapDto,
  type YearInReviewDto,
} from '@immich/sdk';
import { DateTime } from 'luxon';
import type { Translations } from 'svelte-i18n';

/**
 * Frameleaf memory story helpers (FL-62).
 *
 * The server now generates three kinds of memory — the original `on_this_day`, multi-day
 * `event_story` groupings and yearly `year_in_review` recaps — and serves all of them
 * through the same memories API. These are the pure predicates and formatters the index
 * and the player share, so the components stay presentational and the rules can be tested
 * without mounting anything.
 *
 * Nothing here reformats the memory's own dates into a local timezone: an event story's
 * `startDate`/`endDate` are already the owner's local days as the server grouped them, and
 * re-interpreting them in the viewer's zone would move a trip by a day.
 */

export type MemoryStoryKind = 'on_this_day' | 'event_story' | 'year_in_review' | 'birthday' | 'person_recap';

export const isEventStory = (memory: MemoryResponseDto): memory is MemoryResponseDto & { data: EventStoryDto } =>
  memory.type === MemoryType.EventStory && (memory.data as Partial<EventStoryDto>).kind === 'event_story';

export const isYearInReview = (memory: MemoryResponseDto): memory is MemoryResponseDto & { data: YearInReviewDto } =>
  memory.type === MemoryType.YearInReview && (memory.data as Partial<YearInReviewDto>).kind === 'year_in_review';

export const isBirthday = (memory: MemoryResponseDto): memory is MemoryResponseDto & { data: BirthdayMemoryDto } =>
  memory.type === MemoryType.Birthday && (memory.data as Partial<BirthdayMemoryDto>).kind === 'birthday';

export const isPersonRecap = (memory: MemoryResponseDto): memory is MemoryResponseDto & { data: PersonRecapDto } =>
  memory.type === MemoryType.PersonRecap && (memory.data as Partial<PersonRecapDto>).kind === 'person_recap';

export const memoryStoryKind = (memory: MemoryResponseDto): MemoryStoryKind => {
  if (isEventStory(memory)) {
    return 'event_story';
  }
  if (isYearInReview(memory)) {
    return 'year_in_review';
  }
  if (isBirthday(memory)) {
    return 'birthday';
  }
  if (isPersonRecap(memory)) {
    return 'person_recap';
  }
  return 'on_this_day';
};

/**
 * The place an event story is about, when the server found one. Returns undefined rather
 * than an empty string so a caller can fall back to the date range without a blank line.
 */
export const eventStoryPlace = (memory: MemoryResponseDto): string | undefined => {
  if (!isEventStory(memory)) {
    return undefined;
  }
  const { title, place } = memory.data;
  if (title) {
    return title;
  }
  const parts = [place?.city ?? place?.state, place?.country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
};

/**
 * Formats an event story's local day range. `yyyy-MM-dd` strings are parsed as plain
 * calendar dates — never as instants — so the day never shifts under the viewer's zone.
 */
export const formatLocalDateRange = (startDate: string, endDate: string, locale?: string): string => {
  const format = (value: string) => {
    const [year, month, day] = value.split('-').map(Number);
    if (!year || !month || !day) {
      return value;
    }
    return new Date(year, month - 1, day).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return startDate === endDate ? format(startDate) : `${format(startDate)} – ${format(endDate)}`;
};

// --- the Memories index (Memories.jsx) ----------------------------------------------------

/** How far ahead Upcoming looks, and how long a passed day keeps its "N days ago" badge (Memories.jsx: next 14 days). */
export const MEMORY_WINDOW_DAYS = 14;

const isoDay = /^\d{4}-\d{2}-\d{2}$/;

/** The viewer's own local calendar day, 'yyyy-MM-dd'. "Today" is always decided in the viewer's zone. */
export const localToday = (now: Date = new Date()): string => DateTime.fromJSDate(now).toISODate() ?? '';

/** Whole calendar days from `from` to `to` (both 'yyyy-MM-dd'); positive when `to` is later. */
export const dayDiff = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/**
 * The calendar day a dated memory belongs to, or undefined for stories that are not tied to a day.
 *
 * A birthday carries its local date in its data, since the server shows it for that day in every
 * time zone. An "on this day" memory is shown for one day of the server's calendar: the middle of its
 * show window is midday of that day whatever zone the server ran in, so its UTC date is the day.
 */
export const memoryLocalDay = (memory: MemoryResponseDto): string | undefined => {
  if (isBirthday(memory)) {
    return isoDay.test(memory.data.date) ? memory.data.date : undefined;
  }
  if (memory.type !== MemoryType.OnThisDay || !memory.showAt) {
    return undefined;
  }
  const start = Date.parse(memory.showAt);
  const end = memory.hideAt ? Date.parse(memory.hideAt) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  return DateTime.fromMillis((start + end) / 2, { zone: 'utc' }).toISODate() ?? undefined;
};

export type MemoryEntry = {
  memory: MemoryResponseDto;
  /** Days until an upcoming memory's day (1 is tomorrow). */
  inDays?: number;
  /** Days since a recently passed memory's day, within the window (1 is yesterday). */
  passedDays?: number;
};

export type MemorySections = { today: MemoryEntry[]; upcoming: MemoryEntry[]; earlier: MemoryEntry[] };

/**
 * Splits the index into Today, Upcoming and Earlier (Memories.jsx:260-360), from the viewer's local
 * date. A memory for a later day is Upcoming only within the next two weeks and only when the owner
 * shows upcoming memories; trips, highlights and recaps, which are not tied to a day, are Earlier.
 */
export const groupMemories = (
  memories: MemoryResponseDto[],
  {
    today,
    showUpcoming = true,
    windowDays = MEMORY_WINDOW_DAYS,
  }: { today: string; showUpcoming?: boolean; windowDays?: number },
): MemorySections => {
  const sections: MemorySections = { today: [], upcoming: [], earlier: [] };
  for (const memory of memories) {
    const day = memoryLocalDay(memory);
    if (!day) {
      sections.earlier.push({ memory });
      continue;
    }
    const diff = dayDiff(today, day);
    if (diff === 0) {
      sections.today.push({ memory });
    } else if (diff > 0) {
      if (showUpcoming && diff <= windowDays) {
        sections.upcoming.push({ memory, inDays: diff });
      }
    } else {
      sections.earlier.push({ memory, passedDays: -diff <= windowDays ? -diff : undefined });
    }
  }
  sections.upcoming.sort((a, b) => (a.inDays ?? 0) - (b.inDays ?? 0));
  return sections;
};

type Translate = (
  key: Translations,
  options?: { values?: Record<string, string | number | boolean | Date | null | undefined> },
) => string;

const longDate = (day: string, locale?: string) => {
  const date = DateTime.fromISO(day, { zone: 'utc' });
  return date.isValid ? date.setLocale(locale ?? 'en').toLocaleString(DateTime.DATE_FULL) : day;
};

/** 'MM-dd' as "September 25" in the viewer's language. */
export const monthDayLabel = (monthDay: string, locale?: string): string => {
  const [month, day] = monthDay.split('-').map(Number);
  const date = DateTime.fromObject({ year: 2000, month, day }, { zone: 'utc' });
  return date.isValid ? date.setLocale(locale ?? 'en').toLocaleString({ month: 'long', day: 'numeric' }) : monthDay;
};

export type MemoryHeadline = { title: string; subtitle: string };

/**
 * A memory's title and the line under it (Memories.jsx:170-200, discovery-data.mjs:990-1150): "On this
 * day" over "One year ago · September 25, 2025", a trip's place over its days, a birthday, a recap. The
 * owner's own title always wins over the generated one.
 */
export const memoryHeadline = (
  memory: MemoryResponseDto,
  { t, locale, today = localToday() }: { t: Translate; locale?: string; today?: string },
): MemoryHeadline => {
  const headline = generatedHeadline(memory, { t, locale, today });
  return memory.title ? { ...headline, title: memory.title } : headline;
};

const generatedHeadline = (
  memory: MemoryResponseDto,
  { t, locale, today }: { t: Translate; locale?: string; today: string },
): MemoryHeadline => {
  const count = t('frameleaf_memories_item_count', { values: { count: memory.assets.length } });
  if (isEventStory(memory)) {
    const range = formatLocalDateRange(memory.data.startDate, memory.data.endDate, locale);
    return {
      title: eventStoryPlace(memory) ?? range,
      subtitle: [range, t('frameleaf_memories_story_days', { values: { count: memory.data.dayCount } })].join(' · '),
    };
  }
  if (isYearInReview(memory)) {
    return {
      title: t('frameleaf_memories_year_in_review_title', { values: { year: memory.data.year } }),
      subtitle: t('frameleaf_memories_year_in_review_subtitle', { values: { count: memory.data.monthCount } }),
    };
  }
  if (isBirthday(memory)) {
    return {
      title: t('frameleaf_memories_birthday_title', { values: { name: memory.data.name } }),
      subtitle: [
        memory.data.age === null
          ? undefined
          : t('frameleaf_memories_birthday_turns', { values: { age: memory.data.age } }),
        longDate(memory.data.date, locale),
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }
  if (isPersonRecap(memory)) {
    return {
      title: t('frameleaf_memories_recap_title', { values: { year: memory.data.year, name: memory.data.name } }),
      subtitle: count,
    };
  }
  const day = memoryLocalDay(memory) ?? DateTime.fromISO(memory.memoryAt, { zone: 'utc' }).toISODate() ?? today;
  const year = (memory.data as Partial<OnThisDayDto>).year;
  const sourceDay = year ? `${String(year).padStart(4, '0')}${day.slice(4)}` : day;
  const years = year ? Number(day.slice(0, 4)) - year : 0;
  return {
    title: t('frameleaf_memories_on_this_day'),
    subtitle: [
      years > 0 ? t('frameleaf_memories_years_ago', { values: { count: years } }) : undefined,
      longDate(sourceDay, locale),
    ]
      .filter(Boolean)
      .join(' · '),
  };
};

// --- show less (FL-62) ------------------------------------------------------------------------

export type ShowLessOption = { rule: MemoryShowLessDto; label: string };

/**
 * What the owner can ask to see less of from one memory's menu: the person or pet it is about, the
 * day it is tied to, and its kind. The server removes matching memories and stops generating them.
 */
export const showLessOptions = (memory: MemoryResponseDto, { t, locale }: { t: Translate; locale?: string }) => {
  const options: ShowLessOption[] = [];
  if (isBirthday(memory) || isPersonRecap(memory)) {
    options.push({
      rule: {
        kind: memory.data.subject === Subject.Pet ? MemoryShowLessKind.Pet : MemoryShowLessKind.Person,
        value: memory.data.subjectId,
      },
      label: t('frameleaf_memories_show_less_subject', { values: { name: memory.data.name } }),
    });
  }
  const day = memoryLocalDay(memory);
  if (day) {
    options.push({
      rule: { kind: MemoryShowLessKind.Date, value: day.slice(5) },
      label: t('frameleaf_memories_show_less_date', { values: { date: monthDayLabel(day.slice(5), locale) } }),
    });
  }
  options.push({
    rule: { kind: MemoryShowLessKind.Type, value: memory.type },
    label: t('frameleaf_memories_show_less_type', { values: { type: memory.type } }),
  });
  return options;
};

/** How a saved show-less rule reads in Memory settings. */
export const showLessRuleLabel = (
  rule: MemoryShowLessResponseDto,
  { t, locale }: { t: Translate; locale?: string },
): string => {
  switch (rule.kind) {
    case MemoryShowLessKind.Person:
    case MemoryShowLessKind.Pet: {
      return (
        rule.name ??
        t(
          rule.kind === MemoryShowLessKind.Pet
            ? 'frameleaf_memories_show_less_unnamed_pet'
            : 'frameleaf_memories_show_less_unnamed_person',
        )
      );
    }
    case MemoryShowLessKind.Date: {
      return t('frameleaf_memories_show_less_rule_date', { values: { date: monthDayLabel(rule.value, locale) } });
    }
    default: {
      return t('frameleaf_memories_show_less_rule_type', { values: { type: rule.value } });
    }
  }
};

/** The owner's item order for a memory after moving one item earlier (-1) or later (+1). */
export const moveMemoryItem = (ids: string[], id: string, offset: -1 | 1): string[] => {
  const from = ids.indexOf(id);
  const to = from + offset;
  if (from === -1 || to < 0 || to >= ids.length) {
    return ids;
  }
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
};

/**
 * Where a video in a memory starts and opens (FL-62: "timestamped video moments open at their evidence
 * position"): the owner's chosen cover time, else the best-ranked frame, else the beginning.
 */
export const memoryEvidenceMs = (
  moments: { coverTimestampMs: number | null; frames: { rank: number; timestampMs: number }[] } | null | undefined,
): number | null => {
  if (!moments) {
    return null;
  }
  if (moments.coverTimestampMs !== null && moments.coverTimestampMs >= 0) {
    return moments.coverTimestampMs;
  }
  let best: { rank: number; timestampMs: number } | undefined;
  for (const frame of moments.frames) {
    if (!best || frame.rank < best.rank) {
      best = frame;
    }
  }
  return best && best.timestampMs > 0 ? best.timestampMs : null;
};

// --- exports -----------------------------------------------------------------------------

/** A run the Activity page and the player should keep polling. */
export const isExportActive = (status: MemoryExportStatus): boolean =>
  [MemoryExportStatus.Pending, MemoryExportStatus.Running, MemoryExportStatus.Cancelling].includes(status);

/** Fraction of the export that is written, 0 to 1. Pending work reads as 0, not as NaN. */
export const exportProgress = ({ assetCount, processedAssets }: MemoryExportResponseDto): number => {
  if (assetCount <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, processedAssets / assetCount));
};

/**
 * The most recent export of a memory, which is the one a player shows. The list the server
 * returns is already newest first, but the order is re-established here so the component
 * does not depend on it.
 */
export const latestExport = (runs: MemoryExportResponseDto[], memoryId: string): MemoryExportResponseDto | undefined =>
  runs
    .filter((run) => run.memoryId === memoryId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .at(0);
