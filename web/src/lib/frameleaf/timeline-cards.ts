import type { TimelineHighlightResponseDto } from '@immich/sdk';

/**
 * Curated Years and Months cards for the Timeline (FL-33, FL-50), ported from the September 24
 * template's `timeline-highlights.mjs` and `TimelineLibrary.jsx` `TimelineCard`.
 *
 * The template ranks a period's photos in the browser; production asks the server, which ranks the
 * whole period under the same filters as the time buckets (`GET /timeline/highlights`): the key
 * photo is the highest Best Photos score, then the highest rating, then the most recent capture;
 * month cards add the next best photos as a highlight strip; places are the three busiest. The
 * server withholds places the viewer may not see, so a card never shows more than the grid would.
 */

export type TimelineCardKind = 'year' | 'month';

export type TimelineCard = {
  /** "2026" for a year, "2026-08" for a month: the prefix of the finer groups a card opens. */
  id: string;
  kind: TimelineCardKind;
  year: number;
  /** 1–12 for a month card. */
  month?: number;
  count: number;
  keyAssetId: string | null;
  /** Month cards: up to four more photos, in capture order, never the key photo. */
  highlightAssetIds: string[];
  places: string[];
};

/** Where opening a card leads: a year opens Months at that year, a month opens Days at that month. */
export type TimelineCardTarget =
  { grouping: 'months'; year: number } | { grouping: 'days'; year: number; month: number };

/** How many highlights a month card shows under its key photo (template `highlightCount`). */
export const MONTH_HIGHLIGHT_COUNT = 4;

/** The server's bucket (first day of the period, "YYYY-MM-DD") as a year and month. */
const parseBucket = (timeBucket: string) => {
  const [year, month] = timeBucket.replace(/^[+-]/, '').split('-').map(Number);
  return { year, month };
};

/** Cards from the highlights response, in the order the server returned them (the view's order). */
export const timelineCards = (
  highlights: readonly TimelineHighlightResponseDto[],
  kind: TimelineCardKind,
): TimelineCard[] =>
  highlights.flatMap((highlight) => {
    const { year, month } = parseBucket(highlight.timeBucket);
    if (!Number.isFinite(year) || (kind === 'month' && !Number.isFinite(month))) {
      return [];
    }
    return [
      {
        id: kind === 'year' ? String(year) : `${year}-${String(month).padStart(2, '0')}`,
        kind,
        year,
        month: kind === 'month' ? month : undefined,
        count: highlight.count,
        keyAssetId: highlight.keyAssetId,
        highlightAssetIds:
          kind === 'month'
            ? highlight.highlightAssetIds.filter((id) => id !== highlight.keyAssetId).slice(0, MONTH_HIGHLIGHT_COUNT)
            : [],
        places: highlight.places.slice(0, 3),
      },
    ];
  });

/** Template `drillTarget`: one level finer, at the card's period. */
export const cardTarget = (card: TimelineCard): TimelineCardTarget =>
  card.kind === 'year'
    ? { grouping: 'months', year: card.year }
    : { grouping: 'days', year: card.year, month: card.month ?? 1 };

/** Template `firstGroupWithPrefix`: the first card belonging to a year ("2026" → "2026-08"). */
export const firstCardOfYear = (cards: readonly TimelineCard[], year: number) =>
  cards.find((card) => card.year === year) ?? null;

/** Template `placeSummary`: "Banff, Lake Louise and Jasper", in the viewer's language. */
export const placeSummary = (places: readonly string[], locale?: string) => {
  if (places.length < 2) {
    return places[0] ?? '';
  }
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(places);
  } catch {
    return places.join(', ');
  }
};
