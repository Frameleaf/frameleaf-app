import {
  MemoryExportStatus,
  MemoryType,
  type EventStoryDto,
  type MemoryExportResponseDto,
  type MemoryResponseDto,
  type PetStoryDto,
  type YearInReviewDto,
} from '@immich/sdk';

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

export type MemoryStoryKind = 'on_this_day' | 'event_story' | 'year_in_review' | 'pet_story';

export const isEventStory = (memory: MemoryResponseDto): memory is MemoryResponseDto & { data: EventStoryDto } =>
  memory.type === MemoryType.EventStory && (memory.data as Partial<EventStoryDto>).kind === 'event_story';

export const isYearInReview = (memory: MemoryResponseDto): memory is MemoryResponseDto & { data: YearInReviewDto } =>
  memory.type === MemoryType.YearInReview && (memory.data as Partial<YearInReviewDto>).kind === 'year_in_review';

/** FL-58: a month of photos with one of the owner's named pets; `name` is the pet's current name. */
export const isPetStory = (memory: MemoryResponseDto): memory is MemoryResponseDto & { data: PetStoryDto } =>
  memory.type === MemoryType.PetStory && (memory.data as Partial<PetStoryDto>).kind === 'pet_story';

export const memoryStoryKind = (memory: MemoryResponseDto): MemoryStoryKind => {
  if (isEventStory(memory)) {
    return 'event_story';
  }
  if (isPetStory(memory)) {
    return 'pet_story';
  }
  if (isYearInReview(memory)) {
    return 'year_in_review';
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
