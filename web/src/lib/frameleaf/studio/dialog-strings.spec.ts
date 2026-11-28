import { describe, expect, it } from 'vitest';
import en from '../../../../../i18n/en.json';
import { DIALOG_STRINGS, dialogStrings } from './dialog-strings';

const messages = en as unknown as Record<string, string>;

describe('editor dialog strings (FL-1822)', () => {
  it('has an English host message for every dialog string, with no run-time values', () => {
    for (const entry of Object.values(DIALOG_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      expect(messages[entry.host], entry.host).not.toMatch(/\{\w+\}/);
    }
  });

  it('hands the engine sentence-case wording', () => {
    const strings = dialogStrings((key) => messages[key]);
    expect(strings.dialogShortcutsTitle).toBe('Keyboard shortcuts');
    expect(strings.dialogSettingsTitle).toBe('Editor settings');
    expect(Object.keys(strings)).toEqual(Object.keys(DIALOG_STRINGS));
  });
});
