import { updateMyPreferences } from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';

export const setSupportBadgeVisibility = async (value: boolean) => {
  const response = await updateMyPreferences({ userPreferencesUpdateDto: { purchase: { showSupportBadge: value } } });
  authManager.setPreferences(response);
};
