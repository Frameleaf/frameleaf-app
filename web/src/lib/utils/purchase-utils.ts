import { updateMyPreferences } from '@frameleaf/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';

export const setSupportBadgeVisibility = async (value: boolean) => {
  const isCurrent = authManager.captureSession();
  const response = await updateMyPreferences({ userPreferencesUpdateDto: { purchase: { showSupportBadge: value } } });
  if (isCurrent()) {
    authManager.setPreferences(response);
  }
};
