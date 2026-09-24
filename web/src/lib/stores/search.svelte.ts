import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
import type { PaletteSearch } from '$lib/frameleaf/search-palette';

class SearchStore {
  /**
   * FL-49: the search palette's recent searches, with their chips, mode and filters (the prototype's
   * `recentSearches`). Kept in memory only and dropped on every access change: a search typed while the
   * session was unlocked can name a Locked person or tag, and must not be shown once it is locked.
   */
  recentSearches = $state<PaletteSearch[]>([]);
  isSearchEnabled = $state(false);

  constructor() {
    onLibraryAccessChange((change) => {
      if (change === 'revoked') {
        this.clearCache();
      } else if (change !== 'expanded') {
        this.recentSearches = [];
      }
    });
  }

  clearCache() {
    this.recentSearches = [];
    this.isSearchEnabled = false;
  }
}

export const searchStore = new SearchStore();
