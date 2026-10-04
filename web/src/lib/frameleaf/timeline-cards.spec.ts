import { describe, expect, it } from 'vitest';
import { cardTarget, firstCardOfYear, placeSummary, timelineCards } from '$lib/frameleaf/timeline-cards';

const highlight = (timeBucket: string, overrides = {}) => ({
  timeBucket,
  count: 12,
  keyAssetId: 'key',
  highlightAssetIds: ['a', 'b', 'c', 'd', 'e'],
  places: ['Banff', 'Lake Louise', 'Jasper', 'Calgary'],
  ...overrides,
});

describe('timelineCards', () => {
  it('makes one year card per year, keyed by the year, with no highlight strip', () => {
    const [card] = timelineCards([highlight('2026-01-01')], 'year');
    expect(card).toMatchObject({ id: '2026', kind: 'year', year: 2026, count: 12, keyAssetId: 'key' });
    expect(card.highlightAssetIds).toEqual([]);
    expect(card.places).toEqual(['Banff', 'Lake Louise', 'Jasper']);
  });

  it('makes month cards keyed "YYYY-MM" with up to four highlights that never repeat the key photo', () => {
    const [card] = timelineCards(
      [highlight('2026-08-01', { highlightAssetIds: ['key', 'a', 'b', 'c', 'd', 'e'] })],
      'month',
    );
    expect(card).toMatchObject({ id: '2026-08', kind: 'month', year: 2026, month: 8 });
    expect(card.highlightAssetIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the server order and a period without a key photo', () => {
    const cards = timelineCards(
      [highlight('2026-01-01'), highlight('2024-01-01', { keyAssetId: null, places: [] })],
      'year',
    );
    expect(cards.map((card) => card.id)).toEqual(['2026', '2024']);
    expect(cards[1]).toMatchObject({ keyAssetId: null, places: [] });
  });
});

describe('card targets', () => {
  it('opens Months at a year and Days at a month', () => {
    const [year] = timelineCards([highlight('2026-01-01')], 'year');
    const [month] = timelineCards([highlight('2026-08-01')], 'month');
    expect(cardTarget(year)).toEqual({ grouping: 'months', year: 2026 });
    expect(cardTarget(month)).toEqual({ grouping: 'days', year: 2026, month: 8 });
  });

  it('finds the first month card of a year', () => {
    const months = timelineCards([highlight('2026-08-01'), highlight('2025-12-01'), highlight('2025-03-01')], 'month');
    expect(firstCardOfYear(months, 2025)?.id).toBe('2025-12');
    expect(firstCardOfYear(months, 2019)).toBeNull();
  });
});

describe('placeSummary', () => {
  it('lists places as a sentence', () => {
    expect(placeSummary([])).toBe('');
    expect(placeSummary(['Banff'])).toBe('Banff');
    expect(placeSummary(['Banff', 'Lake Louise', 'Jasper'], 'en')).toBe('Banff, Lake Louise, and Jasper');
  });
});
