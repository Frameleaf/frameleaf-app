/**
 * The bin's Library view (FL-636), translated by the host.
 *
 * The view is drawn by the adapter inside the editor frame, which has no translations of its own for
 * Frameleaf strings. The host sends each in `context.strings`. A value the view fills in at run time
 * travels as a `{{name}}` marker, which the host passes through its own formatter as a literal.
 */
export const LIBRARY_PANEL_STRINGS = {
  libraryTab: { host: 'frameleaf_studio_bin_library_tab' },
  librarySearch: { host: 'frameleaf_studio_bin_library_search' },
  librarySuggestions: { host: 'frameleaf_studio_bin_library_suggestions' },
  librarySuggestionBeach: { host: 'frameleaf_studio_bin_library_suggestion_beach' },
  librarySuggestionSunset: { host: 'frameleaf_studio_bin_library_suggestion_sunset' },
  librarySuggestionLaughing: { host: 'frameleaf_studio_bin_library_suggestion_laughing' },
  librarySuggestionCampfire: { host: 'frameleaf_studio_bin_library_suggestion_campfire' },
  libraryShow: { host: 'frameleaf_studio_bin_library_show' },
  libraryAll: { host: 'frameleaf_studio_bin_library_all' },
  libraryPhotos: { host: 'frameleaf_studio_bin_library_photos' },
  libraryVideos: { host: 'frameleaf_studio_bin_library_videos' },
  libraryPeople: { host: 'frameleaf_studio_bin_library_people' },
  libraryPlace: { host: 'frameleaf_studio_bin_library_place' },
  libraryAnywhere: { host: 'frameleaf_studio_bin_library_anywhere' },
  libraryWhen: { host: 'frameleaf_studio_bin_library_when' },
  libraryAnyTime: { host: 'frameleaf_studio_bin_library_any_time' },
  libraryFacetCount: { host: 'frameleaf_studio_bin_library_facet_count', values: ['label', 'count'] },
  libraryClearFilters: { host: 'frameleaf_studio_bin_library_clear_filters' },
  libraryResultOne: { host: 'frameleaf_studio_bin_library_result_one' },
  libraryResults: { host: 'frameleaf_studio_bin_library_results', values: ['count'] },
  libraryResultsFor: { host: 'frameleaf_studio_bin_library_results_for', values: ['results', 'query'] },
  libraryEmpty: { host: 'frameleaf_studio_bin_library_empty' },
  librarySearching: { host: 'frameleaf_studio_bin_library_searching' },
  libraryUnavailable: { host: 'frameleaf_studio_bin_library_unavailable' },
  libraryMore: { host: 'frameleaf_studio_bin_library_more' },
  libraryMedia: { host: 'frameleaf_studio_bin_library_media' },
  libraryAddAtPlayhead: { host: 'frameleaf_studio_bin_library_add_at_playhead', values: ['name'] },
  libraryAdded: { host: 'frameleaf_studio_bin_library_added', values: ['name'] },
  libraryAddFailed: { host: 'frameleaf_studio_bin_library_add_failed' },
  libraryNoTrack: { host: 'frameleaf_studio_bin_library_no_track' },
  libraryNote: { host: 'frameleaf_studio_bin_library_note' },
} as const satisfies Record<string, { host: string; values?: readonly string[] }>;

export type LibraryPanelString = keyof typeof LIBRARY_PANEL_STRINGS;

type LibraryHostKey = (typeof LIBRARY_PANEL_STRINGS)[LibraryPanelString]['host'];
type Translate = (key: LibraryHostKey, options?: { values?: Record<string, string> }) => string;

/** The host's translation of every Library view string, with run-time markers left in place. */
export function libraryPanelStrings(translate: Translate): Record<LibraryPanelString, string> {
  const strings = {} as Record<LibraryPanelString, string>;
  for (const [name, entry] of Object.entries(LIBRARY_PANEL_STRINGS) as Array<
    [LibraryPanelString, { host: LibraryHostKey; values?: readonly string[] }]
  >) {
    const values = Object.fromEntries((entry.values ?? []).map((value) => [value, `{{${value}}}`]));
    strings[name] = entry.values ? translate(entry.host, { values }) : translate(entry.host);
  }
  return strings;
}

/** Fill a string's `{{name}}` markers; the adapter's half of `libraryPanelStrings`. */
export const fillLibraryString = (text: string, values: Readonly<Record<string, string | number>> = {}): string =>
  text.replaceAll(/\{\{(\w+)\}\}/g, (marker, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : marker,
  );
