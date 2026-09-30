import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatUsd } from '$lib/frameleaf/cloud';
import { formatUsd as formatCloudMlUsd } from '$lib/frameleaf/cloud-ml';

/**
 * FL-139: numbers and dates are formatted in the locale the viewer chose (`locale` in
 * preferences.store, "default" for the browser's), never whatever the browser happens to use. A
 * formatter called without a locale, or with `undefined`, takes the browser's instead.
 */
const LOCALELESS = /\.toLocale(?:String|DateString|TimeString)\(\s*\)|Intl\.[A-Za-z]+\(\s*(?:undefined\s*)?[,)]/;
/** A formatter pinned to English, which ignores the chosen locale on purpose or by mistake. */
const PINNED_ENGLISH = /Intl\.[A-Za-z]+\(\s*['"]en|\.toLocale[A-Za-z]*\(\s*['"]en/;

/**
 * The formatters pinned to English on purpose, each with why. Prices are one: the owner decided
 * (FL-146, confirmed for FL-139) that a price reads as US dollars, "$12.99", in every language.
 */
const PINNED_ON_PURPOSE: Record<string, string> = {
  'src/lib/frameleaf/cloud.ts': 'prices: fixed US dollar format in every language (owner decision)',
  'src/lib/frameleaf/cloud-ml.ts': 'prices: fixed US dollar format in every language (owner decision)',
  'src/lib/frameleaf/viewer-date.ts': 'parses the UTC offset out of a time zone name, not shown as is',
  'src/lib/frameleaf/time-zones.ts': 'only checks that a time zone exists',
  'src/lib/frameleaf/search-palette.ts': 'lower-cases text for matching, not display',
};

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

const sources = () =>
  [...files('src/lib'), ...files('src/routes')]
    .filter((path) => /\.(svelte|ts)$/.test(path) && !path.endsWith('.spec.ts'))
    .map((path) => ({ path, lines: readFileSync(path, 'utf8').split('\n') }));

describe('locale-aware formatting (FL-139)', () => {
  it('formats numbers and dates in the chosen locale', () => {
    const offenders: string[] = [];
    for (const { path, lines } of sources()) {
      for (const [index, line] of lines.entries()) {
        // reading the browser's own time zone is not formatting
        if (LOCALELESS.test(line) && !line.includes('.resolvedOptions().timeZone')) {
          offenders.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pins a formatter to English only where that is decided', () => {
    const pinned = new Set<string>();
    for (const { path, lines } of sources()) {
      if (lines.some((line) => PINNED_ENGLISH.test(line))) {
        pinned.add(path);
      }
    }
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...pinned].sort(byName)).toEqual(Object.keys(PINNED_ON_PURPOSE).sort(byName));
  });

  it('shows prices as US dollars in every language', () => {
    expect(formatUsd(12.99)).toBe('$12.99');
    expect(formatCloudMlUsd(12.99)).toBe('$12.99');
  });
});
