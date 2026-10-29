import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import en from '../../../../../i18n/en.json';
import { LIBRARY_PANEL_STRINGS, fillLibraryString, libraryPanelStrings } from './library-strings';

const messages = en as unknown as Record<string, string>;

/** Format like the host's `$t`: ICU message, values substituted. */
const translate = (key: string, options?: { values?: Record<string, string> }) =>
  String(new IntlMessageFormat(messages[key], 'en').format(options?.values ?? {}));

describe('FL-636 bin Library view strings', () => {
  it('has an English host message for every Library view string, with its run-time values', () => {
    for (const entry of Object.values(LIBRARY_PANEL_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      const values = 'values' in entry ? [...entry.values] : [];
      const used = [...messages[entry.host].matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(new Set(used), entry.host).toEqual(new Set(values));
    }
  });

  it('hands the view the host text by key, with markers the view fills in', () => {
    const strings = libraryPanelStrings(
      (key, options) => `${key}${options?.values ? JSON.stringify(options.values) : ''}`,
    );
    expect(strings.libraryNote).toBe('frameleaf_studio_bin_library_note');
    expect(strings.libraryAddAtPlayhead).toBe('frameleaf_studio_bin_library_add_at_playhead{"name":"{{name}}"}');
    expect(Object.keys(strings)).toEqual(Object.keys(LIBRARY_PANEL_STRINGS));
  });

  it('carries the approved note and fills run-time values', () => {
    const strings = libraryPanelStrings(translate);
    expect(strings.libraryNote).toBe(
      'Searches your whole library, like Search. Locked items appear only while your session is unlocked.',
    );
    expect(fillLibraryString(strings.libraryResultsFor, { results: '3 results', query: 'lake' })).toBe(
      '3 results for “lake”',
    );
    expect(fillLibraryString(strings.libraryAddAtPlayhead, { name: 'lake.mp4' })).toBe('Add lake.mp4 at playhead');
  });
});
