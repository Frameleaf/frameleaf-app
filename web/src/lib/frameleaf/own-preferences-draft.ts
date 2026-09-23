import { getMyPreferences, updateMyPreferences } from '@immich/sdk';
import type { AccountPreferenceKey } from '$lib/frameleaf/account-preferences';
import { AccountPreferencesDraftStore } from '$lib/frameleaf/account-preferences-draft.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';

/**
 * A draft for one group of the signed-in account's own settings. It saves through the account's
 * own endpoint (which never accepts the administrator's casting decision), shares every response
 * with the rest of the app, and moves onto a newer revision when another group of the same page
 * saved without touching its keys.
 */
export const createOwnPreferencesDraft = (keys: readonly AccountPreferenceKey[]) =>
  new AccountPreferencesDraftStore(authManager.preferences, {
    role: 'self',
    keys,
    rebaseUnrelated: true,
    save: (update) => updateMyPreferences({ userPreferencesUpdateDto: update }),
    load: () => getMyPreferences(),
    onUpdated: (preferences) => authManager.setPreferences(preferences),
  });
