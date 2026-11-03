import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import en from '../../../../../i18n/en.json';
import { VOICE_CLEANUP_ENGINE_STRINGS, voiceCleanupEngineStrings } from './voice-cleanup-strings';

const messages = en as unknown as Record<string, string>;

/** Format like the host's `$t`: ICU message, values substituted. */
const translate = (key: string, options?: { values?: Record<string, string> }) =>
  String(new IntlMessageFormat(messages[key], 'en').format(options?.values ?? {}));

describe('FL-637 Clean up voice card strings', () => {
  it('has an English host message for every card string, with its run-time values', () => {
    for (const entry of Object.values(VOICE_CLEANUP_ENGINE_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      const values = 'values' in entry ? [...entry.values] : [];
      const used = [...messages[entry.host].matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(new Set(used), entry.host).toEqual(new Set(values));
      expect(entry.engine.startsWith('editor.audioSection.voiceCleanup.'), entry.engine).toBe(true);
    }
  });

  it('uses the approved mock wording', () => {
    const strings = voiceCleanupEngineStrings(translate);
    expect(strings.voiceCleanupTitle).toBe('Clean up voice');
    expect(strings.voiceCleanupFound).toBe('Found in this clip');
    expect([
      strings.voiceCleanupNoiseWind,
      strings.voiceCleanupNoiseHum,
      strings.voiceCleanupNoiseBackground,
      strings.voiceCleanupNoiseEcho,
    ]).toEqual(['Wind', 'Hum and buzz', 'Background noise', 'Room echo']);
    expect([
      strings.voiceCleanupStrengthLight,
      strings.voiceCleanupStrengthStandard,
      strings.voiceCleanupStrengthStrong,
    ]).toEqual(['Light', 'Standard', 'Strong']);
    expect(strings.voiceCleanupUseOriginal).toBe('Use the original sound');
    expect(strings.voiceCleanupAgain).toBe('Clean up again');
  });

  it('hands the engine i18next markers in place of run-time values', () => {
    const strings = voiceCleanupEngineStrings(translate);
    expect(strings.voiceCleanupDone).toBe('Cleaned · {{strength}}');
    expect(strings.voiceCleanupProgress).toBe('Cleaning up the voice… {{percent}}%');
    expect(strings.voiceCleanupCleaned).toBe('Voice cleaned up on {{name}}. The original sound is kept.');
    expect(Object.keys(strings)).toEqual(Object.keys(VOICE_CLEANUP_ENGINE_STRINGS));
  });
});
