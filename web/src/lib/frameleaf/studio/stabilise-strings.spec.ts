import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import en from '../../../../../i18n/en.json';
import { STABILISE_ENGINE_STRINGS, stabiliseEngineStrings } from './stabilise-strings';

const messages = en as unknown as Record<string, string>;

/** Format like the host's `$t`: ICU message, values substituted. */
const translate = (key: string, options?: { values?: Record<string, string> }) =>
  String(new IntlMessageFormat(messages[key], 'en').format(options?.values ?? {}));

describe('FL-638 Stabilise card strings', () => {
  it('has an English host message for every card string, with its run-time values', () => {
    for (const entry of Object.values(STABILISE_ENGINE_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      const values = 'values' in entry ? [...entry.values] : [];
      const used = [...messages[entry.host].matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(new Set(used), entry.host).toEqual(new Set(values));
    }
  });

  it('hands the engine i18next markers in place of run-time values, worded as the approved mock', () => {
    const strings = stabiliseEngineStrings(translate);
    expect(strings.stabiliseStart).toBe('Stabilise clip');
    expect(strings.stabiliseAnalysing).toBe('Analysing camera movement…');
    expect(strings.stabiliseDone).toBe('{{level}} · crops in {{crop}}%');
    expect(strings.stabiliseLevelLocked).toBe('Locked off');
    expect(strings.stabiliseTurnOff).toBe('Turn off');
    expect(Object.keys(strings)).toEqual(Object.keys(STABILISE_ENGINE_STRINGS));
  });
});
