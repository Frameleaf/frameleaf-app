/**
 * Where a day was spent, for its Timeline header (FL-1392, UI review 2026-11-10 B3), ported from
 * `groupPlaces` in the prototype's `TimelineLibrary.jsx`: "Banff", "Banff and Lake Louise",
 * "Banff, Lake Louise and 2 more". The places are the photos' cities, in the order the day shows
 * them; a day whose photos have no place gives an empty string, and its header shows no place line.
 */
import type { MessageFormatter } from 'svelte-i18n';

export const groupPlaces = (cities: Iterable<string | null | undefined>, $t: MessageFormatter): string => {
  const places = [...new Set([...cities].filter((city): city is string => !!city))];
  if (places.length <= 1) {
    return places[0] ?? '';
  }
  const [first, second] = places;
  return places.length === 2
    ? $t('frameleaf_library_places_two', { values: { first, second } })
    : $t('frameleaf_library_places_more', { values: { first, second, count: places.length - 2 } });
};
