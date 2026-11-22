import type { Translations } from 'svelte-i18n';

/**
 * FL-880: the regions whose Mother's Day and Father's Day dates a person can use, in the order the
 * setting lists them. The dates themselves are worked out on the server (`server/src/utils/occasions.ts`);
 * `regionFromLocale` mirrors it so the setting shows the region the server is using while on `auto`.
 */
export const OCCASION_REGIONS = ['us-ca', 'uk-ie', 'au-nz', 'de', 'fr', 'es-pt', 'mx', 'se'] as const;
export type OccasionRegion = (typeof OCCASION_REGIONS)[number];

const COUNTRY_REGIONS: Record<string, OccasionRegion> = {
  US: 'us-ca',
  CA: 'us-ca',
  GB: 'uk-ie',
  UK: 'uk-ie',
  IE: 'uk-ie',
  AU: 'au-nz',
  NZ: 'au-nz',
  DE: 'de',
  FR: 'fr',
  ES: 'es-pt',
  PT: 'es-pt',
  MX: 'mx',
  SE: 'se',
};

const LANGUAGE_REGIONS: Record<string, OccasionRegion> = { de: 'de', fr: 'fr', es: 'es-pt', pt: 'es-pt', sv: 'se' };

export const regionFromLocale = (locale?: string | null): OccasionRegion => {
  const [language = '', ...rest] = (locale ?? '').replaceAll('_', '-').split('-');
  const country = rest.find((part) => /^[a-z]{2}$/i.test(part))?.toUpperCase();
  if (country) {
    return COUNTRY_REGIONS[country] ?? 'us-ca';
  }
  return LANGUAGE_REGIONS[language.toLowerCase()] ?? 'us-ca';
};

/** The region a saved setting means: the person's choice, or their locale's region while on `auto`. */
export const resolveOccasionRegion = (setting: string | undefined, locale?: string | null): OccasionRegion =>
  (OCCASION_REGIONS as readonly string[]).includes(setting ?? '')
    ? (setting as OccasionRegion)
    : regionFromLocale(locale);

const keyPart = (region: OccasionRegion) => region.replace('-', '_');

/** "Canada and United States — second Sunday of May" */
export const occasionRegionLabel = (region: OccasionRegion) =>
  `frameleaf_prefs_tools_occasion_region_${keyPart(region)}` as Translations;

/** "Mother's Day: second Sunday of May. Father's Day: third Sunday of June." */
export const occasionRegionHelp = (region: OccasionRegion) =>
  `frameleaf_prefs_tools_occasion_days_${keyPart(region)}` as Translations;
