import { readFileSync } from 'node:fs';
import { SHIPPED_LANGUAGES } from '$lib/utils/i18n';
import {
  analyse,
  AREAS,
  BUNDLES,
  bundlesFor,
  flatten,
  languageCodes,
  readLanguage,
} from '../../../scripts/message-areas.mjs';

/**
 * FL-1797: the build splits `i18n/<language>.json` into bundles by the part of the app that uses each
 * key. These checks run the real split over the real source and message files.
 */
describe('messages split by area (FL-1797)', () => {
  const directory = '../i18n';
  const en = readLanguage(directory, 'en');
  const { areaOf, reached, literal } = analyse({ src: 'src', keys: Object.keys(en) });
  const areas = Object.keys(AREAS);

  it('gives every English message to exactly one bundle, and loses none', () => {
    const { merged, bundles } = bundlesFor({ code: 'en', own: en, en, areaOf });
    expect(merged).toBe(false);
    expect(Object.keys(bundles).every((name) => BUNDLES.includes(name))).toBe(true);
    expect(Object.assign({}, ...Object.values(bundles))).toEqual(
      flatten(JSON.parse(readFileSync(`${directory}/en.json`, 'utf8'))),
    );
    expect(Object.values(bundles).reduce((total, bundle) => total + Object.keys(bundle).length, 0)).toBe(
      Object.keys(en).length,
    );
  });

  it('keeps the shell small: well under half the messages are needed at startup', () => {
    const core = Object.values(areaOf).filter((bundle) => bundle === 'core').length;
    expect(core).toBeGreaterThan(1000);
    expect(core).toBeLessThan(Object.keys(en).length / 2);
  });

  // No page shows a raw key: whatever a group of routes can load names only keys that are in the
  // bundles that group is given.
  it('has every key the shell and the pages outside the areas name in core', () => {
    const elsewhere: string[] = [];
    for (const file of reached.core) {
      for (const key of literal.get(file) ?? []) {
        if (areaOf[key] !== 'core') {
          elsewhere.push(`${key} (${file})`);
        }
      }
    }
    expect(elsewhere).toEqual([]);
  });

  it.each(areas)('has every key the %s routes name in core or in their own bundle', (area) => {
    expect(reached[area].size).toBeGreaterThan(0);
    const elsewhere: string[] = [];
    for (const file of reached[area]) {
      for (const key of literal.get(file) ?? []) {
        if (areaOf[key] !== 'core' && areaOf[key] !== area) {
          elsewhere.push(`${key} (${file})`);
        }
      }
    }
    expect(elsewhere).toEqual([]);
  });

  it('keeps a title a route load function names in core, since loads run before an area arrives', () => {
    const settingsLoad = [...reached.settings].find((file) => file.endsWith('routes/(user)/user-settings/+page.ts'));
    expect(settingsLoad).toBeDefined();
    for (const key of literal.get(settingsLoad!) ?? []) {
      expect(areaOf[key], key).toBe('core');
    }
  });

  it('finds keys built with a template literal', () => {
    // SystemSettings.svelte names these as `${titleKey}_description`.
    expect(areaOf.frameleaf_cc_section_signals_description).toBe('settings');
  });

  it('merges English into every shipped language, so its readers fetch one file per area', () => {
    for (const { code } of SHIPPED_LANGUAGES) {
      if (code === 'en') {
        continue;
      }
      const { merged, bundles } = bundlesFor({ code, own: readLanguage(directory, code), en, areaOf });
      expect(merged, code).toBe(true);
      for (const name of BUNDLES) {
        const keys = Object.keys(en).filter((key) => areaOf[key] === name);
        expect(Object.keys(bundles[name] ?? {}).sort(), `${code}/${name}`).toEqual(keys.sort());
      }
    }
  });

  it('keeps a partial translation to its own messages, read beside the English bundle', () => {
    const own = {
      ...Object.fromEntries(
        Object.keys(en)
          .slice(0, 10)
          .map((key) => [key, 'x']),
      ),
      gone_from_english: 'x',
    };
    const { merged, bundles } = bundlesFor({ code: 'xx', own, en, areaOf });
    expect(merged).toBe(false);
    // A key English dropped is dropped everywhere.
    expect(
      Object.values(bundles)
        .flatMap((bundle) => Object.keys(bundle))
        .sort(),
    ).toEqual(Object.keys(en).slice(0, 10).sort());
  });

  it('puts everything in core when no analysis is given (the development server)', () => {
    const { bundles } = bundlesFor({ code: 'en', own: en, en });
    expect(Object.keys(bundles)).toEqual(['core']);
  });

  it('lists every language file', () => {
    expect(languageCodes(directory)).toEqual(expect.arrayContaining(['en', 'de', 'nb_NO', 'zh_Hant']));
  });
});
