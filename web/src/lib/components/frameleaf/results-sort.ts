import type { Translations } from 'svelte-i18n';
import type { LibrarySort } from '$lib/frameleaf/library-session';

/**
 * The sorts a results view can offer, in the order they are listed: the prototype's five, and Best
 * Photos' own ranking first, which is listed only where it is offered (LIB-P3).
 */
export const SORT_OPTIONS: readonly { value: LibrarySort; label: Translations }[] = [
  { value: 'quality', label: 'frameleaf_library_sort_best' },
  { value: 'captured-desc', label: 'frameleaf_library_sort_captured_newest' },
  { value: 'captured-asc', label: 'frameleaf_library_sort_captured_oldest' },
  { value: 'imported-desc', label: 'frameleaf_library_sort_added_newest' },
  { value: 'filename', label: 'frameleaf_library_sort_filename' },
  { value: 'rating', label: 'frameleaf_library_sort_rating' },
];
