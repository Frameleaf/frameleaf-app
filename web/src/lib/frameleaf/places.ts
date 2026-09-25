import type { AssetResponseDto, MetadataSearchDto } from '@immich/sdk';

/**
 * The Places tree (FL-51), a port of the prototype's `placesTree` (`discovery-data.mjs:398-474`)
 * over the real places data: `GET /search/cities` gives one representative photo per city with its
 * state, country and coordinates, and `GET /search/cities/counts` how many photos and videos each
 * city holds (same owners and privacy rules). Countries hold states, states hold cities; every
 * level is ordered by its item count, then by name, and knows the search it opens.
 *
 * A place with no country is grouped under "Unknown country" and opens the search for items with no
 * country; a state-less city sits under "Other" in its country.
 */
export type PlaceCity = {
  id: string;
  name: string;
  count: number;
  /** the representative photo the places endpoint returned for the city */
  coverId: string;
  latitude: number | null;
  longitude: number | null;
  query: MetadataSearchDto;
};

export type PlaceState = {
  id: string;
  name: string;
  count: number;
  cities: PlaceCity[];
  query: MetadataSearchDto;
};

export type PlaceCountry = {
  id: string;
  name: string;
  count: number;
  states: PlaceState[];
  query: MetadataSearchDto;
};

export type PlacesTree = {
  countries: PlaceCountry[];
  /** every city, most items first, for the ungrouped grid */
  cities: PlaceCity[];
  /** items in all listed places */
  total: number;
};

const byCount = <T extends { count: number; name: string }>(a: T, b: T) =>
  b.count - a.count || a.name.localeCompare(b.name);

const located = (value: number | null | undefined): value is number => typeof value === 'number';

export const buildPlacesTree = (
  places: AssetResponseDto[],
  counts: Map<string, number>,
  labels: { unknownCountry: string; unknownState: string },
): PlacesTree => {
  const countries = new Map<string, { country: string | null; states: Map<string, PlaceCity[]> }>();

  for (const place of places) {
    const city = place.exifInfo?.city;
    if (!city) {
      continue;
    }
    const country = place.exifInfo?.country ?? null;
    const state = place.exifInfo?.state ?? null;
    const countryKey = country ?? '';
    if (!countries.has(countryKey)) {
      countries.set(countryKey, { country, states: new Map() });
    }
    const states = countries.get(countryKey)!.states;
    const stateKey = state ?? '';
    if (!states.has(stateKey)) {
      states.set(stateKey, []);
    }
    states.get(stateKey)!.push({
      id: `city:${countryKey}:${stateKey}:${city}`,
      name: city,
      // the counts endpoint counts videos too; a city it has not counted still has this photo
      count: Math.max(counts.get(city) ?? 1, 1),
      coverId: place.id,
      latitude: located(place.exifInfo?.latitude) ? place.exifInfo!.latitude! : null,
      longitude: located(place.exifInfo?.longitude) ? place.exifInfo!.longitude! : null,
      query: { city },
    });
  }

  const tree = [...countries.values()].map(({ country, states }): PlaceCountry => {
    const children = [...states]
      .map(([stateKey, cities]): PlaceState => {
        const sorted = [...cities].sort(byCount);
        return {
          id: `state:${country ?? ''}:${stateKey}`,
          name: stateKey || labels.unknownState,
          count: sorted.reduce((sum, city) => sum + city.count, 0),
          cities: sorted,
          query: stateKey ? { state: stateKey, country } : { country, state: null },
        };
      })
      .sort(byCount);
    return {
      id: `country:${country ?? ''}`,
      name: country ?? labels.unknownCountry,
      count: children.reduce((sum, state) => sum + state.count, 0),
      states: children,
      query: { country },
    };
  });

  const countriesSorted = [...tree].sort(byCount);
  return {
    countries: countriesSorted,
    cities: countriesSorted.flatMap((country) => country.states.flatMap((state) => state.cities)).sort(byCount),
    total: countriesSorted.reduce((sum, country) => sum + country.count, 0),
  };
};

/**
 * The search box (`Places.jsx:53-66`): a city stays when its own name, its state's or its country's
 * matches; states and countries with nothing left drop out. Matching ignores case and accents.
 */
export const filterPlacesTree = (tree: PlacesTree, query: string): PlacesTree => {
  const needle = normalize(query.trim());
  if (!needle) {
    return tree;
  }
  const matches = (name: string) => normalize(name).includes(needle);
  const countries = tree.countries
    .map((country) => ({
      ...country,
      states: country.states
        .map((state) => ({
          ...state,
          cities: state.cities.filter((city) => matches(city.name) || matches(state.name) || matches(country.name)),
        }))
        .filter((state) => state.cities.length > 0),
    }))
    .filter((country) => country.states.length > 0);
  return {
    countries,
    cities: tree.cities.filter((city) => matches(city.name)),
    total: tree.total,
  };
};

const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase();

/**
 * The state card's small map (`Places.jsx:141-145`, an offline stylised base): each located city as
 * a dot in the card's own frame, projected equirectangularly over the cities' padded bounds, sized
 * by its count. No tiles are fetched.
 */
export const stateMapDots = (cities: PlaceCity[], width: number, height: number, padding = 24) => {
  const points = cities.filter(
    (city): city is PlaceCity & { latitude: number; longitude: number } =>
      city.latitude !== null && city.longitude !== null,
  );
  if (points.length === 0) {
    return [];
  }
  const lats = points.map((point) => point.latitude);
  const lons = points.map((point) => point.longitude);
  const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
  const [minLon, maxLon] = [Math.min(...lons), Math.max(...lons)];
  const spanLat = Math.max(maxLat - minLat, 0.5);
  const spanLon = Math.max(maxLon - minLon, 0.5);
  const scale = Math.min((width - padding * 2) / spanLon, (height - padding * 2) / spanLat);
  const centreLat = (minLat + maxLat) / 2;
  const centreLon = (minLon + maxLon) / 2;
  const most = Math.max(...points.map((point) => point.count));
  return points.map((point) => ({
    id: point.id,
    x: width / 2 + (point.longitude - centreLon) * scale,
    y: height / 2 - (point.latitude - centreLat) * scale,
    r: 4 + 6 * Math.sqrt(point.count / most),
  }));
};
