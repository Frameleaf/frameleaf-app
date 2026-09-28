import { getMyPreferences, updateMyPreferences, type SavedSearch } from '@immich/sdk';
import type { DiscoveryQuery } from '$lib/components/discovery/query';
import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
import { removeSavedSearch, toSavedSearch, upsertSavedSearch } from '$lib/frameleaf/search-palette';

/**
 * FL-49 (S-14): the account's saved searches, shared by the search palette and the rail's saved-search
 * list (`RailSavedSearches.svelte`). They live in the `savedSearches` preference, which the server trims
 * while the session is locked (a search naming a Locked person, pet or tag is withheld), so the list is
 * always read from the server and dropped on every access change instead of being kept across one.
 */
class SavedSearchesStore {
  list = $state.raw<SavedSearch[]>([]);
  loaded = $state(false);
  #revision: string | undefined;
  #loading: Promise<void> | undefined;
  #generation = 0;

  constructor() {
    onLibraryAccessChange(() => {
      const wasLoaded = this.loaded;
      this.#generation += 1;
      this.list = [];
      this.loaded = false;
      this.#revision = undefined;
      this.#loading = undefined;
      if (wasLoaded) {
        void this.load();
      }
    });
  }

  /** Reads the list from the server (once per access state unless `force`). */
  load(force = false): Promise<void> {
    if (this.#loading && !force) {
      return this.#loading;
    }
    const generation = this.#generation;
    this.#loading = getMyPreferences()
      .then((preferences) => {
        if (generation !== this.#generation) {
          return;
        }
        this.list = preferences.savedSearches ?? [];
        this.#revision = preferences.revision;
        this.loaded = true;
      })
      .catch(() => {
        // Saved searches are optional; the palette and the rail work without them
        if (generation === this.#generation) {
          this.#loading = undefined;
        }
      });
    return this.#loading;
  }

  async #write(list: SavedSearch[]): Promise<boolean> {
    const generation = this.#generation;
    try {
      const response = await updateMyPreferences({
        userPreferencesUpdateDto: { savedSearches: list, expectedRevision: this.#revision },
      });
      if (generation === this.#generation) {
        this.list = response.savedSearches ?? list;
        this.#revision = response.revision;
        this.loaded = true;
      }
      return true;
    } catch {
      // Changed elsewhere (a stale revision) or refused: show what the server has now
      await this.load(true);
      return false;
    }
  }

  /** Saves (or replaces, by name) a compiled search. */
  save(name: string, query: DiscoveryQuery) {
    return this.#write(upsertSavedSearch(this.list, toSavedSearch(name, query)));
  }

  remove(name: string) {
    return this.#write(removeSavedSearch(this.list, name));
  }
}

export const savedSearchesStore = new SavedSearchesStore();
