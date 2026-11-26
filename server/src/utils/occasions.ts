import { DateTime } from 'luxon';

/**
 * FL-880: the days Mother's Day and Father's Day fall on, by region. The regions are the ones the
 * approved settings list offers; each one covers the countries that keep the same two days.
 */
export const OCCASION_REGIONS = ['us-ca', 'uk-ie', 'au-nz', 'de', 'fr', 'es-pt', 'mx', 'se'] as const;
export type OccasionRegion = (typeof OCCASION_REGIONS)[number];

/** The stored choice: a region, or `auto` to follow the person's language and country. */
export const OCCASION_REGION_SETTINGS = ['auto', ...OCCASION_REGIONS] as const;
export type OccasionRegionSetting = (typeof OCCASION_REGION_SETTINGS)[number];

export type OccasionDay = 'mothers_day' | 'fathers_day';

/**
 * What `memory.occasion` holds and the API returns as `occasion.kind`, a plain string so a new kind never
 * breaks a client. `mothers_day` is a memory of the owner's mother; `mothers_day_child` is the owner's own
 * Mother's Day, with one of their children. The same for Father's Day.
 */
export type OccasionKind = OccasionDay | `${OccasionDay}_child`;

const SUNDAY = 7;

const utcDay = (year: number, month: number, day: number) => DateTime.utc(year, month, day);

/** The nth Sunday of a month, counting from 1. */
const nthSunday = (year: number, month: number, nth: number) => {
  const first = utcDay(year, month, 1);
  return first.plus({ days: ((SUNDAY - first.weekday) % 7) + (nth - 1) * 7 });
};

const lastSunday = (year: number, month: number) => {
  const last = utcDay(year, month, 1).endOf('month').startOf('day');
  return last.minus({ days: last.weekday % SUNDAY });
};

/** Western Easter Sunday in the Gregorian calendar (the anonymous Gregorian computus). */
export const easterSunday = (year: number) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDay(year, month, day);
};

/** French law: the last Sunday of May, or the first Sunday of June when that Sunday is Pentecost. */
const frenchMothersDay = (year: number) => {
  const sunday = lastSunday(year, 5);
  return sunday.equals(easterSunday(year).plus({ days: 49 })) ? nthSunday(year, 6, 1) : sunday;
};

const CALENDAR: Record<OccasionRegion, Record<OccasionDay, (year: number) => DateTime>> = {
  'us-ca': { mothers_day: (year) => nthSunday(year, 5, 2), fathers_day: (year) => nthSunday(year, 6, 3) },
  // Mothering Sunday is the fourth Sunday of Lent, three weeks before Easter Sunday
  'uk-ie': {
    mothers_day: (year) => easterSunday(year).minus({ days: 21 }),
    fathers_day: (year) => nthSunday(year, 6, 3),
  },
  'au-nz': { mothers_day: (year) => nthSunday(year, 5, 2), fathers_day: (year) => nthSunday(year, 9, 1) },
  // Father's Day in Germany is Ascension Day, the Thursday 39 days after Easter Sunday
  de: { mothers_day: (year) => nthSunday(year, 5, 2), fathers_day: (year) => easterSunday(year).plus({ days: 39 }) },
  fr: { mothers_day: frenchMothersDay, fathers_day: (year) => nthSunday(year, 6, 3) },
  'es-pt': { mothers_day: (year) => nthSunday(year, 5, 1), fathers_day: (year) => utcDay(year, 3, 19) },
  mx: { mothers_day: (year) => utcDay(year, 5, 10), fathers_day: (year) => nthSunday(year, 6, 3) },
  se: { mothers_day: (year) => lastSunday(year, 5), fathers_day: (year) => nthSunday(year, 11, 2) },
};

/** The day, 'yyyy-MM-dd', an occasion falls on in a region and year. */
export const occasionDate = (region: OccasionRegion, occasion: OccasionDay, year: number): string =>
  CALENDAR[region][occasion](year).toFormat('yyyy-MM-dd');

/** Which occasion, if any, a calendar day ('yyyy-MM-dd') is in a region. */
export const occasionOn = (region: OccasionRegion, date: string): OccasionDay | undefined => {
  const year = Number(date.slice(0, 4));
  return (['mothers_day', 'fathers_day'] as const).find((occasion) => occasionDate(region, occasion, year) === date);
};

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

/**
 * The region a locale points to: its country when it names a listed one, otherwise its language.
 * A country outside the list (pt-BR, de-CH) and anything unknown use the first region in the list.
 */
export const regionFromLocale = (locale?: string | null): OccasionRegion => {
  const [language = '', ...rest] = (locale ?? '').replaceAll('_', '-').split('-');
  const country = rest.find((part) => /^[a-z]{2}$/i.test(part))?.toUpperCase();
  if (country) {
    return COUNTRY_REGIONS[country] ?? 'us-ca';
  }
  return LANGUAGE_REGIONS[language.toLowerCase()] ?? 'us-ca';
};

/** The region a stored setting means: the person's choice, or their locale's region while on `auto`. */
export const resolveOccasionRegion = (setting: string | undefined, locale?: string | null): OccasionRegion =>
  (OCCASION_REGIONS as readonly string[]).includes(setting ?? '')
    ? (setting as OccasionRegion)
    : regionFromLocale(locale);
