import type { AssetResponseDto } from '@immich/sdk';

/**
 * Country/state grouping for the Places page (FL-51).
 *
 * `Places.jsx` in `design/frameleaf/template/src` groups the sample data by country then
 * state, with a "Show on map" link at each level. Production's `/search/cities` endpoint
 * already returns one representative asset per city with `exifInfo.country`/`.state`/
 * `.latitude`/`.longitude` filled in, so this is a pure client-side reshaping of that
 * response: no server change is needed. `PlacesList.svelte` renders the result; keeping
 * the grouping logic here (rather than inline in the component) matches the other pure
 * Frameleaf adapters in this directory and makes it independently testable.
 */

export interface FrameleafPlacesStateGroup {
  id: string;
  name: string;
  places: AssetResponseDto[];
  /** Centre of this state's located places, for the "Show on map" link. Null when none are located. */
  latitude: number | null;
  longitude: number | null;
}

export interface FrameleafPlacesCountryGroup {
  id: string;
  name: string;
  count: number;
  states: FrameleafPlacesStateGroup[];
}

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Empty-country/state placeholders sort after every named entry, then alphabetically. */
const byNameWithUnknownLast = (unknown: string) => (a: string, b: string) => {
  if (a === unknown) {
    return b === unknown ? 0 : 1;
  }
  return b === unknown ? -1 : a.localeCompare(b);
};

export function buildCountryStateGroups(
  places: AssetResponseDto[],
  unknownCountry: string,
  unknownState: string,
): FrameleafPlacesCountryGroup[] {
  const countries = new Map<string, Map<string, AssetResponseDto[]>>();

  for (const place of places) {
    const country = place.exifInfo?.country ?? unknownCountry;
    const state = place.exifInfo?.state ?? unknownState;
    if (!countries.has(country)) {
      countries.set(country, new Map());
    }
    const states = countries.get(country) as Map<string, AssetResponseDto[]>;
    if (!states.has(state)) {
      states.set(state, []);
    }
    (states.get(state) as AssetResponseDto[]).push(place);
  }

  return [...countries.entries()]
    .sort(([a], [b]) => byNameWithUnknownLast(unknownCountry)(a, b))
    .map(([country, states]) => {
      const stateGroups: FrameleafPlacesStateGroup[] = [...states.entries()]
        .sort(([a], [b]) => byNameWithUnknownLast(unknownState)(a, b))
        .map(([state, statePlaces]) => {
          const located = statePlaces.filter(
            (place) => typeof place.exifInfo?.latitude === 'number' && typeof place.exifInfo?.longitude === 'number',
          );
          return {
            id: `${country}::${state}`,
            name: state,
            places: statePlaces,
            latitude: located.length ? average(located.map((place) => place.exifInfo?.latitude as number)) : null,
            longitude: located.length ? average(located.map((place) => place.exifInfo?.longitude as number)) : null,
          };
        });
      return {
        id: country,
        name: country,
        count: stateGroups.reduce((sum, group) => sum + group.places.length, 0),
        states: stateGroups,
      };
    });
}
