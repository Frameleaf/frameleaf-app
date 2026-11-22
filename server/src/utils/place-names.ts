import isoCountries from 'i18n-iso-countries';

/**
 * FL-987: place names in the viewer's language. The stored English `city`, `state` and `country` never
 * change; these helpers decide which GeoNames places stand behind them and which translated names to show.
 */

/** The languages the place-name pack carries, by the code its lines use. */
export const PLACE_NAME_LANGUAGES = ['fr', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'sv', 'da', 'nb'] as const;
export type PlaceNameLanguage = (typeof PLACE_NAME_LANGUAGES)[number];

/**
 * The pack language for an account locale (`de`, `pt-PT`, `nb-NO`), or undefined when place names stay in
 * English: English itself, and any language the pack does not carry. Norwegian is `nb` in the pack whether
 * the locale says `nb` or `no`.
 */
export const placeNameLanguageOf = (locale: string | undefined): PlaceNameLanguage | undefined => {
  const primary = (locale ?? '').toLowerCase().split(/[-_]/)[0];
  const language = primary === 'no' ? 'nb' : primary;
  return PLACE_NAME_LANGUAGES.find((known) => known === language);
};

export interface EnglishPlaceNames {
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

/** The nearest GeoNames city to an item, as `geodata_places` has it. */
export interface NearestPlace {
  id: number;
  name: string;
  admin1Name: string | null;
  admin1Code: string | null;
  countryCode: string;
}

export interface GeonameLink {
  cityGeonameId: number | null;
  admin1GeonameId: number | null;
  countryCode: string | null;
}

/** A country's English name as reverse geocoding stores it, from its ISO 3166-1 code. */
export const englishCountryName = (code: string | null | undefined): string | null =>
  // eslint-disable-next-line import-x/no-named-as-default-member
  (code && isoCountries.getName(code, 'en')) || null;

/**
 * The places behind an item's stored English names. A place is linked only when its English name is the
 * very name the item stores, so a name somebody typed, an import brought, or older place data wrote is
 * never shown as the translation of a different place. The country is read from the stored name itself,
 * which also covers items far from any city.
 */
export const linkGeonames = (
  stored: EnglishPlaceNames,
  nearest: NearestPlace | null | undefined,
  admin1Ids: Map<string, number>,
): GeonameLink => {
  // eslint-disable-next-line import-x/no-named-as-default-member
  const countryCode = (stored.country && isoCountries.getAlpha2Code(stored.country, 'en')) || null;
  if (!nearest || !stored.city || nearest.name !== stored.city) {
    return { cityGeonameId: null, admin1GeonameId: null, countryCode };
  }
  // a region is checked through its city's row when names are read, so it is linked only beside its city
  const stateMatches = !!stored.state && nearest.admin1Name === stored.state;
  return {
    cityGeonameId: nearest.id,
    admin1GeonameId: (stateMatches && admin1Ids.get(`${nearest.countryCode}.${nearest.admin1Code}`)) || null,
    countryCode,
  };
};

/** What the linked places are called in English today, to check a link still fits the stored names. */
export interface LinkedPlace extends GeonameLink {
  cityName: string | null;
  admin1Name: string | null;
}

export interface PlaceNamesLocalized {
  city: string | null;
  state: string | null;
  country: string | null;
  lang: string;
}

/**
 * The names to show for stored English names in `lang`: each translated where the pack has a translation
 * for the linked place, and the stored English name otherwise. Null when nothing is translated, so a
 * caller can tell "show the English" from a translation. A link that no longer fits a stored name (the
 * location was edited since) is ignored for that name.
 */
export const localizePlaceNames = (
  lang: PlaceNameLanguage,
  stored: EnglishPlaceNames,
  linked: LinkedPlace | undefined,
  names: Map<number, string>,
  countryIds: Map<string, number>,
): PlaceNamesLocalized | null => {
  if (!linked) {
    return null;
  }
  const translated = (id: number | null | undefined, fits: boolean) => (id && fits && names.get(id)) || null;
  const city = translated(linked.cityGeonameId, !!stored.city && linked.cityName === stored.city);
  const state = translated(linked.admin1GeonameId, !!stored.state && linked.admin1Name === stored.state);
  const country = translated(
    linked.countryCode ? countryIds.get(linked.countryCode) : null,
    !!stored.country && englishCountryName(linked.countryCode) === stored.country,
  );
  if (!city && !state && !country) {
    return null;
  }
  return {
    city: city ?? stored.city ?? null,
    state: state ?? stored.state ?? null,
    country: country ?? stored.country ?? null,
    lang,
  };
};

/** One line of the place-name pack (`geonameId`, language, name; tab-separated), or undefined when it is malformed. */
export const parsePlaceNameLine = (
  line: string,
): { geonameId: number; lang: PlaceNameLanguage; name: string } | undefined => {
  const [id, language, name, ...rest] = line.split('\t');
  const lang = PLACE_NAME_LANGUAGES.find((known) => known === language);
  if (rest.length > 0 || !/^[1-9]\d{0,9}$/.test(id) || !lang || !name || name.length > 200) {
    return;
  }
  const geonameId = Number(id);
  return geonameId <= 2_147_483_647 ? { geonameId, lang, name } : undefined;
};
