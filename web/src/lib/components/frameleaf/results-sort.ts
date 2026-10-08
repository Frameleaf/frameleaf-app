import type { Translations } from 'svelte-i18n';
import type { LibrarySort } from '$lib/frameleaf/library-session';

/**
 * The five sorts a results view can offer, in the order they are listed. Shared by the results
 * toolbar's Sort control and the phone view menu so the two never drift apart.
 */
export const SORT_OPTIONS: readonly { value: LibrarySort; label: Translations }[] = [
  { value: 'captured-desc', label: 'frameleaf_library_sort_captured_newest' },
  { value: 'captured-asc', label: 'frameleaf_library_sort_captured_oldest' },
  { value: 'imported-desc', label: 'frameleaf_library_sort_added_newest' },
  { value: 'filename', label: 'frameleaf_library_sort_filename' },
  { value: 'rating', label: 'frameleaf_library_sort_rating' },
];
