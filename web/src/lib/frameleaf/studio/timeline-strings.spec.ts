import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import en from '../../../../../i18n/en.json';
import { TIMELINE_STRINGS, timelineStrings } from './timeline-strings';

const messages = en as unknown as Record<string, string>;

const translate = (key: string, options?: { values?: Record<string, string> }) =>
  String(new IntlMessageFormat(messages[key], 'en').format(options?.values ?? {}));

describe('timeline toolbar strings (FL-1822)', () => {
  it('has an English host message for every toolbar string, with its run-time values', () => {
    for (const entry of Object.values(TIMELINE_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      const values = 'values' in entry ? [...entry.values] : [];
      const used = [...messages[entry.host].matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(new Set(used), entry.host).toEqual(new Set(values));
    }
  });

  it('hands the engine the wording of the approved mock, with i18next markers for run-time values', () => {
    const strings = timelineStrings(translate);
    expect(strings.timelineToolSlide).toBe('Slide');
    expect(strings.timelineToolSlideNote).toBe('Move a clip between its neighbours');
    expect(strings.timelineToolAria).toBe('Tool: {{tool}}');
    expect(strings.timelineScrubSound).toBe('Sound while scrubbing');
    expect(strings.timelineSetInTooltip).toBe(strings.timelineSetIn);
    expect(Object.keys(strings)).toEqual(Object.keys(TIMELINE_STRINGS));
  });
});
