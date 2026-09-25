import type { AssetResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { buildPlacesTree, filterPlacesTree, stateMapDots } from '$lib/frameleaf/places';

const place = (
  id: string,
  exif: Partial<{
    city: string | null;
    country: string | null;
    state: string | null;
    latitude: number | null;
    longitude: number | null;
  }>,
): AssetResponseDto =>
  ({
    id,
    exifInfo: { city: null, country: null, state: null, latitude: null, longitude: null, ...exif },
  }) as unknown as AssetResponseDto;

const labels = { unknownCountry: 'Unknown country', unknownState: 'Other' };

describe('places tree (FL-51)', () => {
  const places = [
    place('lisbon', { city: 'Lisbon', state: 'Lisboa', country: 'Portugal', latitude: 38.7, longitude: -9.1 }),
    place('porto', { city: 'Porto', state: 'Porto', country: 'Portugal', latitude: 41.1, longitude: -8.6 }),
    place('sintra', { city: 'Sintra', state: 'Lisboa', country: 'Portugal', latitude: 38.8, longitude: -9.4 }),
    place('kyoto', { city: 'Kyoto', state: null, country: 'Japan', latitude: 35, longitude: 135.7 }),
    place('nowhere', { city: 'Atlantis', state: null, country: null }),
    place('no-city', { country: 'Spain' }),
  ];
  const counts = new Map([
    ['Lisbon', 12],
    ['Porto', 3],
    ['Sintra', 5],
    ['Kyoto', 30],
    ['Atlantis', 1],
  ]);

  it('groups cities by country then state, most items first, with the search each opens', () => {
    const tree = buildPlacesTree(places, counts, labels);
    expect(tree.countries.map(({ name, count }) => [name, count])).toEqual([
      ['Japan', 30],
      ['Portugal', 20],
      ['Unknown country', 1],
    ]);
    const portugal = tree.countries[1];
    expect(portugal.query).toEqual({ country: 'Portugal' });
    expect(portugal.states.map(({ name, count }) => [name, count])).toEqual([
      ['Lisboa', 17],
      ['Porto', 3],
    ]);
    expect(portugal.states[0].query).toEqual({ state: 'Lisboa', country: 'Portugal' });
    expect(portugal.states[0].cities.map(({ name }) => name)).toEqual(['Lisbon', 'Sintra']);
    expect(portugal.states[0].cities[0].query).toEqual({ city: 'Lisbon' });

    expect(tree.countries[0].states[0]).toMatchObject({ name: 'Other', query: { country: 'Japan', state: null } });
    expect(tree.countries[2].query).toEqual({ country: null });
    expect(tree.total).toBe(51);
    expect(tree.cities.map(({ name }) => name)).toEqual(['Kyoto', 'Lisbon', 'Sintra', 'Porto', 'Atlantis']);
  });

  it('finds a place by its own, its state or its country name, ignoring case and accents', () => {
    const tree = buildPlacesTree(
      [...places, place('sao', { city: 'São Paulo', state: 'SP', country: 'Brazil' })],
      counts,
      labels,
    );
    expect(filterPlacesTree(tree, 'lisboa').countries[0].states[0].cities.map(({ name }) => name)).toEqual([
      'Lisbon',
      'Sintra',
    ]);
    expect(filterPlacesTree(tree, 'PORTUGAL').countries[0].states).toHaveLength(2);
    expect(filterPlacesTree(tree, 'sao').cities.map(({ name }) => name)).toEqual(['São Paulo']);
    expect(filterPlacesTree(tree, 'zzz').countries).toEqual([]);
  });

  it('draws the located cities of a state inside its card, larger for more items', () => {
    const tree = buildPlacesTree(places, counts, labels);
    const dots = stateMapDots(tree.countries[1].states[0].cities, 240, 180);
    expect(dots).toHaveLength(2);
    for (const dot of dots) {
      expect(dot.x).toBeGreaterThanOrEqual(0);
      expect(dot.x).toBeLessThanOrEqual(240);
      expect(dot.y).toBeGreaterThanOrEqual(0);
      expect(dot.y).toBeLessThanOrEqual(180);
    }
    expect(dots[0].r).toBeGreaterThan(dots[1].r);
    expect(stateMapDots(tree.countries[2].states[0].cities, 240, 180)).toEqual([]);
  });
});
