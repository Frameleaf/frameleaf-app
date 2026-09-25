import { pruneExpiredOAuthRequests } from '$lib/frameleaf/auth-session-preference';

/**
 * FL-80: private state this browser keeps for the signed-in account is cleared at sign-out, so the
 * next person to use the browser starts clean. Every `frameleaf…` key in local and session storage
 * is removed (recent commands, job history, settings drafts, onboarding progress, Studio hand-off,
 * library and viewer sessions, iCloud and enrichment drafts, the pending lock), except:
 *
 * - the sign-in choices `auth-session-preference.ts` manages (`frameleaf.auth.*`), which a forced
 *   password change keeps for one sign-in and which never name any content; of its OAuth request
 *   records only live ones (under 15 minutes old) stay, and expired ones are removed; and
 * - this device's display preferences, which describe the screen rather than the account.
 *
 * Keys a future feature adds under the `frameleaf` prefix are private by default.
 */
export const DEVICE_PREFERENCE_KEYS: ReadonlySet<string> = new Set([
  'frameleaf-thumbnail-size',
  'frameleaf-work-filenames',
  'frameleaf.rail.closedSections',
  'frameleaf.search.advanced',
]);

const AUTH_PREFIX = 'frameleaf.auth.';

export const isPrivateBrowserKey = (key: string) =>
  key.startsWith('frameleaf') && !key.startsWith(AUTH_PREFIX) && !DEVICE_PREFERENCE_KEYS.has(key);

const clearStore = (store: Storage | undefined) => {
  if (!store) {
    return;
  }
  const keys: string[] = [];
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    if (key !== null && isPrivateBrowserKey(key)) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    store.removeItem(key);
  }
};

const storageOrUndefined = (read: () => Storage) => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

export const clearPrivateBrowserState = () => {
  pruneExpiredOAuthRequests();
  for (const store of [storageOrUndefined(() => localStorage), storageOrUndefined(() => sessionStorage)]) {
    try {
      clearStore(store);
    } catch {
      // Blocked storage must never stop a sign-out.
    }
  }
};
