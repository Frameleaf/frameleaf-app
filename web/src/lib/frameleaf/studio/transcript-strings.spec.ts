import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import en from '../../../../../i18n/en.json';
import { TRANSCRIPT_ENGINE_STRINGS, transcriptEngineStrings } from './transcript-strings';

const messages = en as unknown as Record<string, string>;

/** Format like the host's `$t`: ICU message, values substituted. */
const translate = (key: string, options?: { values?: Record<string, string> }) =>
  String(new IntlMessageFormat(messages[key], 'en').format(options?.values ?? {}));

describe('FL-562 transcript panel strings', () => {
  it('has an English host message for every transcript panel string, with its run-time values', () => {
    for (const entry of Object.values(TRANSCRIPT_ENGINE_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      const values = 'values' in entry ? [...entry.values] : [];
      const used = [...messages[entry.host].matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(new Set(used), entry.host).toEqual(new Set(values));
    }
  });

  it('hands the engine i18next markers in place of run-time values', () => {
    const strings = transcriptEngineStrings(translate);
    expect(strings.transcriptSelected).toBe('Selected: {{count}} · {{seconds}} s');
    expect(strings.transcriptSpeakerNumber).toBe('Speaker {{number}}');
    expect(strings.transcriptRemoveSilences).toBe('Remove silences');
    expect(Object.keys(strings)).toEqual(Object.keys(TRANSCRIPT_ENGINE_STRINGS));
  });
});
