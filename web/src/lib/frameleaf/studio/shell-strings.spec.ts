import { describe, expect, it } from 'vitest';
import en from '../../../../../i18n/en.json';
import { SHELL_STRINGS, shellStrings } from './shell-strings';

const messages = en as unknown as Record<string, string>;

describe('editor shell strings (FL-1822)', () => {
  it('has an English host message for every shell string', () => {
    for (const entry of Object.values(SHELL_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
    }
  });

  it('hands the engine the wording of the approved mock', () => {
    const strings = shellStrings((key) => messages[key]);
    expect(strings.shellWorkspaceColor).toBe('Color');
    expect(strings.shellShortcuts).toBe('Keyboard shortcuts…');
    expect(strings.shellSettings).toBe('Editor settings…');
    expect(strings.shellErrorTitle).toBe('Studio could not open this project');
    expect(Object.keys(strings)).toEqual(Object.keys(SHELL_STRINGS));
  });
});
