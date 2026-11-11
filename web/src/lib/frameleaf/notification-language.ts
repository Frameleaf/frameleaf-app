import { updateMyPreferences } from '@frameleaf/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { languageCodeFor } from '$lib/utils/i18n';

/** An explicit language choice also sets account notices, without changing device overrides. */
export const saveNotificationLanguage = async (language: string) => {
  const locale = languageCodeFor(language);
  if (!locale || !authManager.authenticated || authManager.preferences.notifications?.locale === locale) {
    return;
  }
  const isCurrent = authManager.captureSession();
  const preferences = await updateMyPreferences({ userPreferencesUpdateDto: { notifications: { locale } } });
  if (!isCurrent()) {
    throw new DOMException('The account session changed', 'AbortError');
  }
  authManager.setPreferences(preferences);
};
