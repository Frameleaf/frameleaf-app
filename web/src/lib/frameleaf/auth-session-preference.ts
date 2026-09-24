/** Tab-scoped auth options across provider redirects and mandatory-password relogin. */
import { Route } from '$lib/route';

const preferenceKey = 'frameleaf.auth.rememberMe';
const reloginKey = 'frameleaf.auth.passwordChangeRelogin';
const continueKey = 'frameleaf.auth.oauthContinue';
const forcedContinueKey = 'frameleaf.auth.forcedContinue';

const storage = () => {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
};
const read = (key: string) => {
  try {
    return storage()?.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    const store = storage();
    if (!store) {
      return false;
    }
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};
const remove = (key: string) => {
  try {
    storage()?.removeItem(key);
  } catch {
    // Storage can be blocked; clearing a transient preference must not interrupt logout.
  }
};

export const rememberMePreference = () => read(preferenceKey) !== 'false';

/** Return false before auth begins if a nonpersistent choice cannot survive redirects. */
export const setRememberMePreference = (rememberMe: boolean) => {
  if (rememberMe) {
    remove(preferenceKey);
    return true;
  }
  return write(preferenceKey, 'false');
};

export const clearRememberMePreference = () => {
  remove(preferenceKey);
  remove(reloginKey);
  remove(continueKey);
  remove(forcedContinueKey);
};

export const setOAuthContinue = (continueUrl: string | URL) => {
  const stored = write(continueKey, String(continueUrl));
  remove(forcedContinueKey);
  return stored;
};

export const preserveOAuthContinueForPasswordChange = () => write(forcedContinueKey, '1');

export const getOAuthContinue = (fallback: string | URL): string | URL => {
  try {
    return Route.continue(read(continueKey) ?? null, String(fallback));
  } catch {
    return fallback;
  }
};

export const getForcedPasswordContinue = (fallback: string | URL): string | URL =>
  read(forcedContinueKey) === '1' ? getOAuthContinue(fallback) : fallback;

export const clearOAuthContinue = () => {
  remove(continueKey);
  remove(forcedContinueKey);
};

export const preservePreferenceForPasswordChange = () =>
  (rememberMePreference() && read(forcedContinueKey) !== '1') || write(reloginKey, '1');

/** Normal logout forgets the choice; forced password change keeps it for one relogin. */
export const consumeLogoutPreference = () => {
  if (read(reloginKey) === '1') {
    remove(reloginKey);
  } else {
    remove(preferenceKey);
    clearOAuthContinue();
  }
};
