import { updateMyPreferences } from '@frameleaf/sdk';
import { defaultLang } from '$lib/constants';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { languageCodeFor } from '$lib/utils/i18n';

// One save at a time, in the order asked: a later choice is never overwritten by an earlier save
// that answers after it, on the server or in this session's copy of the preferences.
let saving: Promise<unknown> = Promise.resolve();
const inOrder = <T>(save: () => Promise<T>) => {
  // `saving` never rejects: each save's failure is caught below, so the next one always runs
  const next = saving.then(save);
  saving = next.catch(() => {});
  return next;
};

const write = async (language: string) => {
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

/** An explicit language choice also sets account notices, without changing device overrides. */
export const saveNotificationLanguage = (language: string) => inOrder(() => write(language));

/**
 * An account that never chose a language takes the one the app is shown in, so its emails and
 * notifications match (owner, 2026-11-11). The first device in a language other than English decides;
 * a choice made later in Settings replaces it. English is what an account without one gets anyway.
 */
export const adoptNotificationLanguage = (language: string) =>
  inOrder(async () => {
    const locale = languageCodeFor(language);
    if (!locale || locale === defaultLang.code || !authManager.authenticated) {
      return;
    }
    if (authManager.preferences.notifications?.locale) {
      return;
    }
    try {
      await write(language);
    } catch {
      // best effort: the next time the app opens it tries again
    }
  });
