import { untrack } from 'svelte';

/**
 * Whether one of the account's own preference forms on screen holds unsaved changes (design
 * review finding 70). The forms report it; the settings navigation marks the page they are on with
 * the same pending dot the server settings draft uses.
 */
let held = $state(0);

export const ownPreferencesPending = {
  get dirty() {
    return held > 0;
  },
  /** Called by a form while it has unsaved changes; the returned function releases it. */
  hold(): () => void {
    // Called from an effect: the count is changed without that effect coming to depend on it.
    untrack(() => held++);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      untrack(() => held--);
    };
  },
};
