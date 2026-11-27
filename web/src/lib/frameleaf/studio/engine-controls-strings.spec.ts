import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import en from '../../../../../i18n/en.json';
import { ENGINE_CONTROLS_STRINGS, engineControlsStrings } from './engine-controls-strings';

const messages = en as unknown as Record<string, string>;

/** Format like the host's `$t`: ICU message, values substituted. */
const translate = (key: string, options?: { values?: Record<string, string> }) =>
  String(new IntlMessageFormat(messages[key], 'en').format(options?.values ?? {}));

describe('engine control strings (FL-1562, FL-1555, FL-1561, FL-1563, FL-1559)', () => {
  it('has an English host message for every control string, with its run-time values', () => {
    for (const entry of Object.values(ENGINE_CONTROLS_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      const values = 'values' in entry ? [...entry.values] : [];
      const used = [...messages[entry.host].matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(new Set(used), entry.host).toEqual(new Set(values));
    }
  });

  it('hands the engine i18next markers in place of run-time values, worded as the approved mock', () => {
    const strings = engineControlsStrings(translate);
    expect(strings.controlsFontsYours).toBe('Your fonts');
    expect(strings.controlsFontsAdd).toBe('Add font…');
    expect(strings.controlsFontsWeightCount).toBe('Weights: {{number}}');
    expect(strings.controlsTransitionCurvePower).toBe('Constant power');
    expect(strings.controlsTransitionSoundPair).toContain('Between {{before}} and {{after}}.');
    expect(strings.controlsChannelsMonoLeft).toBe('Mono from left');
    expect(strings.controlsMarkersTimeIn).toBe('{{time}} in');
    expect(strings.controlsGradeHuePoint).toBe('Point at hue {{degrees}}°');
    expect(Object.keys(strings)).toEqual(Object.keys(ENGINE_CONTROLS_STRINGS));
  });
});
