import { getMyPreferences, updateMyPreferences, type SavedSearch } from '@frameleaf/sdk';
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
  #queue: Promise<void> = Promise.resolve();
  #generation = 0;
  #needsRead = true;

  constructor() {
    onLibraryAccessChange((change) => {
      const wasLoaded = this.loaded;
      this.#generation += 1;
      this.list = [];
      this.loaded = false;
      this.#revision = undefined;
      this.#needsRead = true;
      this.#loading = undefined;
      this.#queue = Promise.resolve();
      if (wasLoaded && change !== 'revoked') {
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
    const pending = this.#queue.then(async () => {
      if (!(await this.#read(generation)) && generation === this.#generation && this.#loading === pending) {
        this.#loading = undefined;
      }
    });
    this.#loading = pending;
    this.#queue = pending;
    return pending;
  }

  async #read(generation: number): Promise<boolean> {
    if (generation !== this.#generation) {
      return false;
    }
    try {
      const preferences = await getMyPreferences();
      if (generation !== this.#generation) {
        return false;
      }
      this.list = preferences.savedSearches ?? [];
      this.#revision = preferences.revision;
      this.loaded = true;
      this.#needsRead = false;
      return true;
    } catch {
      if (generation === this.#generation) {
        this.#needsRead = true;
      }
      // Saved searches are optional; the palette and the rail work without them.
      return false;
    }
  }

  #write(change: (list: SavedSearch[]) => SavedSearch[]): Promise<boolean> {
    const generation = this.#generation;
    const loading = this.#loading;
    const pending = this.#queue.then(async () => {
      if (generation !== this.#generation || (this.#needsRead && !(await this.#read(generation)))) {
        return false;
      }
      if (generation !== this.#generation) {
        return false;
      }
      try {
        const list = change(this.list);
        const response = await updateMyPreferences({
          userPreferencesUpdateDto: { savedSearches: list, expectedRevision: this.#revision },
        });
        if (generation !== this.#generation) {
          return false;
        }
        this.list = response.savedSearches ?? list;
        this.#revision = response.revision;
        this.loaded = true;
        this.#needsRead = false;
        this.#loading ??= Promise.resolve();
        return true;
      } catch {
        // Re-read conflicts before the next queued edit derives its list and revision.
        if (!(await this.#read(generation)) && generation === this.#generation && this.#loading === loading) {
          this.#loading = undefined;
        }
        return false;
      }
    });
    this.#queue = pending.then(() => {});
    return pending;
  }

  /** Saves (or replaces, by name) a compiled search. */
  save(name: string, query: DiscoveryQuery) {
    const entry = toSavedSearch(name, query);
    return this.#write((list) => upsertSavedSearch(list, entry));
  }

  remove(name: string) {
    return this.#write((list) => removeSavedSearch(list, name));
  }
}

export const savedSearchesStore = new SavedSearchesStore();
