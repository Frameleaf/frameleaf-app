import { persisted } from 'svelte-persisted-store';

/**
 * Frameleaf shell rollout flag (FL-30).
 *
 * The production shell (Frameleaf rail + top bar) ships behind this flag while the
 * library action ledger is still being qualified. The flag is a browser-local
 * *preference*, never a permission: turning it off restores the legacy navigation
 * immediately, and it never writes, migrates or discards any server-side data.
 * Legacy routes stay reachable in both states, so an in-flight draft (an open
 * upload, an unsaved album edit) survives a flip because only the chrome swaps.
 *
 * The switch lives in Settings -> App Settings. A single storage key keeps the
 * revert path trivial: clearing `frameleaf-shell` in local storage is enough.
 */
export const FRAMELEAF_SHELL_STORAGE_KEY = 'frameleaf-shell';

/**
 * Default on: the Frameleaf shell is the served experience. Switching the App Settings
 * toggle off is still a full, immediate revert to the legacy navigation below — the flag
 * only chooses which chrome renders, so it never migrates or discards server-side data.
 */
export const FRAMELEAF_SHELL_DEFAULT = true;

export const frameleafShell = persisted<boolean>(FRAMELEAF_SHELL_STORAGE_KEY, FRAMELEAF_SHELL_DEFAULT, {});
