import { readFileSync, readdirSync } from 'node:fs';
import { getClosestAvailableLocale, languageChoices, languageCodeFor, langs, SHIPPED_LANGUAGES } from '$lib/utils/i18n';

describe('i18n', () => {
  describe('language choices (FL-708 B4)', () => {
    it('lists only the shipped languages, each in its own name', () => {
      expect(languageChoices().map((entry) => entry.name)).toEqual([
        'English',
        'Français',
        'Español',
        'Deutsch',
        'Italiano',
        'Português',
        'Nederlands',
        'Polski',
        'Svenska',
        'Dansk',
        'Norsk bokmål',
      ]);
      expect(languageChoices().some((entry) => entry.code === 'dev')).toBe(false);
    });

    it('has a file for every shipped language', () => {
      for (const { code } of SHIPPED_LANGUAGES) {
        expect(
          langs.some((entry) => entry.code === code),
          code,
        ).toBe(true);
      }
    });

    it('keeps a language already in use that is not listed, but never the development keys', () => {
      expect(languageChoices('ja').at(-1)).toMatchObject({ code: 'ja' });
      expect(languageChoices('fr')).toHaveLength(SHIPPED_LANGUAGES.length);
      expect(languageChoices('dev')).toHaveLength(SHIPPED_LANGUAGES.length);
    });

    it('matches a regional tag to its language file', () => {
      expect(languageCodeFor('ja-JP')).toBe('ja');
      expect(languageCodeFor('fr')).toBe('fr');
      expect(languageCodeFor('nb-NO')).toBe('nb-NO');
      expect(languageCodeFor('xx-YY')).toBeUndefined();
      expect(languageChoices('ja-JP').at(-1)).toMatchObject({ code: 'ja' });
    });

    it('keeps the saved language selectable while another is chosen but not saved', () => {
      const codes = languageChoices('ja', 'fr').map((entry) => entry.code);
      expect(codes).toContain('ja');
      expect(codes.filter((code) => code === 'fr')).toHaveLength(1);
    });
  });

  describe('loaders', () => {
    const languageFiles = readdirSync('../i18n').sort();
    for (const filename of languageFiles) {
      test(`${filename} should have a loader`, async () => {
        if (!filename.endsWith('.json') || filename === 'package.json') {
          return;
        }

        const code = filename.replaceAll('.json', '');
        const item = langs.find((lang) => lang.code === code);
        expect(item, `${filename} has no loader`).toBeDefined();
        if (!item) {
          return;
        }

        // verify it loads the right file
        const module: { default?: unknown } = await item.loader();
        const translations = JSON.stringify(module.default, null, 2).trim();
        const content = readFileSync(`../i18n/${filename}`).toString().trim();
        expect(translations === content, `${item.name} did not load ${filename}`).toEqual(true);
      });
    }
  });

  describe('getClosestAvailableLocale', () => {
    const allLocales = ['ar', 'bg', 'en', 'en-US', 'en-DE', 'zh-Hans', 'zh-Hans-HK'];

    it('returns undefined on mismatch', () => {
      expect(getClosestAvailableLocale([], allLocales)).toBeUndefined();
      expect(getClosestAvailableLocale(['invalid'], allLocales)).toBeUndefined();
    });

    it('returns the first matching locale', () => {
      expect(getClosestAvailableLocale(['invalid', 'ar', 'bg'], allLocales)).toBe('ar');
      expect(getClosestAvailableLocale(['bg'], allLocales)).toBe('bg');
      expect(getClosestAvailableLocale(['bg', 'invalid', 'ar'], allLocales)).toBe('bg');
    });

    it('returns the locale for a less specific match', () => {
      expect(getClosestAvailableLocale(['ar-AE'], allLocales)).toBe('ar-AE');
      expect(getClosestAvailableLocale(['ar-AE', 'en'], allLocales)).toBe('ar-AE');
      expect(getClosestAvailableLocale(['zh-Hans-HK', 'zh-Hans'], allLocales)).toBe('zh-Hans-HK');
    });

    it('ignores the locale for a more specific match', () => {
      expect(getClosestAvailableLocale(['zh'], allLocales)).toBeUndefined();
      expect(getClosestAvailableLocale(['de', 'zh', 'en-US'], allLocales)).toBe('en-US');
    });

    it('matches underscore-based stored locale codes against normalized locale lists', () => {
      const allLocales = ['de-CH', 'pt-BR', 'sr-Cyrl', 'zh-Hant'];
      expect(getClosestAvailableLocale(['de_CH'], allLocales)).toBe('de_CH');
      expect(getClosestAvailableLocale(['pt_BR'], allLocales)).toBe('pt_BR');
      expect(getClosestAvailableLocale(['sr_Cyrl'], allLocales)).toBe('sr_Cyrl');
      expect(getClosestAvailableLocale(['zh_Hant'], allLocales)).toBe('zh_Hant');
    });

    it('should handle language aliases', () => {
      const allLocales = ['zh-Hans', 'zh-Hant'];
      expect(getClosestAvailableLocale(['zh-CN'], allLocales)).toBe('zh-Hans');
      expect(getClosestAvailableLocale(['zh-HK'], allLocales)).toBe('zh-Hant');
      expect(getClosestAvailableLocale(['zh-MO'], allLocales)).toBe('zh-Hant');
      expect(getClosestAvailableLocale(['zh-SG'], allLocales)).toBe('zh-Hans');
      expect(getClosestAvailableLocale(['zh-TW'], allLocales)).toBe('zh-Hant');
    });

    it('preserves the requested region and extensions while falling back through subtags', () => {
      expect(getClosestAvailableLocale(['sr_Cyrl_RS'], ['sr-Cyrl'])).toBe('sr_Cyrl_RS');
      expect(getClosestAvailableLocale(['en-US-u-ca-gregory'], ['en'])).toBe('en-US-u-ca-gregory');
      expect(getClosestAvailableLocale(['zh-Hant-HK'], ['zh-Hant', 'en'])).toBe('zh-Hant-HK');
      expect(getClosestAvailableLocale(['sr'], ['sr-Cyrl'])).toBeUndefined();
    });

    it('keeps caller arrays unchanged and accepts underscore-based availability codes', () => {
      const requested = Object.freeze(['invalid', 'pt-BR']);
      const available = Object.freeze(['pt_BR', 'en_US']);
      expect(getClosestAvailableLocale(requested, available)).toBe('pt-BR');
      expect(requested).toEqual(['invalid', 'pt-BR']);
      expect(available).toEqual(['pt_BR', 'en_US']);
    });

    it('retains exact alias matching and the existing empty-segment behavior', () => {
      expect(getClosestAvailableLocale(['zh_CN'], ['zh-Hans'])).toBeUndefined();
      expect(getClosestAvailableLocale(['EN-us'], ['en'])).toBeUndefined();
      expect(getClosestAvailableLocale(['en--US'], ['en-'])).toBe('en--US');
      expect(getClosestAvailableLocale([''], [''])).toBe('');
    });
  });
});
