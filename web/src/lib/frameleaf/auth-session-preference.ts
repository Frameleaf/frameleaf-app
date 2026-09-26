/**
 * Tab-scoped auth options across provider redirects and mandatory-password relogin. OAuth sign-in
 * keeps upstream behaviour: it is never routed through the forced password change.
 */
import { Route } from '$lib/route';

const preferenceKey = 'frameleaf.auth.rememberMe';
const reloginKey = 'frameleaf.auth.passwordChangeRelogin';
const continueKey = 'frameleaf.auth.oauthContinue';

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
};

export const setOAuthContinue = (continueUrl: string | URL) => write(continueKey, String(continueUrl));

export const getOAuthContinue = (fallback: string | URL): string | URL => {
  try {
    return Route.continue(read(continueKey) ?? null, String(fallback));
  } catch {
    return fallback;
  }
};

export const clearOAuthContinue = () => {
  remove(continueKey);
};

export const preservePreferenceForPasswordChange = () => rememberMePreference() || write(reloginKey, '1');

/** Normal logout forgets the choice; forced password change keeps it for one relogin. */
export const consumeLogoutPreference = () => {
  if (read(reloginKey) === '1') {
    remove(reloginKey);
  } else {
    remove(preferenceKey);
    clearOAuthContinue();
  }
};

/**
 * FL-80: a provider may finish sign-in in another tab (an email magic link, a phone hand-off, a
 * blocked pop-up reopened), where this tab's session storage is not. The choices the sign-in started
 * with ("Keep me signed in" and where to continue) are also kept in local storage under the
 * provider's `state`, for 15 minutes, and taken back once by the tab that receives the callback.
 * The continue address is still checked by `Route.continue` when it is used.
 */
const OAUTH_REQUEST_PREFIX = 'frameleaf.auth.oauthRequest.';
export const OAUTH_REQUEST_TTL_MS = 15 * 60 * 1000;

type OAuthRequest = { rememberMe: boolean; continueUrl: string | null; expiresAt: number };

const local = () => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

const stateOf = (url: string) => {
  try {
    return new URL(url, 'http://localhost').searchParams.get('state');
  } catch {
    return null;
  }
};

const pruneOAuthRequests = (store: Storage, now: number) => {
  for (let index = store.length - 1; index >= 0; index--) {
    const key = store.key(index);
    if (!key?.startsWith(OAUTH_REQUEST_PREFIX)) {
      continue;
    }
    try {
      const record = JSON.parse(store.getItem(key) ?? '') as Partial<OAuthRequest>;
      // Expired, or dated further ahead than a live record can be (older than 15 minutes is expired).
      if (
        typeof record.expiresAt !== 'number' ||
        record.expiresAt <= now ||
        record.expiresAt > now + OAUTH_REQUEST_TTL_MS
      ) {
        store.removeItem(key);
      }
    } catch {
      store.removeItem(key);
    }
  }
};

/**
 * FL-80: sign-out removes expired sign-in records. A live one (under 15 minutes old) stays, because
 * it belongs to a sign-in still in progress in another tab.
 */
export const pruneExpiredOAuthRequests = (now = Date.now()) => {
  const store = local();
  if (!store) {
    return;
  }
  try {
    pruneOAuthRequests(store, now);
  } catch {
    // Blocked storage must never stop a sign-out.
  }
};

/** Called with the provider's authorize address, before leaving for it. */
export const recordOAuthRequest = (authorizeUrl: string, now = Date.now()) => {
  const state = stateOf(authorizeUrl);
  const store = local();
  if (!state || !store) {
    return;
  }
  try {
    pruneOAuthRequests(store, now);
    const record: OAuthRequest = {
      rememberMe: rememberMePreference(),
      continueUrl: read(continueKey) ?? null,
      expiresAt: now + OAUTH_REQUEST_TTL_MS,
    };
    store.setItem(OAUTH_REQUEST_PREFIX + state, JSON.stringify(record));
  } catch {
    // Without local storage the same-tab choices still apply.
  }
};

/** Called by the tab receiving the callback, before it reads the choices. Takes the record once. */
export const restoreOAuthRequest = (callbackUrl: string, now = Date.now()) => {
  const state = stateOf(callbackUrl);
  const store = local();
  if (!state || !store) {
    return;
  }
  try {
    const key = OAUTH_REQUEST_PREFIX + state;
    const raw = store.getItem(key);
    store.removeItem(key);
    if (!raw) {
      return;
    }
    const record = JSON.parse(raw) as Partial<OAuthRequest>;
    if (typeof record.expiresAt !== 'number' || record.expiresAt <= now) {
      return;
    }
    if (record.rememberMe === false) {
      write(preferenceKey, 'false');
    }
    if (typeof record.continueUrl === 'string' && read(continueKey) === null) {
      write(continueKey, record.continueUrl);
    }
  } catch {
    // A damaged record is ignored; the sign-in completes with this tab's own choices.
  }
};
