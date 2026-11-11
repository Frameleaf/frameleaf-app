import { addMessages, t } from 'svelte-i18n';
import { get } from 'svelte/store';
import en from '$i18n/en.json';
import { groupPlaces } from '$lib/frameleaf/group-places';

// FL-1392 (UI review 2026-11-10, B3): a Timeline day header names where the day was spent.
describe(groupPlaces.name, () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  const places = (...cities: (string | null | undefined)[]) => groupPlaces(cities, get(t));

  it('names one place', () => {
    expect(places('Banff')).toBe('Banff');
    expect(places('Banff', 'Banff', 'Banff')).toBe('Banff');
  });

  it('joins two places', () => {
    expect(places('Banff', 'Lake Louise', 'Banff')).toBe('Banff and Lake Louise');
  });

  it('names the first two places and counts the rest', () => {
    expect(places('Banff', 'Lake Louise', 'Canmore')).toBe('Banff, Lake Louise and 1 more');
    expect(places('Banff', 'Lake Louise', 'Canmore', 'Jasper')).toBe('Banff, Lake Louise and 2 more');
    expect(places('Banff', 'Lake Louise', 'Canmore', 'Jasper', 'Golden', 'Banff')).toBe(
      'Banff, Lake Louise and 3 more',
    );
  });

  it('keeps the order the day shows its photos in, and skips photos with no place', () => {
    expect(places(null, 'Lake Louise', undefined, '', 'Banff')).toBe('Lake Louise and Banff');
  });

  it('is empty for a day whose photos have no place', () => {
    expect(places()).toBe('');
    expect(places(null, undefined, '')).toBe('');
  });
});
