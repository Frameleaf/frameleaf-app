import { updateMyPreferences } from '@frameleaf/sdk';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { DEFAULT_LIBRARY_VIEW, libraryViewFrom, type LibraryViewOptions } from '$lib/frameleaf/library-view';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { handleError } from '$lib/utils/handle-error';

/** Switches flipped one after another are saved together. */
const SAVE_DELAY_MS = 400;

/**
 * The Library View menu's choices for the signed-in account (FL-1398).
 *
 * A change shows at once and is saved to the account's preferences shortly after. What this tab
 * changed wins here until the page is loaded again, so a save that fails (or a server too old to
 * store the group) never flips a switch back under the pointer. A visitor on a shared link gets the
 * defaults and saves nothing.
 */
export class LibraryViewStore {
  #local = $state<Partial<LibraryViewOptions>>({});
  #pending: Partial<LibraryViewOptions> = {};
  #timer: ReturnType<typeof setTimeout> | undefined;

  #account() {
    return authManager.authenticated && !authManager.isSharedLink;
  }

  get value(): LibraryViewOptions {
    return libraryViewFrom({
      ...(this.#account() && authManager.preferences.libraryView),
      ...this.#local,
    });
  }

  set(patch: Partial<LibraryViewOptions>) {
    this.#local = { ...this.#local, ...patch };
    if (!this.#account()) {
      return;
    }
    this.#pending = { ...this.#pending, ...patch };
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.save(), SAVE_DELAY_MS);
  }

  /** "Reset view": every option back to its default. */
  reset() {
    this.set({ ...DEFAULT_LIBRARY_VIEW });
  }

  /** Save what is waiting now. */
  async save() {
    clearTimeout(this.#timer);
    const libraryView = this.#pending;
    this.#pending = {};
    if (Object.keys(libraryView).length === 0) {
      return;
    }
    try {
      authManager.setPreferences(await updateMyPreferences({ userPreferencesUpdateDto: { libraryView } }));
    } catch (error) {
      handleError(error, get(t)('frameleaf_library_view_save_failed'));
    }
  }
}

export const libraryView = new LibraryViewStore();
