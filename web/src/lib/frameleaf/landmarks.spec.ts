import type { SearchLandmarkResponseDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { buildLandmarkCards, landmarkHref, landmarkKind } from '$lib/frameleaf/landmarks';

const landmark = (overrides: Partial<SearchLandmarkResponseDto> = {}): SearchLandmarkResponseDto => ({
  id: 'Q181185',
  name: 'Disneyland Park',
  kind: 'theme_park',
  latitude: 33.8121,
  longitude: -117.919,
  assetCount: 14,
  firstTakenAt: '2026-06-03T10:00:00.000Z',
  lastTakenAt: '2026-06-05T21:30:00.000Z',
  coverAssetId: '11111111-1111-4111-8111-111111111111',
  city: 'Anaheim',
  state: 'California',
  country: 'United States of America',
  ...overrides,
});

describe('landmarks', () => {
  it('links a landmark to the search for everything taken there', () => {
    const query = new URL(landmarkHref('Q243'), 'http://x').searchParams.get('query');
    expect(JSON.parse(query!)).toEqual({ filter: { landmarkIds: { any: ['Q243'] } } });
  });

  it('builds cards in the order given, with the local days of the first and latest item', () => {
    const icon = { background: '#172a76', tile: true };
    const cards = buildLandmarkCards([
      landmark({ icon }),
      landmark({ id: 'Q243', name: 'Eiffel Tower', kind: 'tower' }),
    ]);

    expect(cards.map(({ id }) => id)).toEqual(['Q181185', 'Q243']);
    expect(cards[0]).toMatchObject({
      label: 'Disneyland Park',
      kind: 'theme_park',
      icon,
      count: 14,
      firstDay: '2026-06-03',
      lastDay: '2026-06-05',
      coverAssetId: '11111111-1111-4111-8111-111111111111',
      city: 'Anaheim',
    });
    expect(cards[1].icon).toBeUndefined();
  });

  it('keeps only as many cards as asked for', () => {
    expect(buildLandmarkCards([landmark(), landmark({ id: 'Q243' }), landmark({ id: 'Q351' })], 2)).toHaveLength(2);
  });

  it('reads a kind this build does not know as a plain landmark', () => {
    expect(landmarkKind('observatory')).toBe(landmarkKind('landmark'));
    expect(landmarkKind('theme_park')).not.toBe(landmarkKind('landmark'));
  });
});
