import { updateMyPreferences } from '@frameleaf/sdk';
import { defaultLang } from '$lib/constants';
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

/**
 * An account that never chose a language takes the one the app is shown in, so its emails and
 * notifications match (owner, 2026-11-11). The first device in a language other than English decides;
 * a choice made later in Settings replaces it. English is what an account without one gets anyway.
 */
export const adoptNotificationLanguage = async (language: string) => {
  const locale = languageCodeFor(language);
  if (!locale || locale === defaultLang.code || !authManager.authenticated) {
    return;
  }
  if (authManager.preferences.notifications?.locale) {
    return;
  }
  try {
    await saveNotificationLanguage(language);
  } catch {
    // best effort: the next time the app opens it tries again
  }
};
