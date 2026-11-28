import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import en from '../../../../../i18n/en.json';
import { DIALOG_STRINGS, dialogStrings } from './dialog-strings';

const messages = en as unknown as Record<string, string>;

describe('editor dialog strings (FL-1822)', () => {
  it('has an English host message for every dialog string, with its run-time values', () => {
    for (const entry of Object.values(DIALOG_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      const values = 'values' in entry ? [...entry.values] : [];
      const used = [...messages[entry.host].matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(new Set(used), entry.host).toEqual(new Set(values));
    }
  });

  it('hands the engine sentence-case wording', () => {
    const strings = dialogStrings((key, options) =>
      String(new IntlMessageFormat(messages[key], 'en').format(options?.values ?? {})),
    );
    expect(strings.dialogShortcutsTitle).toBe('Keyboard shortcuts');
    expect(strings.dialogSettingsTitle).toBe('Editor settings');
    expect(strings.dialogSettingsSecondsOther).toBe('{{seconds}} seconds');
    expect(strings.dialogShortcutsChangedCountOther).toBe('{{count}} changed');
    expect(strings.dialogShortcutsChangedFilter).toBe(strings.dialogShortcutsChanged);
    expect(Object.keys(strings)).toEqual(Object.keys(DIALOG_STRINGS));
  });
});
