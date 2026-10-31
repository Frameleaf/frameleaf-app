import { locale, t, waitLocale } from 'svelte-i18n';
import { get, type Unsubscriber } from 'svelte/store';
import type { Lang } from '$lib/constants';

export const getFormatter = async () => {
  let unsubscribe: Unsubscriber | undefined;
  await new Promise((resolve) => {
    unsubscribe = locale.subscribe((value) => value && resolve(value));
  });
  unsubscribe?.();

  await waitLocale();
  return get(t);
};

const aliases: Record<string, string> = {
  'zh-CN': 'zh-Hans',
  'zh-HK': 'zh-Hant',
  'zh-MO': 'zh-Hant',
  'zh-SG': 'zh-Hans',
  'zh-TW': 'zh-Hant',
};

const modules = import.meta.glob('$i18n/*.json');

const fileCodes = Object.keys(modules)
  .map((path) => path.match(/\/(\w+)\.json$/)?.[1])
  .filter(Boolean) as string[];

export const convertBCP47 = (code: string) => code.replaceAll('_', '-');

export const langCodes = fileCodes.map((code) => convertBCP47(code));

export const getClosestAvailableLocale = (locales: readonly string[], allLocales: readonly string[]) => {
  const allLocalesSet = new Set(allLocales.map((locale) => convertBCP47(locale)));
  const requestedLocales = locales.map((locale) => aliases[locale] ?? locale);
  for (const locale of requestedLocales) {
    let candidate = convertBCP47(locale);
    for (;;) {
      if (allLocalesSet.has(candidate)) {
        return locale;
      }
      const separator = candidate.lastIndexOf('-');
      if (separator === -1) {
        break;
      }
      candidate = candidate.slice(0, separator);
    }
  }
};

export const getPreferredLocale = () => getClosestAvailableLocale(navigator.languages, langCodes);

const rtlCodes = new Set([
  'ae',
  'aeb',
  'aii',
  'ajp',
  'apc',
  'apd',
  'ar',
  'ar_BH',
  'ar_DZ',
  'ar_EG',
  'ar_KW',
  'ar_LY',
  'ar_MA',
  'ar_SA',
  'ar_YE',
  'ara',
  'arc',
  'arq',
  'ars',
  'arz',
  'ave',
  'bal',
  'bcc',
  'bgn',
  'bqi',
  'ckb',
  'ckb_IR',
  'dv',
  'egy',
  'fa',
  'fa_AF',
  'fas',
  'glk',
  'ha',
  'he',
  'heb',
  'khw',
  'kmr',
  'ks',
  'ku',
  'lrc',
  'luz',
  'ms_Arab',
  'mzn',
  'nqo',
  'pa_PK',
  'pal',
  'per',
  'phn',
  'pnb',
  'prs',
  'ps',
  'rhg',
  'sam',
  'sd',
  'sdh',
  'skr',
  'syc',
  'syr',
  'ug',
  'ur',
  'ur_IN',
  'urd',
  'yi',
]);

const capitalize = (string: string) =>
  string
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

const nonIntlNames: Record<string, string> = {
  bi: 'Bislama',
  kxm: 'Khmer Surin',
  mfa: 'Malay (Pattani)',
  swg: 'Schwäbisch',
  tl: 'Tagalog',
};

const getLanguageName = (code: string) =>
  nonIntlNames[code] ?? capitalize(new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code);

export const langs: Lang[] = [
  ...fileCodes
    .map((code) => ({
      name: getLanguageName(convertBCP47(code)),
      code,
      loader: () => import(`$i18n/${code}.json`),
      rtl: rtlCodes.has(code),
    }))
    .sort((a, b) => a.code.localeCompare(b.code)),
  { name: 'Development (keys only)', code: 'dev', loader: () => Promise.resolve({ default: {} }) },
];

/**
 * FL-708 (UI review B4): the languages Frameleaf ships, each in its own name, for the pickers people
 * choose from (setup, the account tool and Settings › Preferences). Every file in `i18n/` still loads
 * (`langs`), so an account already using another language keeps it.
 */
export const SHIPPED_LANGUAGES: readonly { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'de', name: 'Deutsch' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt', name: 'Português' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'sv', name: 'Svenska' },
  { code: 'da', name: 'Dansk' },
  { code: 'nb_NO', name: 'Norsk bokmål' },
];

/**
 * The language file (as a BCP 47 code) for a saved or browser language: the exact file, else the file
 * for its base language, so a regional tag (`ja-JP`) selects `ja`. Undefined when there is none.
 */
export const languageCodeFor = (locale?: string) => {
  if (!locale) {
    return;
  }
  let candidate = convertBCP47(aliases[locale] ?? locale);
  for (;;) {
    if (langCodes.includes(candidate)) {
      return candidate;
    }
    const separator = candidate.lastIndexOf('-');
    if (separator === -1) {
      return;
    }
    candidate = candidate.slice(0, separator);
  }
};

/**
 * The language picker's choices: the shipped languages, plus each of `current` (BCP 47 codes, such as
 * the saved language and a draft choice) that Frameleaf has a file for but doesn't list, so the picker
 * never shows a blank choice and the saved language stays selectable until a new one is saved.
 */
export const languageChoices = (...current: (string | undefined)[]) => {
  const choices = SHIPPED_LANGUAGES.map((entry) => ({ code: entry.code, name: entry.name }));
  for (const locale of current) {
    const code = languageCodeFor(locale);
    const known = code ? langs.find((entry) => convertBCP47(entry.code) === code) : undefined;
    if (known && known.code !== 'dev' && choices.every((entry) => entry.code !== known.code)) {
      choices.push({ code: known.code, name: known.name });
    }
  }
  return choices;
};
