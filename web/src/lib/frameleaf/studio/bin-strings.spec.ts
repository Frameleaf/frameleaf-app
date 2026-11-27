import { describe, expect, it } from 'vitest';
import en from '../../../../../i18n/en.json';
import { BIN_STRINGS, binStrings } from './bin-strings';

const messages = en as unknown as Record<string, string>;

describe('media bin strings (FL-1822)', () => {
  it('has an English host message for every bin string, with no run-time values', () => {
    for (const entry of Object.values(BIN_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      expect(messages[entry.host], entry.host).not.toMatch(/\{\w+\}/);
    }
  });

  it('hands the engine the wording of the approved Studio', () => {
    const strings = binStrings((key) => messages[key]);
    expect(strings.binAdd).toBe('Add files');
    expect(strings.binProject).toBe('Project');
    expect(strings.binGroupSound).toBe(strings.binSound);
    expect(Object.keys(strings)).toEqual(Object.keys(BIN_STRINGS));
  });
});
