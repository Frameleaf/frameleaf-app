/**
 * FL-1805: the one place the web app turns a count or an amount of money into text, beside
 * `date-format.ts` for dates. Screens used to declare their own `count`/`number`/`money` helper each.
 * Both follow the "Dates and numbers" region from Look & playback unless given a locale.
 */
import { get } from 'svelte/store';
import { locale as numberLocale } from '$lib/stores/preferences.store';

/** `undefined` follows the browser, which is also what the store's own "default" means. */
const resolve = (locale: string | null | undefined) => {
  const value = locale === undefined ? get(numberLocale) : locale;
  return value && value !== 'default' ? value : undefined;
};

/**
 * A count with the region's grouping ("12,345"). Pass `$locale` from a component so the text follows
 * a change of region at once; `options` are `Intl.NumberFormat`'s (`maximumFractionDigits`, ...).
 */
export const formatCount = (value: number, locale?: string | null, options?: Intl.NumberFormatOptions): string =>
  new Intl.NumberFormat(resolve(locale), options).format(value);

/** An amount held in minor units (cents) as money in its currency ("$12.50"). */
export const formatMoney = (
  minorUnits: number,
  currency: string,
  locale?: string | null,
  options?: Intl.NumberFormatOptions,
): string =>
  new Intl.NumberFormat(resolve(locale), { style: 'currency', currency, ...options }).format(minorUnits / 100);
